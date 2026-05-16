/**
 * RuntimeSettingsStore — persisted, runtime-applied dashboard control truth.
 *
 * Single source of truth for every dashboard toggle that should change live
 * AgentX behaviour. Persists to ~/.agentx/runtime-settings.json. Read
 * synchronously by Agent decision points (chatStream, executeToolCall) so a
 * toggle change takes effect on the very next call — no restart required for
 * the toggles in `LIVE_TOGGLES`.
 *
 * Restart-required settings (model pins of certain providers, OAuth state)
 * are still persisted here but the Agent does not consult them mid-call.
 * The route layer flags them with `restartRequired: true` in the response.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface RuntimeSettings {
  // ── Live toggles (apply on next chat call, no restart) ────────────────
  localOnly: boolean;
  retrievalEnabled: boolean;
  toolCallingEnabled: boolean;

  // ── Gated features (require restart to take effect) ───────────────────
  builderV2Enabled: boolean;
  agentLoopsEnabled: boolean;

  // ── Repair policy (live, consulted by HealthMonitor) ──────────────────
  repairPolicy: 'auto-safe' | 'always-ask' | 'never';

  // ── Model routing pins (live for the next chat call) ──────────────────
  modelPins: Partial<Record<'chat' | 'code' | 'builder' | 'reasoning' | 'vision' | 'summarisation' | 'tool-calling', string>>;
  preferredModels: string[];
  disabledModels: string[];

  // ── Provider hints (live; consulted by future TTS/Vision selection) ──
  ttsProvider: string | null;
  visionProvider: string | null;

  // ── Auto-routing mode (live; consulted by tool-demotion logic) ────────
  autoRoutingMode: 'static' | 'reliability-aware';
}

/** Settings the Agent consults at runtime — toggling them must NOT require restart. */
export const LIVE_TOGGLES: ReadonlyArray<keyof RuntimeSettings> = [
  'localOnly',
  'retrievalEnabled',
  'toolCallingEnabled',
  'repairPolicy',
  'modelPins',
  'preferredModels',
  'disabledModels',
  'ttsProvider',
  'visionProvider',
  'autoRoutingMode',
];

/** Settings the dashboard surfaces as restart-required when changed. */
export const RESTART_REQUIRED: ReadonlyArray<keyof RuntimeSettings> = [
  'builderV2Enabled',
  'agentLoopsEnabled',
];

export const DEFAULT_SETTINGS: RuntimeSettings = {
  localOnly: false,
  retrievalEnabled: true,
  toolCallingEnabled: true,
  builderV2Enabled: false,
  agentLoopsEnabled: false,
  repairPolicy: 'auto-safe',
  modelPins: {},
  preferredModels: [],
  disabledModels: [],
  ttsProvider: null,
  visionProvider: null,
  autoRoutingMode: 'reliability-aware',
};

function defaultConfigPath(): string {
  return path.join(os.homedir(), '.agentx', 'runtime-settings.json');
}

export class RuntimeSettingsStore {
  private static instance: RuntimeSettingsStore | null = null;
  private settings: RuntimeSettings;
  private filePath: string;
  private listeners: Set<(s: RuntimeSettings) => void> = new Set();

  static getInstance(filePath?: string): RuntimeSettingsStore {
    if (!this.instance) this.instance = new RuntimeSettingsStore(filePath ?? defaultConfigPath());
    return this.instance;
  }

  /** Test-only factory bound to an explicit file path. Bypasses the singleton. */
  static __createForTest(filePath: string): RuntimeSettingsStore {
    return new RuntimeSettingsStore(filePath);
  }

  private constructor(filePath: string) {
    this.filePath = filePath;
    this.settings = { ...DEFAULT_SETTINGS };
    this.load();
  }

  /** Read the entire settings snapshot. Always returns a fresh shallow copy
   *  to keep callers from mutating internal state. */
  get(): RuntimeSettings {
    return { ...this.settings, modelPins: { ...this.settings.modelPins } };
  }

  /** Read one setting. */
  getKey<K extends keyof RuntimeSettings>(key: K): RuntimeSettings[K] {
    return this.settings[key];
  }

  /** Update a subset of settings, persist to disk, notify listeners.
   *  Returns the resulting settings snapshot. modelPins are merged
   *  shallowly (existing pins for other task types are preserved). */
  update(patch: Partial<RuntimeSettings>): RuntimeSettings {
    // Preserve modelPins across the spread so partial pin updates don't
    // wipe other task types.
    const mergedPins = patch.modelPins
      ? { ...this.settings.modelPins, ...patch.modelPins }
      : this.settings.modelPins;
    this.settings = { ...this.settings, ...patch, modelPins: mergedPins };
    this.save();
    for (const l of this.listeners) {
      try { l(this.get()); } catch { /* never break the caller */ }
    }
    return this.get();
  }

  /** Reset all settings to defaults. */
  reset(): RuntimeSettings {
    this.settings = { ...DEFAULT_SETTINGS };
    this.save();
    return this.get();
  }

  /** Subscribe to settings changes. Returns an unsubscribe function. */
  onChange(listener: (s: RuntimeSettings) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Report which keys in a patch require a restart to take effect. */
  static restartRequiredFor(patch: Partial<RuntimeSettings>): Array<keyof RuntimeSettings> {
    return RESTART_REQUIRED.filter((k) => k in patch) as Array<keyof RuntimeSettings>;
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<RuntimeSettings>;
      this.settings = { ...DEFAULT_SETTINGS, ...parsed };
      if (parsed.modelPins) {
        this.settings.modelPins = { ...parsed.modelPins };
      }
    } catch {
      // First run, file missing, or corrupted — fall back to defaults.
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2), 'utf-8');
    } catch {
      // Persistence is best-effort; if disk is full or read-only, the
      // in-memory copy still applies for the current session.
    }
  }
}
