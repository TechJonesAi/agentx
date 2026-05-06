/**
 * TTS Router — orchestrates multiple providers with fallback, circuit breaker, and cache.
 */

import * as crypto from 'node:crypto';
import type {
  TtsProvider,
  TtsVoice,
  TtsSynthesizeRequest,
  TtsSynthesizeResult,
  TtsAudioFormat,
} from './types.js';
import { Qwen3Provider } from './providers/qwen3.js';
import { LovevoiceProvider } from './providers/lovevoice.js';
import { NaturalReaderProvider } from './providers/naturalreader.js';
import { SpeechMAProvider } from './providers/speechma.js';

// ─── Circuit breaker state per provider ─────────────────────────────────────

interface BreakerState {
  failCount: number;
  lastFailAt: number;
}

const BREAKER_THRESHOLD = 3;
const BREAKER_COOLOFF_MS = 5 * 60 * 1000; // 5 minutes

// ─── In-memory cache ────────────────────────────────────────────────────────

interface CacheEntry {
  bytes: Buffer;
  contentType: TtsAudioFormat;
  providerId: string;
  voiceId: string;
  createdAt: number;
}

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CACHE_MAX_ENTRIES = 200;

// ─── Health summary type ────────────────────────────────────────────────────

export interface ProviderHealth {
  id: string;
  enabled: boolean;
  ok: boolean;
  detail?: string;
  qualityScore: number;
  circuitOpen?: boolean;
}

export interface HealthSummary {
  ok: boolean;
  providers: ProviderHealth[];
}

// ─── Aggregated error ───────────────────────────────────────────────────────

export class TtsRouterError extends Error {
  attempted: Array<{ providerId: string; error: string }>;
  constructor(message: string, attempted: Array<{ providerId: string; error: string }>) {
    super(message);
    this.name = 'TtsRouterError';
    this.attempted = attempted;
  }
}

// ─── Router ─────────────────────────────────────────────────────────────────

export class TtsRouter {
  private providers: TtsProvider[];
  private breakers: Map<string, BreakerState> = new Map();
  private cache: Map<string, CacheEntry> = new Map();

  constructor(providers: TtsProvider[]) {
    this.providers = providers;
  }

  // ── Circuit breaker helpers ───────────────────────────────────────────

  private isCircuitOpen(providerId: string): boolean {
    const state = this.breakers.get(providerId);
    if (!state) return false;
    if (state.failCount < BREAKER_THRESHOLD) return false;
    return Date.now() - state.lastFailAt < BREAKER_COOLOFF_MS;
  }

  private recordFailure(providerId: string): void {
    const state = this.breakers.get(providerId) ?? { failCount: 0, lastFailAt: 0 };
    state.failCount++;
    state.lastFailAt = Date.now();
    this.breakers.set(providerId, state);
  }

  private recordSuccess(providerId: string): void {
    this.breakers.set(providerId, { failCount: 0, lastFailAt: 0 });
  }

  // ── Cache helpers ─────────────────────────────────────────────────────

  private cacheKey(providerId: string, voiceId: string, text: string): string {
    return crypto.createHash('sha256').update(`${providerId}:${voiceId}:${text}`).digest('hex');
  }

