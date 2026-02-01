# Changelog

All notable changes to AgentX will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2025-02-01

### Added

#### Core
- Multi-LLM orchestration engine (Anthropic Claude, OpenAI GPT-4, Ollama local models)
- Persistent memory system with SQLite storage and JSONL transcripts
- Session management with 4 DM scope modes (main, per-peer, per-channel-peer, per-account-channel-peer)
- Cross-platform identity resolution and linking
- Session reset policies (daily, idle, combined triggers)
- Context window management with automatic summarization at 80% capacity
- In-chat slash commands (/new, /reset, /status, /context, /stop, /compact, /send)
- SSE streaming support across the full stack (providers, agent, API, Web UI)

#### Security
- OS keychain credential storage (macOS Keychain, Windows Credential Manager, libsecret)
- AES-256-GCM encryption with PBKDF2 key derivation for file-based fallback
- Shell sandboxing with 4 permission levels (disabled, allowlist-only, ask-confirm, unrestricted)
- Dangerous command pattern blocking (rm -rf /, fork bombs, sudo, pipe to shell, eval)
- Skill permission system with manifest-declared permissions
- Audit logging to SQLite with configurable retention
- Multi-user access control with owner approval flow

#### Resilience
- Retry with exponential backoff (3 retries, 1s base, 30s max)
- Circuit breaker (5 failures to open, 60s cooldown, half-open probe)
- Token bucket rate limiter with per-provider defaults
- Request queueing when rate limits are hit

#### Integrations
- Telegram bot via Telegraf
- Discord bot via discord.js
- WhatsApp bot via whatsapp-web.js
- Slack bot via @slack/bolt with Socket Mode support
- Signal bot via signal-cli
- iMessage bot via AppleScript + SQLite polling (macOS only)
- Google Gmail + Calendar via OAuth 2.0
- Obsidian vault integration (daily notes, search, create/append)

#### Tools & Skills
- Browser automation via Playwright (navigate, click, fill, screenshot, extract)
- Self-extending skill system with hot-reload
- Built-in monitor skills (website, file, command) with heartbeat alerts
- Web search skill
- Plugin manifest with permission declarations

#### Voice
- Text-to-speech via ElevenLabs
- Speech-to-text via Whisper
- Phone calls via Twilio (inbound/outbound with TwiML)

#### Interfaces
- CLI with terminal chat and daemon mode
- Web UI with SSE streaming and markdown rendering
- Electron desktop app for macOS, Windows, and Linux

#### DevOps
- pnpm monorepo with 15 workspace packages
- 224 tests (175 unit, 23 integration, 27 e2e) via Vitest
- GitHub Actions CI/CD pipeline (Ubuntu, macOS, Windows; Node 18, 20, 22)
- Cross-platform install scripts (bash + PowerShell)
- Health check HTTP server with /health and /stats endpoints

### Infrastructure
- TypeScript 5.7 with ES2022 target
- Modular package architecture (@agentx/core, @agentx/cli, @agentx/browser, etc.)
- Shared type system across all packages
