/**
 * Runtime State Store for AgentX
 * Single source of truth for system runtime state
 *
 * Tracks:
 * - Active builds and their status
 * - Active workflows and stages
 * - Active agents and their actions
 * - Tool executions
 * - Recent errors
 * - System health
 */

export interface ActiveBuild {
  id: string;
  platform: 'ios' | 'web' | 'python' | 'node';
  appName: string;
  status: 'running' | 'completed' | 'failed';
  progress: number; // 0-100
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface ActiveWorkflow {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  currentStage: string;
  stages: string[];
  stageIndex: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
}

export interface ToolExecution {
  id: string;
  toolName: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  duration?: number;
  error?: string;
}

export interface RecentError {
  id: string;
  message: string;
  source: string;
  severity: 'warning' | 'error' | 'critical';
  timestamp: number;
  stack?: string;
}

export interface RuntimeState {
  // System health
  systemHealth: 'healthy' | 'degraded' | 'offline';
  lastHealthCheck: number;
  activeConnections: number;

  // Active operations
  activeBuilds: Map<string, ActiveBuild>;
  activeBuildCount: number;
  buildSuccessRate: number;

  activeWorkflows: Map<string, ActiveWorkflow>;
  activeWorkflowCount: number;

  toolExecutions: Map<string, ToolExecution>;
  recentToolCount: number;

  // Errors and warnings
  recentErrors: RecentError[];
  errorCount: number;

  // Overall metrics
  uptime: number;
  totalBuildsCompleted: number;
  totalWorkflowsCompleted: number;
  lastEventTimestamp: number;
}

/**
 * Central runtime store
 * Thread-safe state management with event emission
 */
class RuntimeStore {
  private state: RuntimeState = {
    systemHealth: 'healthy',
    lastHealthCheck: Date.now(),
    activeConnections: 0,
    activeBuilds: new Map(),
    activeBuildCount: 0,
    buildSuccessRate: 0,
    activeWorkflows: new Map(),
    activeWorkflowCount: 0,
    toolExecutions: new Map(),
    recentToolCount: 0,
    recentErrors: [],
    errorCount: 0,
    uptime: Date.now(),
    totalBuildsCompleted: 0,
    totalWorkflowsCompleted: 0,
    lastEventTimestamp: Date.now(),
  };

  private listeners: Set<(state: RuntimeState) => void> = new Set();

  /**
   * Get current state snapshot
   */
  getState(): RuntimeState {
    return { ...this.state };
  }

