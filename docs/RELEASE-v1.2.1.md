# AgentX v1.2.1

Verification hardening patch for the v1.2.0 release.

## Fixed

- Made Vitest localhost mock-server teardown deterministic by closing keep-alive sockets before `server.close()`.
- Aligned `/api/services/degraded` with `/api/tts/health` so healthy Piper installs are not reported as degraded.
- Added deterministic coverage for Piper fallback when the higher-priority TTS provider is unavailable.
- Fixed Chat status badges by returning nested `vision`, `stt`, and `tts` status objects from `/api/multimodal/status`.
- Fixed the false degraded Engine Integration health state for the normal lazy AgentLoopEngine idle state.

## Verified

- `npx vitest run`: 131 files passed, 1757 tests passed, 1 skipped.
- `packages/memory-core`: 174 Python tests passed.
- Live status endpoints were checked for health, speech, TTS, multimodal, and self-healing consistency.
