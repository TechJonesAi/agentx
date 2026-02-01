# AgentX

A powerful, secure, open-source AI agent that runs on your machine. Full control, full privacy.

[![Tests](https://img.shields.io/badge/tests-224%20passing-brightgreen)]()
[![License](https://img.shields.io/badge/license-MIT-blue)]()
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey)]()

## Features

- **Multi-LLM Support** — Claude, GPT-4, Ollama (local models)
- **6 Chat Integrations** — Telegram, Discord, WhatsApp, Slack, Signal, iMessage
- **Persistent Memory** — Remembers everything across sessions with SQLite + JSONL transcripts
- **Browser Automation** — Navigate, click, fill forms, extract data via Playwright
- **Voice** — Text-to-speech, speech-to-text, phone calls via Twilio
- **Self-Extending** — Creates its own skills on demand
- **Background Monitoring** — Watch websites, files, run scheduled commands
- **Google & Obsidian** — Gmail, Calendar, and Obsidian vault integration
- **Web UI** — Browser-based chat interface with SSE streaming
- **Desktop App** — Electron app for macOS, Windows, and Linux
- **Security First** — OS keychain, AES-256-GCM encryption, shell sandboxing, audit logging
- **Resilience** — Retry with backoff, circuit breaker, rate limiting, context management

## Quick Start

### One-Line Install

```bash
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/yourusername/agentx/main/scripts/install.sh | bash

# Windows (PowerShell)
iwr -useb https://raw.githubusercontent.com/yourusername/agentx/main/scripts/install.ps1 | iex
```

### Manual Install

```bash
git clone https://github.com/yourusername/agentx.git
cd agentx
pnpm install
pnpm build
pnpm link --global
agentx onboard
```

## Usage

### Start the Agent

```bash
# Terminal chat
agentx chat

# With Telegram
agentx start --telegram

# With multiple integrations
agentx start --telegram --discord --web

# Full stack
agentx start --telegram --discord --slack --whatsapp --web --heartbeat --google --obsidian
```

### Chat Commands

| Command | Description |
|---------|-------------|
| `/new [model]` | Start fresh session (optionally switch model) |
| `/reset` | Reset current session |
| `/status` | Show session info and context usage |
| `/context` | Show context summary |
| `/context detail` | Show context with per-message token counts |
| `/stop` | Abort current operation |
| `/compact [instructions]` | Summarize old messages to free context |
| `/send on\|off\|inherit` | Control message delivery for this session |

### CLI Commands

```bash
agentx onboard              # Setup wizard
agentx chat                 # Terminal chat
agentx chat -p ollama       # Chat using Ollama (local models)
agentx start [flags]        # Start agent daemon
agentx status               # Show agent status
agentx session list         # List all sessions
agentx session inspect <id> # Inspect session details
agentx skills list          # List installed skills
agentx skills add <path>    # Install a skill
agentx skills remove <name> # Remove a skill
agentx config show          # Show configuration
agentx config set <key> <v> # Set a config value
agentx config path          # Show config file paths
agentx app                  # Launch desktop app
```

### Start Command Flags

| Flag | Description |
|------|-------------|
| `--telegram` | Enable Telegram integration |
| `--discord` | Enable Discord integration |
| `--slack` | Enable Slack integration |
| `--whatsapp` | Enable WhatsApp integration |
| `--signal` | Enable Signal integration |
| `--imessage` | Enable iMessage integration (macOS only) |
| `--web` | Enable Web UI |
| `--google` | Enable Google (Gmail + Calendar) integration |
| `--obsidian` | Enable Obsidian vault integration |
| `--health` | Enable health check HTTP server |
| `--heartbeat` | Enable heartbeat/proactive messaging |
| `--skills-watch` | Enable skill hot-reload file watcher |

## Configuration

Configuration file: `~/.agentx/config.yaml`

```yaml
agent:
  name: AgentX
  defaultProvider: anthropic  # anthropic | openai | ollama
  model: claude-sonnet-4-20250514

providers:
  anthropic:
    model: claude-sonnet-4-20250514
    maxTokens: 4096
  openai:
    model: gpt-4o
    maxTokens: 4096
  ollama:
    model: llama3
    baseUrl: http://localhost:11434

memory:
  maxConversationHistory: 100
  summarizeAfter: 50
  embeddingProvider: local

sessions:
  persistToDisk: true
  ttlMinutes: 1440
  dmScope: main  # main | per-peer | per-channel-peer | per-account-channel-peer
  reset:
    mode: daily
    atHour: 4
    idleMinutes: 120

security:
  shellPermissionLevel: ask-confirm  # unrestricted | ask-confirm | allowlist-only | disabled
  encryptStorage: false
  auditLog: true
  auditRetentionDays: 90
  multiUserMode: false
  requireOwnerApproval: true

# Integrations
telegram:
  botToken: ${TELEGRAM_BOT_TOKEN}

discord:
  botToken: ${DISCORD_BOT_TOKEN}

google:
  clientId: ${GOOGLE_CLIENT_ID}
  clientSecret: ${GOOGLE_CLIENT_SECRET}
  redirectUri: http://localhost:3002/oauth/callback
  scopes:
    - https://www.googleapis.com/auth/gmail.modify
    - https://www.googleapis.com/auth/calendar

obsidian:
  vaultPath: ~/Documents/Obsidian
  dailyNotesFolder: Daily Notes
  dailyNoteFormat: YYYY-MM-DD

voice:
  ttsProvider: elevenlabs
  sttProvider: whisper
  whisperModel: base
  twilio:
    accountSid: ${TWILIO_ACCOUNT_SID}
    authToken: ${TWILIO_AUTH_TOKEN}
    phoneNumber: ${TWILIO_PHONE_NUMBER}
    webhookBaseUrl: https://your-domain.com

web:
  enabled: true
  port: 3001
  host: "0.0.0.0"
  authToken: ${WEB_AUTH_TOKEN}

health:
  enabled: false
  port: 9090
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key |
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `TELEGRAM_BOT_TOKEN` | For Telegram | Bot token from @BotFather |
| `DISCORD_BOT_TOKEN` | For Discord | Bot token from Discord Developer Portal |
| `SLACK_BOT_TOKEN` | For Slack | Bot token from Slack App |
| `SLACK_APP_TOKEN` | For Slack | App-level token for Socket Mode |
| `WHATSAPP_SESSION_PATH` | For WhatsApp | Path to store session data |
| `SIGNAL_ACCOUNT` | For Signal | Phone number for Signal |
| `GOOGLE_CLIENT_ID` | For Google | OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | For Google | OAuth client secret |
| `TWILIO_ACCOUNT_SID` | For calls | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | For calls | Twilio auth token |
| `TWILIO_PHONE_NUMBER` | For calls | Your Twilio phone number |
| `ELEVENLABS_API_KEY` | For TTS | ElevenLabs API key |
| `WEB_AUTH_TOKEN` | For Web UI | Bearer token for API auth |

*At least one LLM provider required.

## Security

### Credential Storage

API keys stored in OS keychain (macOS Keychain, Windows Credential Manager, libsecret). Falls back to AES-256-GCM encrypted file when keychain is unavailable.

### Shell Sandboxing

Four permission levels:
- **disabled** — No shell access
- **allowlist-only** — Only whitelisted commands (ls, git, node, python, etc.)
- **ask-confirm** — User approval required (default)
- **unrestricted** — All commands except blocked patterns

Dangerous patterns are always blocked: `rm -rf /`, fork bombs, `sudo`, pipe to shell, `eval`. API keys are scrubbed from the subprocess environment.

### Skill Permissions

Skills declare required permissions in `manifest.json`. Users must approve before a skill can load:

| Permission | Description |
|-----------|-------------|
| `network` | Make HTTP requests |
| `filesystem.read` / `filesystem.write` | File access |
| `shell` | Execute commands |
| `browser` | Control browser |
| `memory.read` / `memory.write` | Long-term memory |
| `credentials` | Access stored credentials |
| `scheduler` | Create scheduled tasks |
| `integrations` | Send messages via integrations |

### Audit Logging

All agent actions logged to SQLite: messages, tool calls, tool results, auth events. Configurable retention (default 90 days).

### Multi-User Access Control

- **Single-user mode** (default): Only the owner can interact
- **Multi-user mode**: New users require owner approval (pending/active/denied/banned status)
- **Per-user memory isolation**: Each user's memories stored in separate namespace

## Resilience

### Retry with Backoff

All LLM API calls are wrapped with exponential backoff retry (3 retries, 1s base delay, up to 30s). Retries on: connection errors, timeouts, 429/5xx status codes, overloaded responses.

### Circuit Breaker

If the LLM provider fails 5 times consecutively, the circuit opens for 60 seconds. Prevents cascading failures. Automatically recovers via half-open probe.

### Rate Limiting

Token bucket rate limiter with per-provider defaults:
- **Anthropic**: 50 requests/min, 80k tokens/min
- **OpenAI**: 60 requests/min, 150k tokens/min
- **Ollama**: 1000 requests/min (local, effectively unlimited)

### Context Window Management

Automatic context truncation to fit provider token limits (200k for Anthropic, 128k for OpenAI, 8k for Ollama). At 80% capacity, older messages are summarized by the LLM and replaced with a compact summary. Recent messages (20) are always preserved.

## Integration Setup

### Telegram

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Create new bot with `/newbot`
3. Copy token to `TELEGRAM_BOT_TOKEN`
4. Start with `agentx start --telegram`

### Discord

1. Go to [Discord Developer Portal](https://discord.com/developers)
2. Create application, add bot, copy token
3. Enable Message Content Intent
4. Invite bot with `applications.commands` and `bot` scopes
5. Start with `agentx start --discord`

### WhatsApp

1. Run `agentx start --whatsapp`
2. Scan QR code with WhatsApp mobile app

### Slack

1. Create a Slack app at [api.slack.com](https://api.slack.com/apps)
2. Enable Event Subscriptions (`message.im`, `app_mention`)
3. Set `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, and optionally `SLACK_APP_TOKEN` for Socket Mode
4. Start with `agentx start --slack`

### Signal

1. Install [signal-cli](https://github.com/AsamK/signal-cli) and register your account
2. Set `SIGNAL_ACCOUNT` to your phone number
3. Start with `agentx start --signal`

### iMessage (macOS only)

1. Grant Full Disk Access to Terminal in System Settings > Privacy & Security
2. Start with `agentx start --imessage`

### Google (Gmail & Calendar)

1. Create project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable Gmail and Calendar APIs
3. Create OAuth 2.0 credentials (Desktop app type)
4. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
5. Run `agentx start --google` and complete OAuth flow in browser

### Obsidian

1. Set `obsidian.vaultPath` in config to your vault location
2. Run `agentx start --obsidian`

### Web UI

1. Set `web.authToken` in config (optional, for authentication)
2. Run `agentx start --web`
3. Open `http://localhost:3001` in your browser

### Voice / Phone Calls (Twilio)

1. Create account at [twilio.com](https://www.twilio.com)
2. Get a phone number and set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`
3. Set `voice.twilio.webhookBaseUrl` to your public URL
4. Twilio tools are auto-registered when config is present

## Architecture

```
packages/
├── core/           # LLM orchestration, memory, tools, sessions, security, resilience
├── cli/            # Command-line interface
├── integrations/
│   ├── telegram/   # Telegraf-based Telegram bot
│   ├── discord/    # discord.js bot
│   ├── whatsapp/   # whatsapp-web.js bot
│   ├── slack/      # @slack/bolt bot
│   ├── signal/     # signal-cli wrapper
│   ├── imessage/   # macOS AppleScript + SQLite polling
│   ├── google/     # Gmail + Calendar via Google APIs
│   └── obsidian/   # Obsidian vault file operations
├── browser/        # Playwright browser automation
├── skills/         # Plugin system + built-in skills (monitors, web-search)
├── voice/          # TTS (ElevenLabs), STT (Whisper), phone calls (Twilio)
├── web/            # Web UI with SSE streaming
└── app/            # Electron desktop app
```

## Creating Skills

Skills are self-contained modules installed to `~/.agentx/skills/`:

```
my-skill/
├── manifest.json
└── index.js
```

### manifest.json

```json
{
  "name": "my-skill",
  "version": "1.0.0",
  "description": "What this skill does",
  "triggers": ["keyword1", "keyword2"],
  "permissions": ["network"]
}
```

### index.js

```javascript
exports.tools = [
  {
    definition: {
      name: "my_tool",
      description: "What this tool does",
      parameters: {
        type: "object",
        properties: {
          input: { type: "string", description: "Input parameter" }
        },
        required: ["input"]
      }
    },
    async execute(args, context) {
      return `Result for: ${args.input}`;
    }
  }
];

// Optional lifecycle hooks
exports.onLoad = async () => { /* called when skill loads */ };
exports.onUnload = async () => { /* called when skill unloads */ };
```

Install: `agentx skills add ./my-skill`

Enable hot-reload with `--skills-watch` flag to automatically reload skills when files change.

## Background Monitors

Three built-in monitor skills:

- **monitor_website** — Check URLs for availability, content changes, or string matching
- **monitor_file** — Watch files/directories for changes, additions, deletions
- **monitor_command** — Run shell commands periodically and alert on output

Alerts are routed through the HeartbeatManager to notify you on any connected integration.

## Health Monitoring

Enable with `--health` flag or `health.enabled: true` in config.

- `GET /health` — Status (healthy/degraded/unhealthy), uptime, version
- `GET /stats` — Active sessions, messages processed, memory usage, provider status

Optional Bearer token authentication via `HEALTH_AUTH_TOKEN`.

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run tests
pnpm test

# Unit tests only
pnpm test:unit

# Integration tests only
pnpm test:integration

# Tests with coverage
pnpm test:coverage

# Watch mode
pnpm test:watch

# Type check
pnpm typecheck

# Watch mode for all packages
pnpm dev
```

## Packages

| Package | Description |
|---------|-------------|
| `@agentx/core` | LLM orchestration, memory, tools, sessions, security, resilience |
| `@agentx/cli` | Command-line interface |
| `@agentx/telegram` | Telegram bot (Telegraf) |
| `@agentx/discord` | Discord bot (discord.js) |
| `@agentx/whatsapp` | WhatsApp bot (whatsapp-web.js) |
| `@agentx/slack` | Slack bot (@slack/bolt) |
| `@agentx/signal` | Signal bot (signal-cli) |
| `@agentx/imessage` | iMessage bot (AppleScript + SQLite) |
| `@agentx/google` | Google Gmail + Calendar integration |
| `@agentx/obsidian` | Obsidian vault integration |
| `@agentx/browser` | Playwright browser automation |
| `@agentx/skills` | Plugin system with hot-reload + built-in skills |
| `@agentx/voice` | TTS, STT, phone calls (Twilio) |
| `@agentx/web` | Web UI with SSE streaming |
| `@agentx/app` | Electron desktop app |

## Troubleshooting

### Build fails

```bash
pnpm -r clean && pnpm build
```

### "Cannot find module @agentx/core"

Build the core package first: `pnpm --filter @agentx/core build`

### Integration not connecting

- Verify tokens/credentials are set correctly
- Check network connectivity
- For WhatsApp: re-scan QR code
- Check logs: `LOG_LEVEL=debug agentx start --telegram`

### Rate limiting / "Circuit breaker is open"

The agent automatically queues requests when rate limits are hit. If the LLM provider is persistently failing, the circuit breaker opens for 60 seconds. Check provider status and API key validity.

### High memory usage

- Enable session pruning in config
- Reduce context window size
- Run `/compact` to summarize old messages

## License

MIT

## Credits

Inspired by [OpenClaw](https://openclaw.ai) by Peter Steinberger.
