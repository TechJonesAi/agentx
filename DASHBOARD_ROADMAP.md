# AgentX Dashboard Truth + Control Roadmap

Goal: every dashboard tab, section, control, panel, metric, model selector,
workflow, self-healing, and self-learning surface working end-to-end. No
fake, no decorative-only, no permanently-stubbed.

This document is the single source of truth for what is real, what is
honestly disabled, and what is sequenced for which batch.

---

## Status legend
- ✅ WORKING — UI + backend + persistence + truthful + (target) test coverage
- 🟡 PARTIAL — works in part; some controls fake or some metric uncovered
- 🟥 BROKEN — UI shows feature but backend doesn't run real work
- ⬛ STUBBED — placeholder returned; no real implementation
- 🚫 UNWIRED — UI exists but no backend route at all
- 🟦 DEGRADED — depends on a service that's not available (e.g. tesseract)
- 🆕 NEW IMPL — needs to be built from scratch

## Section-by-section inventory + status

### CORE
| Section | Status | Notes |
|---|---|---|
| Dashboard | ✅ | Real chat sessions count, real project count, new Active LLM Routing + Self-Healing + Self-Learning panels |
| Chat | ✅ | Streaming + tool-calling verified; tool outcomes now feed Self-Learning. **TODO Batch 2:** surface model used in response header |

### CAPABILITIES
| Section | Status | Notes |
|---|---|---|
| Vision | 🟦 | tesseract.js not installed; no local vision model. **Batch 3:** install tesseract + local vision model wiring |
| Voice | ✅ | TTS via Qwen3 produces audio. **Batch 3:** edge-tts replacement, provider selector |

### WORKFLOWS
| Section | Status | Notes |
|---|---|---|
| Projects → Tasks | ✅ | Backed by automation_runs. Dashboard badge fetches real count |
| Projects → Agent Loops | 🟡 | Engine works behind `AGENTX_ENABLE_AGENT_LOOPS=true`. **Batch 2:** UI toggle in Settings |
| Projects → Statistics | ✅ | Aggregates automation_runs |

### INTELLIGENCE
| Section | Status | Notes |
|---|---|---|
| Memory | ✅ | 261 docs; Browse/Upload/Query/Statistics all real. memory_store/search tools now wired |
| Cognitive | 🟡 | Engine gated by `AGENT_COGNITIVE_ENABLED=true`. Badges show actionable hint. **Batch 3:** enable + agent orchestration trace |
| Agent Loops (sidebar) | 🟡 | Same gate as Projects → Agent Loops |
| Validation | 🟡 | NEW: `/api/validation/run` runs a real 14-probe smoke. **Batch 3:** SCENARIOS list + RUN SUITE backend, regression tracking |

### MONITORING
| Section | Status | Notes |
|---|---|---|
| Integrity → Overview | ✅ | Real diagnostics probe across 14 subsystems |
| Integrity → Diagnostics | ✅ | `POST /api/integrity/run-diagnostics` |
| Integrity → Repairs | 🟡 | Honest "no journal" disabled state. **Batch 2:** wire HealthMonitor repair journal into this tab |
| Integrity → History | 🚫 | **Batch 2:** wire HealthMonitor.checks into here |
| Integrity → Services | 🚫 | **Batch 2:** wire HealthMonitor.subsystems list here |
| Logs → LLM Interactions | ✅ | API + UI now match shape; 200+ entries visible |
| Logs → System Logs | ✅ | pino hook feeds SystemLogBuffer in real time |

### CONFIGURATION
| Section | Status | Notes |
|---|---|---|
| Models → Routing Mode | ✅ | Local/Combination/Subscription selectable |
| Models → Subscription Accounts | 🟡 | Claude OAuth connect UI exists. **Batch 2:** wire actual OAuth flow |
| Models → Intelligent Task Routing | 🟡 | Per-task model pins UI. **Batch 2:** persist pins to config and route based on them |
| Tools | ✅ | All 5 builtin tools tagged `type:'built-in'`; counter classifies correctly |

### SYSTEM
| Section | Status | Notes |
|---|---|---|
| Settings → Agent Configuration | ✅ | Name + default model + provider |
| Settings → Features | 🟡 | BuilderV2 toggle present. **Batch 2:** wire each toggle to a real env-var override + persist |
| Settings → localOnly | 🚫 | **Batch 2:** add toggle, persist, apply at runtime |
| Settings → retrieval enabled | 🚫 | **Batch 2:** add toggle |
| Settings → tool-calling enabled | 🚫 | **Batch 2:** add toggle |
| Settings → Repair approval policy | 🚫 | **Batch 2:** add toggle (auto-approve safe / always-ask / never) |
| Settings → Learning reset/export | ✅ | Self-Learning panel has both buttons wired |