  private getCached(key: string): CacheEntry | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
      this.cache.delete(key);
      return undefined;
    }
    return entry;
  }

  private setCache(key: string, entry: CacheEntry): void {
    // Evict oldest if at capacity
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      let oldestKey: string | undefined;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.createdAt < oldestTime) {
          oldestTime = v.createdAt;
          oldestKey = k;
        }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, entry);
  }

  // ── Public API ────────────────────────────────────────────────────────

  async healthSummary(): Promise<HealthSummary> {
    const results = await Promise.all(
      this.providers.map(async (p): Promise<ProviderHealth> => {
        const enabled = p.isEnabled();
        const circuitOpen = this.isCircuitOpen(p.id);
        if (!enabled) {
          return { id: p.id, enabled: false, ok: false, qualityScore: p.qualityScore };
        }
        try {
          const h = await p.health();
          // If provider is actually healthy, reset the circuit breaker
          if (h.ok && circuitOpen) {
            this.recordSuccess(p.id);
          }
          return { id: p.id, enabled: true, ok: h.ok, detail: h.detail, qualityScore: p.qualityScore, circuitOpen: circuitOpen && !h.ok };
        } catch (e) {
          return { id: p.id, enabled: true, ok: false, detail: e instanceof Error ? e.message : String(e), qualityScore: p.qualityScore, circuitOpen };
        }
      }),
    );

    const ok = results.some((r) => r.enabled && r.ok);
    return { ok, providers: results };
  }

  async listAllVoices(): Promise<TtsVoice[]> {
    const allVoices: TtsVoice[] = [];

    for (const provider of this.providers) {
      if (!provider.isEnabled()) continue;
      if (this.isCircuitOpen(provider.id)) continue;
      try {
        const voices = await provider.listVoices();
        for (const v of voices) {
          allVoices.push({
            ...v,
            id: `${provider.id}:${v.id}`,
            providerId: provider.id,
          });
        }
      } catch {
        // Skip provider if voices fail — not a circuit-breaker event
      }
    }

    // Sort by quality desc, then provider qualityScore desc
    allVoices.sort((a, b) => {
      const qa = a.quality ?? 0;
      const qb = b.quality ?? 0;
      if (qb !== qa) return qb - qa;
      const pa = this.providers.find((p) => p.id === a.providerId)?.qualityScore ?? 0;
      const pb = this.providers.find((p) => p.id === b.providerId)?.qualityScore ?? 0;
      return pb - pa;
    });

    return allVoices;
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    // Parse provider prefix from voiceId
    let targetProviderId: string | undefined;
    let rawVoiceId = req.voiceId;

    if (rawVoiceId && rawVoiceId.includes(':')) {
      const colonIdx = rawVoiceId.indexOf(':');
      targetProviderId = rawVoiceId.slice(0, colonIdx);
      rawVoiceId = rawVoiceId.slice(colonIdx + 1);
    }

    // Build ordered provider list
    const enabledProviders = this.providers.filter((p) => p.isEnabled());
    let ordered: TtsProvider[];

    if (targetProviderId) {
      const target = enabledProviders.find((p) => p.id === targetProviderId);
      const rest = enabledProviders.filter((p) => p.id !== targetProviderId);
      rest.sort((a, b) => b.qualityScore - a.qualityScore);
      ordered = target ? [target, ...rest] : rest;
    } else {
      ordered = [...enabledProviders].sort((a, b) => b.qualityScore - a.qualityScore);
    }

    // Try each provider with fallback
    const attempted: Array<{ providerId: string; error: string }> = [];
    const debug = process.env['AGENTX_DEBUG_TTS'] === '1';

    for (const provider of ordered) {
      if (this.isCircuitOpen(provider.id)) {
        if (debug) console.log(`[tts:router] skipping ${provider.id}: circuit open`);
        attempted.push({ providerId: provider.id, error: 'circuit open' });
        continue;
      }

      const voiceForProvider = rawVoiceId ?? req.voiceId;
      const key = this.cacheKey(provider.id, voiceForProvider ?? '', req.text);

      // Check cache
      const cached = this.getCached(key);
      if (cached) {
        if (debug) console.log(`[tts:router] cache hit for ${provider.id}:${voiceForProvider}`);
        return {
          bytes: cached.bytes,
          contentType: cached.contentType,
          providerId: cached.providerId,
          voiceId: cached.voiceId,
        };
      }

      try {
        if (debug) console.log(`[tts:router] trying ${provider.id} voice=${voiceForProvider} text=${req.text.length}chars`);
        const t0 = Date.now();
        const result = await provider.synthesize({ ...req, voiceId: voiceForProvider });
        if (debug) console.log(`[tts:router] ${provider.id} ok: ${result.bytes.length}bytes ${result.contentType} ${Date.now() - t0}ms`);
        this.recordSuccess(provider.id);
        this.setCache(key, {
          bytes: result.bytes,
          contentType: result.contentType,
          providerId: result.providerId,
          voiceId: result.voiceId,
          createdAt: Date.now(),
        });
        return result;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (debug) console.log(`[tts:router] ${provider.id} failed: ${msg.slice(0, 200)}`);
        this.recordFailure(provider.id);
        attempted.push({ providerId: provider.id, error: msg });
      }
    }

    throw new TtsRouterError(
      'All TTS providers failed',
      attempted,
    );
  }
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createTtsRouter(): TtsRouter {
  const providers: TtsProvider[] = [
    new Qwen3Provider(),
    new LovevoiceProvider(),
    new NaturalReaderProvider(),
    new SpeechMAProvider(),
  ];
  return new TtsRouter(providers);
}
