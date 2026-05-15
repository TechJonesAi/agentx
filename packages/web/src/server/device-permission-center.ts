/**
 * Device Permission Center — Self-contained interactive HTML page.
 *
 * Served via GET /api/device/permission-center and embedded in the
 * Tools page via iframe. Communicates with the Device Control API
 * endpoints for all state management.
 *
 * Safety: All actions default to DENY. Every change goes through
 * the DeviceControlService which enforces ComputerPermissionService
 * rules and logs to AuditLogger.
 */

export function getDevicePermissionCenterHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Device Control — Permission Center</title>
<style>
  :root {
    --bg-primary: #0a0a0f;
    --bg-secondary: #12121a;
    --bg-card: #1a1a25;
    --bg-hover: #22222f;
    --border-primary: #2a2a3a;
    --border-active: #6366f1;
    --text-primary: #e4e4e7;
    --text-secondary: #a1a1aa;
    --text-muted: #71717a;
    --accent: #6366f1;
    --accent-soft: #6366f122;
    --success: #10b981;
    --success-soft: #10b98122;
    --warning: #f59e0b;
    --warning-soft: #f59e0b22;
    --danger: #ef4444;
    --danger-soft: #ef444422;
    --radius: 8px;
    --spacing-xs: 4px;
    --spacing-sm: 8px;
    --spacing-md: 16px;
    --spacing-lg: 24px;
    --spacing-xl: 32px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: transparent;
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.5;
  }

  .dpc-container {
    max-width: 100%;
    padding: 0;
  }

  /* ─── Section Cards ─────────────────────────────── */
  .dpc-section {
    background: var(--bg-card);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius);
    margin-bottom: var(--spacing-md);
    overflow: hidden;
  }

  .dpc-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-md);
    border-bottom: 1px solid var(--border-primary);
  }

  .dpc-section-title {
    font-size: 15px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .dpc-section-body {
    padding: var(--spacing-md);
  }

  /* ─── Access Level Selector ─────────────────────── */
  .dpc-access-levels {
    display: flex;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }

  .dpc-access-btn {
    flex: 1;
    min-width: 100px;
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    text-align: center;
    transition: all 0.15s;
  }

  .dpc-access-btn:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .dpc-access-btn.active {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 600;
  }

  .dpc-access-label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 2px;
  }

  .dpc-access-desc {
    display: block;
    font-size: 11px;
    color: var(--text-muted);
    font-weight: 400;
  }

  /* ─── Toggle Rows ───────────────────────────────── */
  .dpc-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-sm) 0;
    border-bottom: 1px solid var(--border-primary);
  }

  .dpc-toggle-row:last-child {
    border-bottom: none;
  }

  .dpc-toggle-label {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: 13px;
    color: var(--text-primary);
  }

  .dpc-toggle-icon {
    font-size: 16px;
    width: 24px;
    text-align: center;
  }

  .dpc-toggle-info {
    font-size: 11px;
    color: var(--text-muted);
    display: block;
    margin-left: 32px;
  }

  /* Toggle switch */
  .dpc-switch {
    position: relative;
    width: 40px;
    height: 22px;
    flex-shrink: 0;
  }

  .dpc-switch input {
    opacity: 0;
    width: 0;
    height: 0;
  }

  .dpc-switch-slider {
    position: absolute;
    top: 0; left: 0; right: 0; bottom: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 11px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .dpc-switch-slider::before {
    content: '';
    position: absolute;
    width: 16px;
    height: 16px;
    left: 2px;
    bottom: 2px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: all 0.2s;
  }

  .dpc-switch input:checked + .dpc-switch-slider {
    background: var(--accent-soft);
    border-color: var(--accent);
  }

  .dpc-switch input:checked + .dpc-switch-slider::before {
    transform: translateX(18px);
    background: var(--accent);
  }

  /* ─── App Permissions ───────────────────────────── */
  .dpc-app-list {
    margin-top: var(--spacing-sm);
  }

  .dpc-app-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius);
    margin-bottom: var(--spacing-xs);
  }

  .dpc-app-name {
    font-size: 13px;
    font-weight: 500;
  }

  .dpc-app-actions {
    display: flex;
    gap: var(--spacing-sm);
    align-items: center;
  }

  .dpc-app-badge {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 3px;
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 500;
  }

  .dpc-btn-remove {
    background: none;
    border: none;
    color: var(--danger);
    cursor: pointer;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 4px;
  }

  .dpc-btn-remove:hover {
    background: var(--danger-soft);
  }

  /* ─── Add App Form ──────────────────────────────── */
  .dpc-add-form {
    display: flex;
    gap: var(--spacing-sm);
    margin-top: var(--spacing-sm);
  }

  .dpc-input {
    flex: 1;
    padding: var(--spacing-sm) var(--spacing-md);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius);
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
  }

  .dpc-input:focus {
    border-color: var(--accent);
  }

  .dpc-btn {
    padding: var(--spacing-sm) var(--spacing-md);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.15s;
  }

  .dpc-btn-primary {
    background: var(--accent);
    border-color: var(--accent);
    color: white;
  }

  .dpc-btn-primary:hover {
    opacity: 0.9;
  }

  /* ─── Status Badge ──────────────────────────────── */
  .dpc-status {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius);
    font-size: 12px;
    font-weight: 500;
  }

  .dpc-status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
  }

  .dpc-status-safe {
    background: var(--success-soft);
    color: var(--success);
  }

  .dpc-status-safe .dpc-status-dot {
    background: var(--success);
  }

  .dpc-status-warn {
    background: var(--warning-soft);
    color: var(--warning);
  }

  .dpc-status-warn .dpc-status-dot {
    background: var(--warning);
  }

  .dpc-status-danger {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .dpc-status-danger .dpc-status-dot {
    background: var(--danger);
  }

  /* ─── Quick Actions ─────────────────────────────── */
  .dpc-quick-actions {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
    gap: var(--spacing-sm);
  }

  .dpc-quick-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: var(--spacing-md) var(--spacing-sm);
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: var(--radius);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
    transition: all 0.15s;
  }

  .dpc-quick-btn:hover {
    background: var(--bg-hover);
    border-color: var(--accent);
    color: var(--text-primary);
  }

  .dpc-quick-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .dpc-quick-btn:disabled:hover {
    background: var(--bg-secondary);
    border-color: var(--border-primary);
    color: var(--text-secondary);
  }

  .dpc-quick-btn-icon {
    font-size: 20px;
  }

  /* Small hint text shown on disabled Quick Action buttons */
  .dpc-quick-btn-hint {
    font-size: 10px;
    color: var(--text-muted, #8b949e);
    font-weight: 500;
    display: none;
    text-align: center;
    line-height: 1.3;
  }

  .dpc-quick-btn:disabled .dpc-quick-btn-hint {
    display: block;
  }

  /* ─── Quick Action formatted results ─────────────────── */
  .dpc-action-loading {
    font-size: 12px;
    color: var(--text-muted, #8b949e);
    font-style: italic;
  }

  .dpc-action-error {
    padding: 10px 12px;
    border-radius: 6px;
    background: rgba(248, 81, 73, 0.12);
    border: 1px solid rgba(248, 81, 73, 0.35);
    color: #f85149;
    font-size: 13px;
    line-height: 1.5;
  }

  .dpc-action-empty {
    padding: 10px 12px;
    border-radius: 6px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    color: var(--text-muted, #8b949e);
    font-size: 13px;
  }

  .dpc-action-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 8px;
  }

  .dpc-action-count {
    display: inline-block;
    padding: 1px 8px;
    border-radius: 10px;
    background: rgba(88, 166, 255, 0.18);
    color: #58a6ff;
    font-size: 11px;
    font-weight: 700;
  }

  /* App grid + chips */
  .dpc-app-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 6px;
  }

  .dpc-app-chip {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    font-size: 12px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dpc-app-chip-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #3fb950;
    flex-shrink: 0;
  }

  /* Screen dimensions display */
  .dpc-screen-size {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 12px 14px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
  }

  .dpc-screen-size-value {
    font-size: 20px;
    font-weight: 700;
    color: #58a6ff;
    font-family: ui-monospace, Menlo, monospace;
  }

  .dpc-screen-size-scale {
    font-size: 12px;
    color: var(--text-muted, #8b949e);
  }

  /* Screenshot preview */
  .dpc-screenshot {
    max-width: 100%;
    border-radius: 6px;
    border: 1px solid var(--border-primary);
    display: block;
  }

  /* Collapsible raw-JSON fallback */
  .dpc-action-raw {
    font-size: 12px;
    color: var(--text-muted, #8b949e);
  }

  .dpc-action-raw summary {
    cursor: pointer;
    user-select: none;
    padding: 4px 0;
  }

  .dpc-action-raw pre {
    margin-top: 6px;
    padding: 10px;
    background: var(--bg-secondary);
    border: 1px solid var(--border-primary);
    border-radius: 6px;
    font-size: 11px;
    overflow-x: auto;
    white-space: pre-wrap;
  }

  /* ─── Toast / Feedback ──────────────────────────── */
  .dpc-toast {
    position: fixed;
    bottom: 16px;
    right: 16px;
    padding: var(--spacing-sm) var(--spacing-md);
    border-radius: var(--radius);
    font-size: 13px;
    font-weight: 500;
    z-index: 100;
    opacity: 0;
    transform: translateY(8px);
    transition: all 0.2s;
    pointer-events: none;
  }

  .dpc-toast.show {
    opacity: 1;
    transform: translateY(0);
  }

  .dpc-toast-success {
    background: var(--success-soft);
    color: var(--success);
    border: 1px solid var(--success);
  }

  .dpc-toast-error {
    background: var(--danger-soft);
    color: var(--danger);
    border: 1px solid var(--danger);
  }

  .dpc-toast-info {
    background: var(--accent-soft);
    color: var(--accent);
    border: 1px solid var(--accent);
  }
</style>
</head>
<body>
<div class="dpc-container">

  <!-- ═══ Safety Status ═══════════════════════════════════ -->
  <div class="dpc-section">
    <div class="dpc-section-header">
      <span class="dpc-section-title">Safety Status</span>
      <div id="safetyBadge" class="dpc-status dpc-status-safe">
        <span class="dpc-status-dot"></span>
        <span id="safetyLabel">DEFAULT-DENY</span>
      </div>
    </div>
    <div class="dpc-section-body" style="font-size: 12px; color: var(--text-muted);">
      All device actions are <strong>blocked by default</strong>. Enable specific capabilities below. Every action is audited.
    </div>
  </div>

  <!-- ═══ Access Level ════════════════════════════════════ -->
  <div class="dpc-section">
    <div class="dpc-section-header">
      <span class="dpc-section-title">Access Level</span>
    </div>
    <div class="dpc-section-body">
      <div class="dpc-access-levels" id="accessLevels">
        <button class="dpc-access-btn" data-level="observe" onclick="setAccessLevel('observe')">
          <span class="dpc-access-label">Observe</span>
          <span class="dpc-access-desc">Read-only, no actions</span>
        </button>
        <button class="dpc-access-btn" data-level="assist" onclick="setAccessLevel('assist')">
          <span class="dpc-access-label">Assist</span>
          <span class="dpc-access-desc">Suggest actions only</span>
        </button>
        <button class="dpc-access-btn" data-level="supervised" onclick="setAccessLevel('supervised')">
          <span class="dpc-access-label">Supervised</span>
          <span class="dpc-access-desc">Actions with approval</span>
        </button>
        <button class="dpc-access-btn" data-level="trusted_app" onclick="setAccessLevel('trusted_app')">
          <span class="dpc-access-label">Trusted App</span>
          <span class="dpc-access-desc">Allowed apps only</span>
        </button>
        <button class="dpc-access-btn" data-level="full" onclick="setAccessLevel('full')">
          <span class="dpc-access-label">Full</span>
          <span class="dpc-access-desc">All actions permitted</span>
        </button>
      </div>
    </div>
  </div>

  <!-- ═══ Capability Toggles ══════════════════════════════ -->
  <div class="dpc-section">
    <div class="dpc-section-header">
      <span class="dpc-section-title">Capabilities</span>
    </div>
    <div class="dpc-section-body">
      <div class="dpc-toggle-row">
        <div>
          <div class="dpc-toggle-label"><span class="dpc-toggle-icon">🖱</span> Mouse Control</div>
          <span class="dpc-toggle-info">Move cursor, click, drag, scroll</span>
        </div>
        <label class="dpc-switch">
          <input type="checkbox" id="toggleMouse" onchange="updateToggle('allowMouse', this.checked)" />
          <span class="dpc-switch-slider"></span>
        </label>
      </div>

      <div class="dpc-toggle-row">
        <div>
          <div class="dpc-toggle-label"><span class="dpc-toggle-icon">⌨</span> Keyboard Control</div>
          <span class="dpc-toggle-info">Type text, send keyboard shortcuts</span>
        </div>
        <label class="dpc-switch">
          <input type="checkbox" id="toggleKeyboard" onchange="updateToggle('allowKeyboard', this.checked)" />
          <span class="dpc-switch-slider"></span>
        </label>
      </div>

      <div class="dpc-toggle-row">
        <div>
          <div class="dpc-toggle-label"><span class="dpc-toggle-icon">📷</span> Screenshots</div>
          <span class="dpc-toggle-info">Capture screen for visual analysis</span>
        </div>
        <label class="dpc-switch">
          <input type="checkbox" id="toggleScreenshots" onchange="updateToggle('allowScreenshots', this.checked)" />
          <span class="dpc-switch-slider"></span>
        </label>
      </div>

      <div class="dpc-toggle-row">
        <div>
          <div class="dpc-toggle-label"><span class="dpc-toggle-icon">💬</span> Messaging Apps</div>
          <span class="dpc-toggle-info">Interact with Messages, WhatsApp, Slack</span>
        </div>
        <label class="dpc-switch">
          <input type="checkbox" id="toggleMessaging" onchange="updateToggle('allowMessagingApps', this.checked)" />
          <span class="dpc-switch-slider"></span>
        </label>
      </div>

      <div class="dpc-toggle-row">
        <div>
          <div class="dpc-toggle-label"><span class="dpc-toggle-icon">💳</span> Financial Actions</div>
          <span class="dpc-toggle-info">Banking, payments — requires per-action approval</span>
        </div>
        <label class="dpc-switch">
          <input type="checkbox" id="toggleFinancial" onchange="updateToggle('allowFinancialActions', this.checked)" />
          <span class="dpc-switch-slider"></span>
        </label>
      </div>
    </div>
  </div>

  <!-- ═══ App Permissions ═════════════════════════════════ -->
  <div class="dpc-section">
    <div class="dpc-section-header">
      <span class="dpc-section-title">App Permissions</span>
      <span style="font-size: 11px; color: var(--text-muted);">Trusted App mode only</span>
    </div>
    <div class="dpc-section-body">
      <div id="appList" class="dpc-app-list"></div>
      <div class="dpc-add-form">
        <input type="text" id="newAppName" class="dpc-input" placeholder="App name (e.g. Safari, Terminal)" />
        <button class="dpc-btn dpc-btn-primary" onclick="addApp()">Add App</button>
      </div>
    </div>
  </div>

  <!-- ═══ Quick Actions ═══════════════════════════════════ -->
  <div class="dpc-section">
    <div class="dpc-section-header">
      <span class="dpc-section-title">Quick Actions</span>
    </div>
    <div class="dpc-section-body">
      <div class="dpc-quick-actions">
        <button class="dpc-quick-btn" id="btnScreenSize" onclick="quickAction('screen_dimensions')">
          <span class="dpc-quick-btn-icon">📐</span>
          Screen Size
          <span class="dpc-quick-btn-hint" data-hint="screen_dimensions"></span>
        </button>
        <button class="dpc-quick-btn" id="btnScreenshot" onclick="quickAction('screenshot')">
          <span class="dpc-quick-btn-icon">📸</span>
          Screenshot
          <span class="dpc-quick-btn-hint" data-hint="screenshot"></span>
        </button>
        <button class="dpc-quick-btn" id="btnListApps" onclick="quickAction('list_apps')">
          <span class="dpc-quick-btn-icon">📋</span>
          List Apps
          <span class="dpc-quick-btn-hint" data-hint="list_apps"></span>
        </button>
      </div>
      <div id="actionResult" style="margin-top: var(--spacing-md); display: none;">
        <div style="font-size: 12px; font-weight: 500; color: var(--text-secondary); margin-bottom: var(--spacing-xs);">Result:</div>
        <div id="actionResultContent" style="
          padding: var(--spacing-md);
          background: transparent;
          max-height: 360px;
          overflow-y: auto;
        "></div>
      </div>
    </div>
  </div>

</div>

<!-- Toast -->
<div id="toast" class="dpc-toast"></div>

<script>
  // ─── State ─────────────────────────────────────────────
  let config = null;
  let apps = [];

  // ─── API Helpers ───────────────────────────────────────
  async function apiGet(path) {
    const res = await fetch(path);
    return res.json();
  }

  async function apiPut(path, body) {
    const res = await fetch(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function apiDelete(path) {
    const res = await fetch(path, { method: 'DELETE' });
    return res.json();
  }

  // ─── Load Config ───────────────────────────────────────
  async function loadConfig() {
    try {
      config = await apiGet('/api/device/config');
      renderConfig();
    } catch (err) {
      toast('Failed to load config', 'error');
    }
  }

  async function loadApps() {
    try {
      const data = await apiGet('/api/device/apps');
      apps = data.apps || [];
      renderApps();
    } catch (err) {
      toast('Failed to load apps', 'error');
    }
  }

  // ─── Render ────────────────────────────────────────────
  function renderConfig() {
    if (!config) return;

    // Access level buttons
    document.querySelectorAll('.dpc-access-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.level === config.accessLevel);
    });

    // Toggles
    document.getElementById('toggleMouse').checked = config.allowMouse;
    document.getElementById('toggleKeyboard').checked = config.allowKeyboard;
    document.getElementById('toggleScreenshots').checked = config.allowScreenshots;
    document.getElementById('toggleMessaging').checked = config.allowMessagingApps;
    document.getElementById('toggleFinancial').checked = config.allowFinancialActions;

    // Quick Action enablement mirrors server-side rules in device-control.ts:
    //   - screen_dimensions (category 'screen_info') is always permitted
    //   - screenshot requires accessLevel != observe AND allowScreenshots = true
    //   - list_apps (category 'app_control') requires accessLevel != observe
    updateQuickAction('btnScreenSize', true, '');
    const screenshotBlockedByLevel = config.accessLevel === 'observe';
    const screenshotBlockedByToggle = !config.allowScreenshots;
    updateQuickAction(
      'btnScreenshot',
      !screenshotBlockedByLevel && !screenshotBlockedByToggle,
      screenshotBlockedByLevel ? 'Requires Supervised+ access' : (screenshotBlockedByToggle ? 'Enable Screenshots toggle' : ''),
    );
    const listAppsBlocked = config.accessLevel === 'observe';
    updateQuickAction(
      'btnListApps',
      !listAppsBlocked,
      listAppsBlocked ? 'Requires Supervised+ access' : '',
    );

    // Safety badge
    updateSafetyBadge();
  }

  /**
   * Toggle a Quick Action button's enabled state + update its hint caption.
   * When disabled, the button is dimmed, non-clickable, and surfaces a short
   * reason ("Requires Supervised+ access") instead of firing and showing a
   * JSON error.
   */
  function updateQuickAction(buttonId, enabled, hintText) {
    const btn = document.getElementById(buttonId);
    if (!btn) return;
    btn.disabled = !enabled;
    btn.title = enabled ? '' : (hintText || 'Action not permitted at current access level');
    const hint = btn.querySelector('.dpc-quick-btn-hint');
    if (hint) hint.textContent = hintText || '';
  }

  function renderApps() {
    const list = document.getElementById('appList');
    if (apps.length === 0) {
      list.innerHTML = '<div style="font-size: 12px; color: var(--text-muted); padding: var(--spacing-sm) 0;">No app permissions configured.</div>';
      return;
    }

    list.innerHTML = apps.map(app =>
      '<div class="dpc-app-row">' +
        '<span class="dpc-app-name">' + escapeHtml(app.appName) + '</span>' +
        '<div class="dpc-app-actions">' +
          (app.actions || []).map(a => '<span class="dpc-app-badge">' + a + '</span>').join('') +
          '<span style="margin-left: 4px; font-size: 12px; color: ' + (app.allowed ? 'var(--success)' : 'var(--danger)') + ';">' +
            (app.allowed ? 'Allowed' : 'Denied') +
          '</span>' +
          '<button class="dpc-btn-remove" onclick="removeApp(\\'' + escapeHtml(app.appName) + '\\')" title="Remove">x</button>' +
        '</div>' +
      '</div>'
    ).join('');
  }

  function updateSafetyBadge() {
    const badge = document.getElementById('safetyBadge');
    const label = document.getElementById('safetyLabel');

    const anyEnabled = config.allowMouse || config.allowKeyboard || config.allowScreenshots;
    const level = config.accessLevel;

    if (level === 'observe' && !anyEnabled) {
      badge.className = 'dpc-status dpc-status-safe';
      label.textContent = 'DEFAULT-DENY';
    } else if (level === 'full') {
      badge.className = 'dpc-status dpc-status-danger';
      label.textContent = 'FULL ACCESS';
    } else if (level === 'trusted_app' || level === 'supervised') {
      badge.className = 'dpc-status dpc-status-warn';
      label.textContent = level === 'trusted_app' ? 'TRUSTED APPS' : 'SUPERVISED';
    } else if (anyEnabled) {
      badge.className = 'dpc-status dpc-status-warn';
      label.textContent = 'PARTIAL ACCESS';
    } else {
      badge.className = 'dpc-status dpc-status-safe';
      label.textContent = 'RESTRICTED';
    }
  }

  // ─── Actions ───────────────────────────────────────────
  async function setAccessLevel(level) {
    try {
      const previousLevel = config?.accessLevel;
      config = await apiPut('/api/device/config', { accessLevel: level });
      renderConfig();
      // Clear any stale Quick Action result. The data was captured at the
      // previous access level; leaving it on-screen would imply it's live
      // and could be refreshed, which is misleading (especially when dropping
      // to a more restrictive level like observe).
      if (previousLevel && previousLevel !== level) {
        clearActionResult();
      }
      toast('Access level set to ' + level, 'success');
    } catch (err) {
      toast('Failed to update access level', 'error');
    }
  }

  /** Hide the Quick Action result panel and wipe its contents. */
  function clearActionResult() {
    const resultDiv = document.getElementById('actionResult');
    const resultContent = document.getElementById('actionResultContent');
    if (resultDiv) resultDiv.style.display = 'none';
    if (resultContent) resultContent.innerHTML = '';
  }

  async function updateToggle(key, value) {
    try {
      const update = {};
      update[key] = value;
      config = await apiPut('/api/device/config', update);
      renderConfig();
      toast(key.replace('allow', '') + ' ' + (value ? 'enabled' : 'disabled'), 'info');
    } catch (err) {
      toast('Failed to update setting', 'error');
    }
  }

  async function addApp() {
    const input = document.getElementById('newAppName');
    const name = input.value.trim();
    if (!name) return;

    try {
      await apiPost('/api/device/apps', {
        appName: name,
        allowed: true,
        actions: ['launch', 'focus', 'quit'],
      });
      input.value = '';
      await loadApps();
      toast(name + ' added to trusted apps', 'success');
    } catch (err) {
      toast('Failed to add app', 'error');
    }
  }

  async function removeApp(name) {
    try {
      await apiDelete('/api/device/apps/' + encodeURIComponent(name));
      await loadApps();
      toast(name + ' removed', 'info');
    } catch (err) {
      toast('Failed to remove app', 'error');
    }
  }

  async function quickAction(action) {
    const resultDiv = document.getElementById('actionResult');
    const resultContent = document.getElementById('actionResultContent');
    if (!resultDiv || !resultContent) return;

    try {
      resultDiv.style.display = 'block';
      resultContent.innerHTML = '<div class="dpc-action-loading">Running ' + escapeHtml(action.replace(/_/g, ' ')) + '\\u2026</div>';

      const data = await apiPost('/api/device/action', { action });
      renderActionResult(action, data, resultContent);
    } catch (err) {
      resultContent.innerHTML = '<div class="dpc-action-error">' + escapeHtml(err.message || 'Action failed') + '</div>';
    }
  }

  /**
   * Render a Quick Action response as a formatted UI (not raw JSON).
   *
   *  - list_apps         \u2192 grid of app chips with icons
   *  - screen_dimensions \u2192 "W \u00d7 H" display
   *  - screenshot        \u2192 inline <img> preview
   *  - anything else     \u2192 collapsible raw-JSON fallback so we never lose info
   */
  function renderActionResult(action, data, container) {
    // Failed action first — uniform red block.
    if (data && data.success === false) {
      container.innerHTML = '<div class="dpc-action-error"><strong>Blocked.</strong> ' +
        escapeHtml(data.detail || 'Action not permitted.') + '</div>';
      return;
    }

    if (action === 'list_apps') {
      // Server returns either data.data.apps (array) or a JSON-stringified detail.
      let apps = Array.isArray(data?.data?.apps) ? data.data.apps : null;
      if (!apps && typeof data?.detail === 'string') {
        try { const parsed = JSON.parse(data.detail); if (Array.isArray(parsed.apps)) apps = parsed.apps; } catch (_) { /* fall through */ }
      }
      if (!Array.isArray(apps) || apps.length === 0) {
        container.innerHTML = '<div class="dpc-action-empty">No running applications reported.</div>';
        return;
      }
      const chips = apps.map(a => '<span class="dpc-app-chip"><span class="dpc-app-chip-dot"></span>' + escapeHtml(String(a)) + '</span>').join('');
      container.innerHTML =
        '<div class="dpc-action-header">Running applications <span class="dpc-action-count">' + apps.length + '</span></div>' +
        '<div class="dpc-app-grid">' + chips + '</div>';
      return;
    }

    if (action === 'screen_dimensions') {
      const d = data?.data ?? {};
      const w = d.width ?? d.screenWidth;
      const h = d.height ?? d.screenHeight;
      const scale = d.scaleFactor ?? d.scale;
      if (typeof w === 'number' && typeof h === 'number') {
        container.innerHTML =
          '<div class="dpc-action-header">Screen dimensions</div>' +
          '<div class="dpc-screen-size">' +
            '<span class="dpc-screen-size-value">' + w + ' \u00d7 ' + h + '</span>' +
            (scale ? ' <span class="dpc-screen-size-scale">@ ' + scale + '\u00d7</span>' : '') +
          '</div>';
        return;
      }
      // unknown shape — fall through to raw
    }

    if (action === 'screenshot') {
      const url = data?.data?.url ?? data?.data?.dataUrl ?? data?.data?.path;
      if (typeof url === 'string' && url.length > 0) {
        const isData = url.startsWith('data:') || url.startsWith('http');
        container.innerHTML =
          '<div class="dpc-action-header">Screenshot captured</div>' +
          (isData
            ? '<img class="dpc-screenshot" src="' + escapeHtml(url) + '" alt="Screenshot" />'
            : '<div class="dpc-action-empty">Saved to <code>' + escapeHtml(url) + '</code></div>');
        return;
      }
    }

    // Fallback — collapsible raw JSON (still available when you actually need it).
    const json = JSON.stringify(data, null, 2);
    container.innerHTML =
      '<details class="dpc-action-raw"><summary>Raw response</summary>' +
      '<pre>' + escapeHtml(json) + '</pre></details>';
  }

  // ─── Helpers ───────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function toast(message, type) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'dpc-toast dpc-toast-' + (type || 'info') + ' show';
    setTimeout(() => { el.classList.remove('show'); }, 2500);
  }

  // ─── Init ──────────────────────────────────────────────
  loadConfig();
  loadApps();
</script>
</body>
</html>`;
}

/**
 * Function-shaped export used by the /api/device/permission-center route
 * handler in api.ts. That route dynamic-imports `renderDevicePermissionCenter`
 * and calls it; this wrapper bridges the older `getDevicePermissionCenterHTML`
 * function name so the Tools tab's iframe loads real HTML.
 */
export function renderDevicePermissionCenter(): string {
  return getDevicePermissionCenterHTML();
}
