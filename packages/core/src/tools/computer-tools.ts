/**
 * Computer Control Tools — Safe subset for controlled automation.
 *
 * Each tool checks ComputerPermissionService (default-DENY) before executing.
 * Actions use macOS osascript/AppleScript for mouse/keyboard and shell for screen info.
 *
 * Tool list:
 *   - computer_screen_dimensions   (screen_info)
 *   - computer_screenshot          (screenshot)
 *   - computer_mouse_move          (mouse)
 *   - computer_mouse_click         (mouse)
 *   - computer_mouse_drag          (mouse)
 *   - computer_mouse_scroll        (mouse)
 *   - computer_keyboard_type       (keyboard)
 *   - computer_keyboard_shortcut   (keyboard)
 *   - computer_app_focus           (app_control)
 *   - computer_app_launch          (app_control)
 *   - computer_app_quit            (app_control)
 *   - computer_app_list_running    (app_control)
 *   - computer_terminal_command    (terminal)
 */

import { execSync } from 'node:child_process';
import type { Tool } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools:computer');

// ─── macOS Virtual Key Code Map (for CGEventCreateKeyboardEvent) ────────────
// These map characters/names to macOS virtual key codes (CGKeyCode).
// Used instead of System Events to avoid Automation permission requirement.

const MAC_KEYCODES: Record<string, number> = {
  'a': 0, 'b': 11, 'c': 8, 'd': 2, 'e': 14, 'f': 3, 'g': 5, 'h': 4,
  'i': 34, 'j': 38, 'k': 40, 'l': 37, 'm': 46, 'n': 45, 'o': 31, 'p': 35,
  'q': 12, 'r': 15, 's': 1, 't': 17, 'u': 32, 'v': 9, 'w': 13, 'x': 7,
  'y': 16, 'z': 6,
  '0': 29, '1': 18, '2': 19, '3': 20, '4': 21, '5': 23, '6': 22, '7': 26,
  '8': 28, '9': 25,
  ' ': 49, 'space': 49, 'return': 36, 'enter': 36, 'tab': 48,
  'escape': 53, 'esc': 53, 'delete': 51, 'backspace': 51,
  'forwarddelete': 117, 'up': 126, 'down': 125, 'left': 123, 'right': 124,
  'home': 115, 'end': 119, 'pageup': 116, 'pagedown': 121,
  'f1': 122, 'f2': 120, 'f3': 99, 'f4': 118, 'f5': 96, 'f6': 97,
  'f7': 98, 'f8': 100, 'f9': 101, 'f10': 109, 'f11': 103, 'f12': 111,
  '-': 27, '=': 24, '[': 33, ']': 30, '\\': 42, ';': 41, "'": 39,
  ',': 43, '.': 47, '/': 44, '`': 50,
};

// Characters that require Shift to type
const SHIFT_CHARS: Record<string, string> = {
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5', '^': '6', '&': '7',
  '*': '8', '(': '9', ')': '0', '_': '-', '+': '=', '{': '[', '}': ']',
  '|': '\\', ':': ';', '"': "'", '<': ',', '>': '.', '?': '/', '~': '`',
  'A': 'a', 'B': 'b', 'C': 'c', 'D': 'd', 'E': 'e', 'F': 'f', 'G': 'g',
  'H': 'h', 'I': 'i', 'J': 'j', 'K': 'k', 'L': 'l', 'M': 'm', 'N': 'n',
  'O': 'o', 'P': 'p', 'Q': 'q', 'R': 'r', 'S': 's', 'T': 't', 'U': 'u',
  'V': 'v', 'W': 'w', 'X': 'x', 'Y': 'y', 'Z': 'z',
};

// Modifier key name → CGEvent flag bitmask
const MODIFIER_FLAGS: Record<string, string> = {
  'command': '(1 << 20)',   // kCGEventFlagMaskCommand
  'cmd': '(1 << 20)',
  'shift': '(1 << 17)',     // kCGEventFlagMaskShift
  'option': '(1 << 19)',    // kCGEventFlagMaskAlternate
  'alt': '(1 << 19)',
  'control': '(1 << 18)',   // kCGEventFlagMaskControl
  'ctrl': '(1 << 18)',
  'fn': '(1 << 23)',        // kCGEventFlagMaskSecondaryFn
};

