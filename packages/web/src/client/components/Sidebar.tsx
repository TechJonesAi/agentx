import React from 'react';
import {
  Dashboard,
  MessageSquare,
  Eye,
  Mic,
  Folder,
  Zap,
  Brain,
  Cpu,
  Settings,
  LogOut,
} from './Icons';
import './Sidebar.css';

type Page =
  | 'dashboard'
  | 'chat'
  | 'vision'
  | 'voice'
  | 'projects'
  | 'memory'
  | 'models'
  | 'tools'
  | 'logs'
  | 'settings'
  | 'cognitive'
  | 'validation'
  | 'integrity'
  | 'agent-loops';

interface SidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
}

const navItems = [
  { id: 'dashboard', label: 'Dashboard', icon: Dashboard, section: 'Core' },
  { id: 'chat', label: 'Chat', icon: MessageSquare, section: 'Core' },
  { id: 'vision', label: 'Vision', icon: Eye, section: 'Capabilities' },
  { id: 'voice', label: 'Voice', icon: Mic, section: 'Capabilities' },
  { id: 'projects', label: 'Projects', icon: Folder, section: 'Workflows' },
  { id: 'memory', label: 'Memory', icon: Brain, section: 'Intelligence' },
  { id: 'cognitive', label: 'Cognitive', icon: Zap, section: 'Intelligence' },
  { id: 'agent-loops', label: 'Agent Loops', icon: Zap, section: 'Intelligence' },
  { id: 'validation', label: 'Validation', icon: Cpu, section: 'Intelligence' },
  { id: 'integrity', label: 'Integrity', icon: Cpu, section: 'Monitoring' },
  { id: 'models', label: 'Models', icon: Cpu, section: 'Configuration' },
  { id: 'tools', label: 'Tools', icon: Settings, section: 'Configuration' },
  { id: 'logs', label: 'Logs', icon: Brain, section: 'Monitoring' },
  { id: 'settings', label: 'Settings', icon: Settings, section: 'System' },
] as const;

export function Sidebar({ currentPage, onPageChange }: SidebarProps) {
  const sections = new Map<string, typeof navItems[number][]>();

  navItems.forEach((item) => {
    if (!sections.has(item.section)) {
      sections.set(item.section, []);
    }
    sections.get(item.section)!.push(item);
  });

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {Array.from(sections.entries()).map(([sectionName, items]) => (
          <div key={sectionName} className="nav-section">
            <div className="nav-section-title">{sectionName}</div>
            <div className="nav-section-items">
              {items.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    className={`nav-item ${currentPage === item.id ? 'active' : ''}`}
                    onClick={() => onPageChange(item.id as Page)}
                    title={item.label}
                  >
                    <Icon />
                    <span className="nav-label">{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <footer className="sidebar-footer">
        <button className="nav-item logout" title="Logout">
          <LogOut />
          <span className="nav-label">Logout</span>
        </button>
      </footer>
    </aside>
  );
}
