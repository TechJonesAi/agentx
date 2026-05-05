import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * DeviceControlService — Unified interface for all computer control actions.
 *
 * Wraps the existing computer tools, enforcing:
 * - ComputerPermissionService (default-DENY)
 * - AuditLogger (full traceability)
 * - AutonomyGate (SUGGEST_ONLY enforcement)
 *
 * Does NOT bypass existing implementations — delegates to registered tools.
 */

import { createLogger } from '../logger.js';

const log = createLogger('services:device-control');

export type AccessLevel = 'observe' | 'assist' | 'supervised' | 'trusted_app' | 'full';

export interface AppPermission {
  appName: string;
  allowed: boolean;
  actions: ('launch' | 'focus' | 'quit' | 'type' | 'click')[];
}

export interface DeviceControlConfig {
  accessLevel: AccessLevel;
  allowMouse: boolean;
  allowKeyboard: boolean;
  allowScreenshots: boolean;
  allowMessagingApps: boolean;
  allowFinancialActions: boolean;
  appPermissions: AppPermission[];
}

const DEFAULT_CONFIG: DeviceControlConfig = {
  accessLevel: 'observe',
  allowMouse: false,
  allowKeyboard: false,
  allowScreenshots: false,
  allowMessagingApps: false,
  allowFinancialActions: false,
  appPermissions: [],
};

export class DeviceControlService {
  private config: DeviceControlConfig;
  private permissionService: any; // ComputerPermissionService
  private auditLogger: any;      // AuditLogger
  private toolRegistry: any;     // ToolRegistry
  private autonomyGate: any;     // AutonomyGate
  /**
   * Absolute path to the JSON file on disk where we persist device-control
   * state. `null` means persistence is disabled (in-memory only — used by
   * tests). Populated from the `persistencePath` constructor option.
   */
  private persistencePath: string | null = null;

  constructor(
    permissionService: any,
    auditLogger: any,
    toolRegistry: any,
    autonomyGate?: any,
    options?: { persistencePath?: string | null },
  ) {
    // IMPORTANT: deep-clone DEFAULT_CONFIG — a shallow spread leaves the
    // `appPermissions` array aliased to the module-level default, so
    // mutating it in one instance (setAppPermission) would silently leak
    // into every future DeviceControlService created in the same process.
    this.config = { ...DEFAULT_CONFIG, appPermissions: [] };
    this.permissionService = permissionService;
    this.auditLogger = auditLogger;
    this.toolRegistry = toolRegistry;
    this.autonomyGate = autonomyGate;
    this.persistencePath = options?.persistencePath ?? null;

    // Restore persisted state BEFORE syncing permissions so the first sync
    // materialises the user's saved access level + toggles into real
    // ComputerPermissionService rules. Without this restore step, a server
    // restart silently reverts every device capability to default-DENY —
    // which hit us during end-to-end testing when the chat attempted a
    // screenshot and got "Permission DENIED" even though the user's last
    // interaction with the dashboard had turned everything on.
    this.loadFromDisk();
    this.syncPermissions();

    log.info({ persistencePath: this.persistencePath, restoredLevel: this.config.accessLevel }, 'DeviceControlService initialized');
  }

