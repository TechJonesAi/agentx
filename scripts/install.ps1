# ─── AgentX Installer for Windows ─────────────────────────────────────────────
#
# Usage: irm https://raw.githubusercontent.com/agentx/agentx/main/scripts/install.ps1 | iex
# Or:    .\scripts\install.ps1
#

$ErrorActionPreference = "Stop"
$AgentXDir = if ($env:AGENTX_DIR) { $env:AGENTX_DIR } else { "$env:USERPROFILE\.agentx" }
$NodeMinVersion = 20

Write-Host ""
Write-Host "================================" -ForegroundColor Blue
Write-Host "   AgentX Installer (Windows)" -ForegroundColor Blue
Write-Host "================================" -ForegroundColor Blue
Write-Host ""

# ─── Check Node.js ──────────────────────────────────────────────────────────────

function Test-Node {
    try {
        $version = (node -v) -replace 'v', ''
        $major = [int]($version.Split('.')[0])
        if ($major -ge $NodeMinVersion) {
            Write-Host "[ok] Node.js v$version found" -ForegroundColor Green
            return $true
        }
        Write-Host "[warn] Node.js v$version found but v$NodeMinVersion+ is required" -ForegroundColor Yellow
    } catch {
        Write-Host "[warn] Node.js not found" -ForegroundColor Yellow
    }
    return $false
}

function Install-Node {
    Write-Host "[info] Installing Node.js..." -ForegroundColor Blue

    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
        Write-Host "[ok] Node.js installed via winget" -ForegroundColor Green
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
        choco install nodejs-lts -y
        Write-Host "[ok] Node.js installed via Chocolatey" -ForegroundColor Green
    } else {
        Write-Host "[error] Cannot install Node.js automatically." -ForegroundColor Red
        Write-Host "  Please install Node.js v$NodeMinVersion+ from: https://nodejs.org/en/download/"
        exit 1
    }

    # Refresh PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
}

if (-not (Test-Node)) {
    Install-Node
}

# ─── Check pnpm ──────────────────────────────────────────────────────────────

function Test-Pnpm {
    try {
        $version = pnpm -v
        Write-Host "[ok] pnpm v$version found" -ForegroundColor Green
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Pnpm)) {
    Write-Host "[info] Installing pnpm..." -ForegroundColor Blue
    npm install -g pnpm
    Write-Host "[ok] pnpm installed" -ForegroundColor Green
}

# ─── Clone or update repo ───────────────────────────────────────────────────────

$RepoDir = "$AgentXDir\repo"

if (Test-Path "$RepoDir\package.json") {
    Write-Host "[info] Updating existing installation..." -ForegroundColor Blue
    Push-Location $RepoDir
    git pull --ff-only 2>$null
    Pop-Location
} else {
    Write-Host "[info] Installing AgentX to $AgentXDir..." -ForegroundColor Blue
    New-Item -ItemType Directory -Force -Path $AgentXDir | Out-Null

    # Check if running from within the repo
    $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
    $ParentDir = Split-Path -Parent $ScriptDir
    if (Test-Path "$ParentDir\package.json") {
        Write-Host "[info] Using local repository..." -ForegroundColor Blue
        New-Item -ItemType Junction -Force -Path $RepoDir -Target $ParentDir | Out-Null
    } else {
        git clone "https://github.com/agentx/agentx.git" $RepoDir
    }
}

# ─── Install and build ──────────────────────────────────────────────────────────

Push-Location $RepoDir
Write-Host "[info] Installing dependencies..." -ForegroundColor Blue
pnpm install
Write-Host "[ok] Dependencies installed" -ForegroundColor Green

Write-Host "[info] Building AgentX..." -ForegroundColor Blue
pnpm build
Write-Host "[ok] Build complete" -ForegroundColor Green
Pop-Location

# ─── Create data directories ────────────────────────────────────────────────────

New-Item -ItemType Directory -Force -Path "$AgentXDir\data" | Out-Null
New-Item -ItemType Directory -Force -Path "$AgentXDir\skills" | Out-Null
New-Item -ItemType Directory -Force -Path "$AgentXDir\logs" | Out-Null

# ─── Done ────────────────────────────────────────────────────────────────────────

Write-Host ""
Write-Host "================================" -ForegroundColor Green
Write-Host "   Installation Complete!" -ForegroundColor Green
Write-Host "================================" -ForegroundColor Green
Write-Host ""
Write-Host "[ok] AgentX installed at: $AgentXDir" -ForegroundColor Green
Write-Host ""
Write-Host "Run the setup wizard:"
Write-Host "  agentx onboard" -ForegroundColor Blue
Write-Host ""
Write-Host "Or start chatting immediately:"
Write-Host "  agentx chat" -ForegroundColor Blue
Write-Host ""