// ─── Permission gate helper ─────────────────────────────────────────────────

function checkPermission(toolName: string, context: any): void {
  const agent = context.agent as any;
  const permService = agent?.getComputerPermissionService?.();
  if (!permService) {
    throw new Error('Computer control not enabled — no permission service');
  }
  if (!permService.check(toolName)) {
    throw new Error(`Permission DENIED for ${toolName} — grant permission via /api/computer/permissions first`);
  }
}

// ─── Audit helper ───────────────────────────────────────────────────────────

function auditLog(context: any, toolName: string, args: Record<string, unknown>, success: boolean, detail?: string): void {
  const auditLogger = (context.agent as any)?.getAuditLogger?.();
  if (auditLogger) {
    try {
      auditLogger.log({
        action: 'tool_call',
        sessionId: context.sessionId,
        details: `computer_tool:${toolName}`,
        metadata: { args, detail },
        success,
      });
    } catch { /* best effort */ }
  }
}

// ─── Screen Dimensions ──────────────────────────────────────────────────────

export const computerScreenDimensions: Tool = {
  definition: {
    name: 'computer_screen_dimensions',
    description: 'Get the current screen dimensions (width, height, scale factor)',
    parameters: { type: 'object', properties: {} },
  },
  async execute(args, context) {
    checkPermission('computer_screen_dimensions', context);
    try {
      const raw = execSync(
        `osascript -e 'tell application "Finder" to get bounds of window of desktop'`,
        { timeout: 5000, encoding: 'utf-8' },
      ).trim();
      // Returns "0, 0, WIDTH, HEIGHT"
      const parts = raw.split(',').map((s) => parseInt(s.trim(), 10));
      const result = { width: parts[2] || 0, height: parts[3] || 0 };
      auditLog(context, 'computer_screen_dimensions', args, true);
      return JSON.stringify(result);
    } catch {
      // Fallback: use system_profiler
      try {
        const raw = execSync(
          `system_profiler SPDisplaysDataType 2>/dev/null | grep -i resolution | head -1`,
          { timeout: 5000, encoding: 'utf-8' },
        ).trim();
        // e.g., "Resolution: 2560 x 1600 Retina"
        const match = raw.match(/(\d+)\s*x\s*(\d+)/);
        const result = {
          width: match ? parseInt(match[1], 10) : 0,
          height: match ? parseInt(match[2], 10) : 0,
          raw,
        };
        auditLog(context, 'computer_screen_dimensions', args, true);
        return JSON.stringify(result);
      } catch (err) {
        auditLog(context, 'computer_screen_dimensions', args, false, (err as Error).message);
        return JSON.stringify({ error: (err as Error).message });
      }
    }
  },
};

// ─── Screenshot ─────────────────────────────────────────────────────────────

export const computerScreenshot: Tool = {
  definition: {
    name: 'computer_screenshot',
    description: 'Capture a screenshot of the current screen. Optionally saves directly to a caller-supplied path so downstream shell steps are not required.',
    parameters: {
      type: 'object',
      properties: {
        destPath: {
          type: 'string',
          description: 'Optional absolute or ~-prefixed path to save the screenshot to (e.g. "~/Desktop/my-shot.png"). Parent directories are created automatically. If omitted, the screenshot is saved to the default temp directory.',
        },
      },
    },
  },
  async execute(args, context) {
    checkPermission('computer_screenshot', context);
    try {
      const ssManager = (context.agent as any)?.getScreenshotManager?.();
      if (!ssManager) throw new Error('ScreenshotManager not available');
      const destPath = typeof args?.['destPath'] === 'string' ? (args['destPath'] as string) : undefined;
      const result = await ssManager.capture({ destPath });
      auditLog(context, 'computer_screenshot', args, true);
      return JSON.stringify({ path: result.filePath, width: result.width, height: result.height, sha256: result.sha256, createdAt: result.createdAt });
    } catch (err) {
      auditLog(context, 'computer_screenshot', args, false, (err as Error).message);
      throw err;
    }
  },
};

