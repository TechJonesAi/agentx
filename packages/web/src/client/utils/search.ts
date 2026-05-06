/**
 * Global Search Utilities
 * Search across projects, workflows, sessions, tools, and memory
 */

export interface SearchResult {
  id: string;
  title: string;
  description?: string;
  category: 'project' | 'workflow' | 'session' | 'tool' | 'memory';
  metadata?: Record<string, any>;
  score: number;  // 0-1, for ranking
}

/**
 * Calculate similarity score between query and text
 * Simple algorithm: character presence + word prefix match
 */
export function calculateScore(query: string, text: string): number {
  if (!query || !text) return 0;

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact match
  if (t === q) return 1.0;

  // Prefix match
  if (t.startsWith(q)) return 0.9;

  // Contains match
  if (t.includes(q)) return 0.7;

  // Word prefix match
  const words = t.split(/[\s\-_]+/);
  if (words.some(w => w.startsWith(q))) return 0.8;

  // Character presence (loose match)
  let charCount = 0;
  let queryIndex = 0;

  for (let i = 0; i < t.length && queryIndex < q.length; i++) {
    if (t[i] === q[queryIndex]) {
      charCount++;
      queryIndex++;
    }
  }

  if (charCount === q.length) {
    return 0.3 + (charCount / q.length) * 0.3;
  }

  return 0;
}

/**
 * Search projects
 */
export function searchProjects(
  query: string,
  projects: any[]
): SearchResult[] {
  if (!query) return [];

  return projects
    .map(project => {
      const nameScore = calculateScore(query, project.name || '');
      const platformScore = calculateScore(query, project.platform || '');
      const score = Math.max(nameScore, platformScore);

      if (score === 0) return null;

      return {
        id: project.id,
        title: project.name,
        description: `${project.platform} • ${project.status || 'unknown'}`,
        category: 'project' as const,
        metadata: { project },
        score
      };
    })
    .filter(Boolean) as SearchResult[];
}

/**
 * Search workflows
 */
export function searchWorkflows(
  query: string,
  workflows: any[]
): SearchResult[] {
  if (!query) return [];

  return workflows
    .map(workflow => {
      const nameScore = calculateScore(query, workflow.name || '');
      const statusScore = calculateScore(query, workflow.status || '');
      const score = Math.max(nameScore, statusScore);

      if (score === 0) return null;

      return {
        id: workflow.id,
        title: workflow.name,
        description: `Workflow • ${workflow.status || 'unknown'} • ${workflow.taskCount || 0} tasks`,
        category: 'workflow' as const,
        metadata: { workflow },
        score
      };
    })
    .filter(Boolean) as SearchResult[];
}

/**
 * Search sessions
 */
export function searchSessions(
  query: string,
  sessions: any[]
): SearchResult[] {
  if (!query) return [];

  return sessions
    .map(session => {
      const idScore = calculateScore(query, session.sessionId || '');
      const channelScore = calculateScore(query, session.channel || '');
      const score = Math.max(idScore, channelScore);

      if (score === 0) return null;

      return {
        id: session.sessionId,
        title: session.sessionId,
        description: `Chat Session • ${session.channel || 'web'}`,
        category: 'session' as const,
        metadata: { session },
        score
      };
    })
    .filter(Boolean) as SearchResult[];
}

/**
 * Search tools
 */
export function searchTools(
  query: string,
  tools: any[]
): SearchResult[] {
  if (!query) return [];

  return tools
    .map(tool => {
      const nameScore = calculateScore(query, tool.name || '');
      const descScore = calculateScore(query, tool.description || '');
      const categoryScore = calculateScore(query, tool.category || '');
      const score = Math.max(nameScore, descScore, categoryScore);

      if (score === 0) return null;

      return {
        id: tool.name,
        title: tool.name,
        description: `${tool.category || 'tool'} • ${tool.enabled ? 'enabled' : 'disabled'}`,
        category: 'tool' as const,
        metadata: { tool },
        score
      };
    })
    .filter(Boolean) as SearchResult[];
}

/**
 * Global search across all data
 */
export function globalSearch(
  query: string,
  {
    projects = [],
    workflows = [],
    sessions = [],
    tools = []
  }: {
    projects?: any[];
    workflows?: any[];
    sessions?: any[];
    tools?: any[];
  }
): SearchResult[] {
  const results: SearchResult[] = [];

  // Search each category
  results.push(...searchProjects(query, projects));
  results.push(...searchWorkflows(query, workflows));
  results.push(...searchSessions(query, sessions));
  results.push(...searchTools(query, tools));

  // Sort by score (descending) and category
  return results.sort((a, b) => {
    // Higher score first
    if (b.score !== a.score) return b.score - a.score;

    // Then by category priority
    const categoryOrder = { project: 0, workflow: 1, session: 2, memory: 3, tool: 4 };
    return (categoryOrder[a.category] ?? 99) - (categoryOrder[b.category] ?? 99);
  });
}

/**
 * Get suggested searches from recent items
 */
export function getSuggestedSearches(maxCount = 5): string[] {
  // Could pull from localStorage or recent history
  // For now, return empty
  return [];
}
