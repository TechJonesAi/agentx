/**
 * User Personalization Layer — Phase 11B
 *
 * Captures user-specific signals and biases build decisions safely,
 * coexisting with global intelligence as a weighted overlay.
 *
 * Design principles:
 * - Personalization is a BIAS layer, not a replacement for global intelligence.
 * - When user data is absent, behavior is identical to pre-11B.
 * - Global intelligence dominates when user signal is weak or conflicts.
 * - All data is local-first (SQLite), keyed by user_id.
 * - Multi-user ready: each user_id gets an independent profile.
 */

import type { GlobalLearningService, GlobalLearningEvent } from './global-learning.js';
import type { BuildAction } from './build-learning-adapter.js';
import type { BuildRecommendations, ActionEffectiveness, IntelligenceConfig } from './build-intelligence.js';
import { DEFAULT_INTELLIGENCE_CONFIG } from './build-intelligence.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** User-specific preference profile, persisted as JSON. */
export interface UserPreferenceProfile {
  user_id: string;
  /** Model preference bias: 'fast' | 'deep' | 'coding' | null */
  model_preference: 'fast' | 'deep' | 'coding' | null;
  /** Strategy bias: positive favors regenerate, negative favors repair. Range [-1, 1]. */
  strategy_bias: number;
  /** Retry tolerance: 0–1 scale. 0 = low patience, 1 = high patience. */
  retry_tolerance: number;
  /** Output style: 'concise' | 'detailed' | null */
  output_style: 'concise' | 'detailed' | null;
  /** Task type affinities: which types this user works with most. */
  task_affinities: Record<string, number>;
  /** Model-specific success rates from this user's history. */
  model_history: Record<string, { total: number; successes: number }>;
  /** Action-specific success rates from this user's history. */
  action_history: Record<string, { total: number; successes: number }>;
  /** Total decisions observed for this user. */
  total_decisions: number;
  /** Last updated timestamp (epoch ms). */
  updated_at: number;
}

/** Feedback signal types captured from user behavior. */
export type FeedbackSignalType =
  | 'outcome_accepted'  // user accepted build output
  | 'outcome_rejected'  // user rejected build output
  | 'retry_triggered'   // user triggered a retry
  | 'manual_override'   // user manually changed a decision
  | 'build_aborted'     // user aborted the build
  | 'model_selected'    // user explicitly chose a model
  | 'strategy_selected'; // user explicitly chose a strategy

export interface FeedbackSignal {
  user_id: string;
  signal_type: FeedbackSignalType;
  task_type: string;
  model?: string;
  strategy?: string;
  action?: BuildAction;
  outcome?: 'success' | 'failure';
  detail?: string;
}

/** Personalized recommendations that layer on top of global intelligence. */
export interface PersonalizedRecommendations {
  /** User-biased model ranking boost (model → weight delta, positive = boost). */
  model_boosts: Record<string, number>;
  /** User-biased strategy preference ('repair' | 'regenerate' and weight). */
  strategy_bias: { preferred: 'repair' | 'regenerate' | null; weight: number };
  /** User's retry tolerance factor (multiplier on default retry budget). */
  retry_factor: number;
  /** Confidence in user data (0–1). Low = defer to global. */
  user_confidence: number;
  /** Whether personalization is active (false if no user data). */
  active: boolean;
}

/** Config for the personalization layer. */
export interface PersonalizationConfig {
  /** Minimum user decisions before personalization activates. Default: 5. */
  minUserDecisions: number;
  /** Maximum bias weight. Caps how much user preference can shift decisions. Default: 0.30. */
  maxBiasWeight: number;
  /** Global dominance threshold: if global confidence > this, ignore conflicting user bias. Default: 0.70. */
  globalDominanceThreshold: number;
  /** Decay factor for old user signals (same semantics as intelligence decay). Default: same as intelligence. */
  userDecayHalfLifeDays: number;
}

export const DEFAULT_PERSONALIZATION_CONFIG: PersonalizationConfig = {
  minUserDecisions: 5,
  maxBiasWeight: 0.30,
  globalDominanceThreshold: 0.70,
  userDecayHalfLifeDays: 14,
};