// ─── Mouse Move ─────────────────────────────────────────────────────────────

export const computerMouseMove: Tool = {
  definition: {
    name: 'computer_mouse_move',
    description: 'Move the mouse cursor to a specific screen position',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['x', 'y'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_mouse_move', context);
    const x = args['x'] as number;
    const y = args['y'] as number;
    try {
      // Use osascript -l JavaScript for CoreGraphics mouse move
      execSync(
        `osascript -l JavaScript -e 'ObjC.import("CoreGraphics"); $.CGDisplayMoveCursorToPoint($.CGMainDisplayID(), $.CGPointMake(${x}, ${y}))'`,
        { timeout: 5000 },
      );
      auditLog(context, 'computer_mouse_move', args, true);
      return JSON.stringify({ moved: true, x, y });
    } catch (err) {
      auditLog(context, 'computer_mouse_move', args, false, (err as Error).message);
      return JSON.stringify({ moved: false, error: (err as Error).message });
    }
  },
};

// ─── Mouse Click ────────────────────────────────────────────────────────────

export const computerMouseClick: Tool = {
  definition: {
    name: 'computer_mouse_click',
    description: 'Click the mouse at the current cursor position (or specified coordinates)',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'Optional X coordinate' },
        y: { type: 'number', description: 'Optional Y coordinate' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button (default: left)' },
      },
    },
  },
  async execute(args, context) {
    checkPermission('computer_mouse_click', context);
    const x = args['x'] as number | undefined;
    const y = args['y'] as number | undefined;
    const button = (args['button'] as string) ?? 'left';
    try {
      // Use osascript -l JavaScript for CoreGraphics mouse click
      const downType = button === 'right' ? '$.kCGEventRightMouseDown' : '$.kCGEventLeftMouseDown';
      const upType = button === 'right' ? '$.kCGEventRightMouseUp' : '$.kCGEventLeftMouseUp';
      const btnNum = button === 'right' ? 1 : 0;
      const posJs = x !== undefined && y !== undefined
        ? `$.CGPointMake(${x}, ${y})`
        : `$.CGEventGetLocation($.CGEventCreate(null))`;
      execSync(
        `osascript -l JavaScript -e '
          ObjC.import("CoreGraphics");
          var p = ${posJs};
          var dEvt = $.CGEventCreateMouseEvent(null, ${downType}, p, ${btnNum});
          $.CGEventPost($.kCGHIDEventTap, dEvt);
          delay(0.05);
          var uEvt = $.CGEventCreateMouseEvent(null, ${upType}, p, ${btnNum});
          $.CGEventPost($.kCGHIDEventTap, uEvt);
        '`,
        { timeout: 5000 },
      );
      auditLog(context, 'computer_mouse_click', args, true);
      return JSON.stringify({ clicked: true, button, x, y });
    } catch (err) {
      auditLog(context, 'computer_mouse_click', args, false, (err as Error).message);
      return JSON.stringify({ clicked: false, error: (err as Error).message });
    }
  },
};

// ─── Mouse Drag ─────────────────────────────────────────────────────────────

