#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# AgentX Startup Orchestrator
# ═══════════════════════════════════════════════════════════════════════════
#
# This script is the core startup engine for AgentX.
# It handles:
#   - Service discovery and health checks
#   - Self-healing of failed/missing services
#   - Startup status reporting
#   - Automatic dashboard opening
#
# Called by the AgentX.app launcher bundle (or directly for debugging).
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Configuration ─────────────────────────────────────────────────────────
AGENTX_PORT="${PORT:-3001}"
AGENTX_HOST="${HOST:-127.0.0.1}"
AGENTX_DASHBOARD="http://${AGENTX_HOST}:${AGENTX_PORT}"
MEMORY_API_PORT="${AGENTX_MEMORY_API_PORT:-8100}"
MEMORY_API_HOST="${AGENTX_MEMORY_API_HOST:-127.0.0.1}"
HEALTH_PORT="${HEALTH_PORT:-9090}"

# Resolve project root (launcher lives at packages/launcher/)
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Data directory
DATA_DIR="${AGENTX_DATA_DIR:-$HOME/.agentx}"
LOG_DIR="$DATA_DIR/logs"
PID_FILE="$DATA_DIR/web.pid"
LAUNCHER_LOG="$LOG_DIR/launcher.log"

# Timing
# 150s per attempt allows for slow first-boot initialization (memory API spawn,
# SQLite setup, email reclassification, retrieval wiring). Previous 45s was
# the root cause of frequent "First start failed" events.
MAX_WAIT_SECS=150
HEALTH_TIMEOUT=5
MAX_START_ATTEMPTS=3

# Status tracking
declare -a STARTED_SERVICES=()
declare -a REPAIRED_SERVICES=()
declare -a FAILED_SERVICES=()
declare -a DEGRADED_SERVICES=()

# ─── Helpers ───────────────────────────────────────────────────────────────

timestamp() { date '+%Y-%m-%d %H:%M:%S'; }

log() {
  local msg="[$(timestamp)] $1"
  echo "$msg" >> "$LAUNCHER_LOG"
  # Also write to stdout for osascript display
  echo "$msg"
}

status_msg() {
  # This function outputs status that the .app wrapper can read
  echo "STATUS: $1"
  log "$1"
}

ensure_dirs() {
  mkdir -p "$DATA_DIR" "$LOG_DIR"
}

# ─── PATH Setup ───────────────────────────────────────────────────────────

setup_path() {
  # Ensure Homebrew and Node are on PATH (macOS installs)
  local brew_paths=(
    "/opt/homebrew/bin"
    "/opt/homebrew/sbin"
    "/usr/local/bin"
  )
  for p in "${brew_paths[@]}"; do
    [[ -d "$p" ]] && [[ ":$PATH:" != *":$p:"* ]] && export PATH="$p:$PATH"
  done

  # Find node via common paths
  if ! command -v node &>/dev/null; then
    # Try Homebrew node cellar
    local node_cellar
    node_cellar=$(find /opt/homebrew/Cellar/node -maxdepth 2 -name "bin" -type d 2>/dev/null | sort -V | tail -1)
    if [[ -n "$node_cellar" ]]; then
      export PATH="$node_cellar:$PATH"
    fi
  fi

  # Find npx/tsx
  if ! command -v npx &>/dev/null; then
    local npm_prefix
    npm_prefix=$(npm config get prefix 2>/dev/null || true)
    if [[ -n "$npm_prefix" && -d "$npm_prefix/bin" ]]; then
      export PATH="$npm_prefix/bin:$PATH"
    fi
  fi
}

# ─── Process Checks ───────────────────────────────────────────────────────

is_pid_alive() {
  local pid="$1"
  kill -0 "$pid" 2>/dev/null
}

is_port_in_use() {
  local p="$1"
  lsof -ti:"$p" &>/dev/null
}

get_port_pid() {
  local p="$1"
  lsof -ti:"$p" 2>/dev/null | head -1
}

