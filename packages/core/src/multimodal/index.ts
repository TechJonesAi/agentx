/**
 * Multimodal Runtime — Real implementation with OCR + optional vision model.
 *
 * OCR (tesseract.js) works independently of vision providers.
 * Vision model (Ollama qwen3-vl) enhances results when available.
 */

import type { MultimodalContentBlock } from '../types.js';

export interface STTProvider { transcribe(audio: Buffer): Promise<{ text: string }>; isAvailable(): boolean; }
export interface STTResult { text: string; }
export interface VisionProvider {
  describe(image: Buffer): Promise<{ description: string }>;
  isAvailable?(): Promise<boolean>;
}
export interface VisionResult { description: string; }
export interface DocumentProvider { extract(doc: Buffer): Promise<{ text: string }>; }
export interface DocumentResult { text: string; }

export type MultimodalContentType = 'audio' | 'image' | 'document';
export interface MultimodalBlockMetadata { type: MultimodalContentType; }
export interface MultimodalMessage { blocks: unknown[]; }
export interface ModalityStatus { available: boolean; }
export interface ModalityCapability { type: string; }
export interface MultimodalPipelineStatus { ready: boolean; }
export interface MultimodalProcessingResult {
  enrichedText: string;
  processedBlocks: MultimodalContentBlock[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// OCR Helper — runs tesseract.js on a buffer
// ---------------------------------------------------------------------------
async function runOCR(imgBuffer: Buffer): Promise<{ text: string; confidence: number }> {
  try {
    const Tesseract = await import('tesseract.js' as any);
    const createWorker = (Tesseract as any).createWorker ?? (Tesseract as any).default?.createWorker;
    if (!createWorker) return { text: '', confidence: 0 };
    const worker = await createWorker('eng');
    const { data } = await worker.recognize(imgBuffer);
    await worker.terminate();
    return { text: data.text || '', confidence: data.confidence || 0 };
  } catch {
    return { text: '', confidence: 0 };
  }
}

// ---------------------------------------------------------------------------
// Check if tesseract.js is available (can be imported)
// ---------------------------------------------------------------------------
async function isOCRAvailable(): Promise<boolean> {
  try {
    const Tesseract = await import('tesseract.js' as any);
    return !!(Tesseract && ((Tesseract as any).createWorker || (Tesseract as any).default?.createWorker));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// MultimodalRouter — processes image/audio/document blocks
// ---------------------------------------------------------------------------
export class MultimodalRouter {
  private _visionProvider: VisionProvider | null = null;
  private _sttProvider: STTProvider | null = null;
  private _ocrAvailable: boolean | null = null;

  registerVision(provider: VisionProvider): void { this._visionProvider = provider; }
  registerSTT(provider: STTProvider): void { this._sttProvider = provider; }

  /**
   * Process multimodal content blocks.
   * For images: runs OCR and optionally vision model.
   * Returns enriched text with extraction results.
   */
  async process(blocks: unknown[]): Promise<MultimodalProcessingResult> {
    const warnings: string[] = [];
    const enrichedParts: string[] = [];
    const processedBlocks: MultimodalContentBlock[] = [];

    for (const raw of blocks) {
      const block = raw as MultimodalContentBlock;

      if (block.type === 'image' && block.data) {
        // Decode base64 image data
        const imgBuffer = Buffer.from(block.data, 'base64');
        let ocrText = '';
        let visionDescription = '';

        // Step 1: Always attempt OCR
        const ocr = await runOCR(imgBuffer);
        ocrText = ocr.text.trim();

        // Step 2: Try vision model if available
        if (this._visionProvider) {
          try {
            const vResult = await this._visionProvider.describe(imgBuffer);
            if (vResult.description && !vResult.description.startsWith('[Vision not available]')) {
              visionDescription = vResult.description;
            }
          } catch {
            warnings.push('Vision model failed — using OCR only');
          }
        }

        // Build enriched text for this image
        const parts: string[] = [];
        if (visionDescription) {
          parts.push(`[Image Analysis]\n${visionDescription}`);
        }
        if (ocrText.length > 0) {
          parts.push(`[Extracted Text (OCR)]\n${ocrText}`);
        }

        if (parts.length > 0) {
          enrichedParts.push(parts.join('\n\n'));
        } else {
          warnings.push('No text could be extracted from image');
          enrichedParts.push('[Image attached — no text could be extracted]');
        }

        processedBlocks.push({
          ...block,
          description: visionDescription || ocrText || '[No content extracted]',
          transcription: ocrText || undefined,
          metadata: {
            ocrConfidence: ocr.confidence,
            hasVision: !!visionDescription,
            hasOCR: ocrText.length > 0,
          },
        });
      } else if (block.type === 'audio' && this._sttProvider) {
        // Audio transcription
        try {
          const audioBuffer = block.data ? Buffer.from(block.data, 'base64') : null;
          if (audioBuffer && this._sttProvider.isAvailable()) {
            const result = await this._sttProvider.transcribe(audioBuffer);
            enrichedParts.push(`[Audio Transcription]\n${result.text}`);
            processedBlocks.push({ ...block, transcription: result.text });
          } else {
            warnings.push('STT provider not available');
            processedBlocks.push(block);
          }
        } catch {
          warnings.push('Audio transcription failed');
          processedBlocks.push(block);
        }
      } else if (block.type === 'document') {
        // Document blocks — pass through text if available
        if (block.text) {
          enrichedParts.push(`[Document Content]\n${block.text}`);
        }
        processedBlocks.push(block);
      } else {
        // Unknown or unsupported type
        processedBlocks.push(block);
      }
    }

    return {
      enrichedText: enrichedParts.join('\n\n---\n\n'),
      processedBlocks,
      warnings,
    };
  }

  /**
   * Get status of multimodal capabilities.
   */
  async getStatus(): Promise<{
    overall: string;
    modalities: Array<{ modality: string; status: string; provider?: string }>;
  }> {
    const modalities: Array<{ modality: string; status: string; provider?: string }> = [];

    // Check OCR
    if (this._ocrAvailable === null) {
      this._ocrAvailable = await isOCRAvailable();
    }

    // Check vision model
    let visionAvailable = false;
    if (this._visionProvider?.isAvailable) {
      try {
        visionAvailable = await this._visionProvider.isAvailable();
      } catch {
        visionAvailable = false;
      }
    }

    // Image modality: available if OCR or vision works
    if (visionAvailable) {
      modalities.push({ modality: 'image', status: 'available', provider: 'vision + OCR' });
    } else if (this._ocrAvailable) {
      modalities.push({ modality: 'image', status: 'available', provider: 'OCR only (tesseract.js)' });
    } else {
      modalities.push({ modality: 'image', status: 'unavailable' });
    }

    // STT modality
    const sttAvailable = this._sttProvider?.isAvailable() ?? false;
    modalities.push({
      modality: 'speech',
      status: sttAvailable ? 'available' : 'unavailable',
      provider: sttAvailable ? 'whisper' : undefined,
    });

    // Determine overall status
    const availableCount = modalities.filter(m => m.status === 'available').length;
    const overall = availableCount === modalities.length ? 'full'
      : availableCount > 0 ? 'partial'
      : 'minimal';

    return { overall, modalities };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      hasVisionProvider: !!this._visionProvider,
      hasSTTProvider: !!this._sttProvider,
      ocrAvailable: this._ocrAvailable,
    };
  }
}

// ---------------------------------------------------------------------------
// VisionRouter — manages multiple named vision providers
// ---------------------------------------------------------------------------
export class VisionRouter {
  private providers = new Map<string, VisionProvider>();

  registerProvider(name: string, provider: VisionProvider): void {
    this.providers.set(name, provider);
  }

  async describe(image: Buffer): Promise<{ description: string }> {
    // Try each provider in order
    for (const [name, provider] of this.providers) {
      try {
        const result = await provider.describe(image);
        if (result.description && !result.description.startsWith('[')) {
          return result;
        }
      } catch {
        // Try next provider
      }
    }
    return { description: '[Vision not available]' };
  }

  async isAvailable(): Promise<boolean> {
    for (const [, provider] of this.providers) {
      if (provider.isAvailable) {
        try {
          if (await provider.isAvailable()) return true;
        } catch { /* continue */ }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// VisionRouterProvider — wraps VisionRouter as a VisionProvider
// ---------------------------------------------------------------------------
export class VisionRouterProvider implements VisionProvider {
  constructor(private router: VisionRouter) {}

  async describe(image: Buffer): Promise<{ description: string }> {
    return this.router.describe(image);
  }

  async isAvailable(): Promise<boolean> {
    return this.router.isAvailable();
  }
}

// ---------------------------------------------------------------------------
// OllamaVisionProvider — calls Ollama with a vision model
// ---------------------------------------------------------------------------
export class OllamaVisionProvider implements VisionProvider {
  private host: string;
  private model: string;

  constructor() {
    this.host = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
    this.model = process.env.AGENTX_VISION_MODEL || 'qwen3-vl:32b';
  }

  async isAvailable(): Promise<boolean> {
    try {
      const resp = await fetch(`${this.host}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return false;
      const data = await resp.json() as any;
      const models = (data?.models || []) as Array<{ name: string }>;
      return models.some(m => m.name.includes('qwen3-vl'));
    } catch {
      return false;
    }
  }

  async describe(image: Buffer): Promise<{ description: string }> {
    const available = await this.isAvailable();
    if (!available) {
      return { description: '[Vision not available]' };
    }

    const imgBase64 = image.toString('base64');
    const prompt = 'Describe what you see in this image in detail. If there is any text, extract it completely. If it is a document or book page, transcribe the content.';

    const payload = JSON.stringify({
      model: this.model,
      messages: [{
        role: 'user',
        content: `/no_think\n${prompt}`,
        images: [imgBase64],
      }],
      stream: false,
      options: { num_predict: 4096 },
    });

    const resp = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      signal: AbortSignal.timeout(120000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      throw new Error(`Ollama vision error (${resp.status}): ${errText.slice(0, 200)}`);
    }

    const data = await resp.json() as any;
    const content = data?.message?.content || '';
    return { description: content || '[No description generated]' };
  }
}

// ---------------------------------------------------------------------------
// LocalWhisperSTT — stub (whisper not bundled yet)
// ---------------------------------------------------------------------------
export class LocalWhisperSTT implements STTProvider {
  isAvailable(): boolean { return false; }
  async transcribe(_audio: Buffer): Promise<{ text: string }> {
    return { text: '[STT not available]' };
  }
}
