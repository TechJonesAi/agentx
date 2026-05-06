/**
 * Keyboard Shortcuts Hook
 * Manages global and local keyboard shortcuts
 */

import { useEffect } from 'react';

export interface Shortcut {
  keys: string[];  // e.g., ['meta', 'k'] or ['g', 'd']
  description: string;
  handler: () => void;
  preventDefault?: boolean;  // Default: true
}

/**
 * Normalize key names for cross-platform consistency
 */
function normalizeKey(key: string): string {
  const normalized: { [key: string]: string } = {
    'Meta': 'meta',        // Mac Command key
    'Control': 'ctrl',     // Ctrl
    'Shift': 'shift',
    'Alt': 'alt',
    'ArrowUp': 'arrowup',
    'ArrowDown': 'arrowdown',
    'ArrowLeft': 'arrowleft',
    'ArrowRight': 'arrowright',
    'Enter': 'enter',
    'Escape': 'escape',
    ' ': 'space',
  };

  return normalized[key] || key.toLowerCase();
}

/**
 * Check if modifier keys match
 */
function isModifierMatch(
  event: KeyboardEvent,
  requiredModifiers: string[]
): boolean {
  const eventModifiers = [
    event.ctrlKey ? 'ctrl' : null,
    event.metaKey ? 'meta' : null,
    event.shiftKey ? 'shift' : null,
    event.altKey ? 'alt' : null
  ].filter(Boolean) as string[];

  const requiredSet = new Set(requiredModifiers);
  const eventSet = new Set(eventModifiers);

  // Check if all required modifiers are present
  for (const mod of requiredSet) {
    if (!eventSet.has(mod)) return false;
  }

  // Check if there are unexpected modifiers
  for (const mod of eventSet) {
    if (!requiredSet.has(mod)) return false;
  }

  return true;
}

/**
 * Hook for managing keyboard shortcuts
 */
export function useKeyboardShortcuts(shortcuts: Shortcut[], enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const normalizedKey = normalizeKey(event.key);

      for (const shortcut of shortcuts) {
        if (shortcut.keys.length === 0) continue;

        // Last key is the main key, others are modifiers
        const mainKey = shortcut.keys[shortcut.keys.length - 1];
        const modifiers = shortcut.keys.slice(0, -1);

        // Check if main key matches
        if (normalizedKey !== mainKey) continue;

        // Check if all modifiers match
        if (!isModifierMatch(event, modifiers)) continue;

        // Found a match!
        if (shortcut.preventDefault !== false) {
          event.preventDefault();
        }

        shortcut.handler();
        break;  // Stop after first match
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [shortcuts, enabled]);
}

/**
 * Common keyboard shortcut patterns
 */
export const commonShortcuts = {
  // Command/Ctrl + K
  commandPalette: (handler: () => void): Shortcut => ({
    keys: ['meta', 'k'],
    description: 'Open command palette',
    handler,
    preventDefault: true
  }),

  // Escape
  escape: (handler: () => void): Shortcut => ({
    keys: ['escape'],
    description: 'Close dialog/escape',
    handler,
    preventDefault: false
  }),

  // Navigation shortcuts (g prefix)
  navigate: (letter: string, handler: () => void): Shortcut => ({
    keys: ['g', letter],
    description: `Navigate to ${letter}`,
    handler,
    preventDefault: true
  }),

  // Refresh
  refresh: (handler: () => void): Shortcut => ({
    keys: ['r'],
    description: 'Refresh current data',
    handler,
    preventDefault: true
  }),

  // Search
  search: (handler: () => void): Shortcut => ({
    keys: ['meta', 'f'],
    description: 'Search',
    handler,
    preventDefault: true
  }),

  // Settings
  settings: (handler: () => void): Shortcut => ({
    keys: ['meta', ','],
    description: 'Open settings',
    handler,
    preventDefault: true
  })
};

/**
 * Format keyboard shortcut for display
 */
export function formatShortcut(keys: string[]): string {
  const isMac = typeof navigator !== 'undefined' &&
    navigator.platform.toUpperCase().includes('MAC');

  return keys.map(key => {
    if (key === 'meta') return isMac ? '⌘' : 'Ctrl';
    if (key === 'ctrl') return isMac ? '⌃' : 'Ctrl';
    if (key === 'shift') return isMac ? '⇧' : 'Shift';
    if (key === 'alt') return isMac ? '⌥' : 'Alt';
    if (key === 'enter') return '⏎';
    if (key === 'escape') return 'Esc';
    if (key === 'space') return '␣';
    if (key === 'arrowup') return '↑';
    if (key === 'arrowdown') return '↓';
    if (key === 'arrowleft') return '←';
    if (key === 'arrowright') return '→';
    return key.toUpperCase();
  }).join(isMac ? '' : '+');
}
