#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# AgentX Health Watchdog — Standalone Process
# ═══════════════════════════════════════════════════════════════════════════
# Runs as an independent, detached process that monitors AgentX services
# and restarts them if they crash. Designed to survive the parent .app
# launcher exiting.
#
# Usage: nohup bash /path/to/agentx-watchdog.sh <project_root> &
# ═══════════════════════════════════════════════════════════════════════════

set -uo pipefail

PROJECT_ROOT="${1:?Usage: agentx-watchdog.sh <project_root>}"

# ─── PATH Setup (identical to main launcher — never hardcode versions) ────
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
NODE_CELLAR=$(find /opt/homebrew/Cellar/node -maxdepth 2 -name "bin" -type d 2>/dev/null | sort -V | tail -1)
if [[ -n "$NODE_CELLAR" ]]; then
  export PATH="$NODE_CELLAR:$PATH"
fi

# ─── Config ───────────────────────────────────────────────────────────────
AGENTX_PORT="${PORT:-3001}"
AGENTX_HOST="${HOST:-127.0.0.1}"
TTS_PORT=9880

DATA_DIR="$HOME/.agentx"
LOG_DIR="$DATA_DIR/logs"
WATCHDOG_LOG="$LOG_DIR/watchdog.log"
WATCHDOG_PID_FILE="$DATA_DIR/watchdog.pid"
mkdir -p "$LOG_DIR"

# Write our PID
echo $$ > "$WATCHDOG_PID_FILE"

CONSECUTIVE_FAILURES=0
MAX_FAILURES=10

wd_log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [watchdog] $1" >> "$WATCHDOG_LOG"
}

check_http() {
  /usr/bin/curl -sf --max-time 5 "$1" &>/dev/null
}

wd_log "════════════════════════════════════════════════"
wd_log "Watchdog started (PID $$)"
wd_log "Project: $PROJECT_ROOT"
wd_log "Node: $(which node 2>/dev/null || echo 'NOT FOUND') ($(node --version 2>/dev/null || echo 'N/A'))"
wd_log "Python: $(/opt/homebrew/bin/python3 --version 2>/dev/null || echo 'NOT FOUND')"
wd_log "Dashboard: http://${AGENTX_HOST}:${AGENTX_PORT}"
wd_log "════════════════════════════════════════════════"

