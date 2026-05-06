/**
 * Command Palette for AgentX Dashboard
 * Global command entry point (Cmd+K / Ctrl+K)
 * Supports navigation, actions, and search
 */

import React, { useState, useEffect, useRef } from 'react';
import './CommandPalette.css';

export interface Command {
  id: string;
  label: string;
  description: string;
  category: 'navigation' | 'action' | 'project' | 'workflow';
  shortcut?: string;
  icon?: string;
  action: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  commands: Command[];
  onNavigate?: (pageId: string) => void;
}

export function CommandPalette({
  isOpen,
  onClose,
  commands,
  onNavigate
}: CommandPaletteProps) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter commands based on search
  const filteredCommands = search
    ? commands.filter(cmd =>
        cmd.label.toLowerCase().includes(search.toLowerCase()) ||
        cmd.description.toLowerCase().includes(search.toLowerCase())
      )
    : commands;

  // Sort by category, then recent/common
  const sortedCommands = [...filteredCommands].sort((a, b) => {
    const categoryOrder = { navigation: 0, action: 1, project: 2, workflow: 3 };
    return (categoryOrder[a.category] ?? 99) - (categoryOrder[b.category] ?? 99);
  });

  // Focus input when opening
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      setSearch('');
      setSelectedIndex(0);
    }
  }, [isOpen]);

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex(prev => (prev + 1) % sortedCommands.length);
          break;

        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex(prev =>
            prev === 0 ? sortedCommands.length - 1 : prev - 1
          );
          break;

        case 'Enter':
          e.preventDefault();
          if (sortedCommands[selectedIndex]) {
            const cmd = sortedCommands[selectedIndex];
            cmd.action();
            onClose();
          }
          break;

        case 'Escape':
          e.preventDefault();
          onClose();
          break;
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
      return () => window.removeEventListener('keydown', handleKeyDown);
    }
  }, [isOpen, selectedIndex, sortedCommands, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const selectedElement = containerRef.current?.querySelector(
      `[data-index="${selectedIndex}"]`
    ) as HTMLElement;

    if (selectedElement) {
      selectedElement.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="command-palette-header">
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder="Type a command or search..."
            value={search}
            onChange={e => {
              setSearch(e.target.value);
              setSelectedIndex(0);
            }}
          />
          <div className="command-palette-hint">ESC to close</div>
        </div>

        {/* Commands List */}
        <div className="command-palette-list" ref={containerRef}>
          {sortedCommands.length === 0 ? (
            <div className="command-palette-empty">
              <div className="empty-icon">⌘</div>
              <div className="empty-text">No commands found</div>
              <div className="empty-hint">Try searching for navigation, actions, or projects</div>
            </div>
          ) : (
            <>
              {/* Group by category */}
              {(['navigation', 'action', 'project', 'workflow'] as const).map(
                category => {
                  const categoryCommands = sortedCommands.filter(
                    cmd => cmd.category === category
                  );

                  if (categoryCommands.length === 0) return null;

                  const categoryLabel = {
                    navigation: 'Navigation',
                    action: 'Actions',
                    project: 'Projects',
                    workflow: 'Workflows'
                  };

                  return (
                    <div key={category} className="command-palette-group">
                      <div className="command-palette-group-label">
                        {categoryLabel[category]}
                      </div>

                      {categoryCommands.map((cmd, idx) => {
                        const globalIndex = sortedCommands.indexOf(cmd);
                        const isSelected = globalIndex === selectedIndex;

                        return (
                          <button
                            key={cmd.id}
                            data-index={globalIndex}
                            className={`command-palette-item ${
                              isSelected ? 'selected' : ''
                            }`}
                            onClick={() => {
                              cmd.action();
                              onClose();
                            }}
                            onMouseEnter={() => setSelectedIndex(globalIndex)}
                          >
                            <div className="command-item-content">
                              {cmd.icon && (
                                <span className="command-item-icon">
                                  {cmd.icon}
                                </span>
                              )}
                              <div className="command-item-text">
                                <div className="command-item-label">
                                  {cmd.label}
                                </div>
                                <div className="command-item-description">
                                  {cmd.description}
                                </div>
                              </div>
                            </div>
                            {cmd.shortcut && (
                              <div className="command-item-shortcut">
                                {cmd.shortcut}
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  );
                }
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="command-palette-footer">
          <div className="footer-hint">
            ↑↓ to navigate • ⏎ to execute • ESC to close
          </div>
        </div>
      </div>
    </div>
  );
}