const DEFAULT_USER_ID = 'default';
const PERSONALIZATION_SUBSYSTEM = 'personalization' as const;

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class UserPersonalizationService {
  private learning: GlobalLearningService;
  private config: PersonalizationConfig;
  /** In-memory profile cache, keyed by user_id. */
  private profiles = new Map<string, UserPreferenceProfile>();

  constructor(learning: GlobalLearningService, config?: Partial<PersonalizationConfig>) {
    this.learning = learning;
    this.config = { ...DEFAULT_PERSONALIZATION_CONFIG, ...config };
  }

  /** Get the active configuration. */
  getConfig(): Readonly<PersonalizationConfig> {
    return this.config;
  }

  /* ================================================================== */
  /*  Area 1: User Profile Memory                                        */
  /* ================================================================== */

  /**
   * Get or create a user preference profile.
   * Hydrates from persistent store on first access.
   */
  getProfile(userId: string = DEFAULT_USER_ID): UserPreferenceProfile {
    if (this.profiles.has(userId)) {
      return this.profiles.get(userId)!;
    }
    // Try to hydrate from persistent store
    const hydrated = this.hydrateProfile(userId);
    if (hydrated) {
      this.profiles.set(userId, hydrated);
      return hydrated;
    }
    // Create empty profile
    const empty = this.createEmptyProfile(userId);
    this.profiles.set(userId, empty);
    return empty;
  }

  /**
   * Update a user's preference profile and persist.
   */
  updateProfile(userId: string, updates: Partial<Omit<UserPreferenceProfile, 'user_id' | 'updated_at'>>): UserPreferenceProfile {
    const profile = this.getProfile(userId);
    Object.assign(profile, updates, { updated_at: Date.now() });
    this.persistProfile(profile);
    return profile;
  }

  /**
   * List all known user profiles.
   */
  listProfiles(): UserPreferenceProfile[] {
    // Hydrate all from persistent store
    try {
      const events = this.learning.queryEvents({
        subsystem: PERSONALIZATION_SUBSYSTEM,
        tool: 'profile_snapshot',
        limit: 1000,
      });
      const latestByUser = new Map<string, GlobalLearningEvent>();
      for (const ev of events) {
        const ctx = this.parseContext(ev.context_json);
        const uid = ctx.user_id as string;
        if (!uid) continue;
        const existing = latestByUser.get(uid);
        if (!existing || ev.created_at > existing.created_at) {
          latestByUser.set(uid, ev);
        }
      }
      for (const [uid, ev] of latestByUser) {
        if (!this.profiles.has(uid)) {
          const ctx = this.parseContext(ev.context_json);
          const profile = ctx.profile as UserPreferenceProfile | undefined;
          if (profile) {
            this.profiles.set(uid, profile);
          }
        }
      }
    } catch { /* non-fatal */ }
    return [...this.profiles.values()];
  }

  /* ================================================================== */
  /*  Area 2: User-Specific Build Intelligence                           */
  /* ================================================================== */

  /**
   * Get personalized recommendations that layer on top of global intelligence.
   * Returns neutral recommendations when no user data exists.
   */
  getPersonalizedRecommendations(
    userId: string = DEFAULT_USER_ID,
    globalRecs?: BuildRecommendations,
    globalConfidence?: number,
  ): PersonalizedRecommendations {
    const profile = this.getProfile(userId);

    // Not enough data — return neutral
    if (profile.total_decisions < this.config.minUserDecisions) {
      return {
        model_boosts: {},
        strategy_bias: { preferred: null, weight: 0 },
        retry_factor: 1.0,
        user_confidence: 0,
        active: false,
      };
    }

    const userConfidence = this.computeUserConfidence(profile);

    // If global intelligence has strong confidence and conflicts, defer
    if (globalConfidence !== undefined && globalConfidence > this.config.globalDominanceThreshold) {
      return {
        model_boosts: this.computeModelBoosts(profile, this.config.maxBiasWeight * 0.3), // heavily attenuated
        strategy_bias: this.computeStrategyBias(profile, this.config.maxBiasWeight * 0.3),
        retry_factor: this.computeRetryFactor(profile),
        user_confidence: userConfidence * 0.3,
        active: true,
      };
    }

    return {
      model_boosts: this.computeModelBoosts(profile, this.config.maxBiasWeight),
      strategy_bias: this.computeStrategyBias(profile, this.config.maxBiasWeight),
      retry_factor: this.computeRetryFactor(profile),
      user_confidence: userConfidence,
      active: true,
    };
  }

  /**
   * Merge global action effectiveness with user-specific history.
   * User data biases the result without overriding strong global evidence.
   */
  mergeActionEffectiveness(
    globalActions: ActionEffectiveness[],
    userId: string = DEFAULT_USER_ID,
  ): ActionEffectiveness[] {
    const profile = this.getProfile(userId);
    if (profile.total_decisions < this.config.minUserDecisions) {
      return globalActions; // No user data — return global as-is
    }

    const weight = Math.min(
      profile.total_decisions / 50, // ramp up to full weight at 50 decisions
      this.config.maxBiasWeight,
    );

    return globalActions.map(ga => {
      const userHistory = profile.action_history[ga.action];
      if (!userHistory || userHistory.total === 0) return ga;

      const userRate = userHistory.successes / userHistory.total;
      // Weighted blend: global * (1-weight) + user * weight
      const blendedRate = ga.success_rate * (1 - weight) + userRate * weight;

      return {
        ...ga,
        success_rate: blendedRate,
      };
    });
  }

  /* ================================================================== */
  /*  Area 3: Decision Biasing                                           */
  /* ================================================================== */

  /**
   * Apply user bias to a model ranking list.
   * Returns the reranked list. Does not remove any models.
   */
  biasModelRanking(
    models: string[],
    userId: string = DEFAULT_USER_ID,
    globalRecs?: BuildRecommendations,
    globalConfidence?: number,
  ): string[] {
    const recs = this.getPersonalizedRecommendations(userId, globalRecs, globalConfidence);
    if (!recs.active || Object.keys(recs.model_boosts).length === 0) {
      return models;
    }

    // Score each model: index-based base score + user boost
    const scored = models.map((model, idx) => ({
      model,
      score: (models.length - idx) + (recs.model_boosts[model] ?? 0) * models.length,
    }));

    scored.sort((a, b) => b.score - a.score);
    return scored.map(s => s.model);
  }

  /**
   * Get user-biased retry budget multiplier.
   */
  getRetryBudgetMultiplier(userId: string = DEFAULT_USER_ID): number {
    const recs = this.getPersonalizedRecommendations(userId);
    return recs.retry_factor;
  }

  /* ================================================================== */
  /*  Area 4: User Feedback Capture                                      */
  /* ================================================================== */

  /**
   * Record a feedback signal from user behavior.
   * Updates the user profile AND persists the signal to the learning system.
   */
  recordFeedback(signal: FeedbackSignal): void {
    const profile = this.getProfile(signal.user_id);

    // Update profile based on signal type
    switch (signal.signal_type) {
      case 'outcome_accepted':
        profile.total_decisions++;
        if (signal.action) {
          this.incrementActionHistory(profile, signal.action, true);
        }
        if (signal.model) {
          this.incrementModelHistory(profile, signal.model, true);
        }
        this.updateTaskAffinity(profile, signal.task_type, 1);
        break;

      case 'outcome_rejected':
        profile.total_decisions++;
        if (signal.action) {
          this.incrementActionHistory(profile, signal.action, false);
        }
        if (signal.model) {
          this.incrementModelHistory(profile, signal.model, false);
        }
        break;

      case 'retry_triggered':
        profile.total_decisions++;
        // Retries reduce tolerance slightly
        profile.retry_tolerance = Math.max(0, profile.retry_tolerance - 0.02);
        if (signal.action) {
          this.incrementActionHistory(profile, signal.action, false);
        }
        break;

      case 'manual_override':
        profile.total_decisions++;
        // Strong signal: user explicitly chose differently
        if (signal.strategy === 'regenerate') {
          profile.strategy_bias = Math.min(1, profile.strategy_bias + 0.1);
        } else if (signal.strategy === 'repair') {
          profile.strategy_bias = Math.max(-1, profile.strategy_bias - 0.1);
        }
        break;

      case 'build_aborted':
        profile.total_decisions++;
        // Aborts reduce retry tolerance
        profile.retry_tolerance = Math.max(0, profile.retry_tolerance - 0.05);
        break;

      case 'model_selected':
        profile.total_decisions++;
        if (signal.model) {
          this.incrementModelHistory(profile, signal.model, true);
          // Explicit model selection is a strong preference signal
          const pref = this.inferModelPreference(signal.model);
          if (pref) profile.model_preference = pref;
        }
        break;

      case 'strategy_selected':
        profile.total_decisions++;
        if (signal.strategy === 'regenerate') {
          profile.strategy_bias = Math.min(1, profile.strategy_bias + 0.15);
        } else if (signal.strategy === 'repair') {
          profile.strategy_bias = Math.max(-1, profile.strategy_bias - 0.15);
        }
        break;
    }

    profile.updated_at = Date.now();
    this.profiles.set(signal.user_id, profile);
    this.persistProfile(profile);

    // Also persist as a learning event for cross-session analysis
    try {
      this.learning.recordEvent({
        subsystem: PERSONALIZATION_SUBSYSTEM,
        task_type: signal.task_type,
        tool: signal.signal_type,
        outcome: signal.outcome ?? (signal.signal_type === 'outcome_accepted' ? 'success' : 'failure'),
        model: signal.model,
        strategy: signal.strategy,
        context: {
          user_id: signal.user_id,
          action: signal.action,
          detail: signal.detail,
        },
      });
    } catch { /* non-fatal */ }
  }

  /* ================================================================== */
  /*  Area 5: Safety Guards                                              */
  /* ================================================================== */

  /**
   * Check if user personalization should be overridden by global intelligence.
   * Returns true if global should dominate.
   */
  shouldDeferToGlobal(
    userId: string = DEFAULT_USER_ID,
    globalConfidence?: number,
  ): boolean {
    const profile = this.getProfile(userId);

    // No user data → always defer
    if (profile.total_decisions < this.config.minUserDecisions) {
      return true;
    }

    // Strong global confidence → defer
    if (globalConfidence !== undefined && globalConfidence > this.config.globalDominanceThreshold) {
      return true;
    }

    return false;
  }

  /**
   * Validate that a user-biased recommendation doesn't conflict with safety.
   * Returns the safe recommendation (may override user preference).
   */
  applySafetyGuard(
    userPreferred: 'repair' | 'regenerate',
    globalRecommended: 'repair' | 'regenerate' | null,
    globalSuccessRate: number,
    userSuccessRate: number,
  ): { action: 'repair' | 'regenerate'; source: 'user' | 'global' | 'default' } {
    // If global has strong success evidence and user conflicts, use global
    if (globalRecommended && globalSuccessRate > 0.7 && userPreferred !== globalRecommended) {
      // Only override if global is significantly better
      if (globalSuccessRate - userSuccessRate > 0.2) {
        return { action: globalRecommended, source: 'global' };
      }
    }

    // If user has reasonable success rate with their preference, allow it
    if (userSuccessRate > 0.4) {
      return { action: userPreferred, source: 'user' };
    }

    // Default: use global or fallback
    return { action: globalRecommended ?? 'repair', source: globalRecommended ? 'global' : 'default' };
  }

  /* ================================================================== */
  /*  Internal helpers                                                   */
  /* ================================================================== */

  private createEmptyProfile(userId: string): UserPreferenceProfile {
    return {
      user_id: userId,
      model_preference: null,
      strategy_bias: 0,
      retry_tolerance: 0.5,
      output_style: null,
      task_affinities: {},
      model_history: {},
      action_history: {},
      total_decisions: 0,
      updated_at: Date.now(),
    };
  }

  private hydrateProfile(userId: string): UserPreferenceProfile | null {
    try {
      const events = this.learning.queryEvents({
        subsystem: PERSONALIZATION_SUBSYSTEM,
        tool: 'profile_snapshot',
        limit: 500,
      });
      // Find the most recent snapshot for this user by profile.updated_at (ms precision).
      // Cannot rely solely on event created_at because multiple snapshots may share the same second.
      let best: UserPreferenceProfile | null = null;
      for (const ev of events) {
        const ctx = this.parseContext(ev.context_json);
        if (ctx.user_id === userId) {
          const profile = ctx.profile as UserPreferenceProfile | undefined;
          if (profile && profile.user_id === userId) {
            if (!best || profile.updated_at > best.updated_at || (profile.updated_at === best.updated_at && profile.total_decisions > best.total_decisions)) {
              best = profile;
            }
          }
        }
      }
      return best;
    } catch { /* non-fatal */ }
    return null;
  }

  private persistProfile(profile: UserPreferenceProfile): void {
    try {
      this.learning.recordEvent({
        subsystem: PERSONALIZATION_SUBSYSTEM,
        task_type: 'profile',
        tool: 'profile_snapshot',
        outcome: 'success',
        context: {
          user_id: profile.user_id,
          profile,
        },
      });
    } catch { /* non-fatal */ }
  }

  private computeUserConfidence(profile: UserPreferenceProfile): number {
    // Ramp: 0 at minDecisions, 1.0 at 50 decisions
    const ramp = Math.min((profile.total_decisions - this.config.minUserDecisions) / 45, 1.0);
    return Math.max(0, ramp);
  }

  private computeModelBoosts(
    profile: UserPreferenceProfile,
    maxWeight: number,
  ): Record<string, number> {
    const boosts: Record<string, number> = {};
    for (const [model, history] of Object.entries(profile.model_history)) {
      if (history.total < 2) continue;
      const rate = history.successes / history.total;
      // Boost models with above-average success, penalize below-average
      boosts[model] = (rate - 0.5) * 2 * maxWeight;
    }
    return boosts;
  }

  private computeStrategyBias(
    profile: UserPreferenceProfile,
    maxWeight: number,
  ): PersonalizedRecommendations['strategy_bias'] {
    if (Math.abs(profile.strategy_bias) < 0.05) {
      return { preferred: null, weight: 0 };
    }
    return {
      preferred: profile.strategy_bias > 0 ? 'regenerate' : 'repair',
      weight: Math.min(Math.abs(profile.strategy_bias), maxWeight),
    };
  }

  private computeRetryFactor(profile: UserPreferenceProfile): number {
    // Map retry_tolerance (0–1) to a multiplier (0.5–1.5)
    return 0.5 + profile.retry_tolerance;
  }

  private incrementActionHistory(profile: UserPreferenceProfile, action: string, success: boolean): void {
    if (!profile.action_history[action]) {
      profile.action_history[action] = { total: 0, successes: 0 };
    }
    profile.action_history[action].total++;
    if (success) profile.action_history[action].successes++;
  }

  private incrementModelHistory(profile: UserPreferenceProfile, model: string, success: boolean): void {
    if (!profile.model_history[model]) {
      profile.model_history[model] = { total: 0, successes: 0 };
    }
    profile.model_history[model].total++;
    if (success) profile.model_history[model].successes++;
  }

  private updateTaskAffinity(profile: UserPreferenceProfile, taskType: string, delta: number): void {
    profile.task_affinities[taskType] = (profile.task_affinities[taskType] ?? 0) + delta;
  }

  private inferModelPreference(model: string): UserPreferenceProfile['model_preference'] {
    const lower = model.toLowerCase();
    if (lower.includes('fast') || lower.includes('mini') || lower.includes('small')) return 'fast';
    if (lower.includes('code') || lower.includes('coder') || lower.includes('deepseek')) return 'coding';
    if (lower.includes('large') || lower.includes('70b') || lower.includes('opus')) return 'deep';
    return null;
  }

  private parseContext(contextJson: string | null): Record<string, unknown> {
    if (!contextJson) return {};
    try {
      return JSON.parse(contextJson);
    } catch {
      return {};
    }
  }
}