### NEW DASHBOARD PANELS (added this batch)
| Panel | Status | Backed by |
|---|---|---|
| Active LLM Routing | ✅ | `/api/models/active` + `/api/models/routing/history` |
| Self-Healing | ✅ | `/api/health/status` + `/api/health/run` |
| Self-Learning | ✅ | `/api/learning/tool-outcomes` (GET + DELETE for clear, JSON export client-side) |

---

## Self-Healing — coverage matrix

| Subsystem | Probe | Auto-repair | Status |
|---|---|---|---|
| LLM Provider (ollama) | ✅ ping `/api/tags` | re-ping with extended timeout, else needs-approval | ✅ |
| Long-term Memory DB | ✅ listAll(1) | — | ✅ |
| Tool Registry | ✅ required tools present | — | ✅ |
| Conversation Memory | ✅ getMessages noop | — | ✅ |
| Workspace (AGENTX_APPS) | ✅ stat + write-probe | mkdir -p | ✅ |
| Vision/OCR | 🚫 | 🚫 | Batch 3 |
| MCP tool runtime | 🚫 | 🚫 | Batch 3 |
| TTS sidecar | 🚫 | 🚫 | Batch 3 |
| Builder run pipeline | 🚫 | 🚫 | Batch 3 |
| Document ingestion | 🚫 | 🚫 | Batch 3 |
| Service worker / cache | 🚫 | 🚫 | Batch 3 |
| DB schema integrity | 🚫 | 🚫 | Batch 3 |

---

## Self-Learning — coverage matrix

| Signal | Recorded | Influences routing | Status |
|---|---|---|---|
| Tool call success/failure | ✅ ToolOutcomeStore | 🚫 (Batch 2) | ✅ recording |
| Tool call latency | ✅ | 🚫 | ✅ recording |
| Model routing decision | ✅ ModelRoutingHistory | 🚫 (Batch 2) | ✅ recording |
| Model routing latency | ✅ | 🚫 | ✅ recording |
| Retrieval success/failure | 🚫 | 🚫 | Batch 2 |
| Answer grounding quality | 🚫 | 🚫 | Batch 3 |
| Builder run success/failure | 🚫 | 🚫 | Batch 3 |
| User feedback (👍/👎) | 🟡 endpoint exists | 🚫 | Batch 2 |
| Document utility (repeat retrievals) | 🚫 | 🚫 | Batch 3 |
| Repair outcome | ✅ HealthMonitor | 🚫 | Batch 2 |

---

## Batch sequence

### Batch 1 — Truth restoration + self-healing/learning foundations (THIS COMMIT)
Done. See commit message.

### Batch 2 — User controls + persistence + routing influence
- Settings: localOnly toggle, retrieval toggle, tool-calling toggle, Builder
  V2 toggle, Agent Loops enable toggle, Repair approval policy. All persist
  to a JSON config and apply at runtime.
- Models page: per-task pin selectors persist + influence chat routing.
- Integrity → Repairs / History / Services tabs read from HealthMonitor.
- Retrieval success/failure recording (extend ModelRoutingHistory or new
  RetrievalOutcomeStore).
- User feedback influence: thumbs up/down weighted into reliability scoring.
- Routing influence: when ToolOutcomeStore shows <50% success on a tool
  pattern, emit a "tool routing demoted" decision trace event.
- Tests: unit for each store + integration for each new route.

### Batch 3 — Deep runtime features
- Builder repair/retry pipeline + per-build outcome recording.
- Validation SCENARIOS list + RUN SUITE backend (real regression harness).
- MCP runtime spawn + per-tool reliability tracking.
- Local TTS replacement for edge-tts.
- Vision: install tesseract.js + wire local vision model.
- OCR / image retrieval hardening.
- Long-session memory integrity probe.
- UI decision trace panel.
- DB schema integrity self-repair (safe migrations only).
- Service-worker stale-cache detection + reload prompt.

### Batch 4 — E2E test coverage + CI gate + tag release
- Playwright dashboard truth test: every visible button either calls a
  real route or is disabled with reason.
- Vitest snapshot of all panels under empty state and populated state.
- localOnly regression: navigate, verify no cloud requests fired.
- private-memory-first regression: chat with localOnly, verify
  retrieval > tool fallback.
- Tag `v0.11.0-dashboard-truth` only after green CI on all platforms.

---

## Acceptance criteria reminder
A surface is only ✅ when:
1. UI control exists
2. User can interact
3. Calls a real route
4. Backend performs real work
5. Result persists or reflects in runtime state
6. UI updates with the real result
7. Errors shown truthfully
8. Test coverage exists
9. Works under localOnly when applicable