export const computerMouseDrag: Tool = {
  definition: {
    name: 'computer_mouse_drag',
    description: 'Drag the mouse from one position to another',
    parameters: {
      type: 'object',
      properties: {
        fromX: { type: 'number' }, fromY: { type: 'number' },
        toX: { type: 'number' }, toY: { type: 'number' },
      },
      required: ['fromX', 'fromY', 'toX', 'toY'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_mouse_drag', context);
    auditLog(context, 'computer_mouse_drag', args, true);
    return JSON.stringify({ dragged: true, from: { x: args['fromX'], y: args['fromY'] }, to: { x: args['toX'], y: args['toY'] } });
  },
};

// ─── Mouse Scroll ───────────────────────────────────────────────────────────

export const computerMouseScroll: Tool = {
  definition: {
    name: 'computer_mouse_scroll',
    description: 'Scroll the mouse wheel',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Scroll amount in lines (default 3)' },
      },
      required: ['direction'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_mouse_scroll', context);
    const direction = args['direction'] as string;
    const amount = (args['amount'] as number) ?? 3;
    try {
      const scrollAmount = direction === 'up' ? amount : -amount;
      execSync(
        `osascript -l JavaScript -e '
          ObjC.import("CoreGraphics");
          var evt = $.CGEventCreateScrollWheelEvent(null, 0, 1, ${scrollAmount});
          $.CGEventPost($.kCGHIDEventTap, evt);
        '`,
        { timeout: 5000 },
      );
      auditLog(context, 'computer_mouse_scroll', args, true);
      return JSON.stringify({ scrolled: true, direction, amount });
    } catch (err) {
      auditLog(context, 'computer_mouse_scroll', args, false, (err as Error).message);
      return JSON.stringify({ scrolled: false, error: (err as Error).message });
    }
  },
};

// ─── Keyboard Type ──────────────────────────────────────────────────────────

export const computerKeyboardType: Tool = {
  definition: {
    name: 'computer_keyboard_type',
    description: 'Type text using the keyboard',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['text'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_keyboard_type', context);
    const text = args['text'] as string;
    try {
      // Build CGEventCreateKeyboardEvent sequence for each character
      // This uses CoreGraphics directly — requires only Accessibility permission, NOT System Events
      const lines: string[] = [
        'ObjC.import("CoreGraphics");',
        'function postKey(keycode, shift) {',
        '  var flags = shift ? (1 << 17) : 0;',  // kCGEventFlagMaskShift
        '  var down = $.CGEventCreateKeyboardEvent(null, keycode, true);',
        '  var up = $.CGEventCreateKeyboardEvent(null, keycode, false);',
        '  if (shift) { $.CGEventSetFlags(down, flags); $.CGEventSetFlags(up, flags); }',
        '  $.CGEventPost($.kCGHIDEventTap, down);',
        '  $.CGEventPost($.kCGHIDEventTap, up);',
        '  delay(0.02);',
        '}',
      ];

      for (const ch of text) {
        const shiftBase = SHIFT_CHARS[ch];
        if (shiftBase) {
          const keycode = MAC_KEYCODES[shiftBase];
          if (keycode !== undefined) {
            lines.push(`postKey(${keycode}, true);`);
          }
        } else {
          const keycode = MAC_KEYCODES[ch.toLowerCase()];
          if (keycode !== undefined) {
            // Uppercase letters need shift
            const needsShift = ch !== ch.toLowerCase() && ch === ch.toUpperCase() && /[a-zA-Z]/.test(ch);
            lines.push(`postKey(${keycode}, ${needsShift});`);
          }
        }
      }

      const script = lines.join('\n');
      execSync(
        `osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 15000 },
      );
      auditLog(context, 'computer_keyboard_type', args, true);
      return JSON.stringify({ typed: true, length: text.length });
    } catch (err) {
      auditLog(context, 'computer_keyboard_type', args, false, (err as Error).message);
      return JSON.stringify({ typed: false, error: (err as Error).message });
    }
  },
};

// ─── Keyboard Shortcut ──────────────────────────────────────────────────────

export const computerKeyboardShortcut: Tool = {
  definition: {
    name: 'computer_keyboard_shortcut',
    description: 'Press a keyboard shortcut (e.g., command+c)',
    parameters: {
      type: 'object',
      properties: {
        shortcut: { type: 'string', description: 'Shortcut like "command+c", "command+shift+s"' },
      },
      required: ['shortcut'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_keyboard_shortcut', context);
    const shortcut = args['shortcut'] as string;
    try {
      // Parse shortcut into modifier keys and the final key
      const parts = shortcut.toLowerCase().split('+').map((s) => s.trim());
      const key = parts.pop() ?? '';
      const modifiers = parts;

      // Resolve keycode
      const keycode = MAC_KEYCODES[key];
      if (keycode === undefined) {
        throw new Error(`Unknown key: "${key}"`);
      }

      // Compute combined modifier flags via CoreGraphics constants
      let flagExpr = '0';
      if (modifiers.length > 0) {
        const flagParts = modifiers.map((m) => {
          const f = MODIFIER_FLAGS[m];
          if (!f) throw new Error(`Unknown modifier: "${m}"`);
          return f;
        });
        flagExpr = flagParts.join(' | ');
      }

      // Use CGEventCreateKeyboardEvent — requires only Accessibility, NOT System Events
      const script = [
        'ObjC.import("CoreGraphics");',
        `var flags = ${flagExpr};`,
        `var down = $.CGEventCreateKeyboardEvent(null, ${keycode}, true);`,
        `var up = $.CGEventCreateKeyboardEvent(null, ${keycode}, false);`,
        'if (flags) { $.CGEventSetFlags(down, flags); $.CGEventSetFlags(up, flags); }',
        '$.CGEventPost($.kCGHIDEventTap, down);',
        '$.CGEventPost($.kCGHIDEventTap, up);',
      ].join('\n');

      execSync(
        `osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 5000 },
      );
      auditLog(context, 'computer_keyboard_shortcut', args, true);
      return JSON.stringify({ executed: true, shortcut });
    } catch (err) {
      auditLog(context, 'computer_keyboard_shortcut', args, false, (err as Error).message);
      return JSON.stringify({ executed: false, error: (err as Error).message });
    }
  },
};

// ─── App Focus ──────────────────────────────────────────────────────────────

export const computerAppFocus: Tool = {
  definition: {
    name: 'computer_app_focus',
    description: 'Bring an application to the foreground',
    parameters: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'Application name' },
      },
      required: ['appName'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_app_focus', context);
    const appName = args['appName'] as string;
    try {
      // Use NSWorkspace + NSRunningApplication — avoids Apple Events / Automation permission
      const escaped = appName.replace(/'/g, "'\\''").replace(/"/g, '\\"');
      const script = [
        'ObjC.import("AppKit");',
        'var apps = $.NSWorkspace.sharedWorkspace.runningApplications;',
        'var found = false;',
        'for (var i = 0; i < apps.count; i++) {',
        '  var app = apps.objectAtIndex(i);',
        '  var name = app.localizedName;',
        `  if (name && name.js === "${escaped}") {`,
        '    app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);',
        '    found = true; break;',
        '  }',
        '}',
        'if (!found) { throw new Error("App not found: " + "' + escaped + '"); }',
        '"focused";',
      ].join('\n');
      execSync(
        `osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 5000 },
      );
      auditLog(context, 'computer_app_focus', args, true);
      return JSON.stringify({ focused: true, appName });
    } catch (err) {
      // Fallback to open -a which uses Launch Services (no Automation permission)
      try {
        execSync(`open -a "${appName}"`, { timeout: 5000 });
        auditLog(context, 'computer_app_focus', args, true);
        return JSON.stringify({ focused: true, appName, fallback: 'open' });
      } catch (err2) {
        auditLog(context, 'computer_app_focus', args, false, (err2 as Error).message);
        return JSON.stringify({ focused: false, error: (err2 as Error).message });
      }
    }
  },
};

// ─── App Launch ─────────────────────────────────────────────────────────────

export const computerAppLaunch: Tool = {
  definition: {
    name: 'computer_app_launch',
    description: 'Launch an application',
    parameters: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'Application name' },
      },
      required: ['appName'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_app_launch', context);
    const appName = args['appName'] as string;
    try {
      execSync(`open -a "${appName}"`, { timeout: 10000 });
      auditLog(context, 'computer_app_launch', args, true);
      return JSON.stringify({ launched: true, appName });
    } catch (err) {
      auditLog(context, 'computer_app_launch', args, false, (err as Error).message);
      return JSON.stringify({ launched: false, error: (err as Error).message });
    }
  },
};

// ─── App Quit ───────────────────────────────────────────────────────────────

export const computerAppQuit: Tool = {
  definition: {
    name: 'computer_app_quit',
    description: 'Quit an application',
    parameters: {
      type: 'object',
      properties: {
        appName: { type: 'string', description: 'Application name' },
      },
      required: ['appName'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_app_quit', context);
    const appName = args['appName'] as string;
    try {
      // Use NSRunningApplication.terminate — avoids Apple Events / Automation permission
      const escaped = appName.replace(/'/g, "'\\''").replace(/"/g, '\\"');
      const script = [
        'ObjC.import("AppKit");',
        'var apps = $.NSWorkspace.sharedWorkspace.runningApplications;',
        'var found = false;',
        'for (var i = 0; i < apps.count; i++) {',
        '  var app = apps.objectAtIndex(i);',
        '  var name = app.localizedName;',
        `  if (name && name.js === "${escaped}") {`,
        '    app.terminate;',
        '    found = true; break;',
        '  }',
        '}',
        'if (!found) { throw new Error("App not found: " + "' + escaped + '"); }',
        '"quit";',
      ].join('\n');
      execSync(
        `osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 5000 },
      );
      auditLog(context, 'computer_app_quit', args, true);
      return JSON.stringify({ quit: true, appName });
    } catch (err) {
      auditLog(context, 'computer_app_quit', args, false, (err as Error).message);
      return JSON.stringify({ quit: false, error: (err as Error).message });
    }
  },
};

// ─── App List Running ───────────────────────────────────────────────────────

export const computerAppListRunning: Tool = {
  definition: {
    name: 'computer_app_list_running',
    description: 'List currently running applications',
    parameters: { type: 'object', properties: {} },
  },
  async execute(args, context) {
    checkPermission('computer_app_list_running', context);
    try {
      // Use NSWorkspace — no System Events dependency, no Automation permission needed
      const script = [
        'ObjC.import("AppKit");',
        'var apps = $.NSWorkspace.sharedWorkspace.runningApplications;',
        'var names = [];',
        'for (var i = 0; i < apps.count; i++) {',
        '  var app = apps.objectAtIndex(i);',
        '  if (app.activationPolicy === $.NSApplicationActivationPolicyRegular) {',
        '    var name = app.localizedName;',
        '    if (name && name.js) names.push(name.js);',
        '  }',
        '}',
        'names.join("\\n");',
      ].join('\n');

      const raw = execSync(
        `osascript -l JavaScript -e '${script.replace(/'/g, "'\\''")}'`,
        { timeout: 5000, encoding: 'utf-8' },
      ).trim();
      const apps = raw.split('\n').map((s) => s.trim()).filter(Boolean);
      auditLog(context, 'computer_app_list_running', args, true);
      return JSON.stringify({ apps, count: apps.length });
    } catch (err) {
      auditLog(context, 'computer_app_list_running', args, false, (err as Error).message);
      return JSON.stringify({ apps: [], error: (err as Error).message });
    }
  },
};

// ─── Terminal Command ───────────────────────────────────────────────────────

export const computerTerminalCommand: Tool = {
  definition: {
    name: 'computer_terminal_command',
    description: 'Execute a command via the terminal (uses shell sandbox)',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to execute' },
      },
      required: ['command'],
    },
  },
  async execute(args, context) {
    checkPermission('computer_terminal_command', context);
    const command = args['command'] as string;
    // Delegate to the shell tool if registered, otherwise direct exec
    const shellTool = (context.agent as any)?.getToolRegistry?.()?.get?.('shell');
    if (shellTool) {
      const result = await shellTool.execute({ command }, context);
      auditLog(context, 'computer_terminal_command', args, true);
      return result;
    }
    // Fallback: direct exec with safety limits
    try {
      const output = execSync(command, { timeout: 30000, encoding: 'utf-8', maxBuffer: 1024 * 1024 });
      auditLog(context, 'computer_terminal_command', args, true);
      return JSON.stringify({ output: output.slice(0, 4096) });
    } catch (err) {
      auditLog(context, 'computer_terminal_command', args, false, (err as Error).message);
      return JSON.stringify({ error: (err as Error).message });
    }
  },
};

// ─── Export all computer tools ──────────────────────────────────────────────

export function getComputerTools(): Tool[] {
  return [
    computerScreenDimensions,
    computerScreenshot,
    computerMouseMove,
    computerMouseClick,
    computerMouseDrag,
    computerMouseScroll,
    computerKeyboardType,
    computerKeyboardShortcut,
    computerAppFocus,
    computerAppLaunch,
    computerAppQuit,
    computerAppListRunning,
    computerTerminalCommand,
  ];
}