  /** Read saved config from disk (no-op if persistence disabled). */
  private loadFromDisk(): void {
    if (!this.persistencePath) return;
    try {
      if (!fs.existsSync(this.persistencePath)) return;
      const raw = fs.readFileSync(this.persistencePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<DeviceControlConfig>;
      this.config = {
        ...DEFAULT_CONFIG,
        ...parsed,
        appPermissions: Array.isArray(parsed.appPermissions) ? parsed.appPermissions : [],
      };
      log.info({ accessLevel: this.config.accessLevel }, 'Device control config restored from disk');
    } catch (err) {
      log.warn({ err: (err as Error).message, path: this.persistencePath }, 'Failed to load device control config — starting from defaults');
    }
  }

  /** Atomically write current config to disk (no-op if persistence disabled). */
  private saveToDisk(): void {
    if (!this.persistencePath) return;
    try {
      const dir = path.dirname(this.persistencePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Atomic write: tmp + rename, so a crash mid-write can't corrupt the file.
      const tmp = `${this.persistencePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.config, null, 2), 'utf-8');
      fs.renameSync(tmp, this.persistencePath);
    } catch (err) {
      log.warn({ err: (err as Error).message, path: this.persistencePath }, 'Failed to persist device control config');
    }
  }

  // ─── Configuration ──────────────────────────────────────────────────────

  getConfig(): DeviceControlConfig {
    return { ...this.config };
  }

  updateConfig(changes: Partial<DeviceControlConfig>): DeviceControlConfig {
    // Safety: block full control if AutonomyGate is not at SUPERVISED+
    if (changes.accessLevel === 'full' || changes.accessLevel === 'trusted_app') {
      const gate = this.autonomyGate;
      if (gate && gate.getCurrentLevel() === 'SUGGEST_ONLY') {
        log.warn('Cannot set full/trusted_app access — AutonomyGate is SUGGEST_ONLY');
        changes.accessLevel = 'supervised';
      }
    }

    // Safety: financial actions always require explicit opt-in
    if (changes.allowFinancialActions && !this.config.allowFinancialActions) {
      log.warn('Financial actions enabled — requires explicit user approval per action');
    }

    Object.assign(this.config, changes);
    this.syncPermissions();
    this.saveToDisk();
    this.audit('config_update', JSON.stringify(changes), true);
    log.info({ config: this.config }, 'Device control config updated');
    return { ...this.config };
  }

  // ─── App Permissions ────────────────────────────────────────────────────

  getAppPermissions(): AppPermission[] {
    return [...this.config.appPermissions];
  }

  setAppPermission(appName: string, allowed: boolean, actions?: ('launch' | 'focus' | 'quit' | 'type' | 'click')[]): AppPermission {
    const existing = this.config.appPermissions.find((a) => a.appName === appName);
    if (existing) {
      existing.allowed = allowed;
      if (actions) existing.actions = actions;
    } else {
      this.config.appPermissions.push({
        appName,
        allowed,
        actions: actions ?? ['launch', 'focus'],
      });
    }
    this.saveToDisk();
    this.audit('app_permission', `${appName}: ${allowed ? 'allowed' : 'denied'}`, true);
    return this.config.appPermissions.find((a) => a.appName === appName)!;
  }

  removeAppPermission(appName: string): boolean {
    const idx = this.config.appPermissions.findIndex((a) => a.appName === appName);
    if (idx >= 0) {
      this.config.appPermissions.splice(idx, 1);
      this.saveToDisk();
      this.audit('app_permission_removed', appName, true);
      return true;
    }
    return false;
  }

  // ─── Device Actions ─────────────────────────────────────────────────────

  async openApp(appName: string): Promise<{ success: boolean; detail: string }> {
    return this.executeAction('computer_app_launch', { appName }, 'app_control', appName);
  }

  async focusApp(appName: string): Promise<{ success: boolean; detail: string }> {
    return this.executeAction('computer_app_focus', { appName }, 'app_control', appName);
  }

  async quitApp(appName: string): Promise<{ success: boolean; detail: string }> {
    return this.executeAction('computer_app_quit', { appName }, 'app_control', appName);
  }

  async moveMouse(x: number, y: number): Promise<{ success: boolean; detail: string }> {
    if (!this.config.allowMouse) {
      return { success: false, detail: 'Mouse control not enabled in device settings' };
    }
    return this.executeAction('computer_mouse_move', { x, y }, 'mouse');
  }

  async click(x?: number, y?: number, button?: 'left' | 'right'): Promise<{ success: boolean; detail: string }> {
    if (!this.config.allowMouse) {
      return { success: false, detail: 'Mouse control not enabled in device settings' };
    }
    return this.executeAction('computer_mouse_click', { x, y, button }, 'mouse');
  }

  async typeText(text: string): Promise<{ success: boolean; detail: string }> {
    if (!this.config.allowKeyboard) {
      return { success: false, detail: 'Keyboard control not enabled in device settings' };
    }
    return this.executeAction('computer_keyboard_type', { text }, 'keyboard');
  }

  async takeScreenshot(): Promise<{ success: boolean; detail: string; data?: any }> {
    if (!this.config.allowScreenshots) {
      return { success: false, detail: 'Screenshots not enabled in device settings' };
    }
    return this.executeAction('computer_screenshot', {}, 'screenshot');
  }

  async getScreenDimensions(): Promise<{ success: boolean; detail: string; data?: any }> {
    return this.executeAction('computer_screen_dimensions', {}, 'screen_info');
  }

  async listRunningApps(): Promise<{ success: boolean; detail: string; data?: any }> {
    return this.executeAction('computer_app_list_running', {}, 'app_control');
  }

  // ─── Capability Checks ──────────────────────────────────────────────────

  canDo(action: string): boolean {
    switch (action) {
      case 'mouse': return this.config.allowMouse && this.config.accessLevel !== 'observe';
      case 'keyboard': return this.config.allowKeyboard && this.config.accessLevel !== 'observe';
      case 'screenshot': return this.config.allowScreenshots;
      case 'app_control': return this.config.accessLevel !== 'observe';
      case 'messaging': return this.config.allowMessagingApps;
      case 'financial': return this.config.allowFinancialActions;
      default: return false;
    }
  }

  isAppAllowed(appName: string): boolean {
    const perm = this.config.appPermissions.find(
      (a) => a.appName.toLowerCase() === appName.toLowerCase()
    );
    return perm?.allowed ?? false;
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  private async executeAction(
    toolName: string,
    args: Record<string, unknown>,
    category: string,
    appName?: string,
  ): Promise<{ success: boolean; detail: string; data?: any }> {
    // 1. Access level check
    if (this.config.accessLevel === 'observe' && category !== 'screen_info') {
      this.audit(`device:${toolName}`, 'Blocked: observe-only mode', false);
      return { success: false, detail: 'Device is in observe-only mode. Change access level to enable actions.' };
    }

    // 2. App-level permission check
    if (appName && this.config.accessLevel === 'trusted_app') {
      if (!this.isAppAllowed(appName)) {
        this.audit(`device:${toolName}`, `Blocked: app '${appName}' not in trusted list`, false);
        return { success: false, detail: `App '${appName}' is not in the trusted app list. Add it in Device Control settings.` };
      }
    }

    // 3. Category toggle check
    if (category === 'mouse' && !this.config.allowMouse) {
      this.audit(`device:${toolName}`, 'Blocked: mouse control disabled', false);
      return { success: false, detail: 'Mouse control is disabled in device settings.' };
    }
    if (category === 'keyboard' && !this.config.allowKeyboard) {
      this.audit(`device:${toolName}`, 'Blocked: keyboard control disabled', false);
      return { success: false, detail: 'Keyboard control is disabled in device settings.' };
    }
    if (category === 'screenshot' && !this.config.allowScreenshots) {
      this.audit(`device:${toolName}`, 'Blocked: screenshots disabled', false);
      return { success: false, detail: 'Screenshots are disabled in device settings.' };
    }

    // 4. Execute via tool registry (which checks ComputerPermissionService)
    const tool = this.toolRegistry?.get?.(toolName);
    if (!tool) {
      return { success: false, detail: `Tool '${toolName}' not registered` };
    }

    try {
      const result = await tool.execute(args, {
        sessionId: 'device-control',
        agent: this.toolRegistry._agent ?? {},
      });

      const parsed = tryParseJSON(result);
      this.audit(`device:${toolName}`, `Success: ${result.slice(0, 200)}`, true);
      return { success: true, detail: result, data: parsed };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.audit(`device:${toolName}`, `Error: ${msg}`, false);
      return { success: false, detail: msg };
    }
  }

  /** Sync config toggles → ComputerPermissionService rules. */
  private syncPermissions(): void {
    if (!this.permissionService) return;

    const syncCategory = (category: string, enabled: boolean) => {
      const rules = this.permissionService.list(category);
      if (enabled && rules.length === 0) {
        this.permissionService.grant({ category, decision: 'allow' });
      } else if (!enabled) {
        for (const rule of rules) {
          if (rule.decision === 'allow') {
            this.permissionService.revoke(rule.id);
          }
        }
      }
    };

    syncCategory('mouse', this.config.allowMouse);
    syncCategory('keyboard', this.config.allowKeyboard);
    syncCategory('screenshot', this.config.allowScreenshots);
    syncCategory('screen_info', true); // always allow screen info reads
    syncCategory('app_control', this.config.accessLevel !== 'observe');
  }

  private audit(action: string, detail: string, success: boolean): void {
    try {
      this.auditLogger?.log?.({
        action: 'tool_call' as any,
        sessionId: 'device-control',
        details: action,
        metadata: { detail, accessLevel: this.config.accessLevel },
        success,
      });
    } catch { /* best effort */ }
  }
}

function tryParseJSON(str: string): any {
  try { return JSON.parse(str); } catch { return null; }
}
