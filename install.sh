#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# AgentX client installer — macOS (Apple Silicon)
#
#   curl -fsSL https://<your-host>/install.sh | bash
#   — or, from a release tarball / git checkout —
#   bash install.sh
#
# What it does (idempotent — safe to re-run):
#   1. Verifies macOS + Apple Silicon
#   2. Installs Homebrew if missing (asks first when interactive)
#   3. Installs node, pnpm, ollama, python via brew if missing
#   4. Places the AgentX source at ~/AgentX (git clone or copies this repo)
#   5. pnpm install + builds core/web/builder
#   6. Records the install path, installs AgentX.app → /Applications
#   7. First launch: agentx-start.sh pulls minimum models + starts services
#
# License: set AGENTX_LICENSE_PUBLIC_KEY + AGENTX_LICENSE_REQUIRED=true in
# ~/.agentx/env.client for paid installs (see docs/CLIENT-INSTALL.md).
# ═══════════════════════════════════════════════════════════════════════════

set -euo pipefail

INSTALL_DIR="${AGENTX_INSTALL_DIR:-$HOME/AgentX}"
REPO_URL="${AGENTX_REPO_URL:-}"   # optional: git source for curl|bash installs
step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ── 1. Platform checks ─────────────────────────────────────────────────────
step "Checking platform"
[[ "$(uname -s)" == "Darwin" ]] || die "AgentX installer supports macOS only"
[[ "$(uname -m)" == "arm64" ]] || die "Apple Silicon (arm64) required — local models need it"
ok "macOS $(sw_vers -productVersion) on Apple Silicon"

# ── 2. Homebrew ─────────────────────────────────────────────────────────────
step "Checking Homebrew"
if ! command -v brew >/dev/null 2>&1 && [[ ! -x /opt/homebrew/bin/brew ]]; then
  echo "Homebrew is required. Installing (you may be asked for your password)…"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
eval "$(/opt/homebrew/bin/brew shellenv)" 2>/dev/null || true
ok "Homebrew ready"

# ── 3. Dependencies ─────────────────────────────────────────────────────────
step "Installing dependencies (node, pnpm, ollama, python)"
for pkg in node pnpm ollama python@3.12; do
  if ! brew list "$pkg" >/dev/null 2>&1; then
    brew install "$pkg" || die "brew install $pkg failed"
  fi
done
ok "Dependencies installed"

# ── 4. Source ───────────────────────────────────────────────────────────────
step "Placing AgentX at $INSTALL_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
if [[ -d "$INSTALL_DIR/packages/launcher" ]]; then
  ok "Existing install found — updating in place"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" pull --ff-only || echo "  (git pull skipped — local changes)"
  fi
elif [[ -n "$SCRIPT_DIR" && -d "$SCRIPT_DIR/packages/launcher" ]]; then
  # Running from inside a checkout/tarball — copy it into place.
  if [[ "$SCRIPT_DIR" != "$INSTALL_DIR" ]]; then
    mkdir -p "$INSTALL_DIR"
    rsync -a --exclude node_modules --exclude .git "$SCRIPT_DIR/" "$INSTALL_DIR/"
  fi
elif [[ -n "$REPO_URL" ]]; then
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
else
  die "No AgentX source found. Run install.sh from the release folder, or set AGENTX_REPO_URL."
fi
ok "Source in place"

# ── 5. Build ────────────────────────────────────────────────────────────────
step "Installing packages and building (few minutes on first run)"
cd "$INSTALL_DIR"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
pnpm -C packages/core build
pnpm -C packages/builder-v2 build 2>/dev/null || true
pnpm -C packages/web build
ok "Build complete"

# ── 6. Register install + app bundle ───────────────────────────────────────
step "Installing AgentX.app"
mkdir -p "$HOME/.agentx"
echo "$INSTALL_DIR" > "$HOME/.agentx/install-path"
APP_SRC="$INSTALL_DIR/packages/launcher/AgentX.app"
APP_DST="/Applications/AgentX.app"
if [[ -d "$APP_SRC" ]]; then
  rm -rf "$APP_DST" 2>/dev/null || sudo rm -rf "$APP_DST"
  cp -R "$APP_SRC" "$APP_DST" 2>/dev/null || sudo cp -R "$APP_SRC" "$APP_DST"
  chmod +x "$APP_DST/Contents/MacOS/AgentX"
  ok "AgentX.app installed to /Applications"
else
  echo "  (app bundle missing in source — launch via packages/launcher/agentx-start.sh)"
fi

# ── 7. Done ─────────────────────────────────────────────────────────────────
step "Install complete"
cat <<'EOM'

  Launch AgentX from /Applications (or Spotlight: "AgentX").
  First launch downloads the minimum AI models (~5GB) and starts
  all services with self-healing. The dashboard opens automatically
  at http://127.0.0.1:3001

  Uninstall: bash ~/AgentX/uninstall.sh
EOM