while true; do
  sleep 30

  # ── Check web server ──
  if ! check_http "http://${AGENTX_HOST}:${AGENTX_PORT}/api/health"; then
    CONSECUTIVE_FAILURES=$((CONSECUTIVE_FAILURES + 1))
    wd_log "Web server unhealthy (failure $CONSECUTIVE_FAILURES/$MAX_FAILURES)"

    if [[ $CONSECUTIVE_FAILURES -ge $MAX_FAILURES ]]; then
      wd_log "Web server dead for $MAX_FAILURES checks — exiting watchdog"
      rm -f "$WATCHDOG_PID_FILE"
      exit 1
    fi

    # Attempt restart
    wd_log "Restarting web server..."
    # Kill stale port users
    local_pids=$(/usr/sbin/lsof -ti:"$AGENTX_PORT" 2>/dev/null || true)
    if [[ -n "$local_pids" ]]; then
      echo "$local_pids" | xargs kill 2>/dev/null || true
      sleep 2
    fi

    cd "$PROJECT_ROOT"

    # Remove stale PID file BEFORE starting — serve.js checks it on boot
    rm -f "$DATA_DIR/web.pid"

    if [[ -f "packages/web/dist/serve.js" ]]; then
      WD_CMD="$(which node) packages/web/dist/serve.js"
    elif command -v npx &>/dev/null; then
      WD_CMD="$(which npx) tsx packages/web/src/serve.ts"
    else
      wd_log "ERROR: Cannot find node or npx to restart server"
      continue
    fi

    nohup env PORT="$AGENTX_PORT" HOST="$AGENTX_HOST" $WD_CMD >> "$LOG_DIR/web-server.log" 2>&1 &
    NEW_PID=$!
    wd_log "Web server restarted (PID $NEW_PID) via: $WD_CMD"

    # Wait for it to come up — server init can take 45-60s on first boot.
    # Poll every 3s for up to 120s; exit loop early on success.
    RECOVERY_WAITED=0
    while [[ $RECOVERY_WAITED -lt 120 ]]; do
      if check_http "http://${AGENTX_HOST}:${AGENTX_PORT}/api/health"; then
        wd_log "Web server recovered after ${RECOVERY_WAITED}s"
        CONSECUTIVE_FAILURES=0
        osascript -e 'display notification "Server recovered automatically" with title "AgentX" subtitle "Self-healing active"' 2>/dev/null || true
        break
      fi
      # If process died during recovery, break early so next loop iteration retries
      if ! kill -0 "$NEW_PID" 2>/dev/null; then
        wd_log "Recovery process died at ${RECOVERY_WAITED}s — will retry next cycle"
        break
      fi
      sleep 3
      RECOVERY_WAITED=$((RECOVERY_WAITED + 3))
    done
  else
    # Reset failure counter on success
    if [[ $CONSECUTIVE_FAILURES -gt 0 ]]; then
      wd_log "Web server healthy again (was at failure $CONSECUTIVE_FAILURES)"
    fi
    CONSECUTIVE_FAILURES=0
  fi

  # ── Check Memory API (port 8100) ──
  MEMORY_PORT="${AGENTX_MEMORY_API_PORT:-8100}"
  if ! check_http "http://127.0.0.1:${MEMORY_PORT}/health"; then
    wd_log "Memory API (port $MEMORY_PORT) not responding — checking if server should restart it"
    # Memory API is managed by ServiceSupervisor inside the web server.
    # If web server is healthy but memory API is not, nudge it via the
    # cognitive status endpoint which triggers lazy re-init.
    if check_http "http://${AGENTX_HOST}:${AGENTX_PORT}/api/health"; then
      /usr/bin/curl -sf --max-time 5 "http://${AGENTX_HOST}:${AGENTX_PORT}/api/cognitive/status" &>/dev/null || true
      wd_log "Memory API recovery nudge sent via cognitive/status"
    fi
  fi

  # ── Check TTS server ──
  if ! check_http "http://127.0.0.1:${TTS_PORT}/health"; then
    wd_log "TTS server down — restarting..."
    TTS_SCRIPT="$PROJECT_ROOT/packages/launcher/qwen3-tts-server.py"
    if [[ -f "$TTS_SCRIPT" ]]; then
      # Kill stale TTS
      tts_pids=$(/usr/sbin/lsof -ti:"$TTS_PORT" 2>/dev/null || true)
      if [[ -n "$tts_pids" ]]; then
        echo "$tts_pids" | xargs kill 2>/dev/null || true
        sleep 1
      fi
      nohup /opt/homebrew/bin/python3 "$TTS_SCRIPT" >> "$LOG_DIR/tts-server.log" 2>&1 &
      wd_log "TTS server restarted (PID $!)"
      sleep 3
      if check_http "http://127.0.0.1:${TTS_PORT}/health"; then
        wd_log "TTS server recovered"
      fi
    fi
  fi

  # ── P13-A3: Check oMLX inference sidecar ──
  # Optional: only supervised when the MLX venv is installed. A dead
  # oMLX is restarted; AgentX routing falls back to Ollama meanwhile,
  # so this is availability polish, never a hard dependency.
  OMLX_PORT="${AGENTX_OMLX_PORT:-8080}"
  OMLX_BIN="$HOME/.agentx/mlx-venv/bin/mlx_lm.server"
  OMLX_MODEL="${AGENTX_OMLX_MODEL:-mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit}"
  if [[ -x "$OMLX_BIN" ]] && ! check_http "http://127.0.0.1:${OMLX_PORT}/v1/models"; then
    wd_log "oMLX down — restarting..."
    omlx_pids=$(/usr/sbin/lsof -ti:"$OMLX_PORT" 2>/dev/null || true)
    if [[ -n "$omlx_pids" ]]; then
      echo "$omlx_pids" | xargs kill 2>/dev/null || true
      sleep 1
    fi
    nohup "$OMLX_BIN" --model "$OMLX_MODEL" --port "$OMLX_PORT" --host 127.0.0.1 >> "$LOG_DIR/omlx.log" 2>&1 &
    wd_log "oMLX restarted (PID $!)"
    sleep 5
    if check_http "http://127.0.0.1:${OMLX_PORT}/v1/models"; then
      wd_log "oMLX recovered"
    fi
  fi
done
