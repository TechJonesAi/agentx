/**
 * ChatSidebar — right-rail panel for the Chat page.
 *
 * Visual restoration adapted from Silly Johnson. Hosts:
 *   1. Multimodal status badges (TTS, Vision, STT) — one-shot availability
 *      probes on mount; each badge shows green/grey based on whether the
 *      corresponding /health-style endpoint reports the feature is ready.
 *      NO POLLING.
 *   2. Project Workflow summary — one-shot fetch of /api/projects, renders
 *      the stat summary or "unavailable" when the call fails.
 *   3. Active Build slot — currently always empty (no build-progress
 *      streaming wired on this branch). Renders BuildCardEmpty.
 *
 * This panel never calls shimmed endpoints in a polling loop. Each fetch
 * is a single shot on mount; failure → unavailable state.
 */
import React, { useEffect, useState } from 'react';
import { BuildCardEmpty } from './BuildCard';

interface ProjectStats {
  activeProjects: number;
  completedProjects: number;
  totalProjects: number;
  pendingTasks: number;
  openIssues: number;
  averageHealth: number;
}

interface AvailabilityState {
  tts: 'unknown' | 'available' | 'unavailable';
  vision: 'unknown' | 'available' | 'unavailable';
  stt: 'unknown' | 'available' | 'unavailable';
}

async function probe(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) return false;
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // Common shapes: {available:true}, {ok:true}, {ready:true}, {state:'active'}
    if (j['available'] === true || j['ok'] === true || j['ready'] === true) return true;
    if (typeof j['state'] === 'string' && j['state'] !== 'unavailable') return true;
    // /api/multimodal/status returns { vision:{available,...}, stt:{...}, tts:{...} }
    return false;
  } catch {
    return false;
  }
}

export function ChatSidebar(): React.JSX.Element {
  const [availability, setAvailability] = useState<AvailabilityState>({
    tts: 'unknown', vision: 'unknown', stt: 'unknown',
  });
  const [projects, setProjects] = useState<ProjectStats | null>(null);
  const [projectsError, setProjectsError] = useState(false);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const [ttsOk] = await Promise.all([probe('/api/tts/health')]);
      if (!cancelled) {
        setAvailability((a) => ({ ...a, tts: ttsOk ? 'available' : 'unavailable' }));
      }
    })();

    void (async () => {
      try {
        const r = await fetch('/api/multimodal/status', { signal: AbortSignal.timeout(3000) });
        const j = (await r.json().catch(() => ({}))) as {
          vision?: { available?: boolean };
          stt?: { available?: boolean };
          tts?: { available?: boolean };
        };
        if (cancelled) return;
        setAvailability((a) => ({
          ...a,
          vision: j?.vision?.available ? 'available' : 'unavailable',
          stt: j?.stt?.available ? 'available' : 'unavailable',
        }));
      } catch {
        if (cancelled) return;
        setAvailability((a) => ({ ...a, vision: 'unavailable', stt: 'unavailable' }));
      }
    })();

    void (async () => {
      try {
        const r = await fetch('/api/projects', { signal: AbortSignal.timeout(3000) });
        if (!r.ok) throw new Error('not ok');
        const j = (await r.json()) as ProjectStats;
        if (!cancelled) setProjects(j);
      } catch {
        if (!cancelled) setProjectsError(true);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  const badge = (label: string, state: AvailabilityState[keyof AvailabilityState]): React.JSX.Element => {
    const colour =
      state === 'available' ? '#3fb950' :
      state === 'unavailable' ? '#6e7681' : '#d29922';
    const text =
      state === 'available' ? 'ready' :
      state === 'unavailable' ? 'unavailable' : 'checking…';
    return (
      <div className="chat-sidebar__badge"
        style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 10px', background: 'var(--bg-secondary, #161b22)',
          border: '1px solid var(--border, #30363d)', borderRadius: '6px',
          marginBottom: '6px', fontSize: '12px',
        }}>
        <span>{label}</span>
        <span style={{ color: colour, fontWeight: 600 }}>● {text}</span>
      </div>
    );
  };

  return (
    <aside className="chat-sidebar"
      style={{
        width: '260px', flexShrink: 0, padding: '12px',
        borderLeft: '1px solid var(--border, #30363d)',
        background: 'var(--bg-primary, #0d1117)',
        overflow: 'auto',
      }}>
      <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-secondary, #8b949e)', margin: '4px 0 8px' }}>
        Multimodal
      </h3>
      {badge('Text-to-speech', availability.tts)}
      {badge('Vision (OCR/Ollama)', availability.vision)}
      {badge('Speech-to-text', availability.stt)}

      <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-secondary, #8b949e)', margin: '14px 0 8px' }}>
        Projects
      </h3>
      {projectsError ? (
        <div className="chat-sidebar__empty"
          style={{
            padding: '10px', background: 'var(--bg-secondary, #161b22)',
            border: '1px dashed var(--border, #30363d)', borderRadius: '6px',
            fontSize: '12px', color: 'var(--text-tertiary, #6e7681)',
          }}>
          Projects panel unavailable on this build.
        </div>
      ) : projects === null ? (
        <div style={{ fontSize: '12px', color: 'var(--text-tertiary, #6e7681)' }}>Loading…</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', fontSize: '12px' }}>
          <Stat label="Active" value={projects.activeProjects} />
          <Stat label="Done" value={projects.completedProjects} />
          <Stat label="Total" value={projects.totalProjects} />
          <Stat label="Tasks" value={projects.pendingTasks} />
          <Stat label="Issues" value={projects.openIssues} />
          <Stat label="Health" value={projects.averageHealth} />
        </div>
      )}

      <h3 style={{ fontSize: '12px', textTransform: 'uppercase', color: 'var(--text-secondary, #8b949e)', margin: '14px 0 8px' }}>
        Active build
      </h3>
      <BuildCardEmpty />
    </aside>
  );
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div style={{
      padding: '6px 8px', background: 'var(--bg-secondary, #161b22)',
      border: '1px solid var(--border, #30363d)', borderRadius: '6px',
    }}>
      <div style={{ color: 'var(--text-tertiary, #6e7681)', fontSize: '10px', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ fontWeight: 600, fontSize: '14px' }}>{value}</div>
    </div>
  );
}
