#!/usr/bin/env python3
"""
AgentX Qwen3 TTS Server
========================
Local TTS server on port 9880 using edge-tts (Microsoft Neural TTS).
Implements the exact API the Qwen3 TTS provider expects:
  GET  /health  — health check
  GET  /voices  — list available voices
  POST /tts     — synthesize speech (returns audio/mpeg)

Hardcoded as the sole TTS engine for AgentX.
"""

import asyncio
import io
import json
import os
import sys
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

try:
    import edge_tts
except ImportError:
    print("ERROR: edge-tts not installed. Run: pip3 install edge-tts", file=sys.stderr)
    sys.exit(1)

PORT = int(os.environ.get("AGENTX_TTS_PORT", "9880"))
HOST = os.environ.get("AGENTX_TTS_HOST", "127.0.0.1")

# Voice mapping: AgentX voice names → edge-tts voice IDs
VOICE_MAP = {
    "Chelsie":  "en-US-JennyNeural",
    "Aria":     "en-US-AriaNeural",
    "Ethan":    "en-US-GuyNeural",
    "Davis":    "en-US-ChristopherNeural",
}

DEFAULT_VOICE = "en-US-JennyNeural"

VOICES = [
    {"id": "Chelsie",  "name": "Chelsie",  "description": "Female, warm and clear",        "builtin": True},
    {"id": "Aria",     "name": "Aria",     "description": "Female, friendly and expressive", "builtin": True},
    {"id": "Ethan",    "name": "Ethan",    "description": "Male, calm and professional",     "builtin": True},
    {"id": "Davis",    "name": "Davis",    "description": "Male, authoritative narrator",    "builtin": True},
]


def synthesize_sync(text: str, voice: str, speed: float = 1.0) -> bytes:
    """Run edge-tts synthesis synchronously, return MP3 bytes."""
    edge_voice = VOICE_MAP.get(voice, DEFAULT_VOICE)

    rate_str = ""
    if speed != 1.0:
        pct = int((speed - 1.0) * 100)
        rate_str = f"+{pct}%" if pct >= 0 else f"{pct}%"

    async def _synth():
        communicate = edge_tts.Communicate(text, edge_voice, rate=rate_str if rate_str else "+0%")
        buf = io.BytesIO()
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                buf.write(chunk["data"])
        return buf.getvalue()

    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(_synth())
    finally:
        loop.close()


class TTSHandler(BaseHTTPRequestHandler):
    """HTTP handler for the TTS API."""

    def log_message(self, format, *args):
        """Suppress default logging, use our own."""
        pass

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self._send_json(200, {"status": "ok", "provider": "qwen3-tts", "engine": "edge-tts"})
            return

        if self.path == "/voices":
            self._send_json(200, VOICES)
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self):
        if self.path != "/tts":
            self._send_json(404, {"error": "Not found"})
            return

        # Read body
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length == 0:
            self._send_json(400, {"error": "Empty request body"})
            return

        raw = self.rfile.read(content_length)
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            self._send_json(400, {"error": "Invalid JSON"})
            return

        text = body.get("text", "").strip()
        if not text:
            self._send_json(400, {"error": "text is required"})
            return

        voice_id = body.get("voice_id", "Chelsie")
        speed = float(body.get("speed", 1.0))

        try:
            audio_bytes = synthesize_sync(text, voice_id, speed)
            if not audio_bytes:
                self._send_json(500, {"error": "Synthesis returned empty audio"})
                return

            self.send_response(200)
            self.send_header("Content-Type", "audio/mpeg")
            self.send_header("Content-Length", str(len(audio_bytes)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("X-TTS-Provider", "edge-tts")
            self.send_header("X-TTS-Voice", voice_id)
            self.end_headers()
            self.wfile.write(audio_bytes)
            print(f"[TTS] Synthesized {len(text)} chars → {len(audio_bytes)} bytes (voice={voice_id})")

        except Exception as e:
            print(f"[TTS] ERROR: {e}", file=sys.stderr)
            self._send_json(500, {"error": str(e)})


def main():
    server = HTTPServer((HOST, PORT), TTSHandler)
    print(f"[TTS] Qwen3 TTS Server running on http://{HOST}:{PORT}")
    print(f"[TTS] Engine: edge-tts (Microsoft Neural TTS)")
    print(f"[TTS] Voices: {', '.join(v['id'] for v in VOICES)}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[TTS] Shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