  /**
   * Subscribe to state changes
   */
  subscribe(listener: (state: RuntimeState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Notify all listeners of state change
   */
  private notifyListeners(): void {
    this.listeners.forEach(listener => {
      try {
        listener(this.getState());
      } catch (error) {
        console.error('[RuntimeStore] Error in listener:', error);
      }
    });
  }

  // ─── Build Management ────────────────────────────────────────

  addBuild(build: ActiveBuild): void {
    this.state.activeBuilds.set(build.id, build);
    this.state.activeBuildCount = this.state.activeBuilds.size;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
    console.log(`[agentx:runtime] Build added: ${build.id}`);
  }

  updateBuild(buildId: string, updates: Partial<ActiveBuild>): void {
    const build = this.state.activeBuilds.get(buildId);
    if (build) {
      const updated = { ...build, ...updates, updatedAt: Date.now() };
      this.state.activeBuilds.set(buildId, updated);

      // Update success rate if build completed
      if (updated.status === 'completed') {
        this.updateBuildSuccessRate();
        this.state.totalBuildsCompleted++;
      }

      this.state.lastEventTimestamp = Date.now();
      this.notifyListeners();
      console.log(`[agentx:runtime] Build updated: ${buildId}`, updates);
    }
  }

  removeBuild(buildId: string): void {
    this.state.activeBuilds.delete(buildId);
    this.state.activeBuildCount = this.state.activeBuilds.size;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
    console.log(`[agentx:runtime] Build removed: ${buildId}`);
  }

  getActiveBuild(buildId: string): ActiveBuild | undefined {
    return this.state.activeBuilds.get(buildId);
  }

  getActiveBuildsList(): ActiveBuild[] {
    return Array.from(this.state.activeBuilds.values());
  }

  private updateBuildSuccessRate(): void {
    const allBuilds = Array.from(this.state.activeBuilds.values());
    const successful = allBuilds.filter(b => b.status === 'completed').length;
    this.state.buildSuccessRate = allBuilds.length > 0
      ? Math.round((successful / allBuilds.length) * 100)
      : 0;
  }

  // ─── Workflow Management ─────────────────────────────────────

  addWorkflow(workflow: ActiveWorkflow): void {
    this.state.activeWorkflows.set(workflow.id, workflow);
    this.state.activeWorkflowCount = this.state.activeWorkflows.size;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
    console.log(`[agentx:runtime] Workflow added: ${workflow.id}`);
  }

  updateWorkflow(workflowId: string, updates: Partial<ActiveWorkflow>): void {
    const workflow = this.state.activeWorkflows.get(workflowId);
    if (workflow) {
      const updated = { ...workflow, ...updates, updatedAt: Date.now() };
      this.state.activeWorkflows.set(workflowId, updated);

      if (updated.status === 'completed') {
        this.state.totalWorkflowsCompleted++;
      }

      this.state.lastEventTimestamp = Date.now();
      this.notifyListeners();
      console.log(`[agentx:runtime] Workflow updated: ${workflowId}`, updates);
    }
  }

  removeWorkflow(workflowId: string): void {
    this.state.activeWorkflows.delete(workflowId);
    this.state.activeWorkflowCount = this.state.activeWorkflows.size;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
    console.log(`[agentx:runtime] Workflow removed: ${workflowId}`);
  }

  getActiveWorkflowsList(): ActiveWorkflow[] {
    return Array.from(this.state.activeWorkflows.values());
  }

  // ─── Tool Execution Management ───────────────────────────────

  addToolExecution(execution: ToolExecution): void {
    this.state.toolExecutions.set(execution.id, execution);
    this.state.recentToolCount = this.state.toolExecutions.size;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
    console.log(`[agentx:runtime] Tool execution added: ${execution.id}`);
  }

  completeToolExecution(executionId: string, duration: number, error?: string): void {
    const execution = this.state.toolExecutions.get(executionId);
    if (execution) {
      const updated: ToolExecution = {
        ...execution,
        status: error ? 'failed' : 'completed',
        completedAt: Date.now(),
        duration,
        error,
      };
      this.state.toolExecutions.set(executionId, updated);
      this.state.lastEventTimestamp = Date.now();
      this.notifyListeners();
      console.log(`[agentx:runtime] Tool execution completed: ${executionId}`);
    }
  }

  // ─── Error Management ───────────────────────────────────────

  addError(error: RecentError): void {
    this.state.recentErrors.unshift(error);
    if (this.state.recentErrors.length > 50) {
      this.state.recentErrors.pop();
    }
    this.state.errorCount++;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
    console.log(`[agentx:runtime] Error added: ${error.source}`, error.message);
  }

  getRecentErrors(limit = 10): RecentError[] {
    return this.state.recentErrors.slice(0, limit);
  }

  // ─── System Health ──────────────────────────────────────────

  setSystemHealth(health: 'healthy' | 'degraded' | 'offline', reason?: string): void {
    if (this.state.systemHealth !== health) {
      console.log(`[agentx:runtime] System health changed: ${this.state.systemHealth} → ${health}${reason ? ` (${reason})` : ''}`);
    }
    this.state.systemHealth = health;
    this.state.lastHealthCheck = Date.now();
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
  }

  setActiveConnections(count: number): void {
    this.state.activeConnections = count;
    this.state.lastEventTimestamp = Date.now();
    this.notifyListeners();
  }

  // ─── Metrics ────────────────────────────────────────────────

  getMetrics() {
    return {
      systemHealth: this.state.systemHealth,
      activeBuilds: this.state.activeBuildCount,
      activeWorkflows: this.state.activeWorkflowCount,
      recentTools: this.state.recentToolCount,
      buildSuccessRate: this.state.buildSuccessRate,
      errorCount: this.state.errorCount,
      uptime: Date.now() - this.state.uptime,
      totalBuildsCompleted: this.state.totalBuildsCompleted,
      totalWorkflowsCompleted: this.state.totalWorkflowsCompleted,
      recentErrors: this.getRecentErrors(5),
    };
  }

  /**
   * Reset store (for testing)
   */
  reset(): void {
    this.state = {
      systemHealth: 'healthy',
      lastHealthCheck: Date.now(),
      activeConnections: 0,
      activeBuilds: new Map(),
      activeBuildCount: 0,
      buildSuccessRate: 0,
      activeWorkflows: new Map(),
      activeWorkflowCount: 0,
      toolExecutions: new Map(),
      recentToolCount: 0,
      recentErrors: [],
      errorCount: 0,
      uptime: Date.now(),
      totalBuildsCompleted: 0,
      totalWorkflowsCompleted: 0,
      lastEventTimestamp: Date.now(),
    };
    this.notifyListeners();
  }
}

// Export singleton instance
export const runtimeStore = new RuntimeStore();

// Also export the class for testing
export { RuntimeStore };
