import React, { useState, useEffect } from 'react';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PageErrorBoundary } from './components/PageErrorBoundary';
import { CommandPalette, type Command } from './components/CommandPalette';
import { Dashboard } from './pages/Dashboard';
import { Chat } from './pages/Chat';
import { Vision } from './pages/Vision';
import { Voice } from './pages/Voice';
import { Projects } from './pages/Projects';
import { Memory } from './pages/Memory';
import { Models } from './pages/Models';
import { Tools } from './pages/Tools';
import { Logs } from './pages/Logs';
import { Settings } from './pages/Settings';
import { Cognitive } from './pages/Cognitive';
import { ValidationLab } from './pages/ValidationLab';
import { Integrity } from './pages/Integrity';
import { AgentLoopsPanel } from './pages/AgentLoops';
import { initDB } from './utils/db-cache';
import { useKeyboardShortcuts, commonShortcuts } from './hooks/useKeyboardShortcuts';
import { eventBus } from './utils/event-bus';
import { runtimeStore } from './utils/runtime-store';
import { telemetry } from './utils/telemetry';

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

export function App() {
  const [currentPage, setCurrentPage] = useState<Page>('dashboard');
  const [isDark, setIsDark] = useState(true);
  const [systemHealth, setSystemHealth] = useState<'healthy' | 'degraded' | 'offline'>('healthy');
  const [isCommandPaletteOpen, setIsCommandPaletteOpen] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Setup keyboard shortcuts
  useKeyboardShortcuts([
    commonShortcuts.commandPalette(() => setIsCommandPaletteOpen(true)),
    commonShortcuts.navigate('d', () => setCurrentPage('dashboard')),
    commonShortcuts.navigate('p', () => setCurrentPage('projects')),
    commonShortcuts.navigate('l', () => setCurrentPage('logs')),
    commonShortcuts.navigate('s', () => setCurrentPage('settings')),
    commonShortcuts.navigate('r', () => setCurrentPage('cognitive')),
  ]);

  // Build command palette commands
  const commands: Command[] = [
    // Navigation
    {
      id: 'nav-dashboard',
      label: 'Dashboard',
      description: 'View main dashboard',
      category: 'navigation',
      shortcut: 'g d',
      icon: '📊',
      action: () => setCurrentPage('dashboard')
    },
    {
      id: 'nav-chat',
      label: 'Chat',
      description: 'Open chat interface',
      category: 'navigation',
      shortcut: 'g c',
      icon: '💬',
      action: () => setCurrentPage('chat')
    },
    {
      id: 'nav-projects',
      label: 'Projects',
      description: 'View all projects and workflow statistics',
      category: 'navigation',
      shortcut: 'g p',
      icon: '📁',
      action: () => setCurrentPage('projects')
    },
    {
      id: 'nav-memory',
      label: 'Build Memory',
      description: 'View learning patterns',
      category: 'navigation',
      shortcut: 'g m',
      icon: '🧠',
      action: () => setCurrentPage('memory')
    },
    {
      id: 'nav-logs',
      label: 'Logs',
      description: 'View system logs',
      category: 'navigation',
      shortcut: 'g l',
      icon: '📝',
      action: () => setCurrentPage('logs')
    },
    {
      id: 'nav-settings',
      label: 'Settings',
      description: 'Configure dashboard',
      category: 'navigation',
      shortcut: 'g s',
      icon: '⚡',
      action: () => setCurrentPage('settings')
    },
    {
      id: 'nav-cognitive',
      label: 'Cognitive',
      description: 'Frontier research agent runtime',
      category: 'navigation',
      shortcut: 'g r',
      icon: '🧠',
      action: () => setCurrentPage('cognitive')
    },
    {
      id: 'nav-validation',
      label: 'Validation Lab',
      description: 'Autonomous validation and self-improvement harness',
      category: 'navigation',
      shortcut: 'g v',
      icon: '🧪',
      action: () => setCurrentPage('validation')
    },
    {
      id: 'nav-integrity',
      label: 'Integrity',
      description: 'System integrity monitor and self-repair',
      category: 'navigation',
      shortcut: 'g i',
      icon: '🛡️',
      action: () => setCurrentPage('integrity')
    },

    // Actions
    {
      id: 'action-new-build',
      label: 'New Build',
      description: 'Start a new app generation',
      category: 'action',
      icon: '🔨',
      action: () => {
        setCurrentPage('chat');
        setIsCommandPaletteOpen(false);
      }
    },
    {
      id: 'action-refresh',
      label: 'Refresh Data',
      description: 'Manually refresh all panels',
      category: 'action',
      icon: '🔄',
      action: () => {
        // Trigger refresh across all panels
        window.dispatchEvent(new CustomEvent('refresh-all-data'));
        setIsCommandPaletteOpen(false);
      }
    },
    {
      id: 'action-toggle-theme',
      label: 'Toggle Theme',
      description: isDark ? 'Switch to light mode' : 'Switch to dark mode',
      category: 'action',
      icon: isDark ? '☀️' : '🌙',
      action: () => {
        setIsDark(!isDark);
        setIsCommandPaletteOpen(false);
      }
    }
  ];

  useEffect(() => {
    // Initialize service worker — skip in dev mode where Vite's SPA fallback
    // returns HTML for the SW path, causing a MIME-type SecurityError.
    // Detect dev mode by checking if the SW URL resolves to a JS file.
    const registerServiceWorker = async () => {
      if (!('serviceWorker' in navigator)) return;
      // Probe the SW URL first — in dev mode Vite returns HTML (SPA fallback),
      // which causes a MIME-type SecurityError on register(). Skip if not JS.
      //
      // The @vite-ignore is intentional: vite warns because the .js file
      // doesn't exist at source-resolve time, but our vite.config.ts emits
      // it at /service-worker.js (a second entry point, root-of-dist, NOT
      // /assets/). The literal URL is correct at runtime; we just want
      // vite to stop trying to bundle it as a JS module.
      const swUrl = new URL(/* @vite-ignore */ './service-worker.js', import.meta.url);
      try {
        const probe = await fetch(swUrl, { method: 'HEAD' });
        const ct = probe.headers.get('content-type') ?? '';
        if (!ct.includes('javascript')) return;
      } catch { return; }
      try {
        const registration = await navigator.serviceWorker.register(swUrl, { type: 'module' });
        console.log('[App] Service worker registered:', registration);
        setInterval(() => { registration.update().catch(console.error); }, 60000);
      } catch (error) {
        console.error('[App] Service worker registration failed:', error);
      }
    };

    // Initialize IndexedDB
    const initializeDB = async () => {
      try {
        await initDB();
        console.log('[App] Database initialized');
      } catch (error) {
        console.error('[App] Database initialization failed:', error);
      }
    };

    // Listen for service worker update notifications
    const swMessageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'SW_UPDATED') {
        console.log('[App] New version available:', event.data.build);
        setUpdateAvailable(true);
      }
    };
    navigator.serviceWorker?.addEventListener('message', swMessageHandler);

    registerServiceWorker();
    initializeDB();

    // Poll system health and update runtime store
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/health');
        const health = res.ok ? 'healthy' : 'degraded';
        setSystemHealth(health);
        runtimeStore.setSystemHealth(health);

        // Emit health event
        eventBus.emit('system.health_changed', {
          status: health,
          timestamp: Date.now(),
        });

        telemetry.runtime('health_check', { status: health });
      } catch (error) {
        const health = 'offline';
        setSystemHealth(health);
        runtimeStore.setSystemHealth(health, 'Network error');

        // Emit health event
        eventBus.emit('system.health_changed', {
          status: health,
          reason: error instanceof Error ? error.message : 'Unknown error',
          timestamp: Date.now(),
        });

        telemetry.runtime('health_check_failed', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    };

    checkHealth();
    const interval = setInterval(checkHealth, 10000);

    telemetry.runtime('app_initialized', { timestamp: Date.now() });

    return () => {
      clearInterval(interval);
      navigator.serviceWorker?.removeEventListener('message', swMessageHandler);
    };
  }, [isDark]);

  const renderPage = () => {
    switch (currentPage) {
      case 'dashboard':
        return <Dashboard />;
      case 'chat':
        return <Chat />;
      case 'vision':
        return <Vision />;
      case 'voice':
        return <Voice />;
      case 'projects':
        return <Projects />;
      case 'memory':
        return <Memory />;
      case 'models':
        return <Models />;
      case 'tools':
        return <Tools />;
      case 'logs':
        return <Logs />;
      case 'settings':
        return <Settings />;
      case 'cognitive':
        return <Cognitive />;
      case 'validation':
        return <ValidationLab />;
      case 'integrity':
        return <Integrity />;
      case 'agent-loops':
        return <AgentLoopsPanel />;
      default:
        return <Dashboard />;
    }
  };

  return (
    <div className={`app-container ${isDark ? 'dark' : 'light'}`}>
      {updateAvailable && (
        <div
          onClick={() => window.location.reload()}
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
            padding: '10px', textAlign: 'center', cursor: 'pointer',
            background: '#1f6feb', color: '#fff', fontSize: '14px', fontWeight: 600,
          }}
        >
          New version available — click to refresh
        </div>
      )}
      <Header
        systemHealth={systemHealth}
        isDark={isDark}
        onThemeToggle={() => setIsDark(!isDark)}
      />
      <div className="app-content">
        <Sidebar currentPage={currentPage} onPageChange={setCurrentPage} />
        <main className="main-content">
          <PageErrorBoundary pageKey={currentPage}>
            {renderPage()}
          </PageErrorBoundary>
        </main>
      </div>
      <OfflineIndicator />
      <CommandPalette
        isOpen={isCommandPaletteOpen}
        onClose={() => setIsCommandPaletteOpen(false)}
        commands={commands}
      />
    </div>
  );
}
