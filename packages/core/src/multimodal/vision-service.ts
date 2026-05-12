/**
 * Vision service — thin factory around OllamaVisionProvider for route handlers.
 *
 * Lets `POST /api/vision/analyze` instantiate a vision provider without
 * touching agent.ts. Tests inject a mock provider via
 * `setVisionProviderForTesting()` so CI can exercise the success path
 * without a live Ollama install. Always call `clearVisionProviderForTesting()`
 * in afterEach to avoid leaking state between specs.
 */

import { OllamaVisionProvider, type VisionProvider } from './index.js';

let testOverride: VisionProvider | null = null;

/** Return the active vision provider (test override > default Ollama). */
export function getVisionProvider(): VisionProvider {
  if (testOverride) return testOverride;
  return new OllamaVisionProvider();
}

/** TEST ONLY — install a mock provider. */
export function setVisionProviderForTesting(provider: VisionProvider): void {
  testOverride = provider;
}

/** TEST ONLY — remove the mock provider. */
export function clearVisionProviderForTesting(): void {
  testOverride = null;
}

/**
 * Describe an image buffer using the active vision provider. Returns a
 * structured response that the route handler echoes to the client.
 *
 * On unreachable Ollama / missing model, returns `{available:false, …}` —
 * never throws. Network/parse errors propagate.
 */
export interface VisionAnalyzeResult {
  available: boolean;
  description?: string;
  reason?: string;
  model?: string;
  latencyMs: number;
}

export async function analyzeImageBuffer(image: Buffer): Promise<VisionAnalyzeResult> {
  const provider = getVisionProvider();
  const start = Date.now();
  const model = process.env['AGENTX_VISION_MODEL'] || 'qwen3-vl:32b';

  // Probe availability first — turns "vision model not installed" into a
  // structured 200 response rather than a 500 cascade.
  let available = true;
  if (provider.isAvailable) {
    try { available = await provider.isAvailable(); } catch { available = false; }
  }
  if (!available) {
    return {
      available: false,
      reason: 'vision model not available (Ollama unreachable or qwen3-vl not installed)',
      model,
      latencyMs: Date.now() - start,
    };
  }

  const { description } = await provider.describe(image);
  // Provider may still return a placeholder string when partially available.
  if (!description || description.startsWith('[')) {
    return {
      available: false,
      reason: 'vision provider returned no description',
      model,
      latencyMs: Date.now() - start,
    };
  }
  return {
    available: true,
    description,
    model,
    latencyMs: Date.now() - start,
  };
}