kill_port() {
  local p="$1"
  local pids
  pids=$(lsof -ti:"$p" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 2
    # Force kill if still alive
    pids=$(lsof -ti:"$p" 2>/dev/null || true)
    if [[ -n "$pids" ]]; then
      echo "$pids" | xargs kill -9 2>/dev/null || true
      sleep 1
    fi
  fi
}

# ─── Health Checks ─────────────────────────────────────────────────────────

check_http() {
  local url="$1"
  local timeout="${2:-$HEALTH_TIMEOUT}"
  curl -sf --max-time "$timeout" "$url" &>/dev/null
}

check_web_server() {
  check_http "${AGENTX_DASHBOARD}/api/health"
}

check_memory_api() {
  check_http "http://${MEMORY_API_HOST}:${MEMORY_API_PORT}/health"
}

check_ollama() {
  check_http "http://127.0.0.1:11434/api/tags" 3
}

check_dashboard_routes() {
  # Verify critical API routes are responding
  local routes_ok=0
  local routes_total=0

  local critical_routes=(
    "/api/health"
    "/api/status"
  )

  local optional_routes=(
    "/api/device/config"
  )

  for route in "${critical_routes[@]}"; do
    routes_total=$((routes_total + 1))
    if check_http "${AGENTX_DASHBOARD}${route}"; then
      routes_ok=$((routes_ok + 1))
    fi
  done

  for route in "${optional_routes[@]}"; do
    routes_total=$((routes_total + 1))
    if check_http "${AGENTX_DASHBOARD}${route}"; then
      routes_ok=$((routes_ok + 1))
    fi
  done

  log "Route check: $routes_ok/$routes_total healthy"
  [[ $routes_ok -ge ${#critical_routes[@]} ]]
}

# ─── Service Start / Repair ───────────────────────────────────────────────

start_web_server() {
  status_msg "Starting AgentX web server..."
  log "Starting web server at $PROJECT_ROOT"

  cd "$PROJECT_ROOT"

  # Use tsx for development, node for production
  local server_cmd
  if [[ -f "packages/web/dist/serve.js" ]]; then
    server_cmd="node packages/web/dist/serve.js"
  else
    server_cmd="npx tsx packages/web/src/serve.ts"
  fi

  # Start in background, redirect output to log
  local server_log="$LOG_DIR/web-server.log"
  nohup env PORT="$AGENTX_PORT" HOST="$AGENTX_HOST" $server_cmd >> "$server_log" 2>&1 &
  local server_pid=$!
  log "Web server process started (PID $server_pid)"

  # Wait for server to be ready. As long as the process is alive we keep
  # waiting — killing a still-initializing server is what produced the old
  # "First start failed" → repair → FATAL cycles.
  local waited=0
  while [[ $waited -lt $MAX_WAIT_SECS ]]; do
    if check_web_server; then
      log "Web server healthy after ${waited}s"
      STARTED_SERVICES+=("web-server")
      return 0
    fi
    if ! is_pid_alive "$server_pid"; then
      log "ERROR: Web server process died at ${waited}s (PID $server_pid)"
      return 1
    fi
    sleep 2
    waited=$((waited + 2))
    if (( waited % 15 == 0 )); then
      status_msg "Waiting for server... (${waited}s)"
      log "Still waiting for server health (${waited}s elapsed, PID $server_pid alive)"
    fi
  done

  log "ERROR: Web server failed to start within ${MAX_WAIT_SECS}s"
  return 1
}

repair_web_server() {
  local attempt="${1:-2}"
  status_msg "Repairing web server (attempt $attempt)..."
  log "Attempting web server repair (attempt $attempt)"

  # Kill stale processes
  if is_port_in_use "$AGENTX_PORT"; then
    log "Port $AGENTX_PORT occupied — killing stale process"
    kill_port "$AGENTX_PORT"
  fi

  # Aggressive PID file cleanup — always remove on repair
  if [[ -f "$PID_FILE" ]]; then
    local old_pid
    old_pid=$(cat "$PID_FILE" 2>/dev/null || true)
    log "Removing PID file (was PID $old_pid) before retry"
    rm -f "$PID_FILE"
  fi

  # Settle delay — lets OS release socket and filesystem watchers
  sleep 3

  # Try starting again
  if start_web_server; then
    REPAIRED_SERVICES+=("web-server")
    return 0
  fi

  # Don't mark FAILED here — caller controls retry budget
  return 1
}

# Run up to MAX_START_ATTEMPTS starts before giving up
resilient_start_web_server() {
  if start_web_server; then
    return 0
  fi
  local attempt=2
  while [[ $attempt -le $MAX_START_ATTEMPTS ]]; do
    if repair_web_server "$attempt"; then
      return 0
    fi
    attempt=$((attempt + 1))
  done
  FAILED_SERVICES+=("web-server")
  return 1
}

# Warm the primary chat + embedding models in the background so the FIRST
# message doesn't pay a cold model load (30-60s for large weights). The
# 30-minute keep_alive then keeps them resident between messages.
warm_models() {
  check_ollama || return 0
  (
    /usr/bin/curl -sf -m 240 http://127.0.0.1:11434/api/chat \
      -d '{"model":"qwen3:30b-a3b-instruct-2507-q4_K_M","messages":[{"role":"user","content":"hi"}],"stream":false,"keep_alive":"30m","options":{"num_predict":1}}' >/dev/null 2>&1
    /usr/bin/curl -sf -m 60 http://127.0.0.1:11434/api/embed \
      -d '{"model":"nomic-embed-text","input":"warm","keep_alive":"30m"}' >/dev/null 2>&1
    # Heavy model too: legal/medical/doc questions shouldn't pay a 40GB
    # cold load. 128GB RAM comfortably fits 70B + MoE + embeddings.
    /usr/bin/curl -sf -m 300 http://127.0.0.1:11434/api/chat \
      -d '{"model":"llama3.3:70b-instruct-q4_K_M","messages":[{"role":"user","content":"hi"}],"stream":false,"keep_alive":"30m","options":{"num_predict":1}}' >/dev/null 2>&1
    log "Model warm-up complete (chat MoE + 70B + embeddings resident)"
  ) &
}

# First-run experience: pull the MINIMUM models a fresh install needs.
# nomic-embed-text (274MB) powers retrieval/memory; llama3.1:8b (4.9GB) is
# the smallest chat-capable fleet model, so a brand-new machine can talk
# within minutes. The large models (70b, qwen3 MoE, coder, vision) are
# pulled on demand from the Models tab — never forced at first launch.
ensure_core_models() {
  check_ollama || return 0
  local required=("nomic-embed-text" "llama3.1:8b")
  local installed
  installed=$(/usr/bin/curl -sf -m 5 http://127.0.0.1:11434/api/tags 2>/dev/null | /usr/bin/grep -o '"name":"[^"]*"' || true)
  for model in "${required[@]}"; do
    if ! echo "$installed" | /usr/bin/grep -q "$model"; then
      status_msg "First run: downloading $model (one-time)..."
      log "Pulling required model: $model"
      if command -v ollama &>/dev/null; then
        ollama pull "$model" >> "$LOG_DIR/ollama-pull.log" 2>&1 \
          && log "Model $model ready" \
          || log "WARNING: pull of $model failed — features needing it degrade until installed"
      fi
    fi
  done
}

ensure_ollama() {
  if check_ollama; then
    log "Ollama already running"
    STARTED_SERVICES+=("ollama")
    return 0
  fi

  # Try starting Ollama if installed
  if command -v ollama &>/dev/null; then
    status_msg "Starting Ollama..."
    nohup ollama serve >> "$LOG_DIR/ollama.log" 2>&1 &
    sleep 3
    if check_ollama; then
      log "Ollama started successfully"
      STARTED_SERVICES+=("ollama")
      return 0
    fi
  fi

  # Ollama is optional — mark degraded, don't fail
  log "Ollama not available (optional service)"
  DEGRADED_SERVICES+=("ollama")
  return 0
}

# ─── oMLX (P13-A3) ─────────────────────────────────────────────────────────
# Apple-Silicon MLX inference sidecar. OPTIONAL: when it runs, AgentX's
# routing engine benchmarks it against Ollama and promotes it per task
# (measured 4-6× faster on the M4 Max). When it's absent, everything
# runs on Ollama — never a failure condition.

OMLX_PORT="${AGENTX_OMLX_PORT:-8080}"
OMLX_MODEL="${AGENTX_OMLX_MODEL:-mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit}"
OMLX_BIN="$HOME/.agentx/mlx-venv/bin/mlx_lm.server"

check_omlx() {
  check_http "http://127.0.0.1:${OMLX_PORT}/v1/models" 3
}

ensure_omlx() {
  if check_omlx; then
    log "oMLX already running on :${OMLX_PORT}"
    STARTED_SERVICES+=("omlx")
    return 0
  fi

  if [[ ! -x "$OMLX_BIN" ]]; then
    log "oMLX not installed (optional — Ollama-only mode). Install: python3.13 -m venv ~/.agentx/mlx-venv && ~/.agentx/mlx-venv/bin/pip install mlx-lm 'transformers==5.12.0'"
    DEGRADED_SERVICES+=("omlx")
    return 0
  fi

  # Port occupied by something unhealthy → clean it first.
  if is_port_in_use "$OMLX_PORT"; then
    log "Port $OMLX_PORT occupied but unhealthy — cleaning stale oMLX"
    kill_port "$OMLX_PORT"
    REPAIRED_SERVICES+=("omlx-stale-cleanup")
  fi

  status_msg "Starting oMLX inference engine..."
  nohup "$OMLX_BIN" --model "$OMLX_MODEL" --port "$OMLX_PORT" --host 127.0.0.1 \
    >> "$LOG_DIR/omlx.log" 2>&1 &
  local omlx_pid=$!
  log "oMLX process started (PID $omlx_pid, model $OMLX_MODEL)"

  # The httpd binds immediately; model weights load lazily from the HF
  # cache (~1s warm). First-EVER run downloads the model (~17GB) — we
  # do NOT block launch on that: AgentX's 60s TTL probe picks oMLX up
  # automatically once it's serving, and routing falls back to Ollama
  # meanwhile.
  local waited=0
  while [[ $waited -lt 15 ]]; do
    if check_omlx; then
      log "oMLX healthy after ${waited}s"
      STARTED_SERVICES+=("omlx")
      return 0
    fi
    if ! is_pid_alive "$omlx_pid"; then
      log "oMLX process died at ${waited}s — see $LOG_DIR/omlx.log"
      DEGRADED_SERVICES+=("omlx")
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done

  log "oMLX not healthy within ${waited}s (may be downloading model) — continuing; AgentX will auto-detect when ready"
  DEGRADED_SERVICES+=("omlx")
  return 0
}

# ─── qwen3-TTS sidecar ─────────────────────────────────────────────────────
# Premium local voice on :9880 (edge-tts backed). OPTIONAL: when it's
# down, /api/tts falls back to macos-say — voice still works, just the
# built-in voice. Self-heals its own missing python dep (edge-tts).

TTS_PORT="${AGENTX_TTS_PORT:-9880}"
TTS_SCRIPT="$PROJECT_ROOT/packages/launcher/qwen3-tts-server.py"
TTS_PYTHON="/opt/homebrew/bin/python3"

check_tts() {
  check_http "http://127.0.0.1:${TTS_PORT}/health" 3
}

ensure_tts() {
  if check_tts; then
    log "qwen3-TTS already running on :${TTS_PORT}"
    STARTED_SERVICES+=("qwen3-tts")
    return 0
  fi
  if [[ ! -f "$TTS_SCRIPT" || ! -x "$TTS_PYTHON" ]]; then
    log "qwen3-TTS not available (script or python3 missing — optional; macos-say fallback active)"
    DEGRADED_SERVICES+=("qwen3-tts")
    return 0
  fi
  # Self-heal the python dependency (root cause of most TTS-down states).
  if ! "$TTS_PYTHON" -c "import edge_tts" 2>/dev/null; then
    log "qwen3-TTS dep 'edge-tts' missing — installing (one-time)"
    status_msg "Installing voice dependencies..."
    "$TTS_PYTHON" -m pip install --user --break-system-packages --quiet edge-tts \
      >> "$LOG_DIR/python-deps-install.log" 2>&1 || true
    if "$TTS_PYTHON" -c "import edge_tts" 2>/dev/null; then
      REPAIRED_SERVICES+=("edge-tts-dep")
    else
      log "WARNING: edge-tts install failed — voice stays on macos-say fallback"
      DEGRADED_SERVICES+=("qwen3-tts")
      return 0
    fi
  fi
  if is_port_in_use "$TTS_PORT"; then
    log "Port $TTS_PORT occupied but unhealthy — cleaning stale TTS"
    kill_port "$TTS_PORT"
    REPAIRED_SERVICES+=("tts-stale-cleanup")
  fi
  status_msg "Starting voice engine..."
  nohup "$TTS_PYTHON" "$TTS_SCRIPT" >> "$LOG_DIR/tts-server.log" 2>&1 &
  local tts_pid=$!
  log "qwen3-TTS started (PID $tts_pid)"
  local waited=0
  while [[ $waited -lt 12 ]]; do
    if check_tts; then
      log "qwen3-TTS healthy after ${waited}s"
      STARTED_SERVICES+=("qwen3-tts")
      return 0
    fi
    if ! is_pid_alive "$tts_pid"; then
      log "qwen3-TTS process died — see $LOG_DIR/tts-server.log"
      DEGRADED_SERVICES+=("qwen3-tts")
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  log "qwen3-TTS not healthy within ${waited}s — degraded (macos-say fallback active)"
  DEGRADED_SERVICES+=("qwen3-tts")
  return 0
}

# ─── Watchdog supervisor ───────────────────────────────────────────────────
# THE self-healing engine between launches. Previously NEVER started by
# the launcher — all its recovery logic (web restart, TTS restart, oMLX
# restart, memory nudge) existed but never ran. Exactly one instance.

WATCHDOG_SCRIPT="$SCRIPT_DIR/agentx-watchdog.sh"

ensure_watchdog() {
  if pgrep -f "agentx-watchdog.sh" &>/dev/null; then
    log "Watchdog already running"
    STARTED_SERVICES+=("watchdog")
    return 0
  fi
  if [[ ! -f "$WATCHDOG_SCRIPT" ]]; then
    log "Watchdog script missing (optional)"
    DEGRADED_SERVICES+=("watchdog")
    return 0
  fi
  nohup bash "$WATCHDOG_SCRIPT" "$PROJECT_ROOT" >> "$LOG_DIR/watchdog.log" 2>&1 &
  log "Watchdog started (PID $!) — supervising web/memory/tts/omlx/ollama"
  STARTED_SERVICES+=("watchdog")
  return 0
}

# ─── Health Policy ─────────────────────────────────────────────────────────
#
# REQUIRED SERVICES (must be healthy for launch):
#   - web-server (port 3001)
#   - /api/health responding
#   - /api/status responding
#
# OPTIONAL SERVICES (degraded mode if missing):
#   - memory-api (port 8100) — launched by web server supervisor
#   - ollama (port 11434) — needed for local models
#   - TTS — not started independently
#   - health-server (port 9090) — not started independently
#
# FAIL MODE:
#   - web server won't start after repair → FAIL
#   - critical routes not responding → FAIL
#
# DEGRADED MODE:
#   - memory API down → features degraded but dashboard usable
#   - ollama down → no local model inference, but dashboard loads
#   - optional routes missing → continue
# ───────────────────────────────────────────────────────────────────────────

# ─── Main Orchestration ───────────────────────────────────────────────────

ensure_python_deps() {
  # Ensure Memory API Python deps are installed (uvicorn, fastapi, duckdb, etc.)
  # Missing these is the root cause of "Memory API degraded" on every boot.
  local pybin="/opt/homebrew/bin/python3"
  [[ ! -x "$pybin" ]] && return 0
  if "$pybin" -c "import uvicorn, fastapi, duckdb, lancedb, yaml, pyarrow, numpy" 2>/dev/null; then
    log "Memory API Python deps OK"
    return 0
  fi
  log "Memory API Python deps missing — installing (one-time)"
  status_msg "Installing memory service dependencies..."
  "$pybin" -m pip install --user --break-system-packages --quiet \
    uvicorn fastapi duckdb lancedb pyyaml pyarrow numpy ollama \
    >> "$LOG_DIR/python-deps-install.log" 2>&1
  if "$pybin" -c "import uvicorn, fastapi, duckdb, lancedb, yaml, pyarrow, numpy" 2>/dev/null; then
    log "Memory API Python deps installed"
    REPAIRED_SERVICES+=("python-deps")
  else
    log "WARNING: Python dep install failed — Memory API will stay degraded"
  fi
}

main() {
  ensure_dirs
  setup_path

  log "═══════════════════════════════════════════════════════"
  log "AgentX Startup Orchestrator"
  log "Project: $PROJECT_ROOT"
  log "Dashboard: $AGENTX_DASHBOARD"
  log "═══════════════════════════════════════════════════════"

  status_msg "Starting AgentX..."

  # ─── Phase 0: Ensure Python deps for Memory API ──────────────────────
  ensure_python_deps

  # ─── Phase 1: Check if already running ─────────────────────────────────
  if check_web_server; then
    log "Web server already running and healthy"
    STARTED_SERVICES+=("web-server (existing)")

    # Still verify routes
    if check_dashboard_routes; then
      # Heal ALL optional sidecars even on the already-running fast
      # path, so re-clicking the app icon repairs anything dead
      # without restarting AgentX itself.
      ensure_omlx
      ensure_tts
      ensure_watchdog
      status_msg "AgentX already running — opening dashboard"
      open "$AGENTX_DASHBOARD"
      print_summary "RUNNING"
      exit 0
    fi
  fi

  # ─── Phase 2: Handle stale state ───────────────────────────────────────
  if is_port_in_use "$AGENTX_PORT" && ! check_web_server; then
    log "Port $AGENTX_PORT in use but unhealthy — stale process detected"
    status_msg "Cleaning up stale processes..."
    kill_port "$AGENTX_PORT"
    sleep 1
    REPAIRED_SERVICES+=("stale-cleanup")
  fi

  # ─── Phase 3: Start optional services first ────────────────────────────
  status_msg "Checking services..."
  ensure_ollama
  ensure_core_models
  warm_models
  ensure_omlx
  ensure_tts

  # ─── Phase 4: Start web server (includes memory API via supervisor) ────
  # resilient_start_web_server attempts up to MAX_START_ATTEMPTS (3) times
  # with escalating cleanup between attempts, each with a 150s timeout.
  if ! resilient_start_web_server; then
    status_msg "FAILED: Could not start AgentX web server after $MAX_START_ATTEMPTS attempts"
    print_summary "FAILED"
    show_failure_dialog
    exit 1
  fi

  # ─── Phase 5: Wait for memory API (started by web server supervisor) ───
  # Supervisor needs ~25s minimum (20s port bind + uvicorn init). Wait up to 45s.
  # If the Python source isn't present, the service can't exist — skip the
  # wait entirely (not a degradation; there is nothing to heal).
  status_msg "Checking memory services..."
  local mem_waited=0
  if [[ ! -f "$PROJECT_ROOT/packages/memory-core/src/agentx_memory/api/server.py" ]]; then
    log "Memory API source not installed (packages/memory-core empty) — skipping"
    mem_waited=45
  fi
  while [[ $mem_waited -lt 45 ]]; do
    if check_memory_api; then
      log "Memory API healthy after ${mem_waited}s"
      STARTED_SERVICES+=("memory-api")
      break
    fi
    sleep 2
    mem_waited=$((mem_waited + 2))
    if (( mem_waited % 15 == 0 )); then
      log "Still waiting for Memory API (${mem_waited}s)"
    fi
  done
  if ! check_memory_api; then
    if [[ -f "$PROJECT_ROOT/packages/memory-core/src/agentx_memory/api/server.py" ]]; then
      log "Memory API not available after ${mem_waited}s (degraded — watchdog will retry)"
      DEGRADED_SERVICES+=("memory-api")
    fi
  fi

  # ─── Phase 6: Validate critical routes ─────────────────────────────────
  status_msg "Validating AgentX health..."
  if ! check_dashboard_routes; then
    log "WARNING: Some dashboard routes unhealthy"
    # Still continue if basic health passes
    if ! check_web_server; then
      status_msg "FAILED: AgentX server unhealthy after start"
      FAILED_SERVICES+=("route-validation")
      print_summary "FAILED"
      show_failure_dialog
      exit 1
    fi
  fi

  # ─── Phase 6.5: Start the watchdog supervisor ──────────────────────────
  # Keeps everything above alive BETWEEN launches: web server, memory
  # API, qwen3-TTS, oMLX, Ollama. Started last so it never races the
  # initial bring-up.
  ensure_watchdog

  # ─── Phase 7: Open dashboard ───────────────────────────────────────────
  status_msg "Opening AgentX dashboard..."
  open "$AGENTX_DASHBOARD"

  # ─── Phase 8: Report ───────────────────────────────────────────────────
  local final_status="HEALTHY"
  if [[ ${#DEGRADED_SERVICES[@]} -gt 0 ]]; then
    final_status="DEGRADED"
  fi
  if [[ ${#FAILED_SERVICES[@]} -gt 0 ]]; then
    final_status="FAILED"
  fi

  print_summary "$final_status"
  status_msg "AgentX started ($final_status)"

  # Show notification
  if [[ "$final_status" == "HEALTHY" ]]; then
    osascript -e 'display notification "Dashboard is ready" with title "AgentX" subtitle "All services healthy"' 2>/dev/null || true
  elif [[ "$final_status" == "DEGRADED" ]]; then
    local degraded_list
    degraded_list=$(printf ", %s" "${DEGRADED_SERVICES[@]}")
    degraded_list="${degraded_list:2}"
    osascript -e "display notification \"Some services degraded: ${degraded_list}\" with title \"AgentX\" subtitle \"Running in degraded mode\"" 2>/dev/null || true
  fi
}

print_summary() {
  local status="$1"
  log ""
  log "═══════════════════════════════════════════════════════"
  log "AgentX Startup Summary — $status"
  log "═══════════════════════════════════════════════════════"

  if [[ ${#STARTED_SERVICES[@]} -gt 0 ]]; then
    log "Started: ${STARTED_SERVICES[*]}"
  fi
  if [[ ${#REPAIRED_SERVICES[@]} -gt 0 ]]; then
    log "Repaired: ${REPAIRED_SERVICES[*]}"
  fi
  if [[ ${#DEGRADED_SERVICES[@]} -gt 0 ]]; then
    log "Degraded: ${DEGRADED_SERVICES[*]}"
  fi
  if [[ ${#FAILED_SERVICES[@]} -gt 0 ]]; then
    log "FAILED: ${FAILED_SERVICES[*]}"
  fi

  log "Dashboard: $AGENTX_DASHBOARD"
  log "Log: $LAUNCHER_LOG"
  log "═══════════════════════════════════════════════════════"
}

show_failure_dialog() {
  local msg="AgentX failed to start.\n\n"
  if [[ ${#FAILED_SERVICES[@]} -gt 0 ]]; then
    msg+="Failed services: ${FAILED_SERVICES[*]}\n"
  fi
  if [[ ${#REPAIRED_SERVICES[@]} -gt 0 ]]; then
    msg+="Repaired: ${REPAIRED_SERVICES[*]}\n"
  fi
  msg+="\nCheck log: $LAUNCHER_LOG"

  osascript -e "display dialog \"$msg\" with title \"AgentX Startup Failed\" buttons {\"OK\"} default button \"OK\" with icon stop" 2>/dev/null || true
}

# ─── Run ───────────────────────────────────────────────────────────────────
main "$@"
