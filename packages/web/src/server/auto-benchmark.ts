/**
 * Auto-benchmark — keeps provider-promotion evidence fresh.
 *
 * The routing engine promotes tasks to whichever engine (Ollama vs oMLX)
 * wins recent benchmarks, but evidence recorded once goes stale: models
 * update, machine load changes, sidecars come and go. This runs a tiny
 * head-to-head (one short prompt per task category) every 6 hours and
 * records honest scores + measured latency into the benchmark store.
 *
 * Cost: ~4 requests/6h on small prompts. Opt out: AGENTX_AUTO_BENCHMARK=false.
 */

import { createLogger } from '@agentx/core';

const log = createLogger('web:auto-benchmark');

const CATEGORIES: Array<{ category: string; prompt: string }> = [
  { category: 'chat', prompt: 'Suggest three names for a small bakery.' },
  { category: 'summarisation', prompt: 'Summarise in one sentence: The meeting agreed to move the launch to May, pending legal review of the new terms.' },
];

const OLLAMA_MODEL = 'qwen3:30b-a3b-instruct-2507-q4_K_M';
const OMLX_MODEL = 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit';

interface BenchmarkStoreLike {
  record(row: Record<string, unknown>): unknown;
}

async function timedOllama(prompt: string): Promise<{ ms: number; ok: boolean } | null> {
  try {
    const t0 = Date.now();
    const r = await fetch('http://127.0.0.1:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false, keep_alive: '30m', options: { num_predict: 60 },
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { message?: { content?: string } };
    return { ms: Date.now() - t0, ok: !!data.message?.content?.trim() };
  } catch { return null; }
}

async function timedOmlx(prompt: string): Promise<{ ms: number; ok: boolean } | null> {
  try {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${process.env['AGENTX_OMLX_PORT'] ?? 8080}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OMLX_MODEL,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 60,
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as { choices?: Array<{ message?: { content?: string } }> };
    return { ms: Date.now() - t0, ok: !!data.choices?.[0]?.message?.content?.trim() };
  } catch { return null; }
}

export async function runAutoBenchmark(store: BenchmarkStoreLike): Promise<number> {
  let recorded = 0;
  for (const { category, prompt } of CATEGORIES) {
    const [ol, om] = await Promise.all([timedOllama(prompt), timedOmlx(prompt)]);
    if (ol) {
      store.record({ taskCategory: category, provider: 'ollama', model: OLLAMA_MODEL, score: ol.ok ? 1 : 0, totalLatencyMs: ol.ms });
      recorded++;
    }
    if (om) {
      store.record({ taskCategory: category, provider: 'omlx', model: OMLX_MODEL, score: om.ok ? 1 : 0, totalLatencyMs: om.ms });
      recorded++;
    }
  }
  log.info({ recorded }, 'Auto-benchmark cycle complete');
  return recorded;
}

/** Start the periodic runner: first cycle after 3 minutes (post-boot calm),
 *  then every 6 hours. Returns a stop function. */
export function startAutoBenchmark(getStore: () => BenchmarkStoreLike | null): () => void {
  if ((process.env['AGENTX_AUTO_BENCHMARK'] ?? 'true').toLowerCase() === 'false') {
    log.info('Auto-benchmark disabled by env');
    return () => undefined;
  }
  const run = () => {
    const store = getStore();
    if (!store) return;
    void runAutoBenchmark(store).catch((e) =>
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Auto-benchmark cycle failed'));
  };
  const first = setTimeout(run, 3 * 60 * 1000);
  const interval = setInterval(run, 6 * 60 * 60 * 1000);
  // Never keep the process alive just for benchmarks.
  first.unref?.(); interval.unref?.();
  return () => { clearTimeout(first); clearInterval(interval); };
}
