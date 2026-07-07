#!/bin/bash
# AgentX uninstaller. Removes the app, stops services, and (optionally)
# deletes all data. Source folder is left unless --purge-source is given.

set -uo pipefail

echo "Stopping AgentX services…"
/usr/bin/pgrep -f "agentx-watchdog|dist/serve.js|qwen3-tts-server|mlx_lm.server|uvicorn agentx_memory" 2>/dev/null \
  | xargs kill 2>/dev/null || true

echo "Removing /Applications/AgentX.app…"
rm -rf "/Applications/AgentX.app" 2>/dev/null || sudo rm -rf "/Applications/AgentX.app" || true

if [[ "${1:-}" == "--purge-data" || "${1:-}" == "--purge-all" ]]; then
  echo "Deleting ~/.agentx (ALL conversations, memory, licenses)…"
  rm -rf "$HOME/.agentx"
else
  echo "Data kept at ~/.agentx (use --purge-data to delete)."
fi

if [[ "${1:-}" == "--purge-all" ]]; then
  src=$(cat "$HOME/.agentx/install-path" 2>/dev/null || echo "$HOME/AgentX")
  echo "Deleting source at $src…"
  rm -rf "$src"
fi

echo "AgentX uninstalled."
