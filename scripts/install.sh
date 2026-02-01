#!/bin/bash
set -e

# ─── AgentX Installer ──────────────────────────────────────────────────────────
#
# Usage: curl -fsSL https://raw.githubusercontent.com/agentx/agentx/main/scripts/install.sh | bash
# Or:    ./scripts/install.sh
#

AGENTX_DIR="${AGENTX_DIR:-$HOME/.agentx}"
NODE_MIN_VERSION="20"
REPO_URL="https://github.com/agentx/agentx.git"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[info]${NC} $1"; }
log_success() { echo -e "${GREEN}[ok]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[warn]${NC} $1"; }
log_error() { echo -e "${RED}[error]${NC} $1"; }

echo ""
echo -e "${BLUE}================================${NC}"
echo -e "${BLUE}   AgentX Installer${NC}"
echo -e "${BLUE}================================${NC}"
echo ""

# ─── Check Node.js ──────────────────────────────────────────────────────────────

check_node() {
  if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$NODE_VERSION" -ge "$NODE_MIN_VERSION" ]; then
      log_success "Node.js v$(node -v | sed 's/v//') found"
      return 0
    else
      log_warn "Node.js $(node -v) found but v${NODE_MIN_VERSION}+ is required"
    fi
  else
    log_warn "Node.js not found"
  fi
  return 1
}

install_node() {
  log_info "Installing Node.js v${NODE_MIN_VERSION}+..."

  if command -v brew &> /dev/null; then
    brew install node@22
    log_success "Node.js installed via Homebrew"
  elif command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
    log_success "Node.js installed via apt"
  elif command -v dnf &> /dev/null; then
    sudo dnf install -y nodejs
    log_success "Node.js installed via dnf"
  else
    log_error "Cannot install Node.js automatically. Please install Node.js v${NODE_MIN_VERSION}+ manually."
    echo "  Visit: https://nodejs.org/en/download/"
    exit 1
  fi
}

if ! check_node; then
  install_node
fi

# ─── Check pnpm ──────────────────────────────────────────────────────────────

check_pnpm() {
  if command -v pnpm &> /dev/null; then
    log_success "pnpm $(pnpm -v) found"
    return 0
  fi
  return 1
}

install_pnpm() {
  log_info "Installing pnpm..."
  npm install -g pnpm
  log_success "pnpm installed"
}

if ! check_pnpm; then
  install_pnpm
fi

# ─── Clone or update repo ───────────────────────────────────────────────────────

if [ -d "$AGENTX_DIR/repo" ]; then
  log_info "Updating existing installation..."
  cd "$AGENTX_DIR/repo"
  git pull --ff-only 2>/dev/null || log_warn "Could not update (local changes?)"
else
  log_info "Installing AgentX to $AGENTX_DIR..."
  mkdir -p "$AGENTX_DIR"

  # If running from within the repo, use the local copy
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [ -f "$SCRIPT_DIR/../package.json" ]; then
    log_info "Using local repository..."
    ln -sf "$(dirname "$SCRIPT_DIR")" "$AGENTX_DIR/repo"
  else
    git clone "$REPO_URL" "$AGENTX_DIR/repo"
  fi
fi

# ─── Install dependencies ───────────────────────────────────────────────────────

cd "$AGENTX_DIR/repo"
log_info "Installing dependencies..."
pnpm install --frozen-lockfile 2>/dev/null || pnpm install
log_success "Dependencies installed"

# ─── Build ───────────────────────────────────────────────────────────────────────

log_info "Building AgentX..."
pnpm build
log_success "Build complete"

# ─── Link CLI ────────────────────────────────────────────────────────────────────

log_info "Linking CLI..."
cd "$AGENTX_DIR/repo/packages/cli"
pnpm link --global 2>/dev/null || npm link 2>/dev/null || log_warn "Could not link CLI globally"
cd "$AGENTX_DIR/repo"

# ─── Create data directory ───────────────────────────────────────────────────────

mkdir -p "$AGENTX_DIR/data"
mkdir -p "$AGENTX_DIR/skills"
mkdir -p "$AGENTX_DIR/logs"

# ─── Run onboarding ─────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}   Installation Complete!${NC}"
echo -e "${GREEN}================================${NC}"
echo ""
log_success "AgentX installed at: $AGENTX_DIR"
echo ""

if command -v agentx &> /dev/null; then
  echo "Run the setup wizard:"
  echo -e "  ${BLUE}agentx onboard${NC}"
  echo ""
  echo "Or start chatting immediately:"
  echo -e "  ${BLUE}agentx chat${NC}"
else
  echo "Run the setup wizard:"
  echo -e "  ${BLUE}npx agentx onboard${NC}"
  echo ""
  echo "Or start chatting immediately:"
  echo -e "  ${BLUE}npx agentx chat${NC}"
fi

echo ""
