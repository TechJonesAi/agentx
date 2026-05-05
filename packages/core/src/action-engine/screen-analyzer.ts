/**
 * Screen Analyzer — Vision-powered screen awareness
 *
 * Captures screenshots and sends them to a vision model (qwen3-vl)
 * to understand what's currently on screen. Returns structured
 * UI element maps for the Action Planner and Executor.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ScreenAnalysis, UIElement } from './types.js';

export interface ScreenAnalyzerConfig {
  visionModel: string;
  ollamaBaseUrl: string;
}

export class ScreenAnalyzer {
  private config: ScreenAnalyzerConfig;
  private screenshotDir: string;

  constructor(config: ScreenAnalyzerConfig) {
    this.config = config;
    this.screenshotDir = path.join(os.tmpdir(), 'agentx-action-screenshots');
    if (!fs.existsSync(this.screenshotDir)) {
      fs.mkdirSync(this.screenshotDir, { recursive: true });
    }
  }

  /**
   * Capture a screenshot and return it as base64 + dimensions.
   */
  async captureScreen(): Promise<{ base64: string; width: number; height: number; filePath: string }> {
    const filePath = path.join(this.screenshotDir, `screen-${Date.now()}.png`);

    try {
      execSync(`/usr/sbin/screencapture -x -C "${filePath}"`, { timeout: 10000 });
    } catch (err) {
      throw new Error(`Screenshot capture failed: ${(err as Error).message}`);
    }

    if (!fs.existsSync(filePath)) {
      throw new Error('Screenshot file was not created');
    }

    const buffer = fs.readFileSync(filePath);
    const base64 = buffer.toString('base64');

    // Parse PNG IHDR for dimensions
    let width = 0;
    let height = 0;
    if (buffer.length > 24 && buffer.toString('ascii', 12, 16) === 'IHDR') {
      width = buffer.readUInt32BE(16);
      height = buffer.readUInt32BE(20);
    }

    return { base64, width, height, filePath };
  }

  /**
   * Analyze the current screen state using the vision model.
   * Optionally provide a task context for more focused analysis.
   */
  async analyzeScreen(taskContext?: string): Promise<ScreenAnalysis> {
    const { base64, width, height, filePath } = await this.captureScreen();

    const prompt = taskContext
      ? `You are analyzing a macOS desktop screenshot to help complete this task: "${taskContext}"

Describe what you see on screen. Be specific about:
1. Which application is currently in the foreground
2. What window/dialog is visible
3. Key UI elements (buttons, text fields, menus, labels) with their approximate positions
4. Any error messages or dialogs
5. The current state of the application (is it ready for input?)

Format your response as JSON:
{
  "activeApp": "app name",
  "activeWindow": "window title",
  "description": "brief description of what's visible",
  "elements": [
    {
      "type": "button|input|menu|text|window|icon|dialog|toolbar",
      "label": "visible text",
      "bounds": { "x": approx_x, "y": approx_y, "width": approx_w, "height": approx_h },
      "clickTarget": { "x": center_x, "y": center_y },
      "state": "normal|focused|disabled|selected"
    }
  ]
}

Return ONLY the JSON, no markdown fences.`
      : `Describe this macOS desktop screenshot. Identify the active application, window title, and key UI elements with their approximate positions. Return as JSON with fields: activeApp, activeWindow, description, elements (array of {type, label, bounds: {x,y,width,height}, clickTarget: {x,y}, state}). Return ONLY JSON, no markdown fences.`;

    const analysis = await this.callVisionModel(base64, prompt);

    // Clean up screenshot file (keep last 5 for debugging)
    this.cleanupOldScreenshots(5);

    return {
      ...analysis,
      screenshotBase64: base64,
      dimensions: { width, height },
      analyzedAt: Date.now(),
    };
  }

  /**
   * Verify that a specific action was successful by analyzing the screen.
   */
  async verifyAction(actionDescription: string, expectedOutcome: string): Promise<{
    success: boolean;
    description: string;
    screenshotBase64: string;
  }> {
    const { base64 } = await this.captureScreen();

    const prompt = `You are verifying whether a macOS desktop action was successful.

Action performed: "${actionDescription}"
Expected outcome: "${expectedOutcome}"

Look at this screenshot and determine:
1. Did the action succeed?
2. What is the current state of the screen?

Return ONLY JSON:
{
  "success": true/false,
  "description": "what you see that confirms or denies success",
  "confidence": 0.0-1.0
}

Return ONLY the JSON, no markdown fences.`;

    const response = await this.callVisionModelRaw(base64, prompt);

    try {
      const result = JSON.parse(this.extractJSON(response));
      return {
        success: result.success === true,
        description: result.description || response,
        screenshotBase64: base64,
      };
    } catch {
      // If we can't parse, assume cautious failure
      return {
        success: false,
        description: `Vision model response (unparsed): ${response.substring(0, 500)}`,
        screenshotBase64: base64,
      };
    }
  }

  /**
   * Call Ollama vision model with an image and prompt.
   */
  private async callVisionModel(imageBase64: string, prompt: string): Promise<Omit<ScreenAnalysis, 'screenshotBase64' | 'dimensions' | 'analyzedAt'>> {
    const rawResponse = await this.callVisionModelRaw(imageBase64, prompt);

    try {
      const parsed = JSON.parse(this.extractJSON(rawResponse));
      return {
        description: parsed.description || rawResponse.substring(0, 200),
        activeApp: parsed.activeApp,
        activeWindow: parsed.activeWindow,
        elements: Array.isArray(parsed.elements) ? parsed.elements.map(this.normalizeElement) : [],
        rawResponse,
      };
    } catch {
      // Fallback: return raw description with no structured elements
      return {
        description: rawResponse.substring(0, 500),
        elements: [],
        rawResponse,
      };
    }
  }

  /**
   * Raw Ollama vision API call.
   */
  private async callVisionModelRaw(imageBase64: string, prompt: string): Promise<string> {
    const url = `${this.config.ollamaBaseUrl}/api/chat`;

    const body: Record<string, unknown> = {
      model: this.config.visionModel,
      messages: [
        {
          role: 'user',
          content: prompt,
          images: [imageBase64],
        },
      ],
      stream: false,
      think: false,  // Disable thinking mode for direct JSON output
      options: {
        temperature: 0.1,
        num_predict: 2048,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300000); // 5 minute timeout for vision (32B model is slow)

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama vision request failed (${response.status}): ${text}`);
      }

      const data = await response.json() as { message?: { content?: string; thinking?: string } };
      // Handle qwen3 thinking mode: content may be empty, actual response in thinking
      return data.message?.content || data.message?.thinking || '';
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Extract JSON from a response that may contain markdown fences.
   */
  private extractJSON(text: string): string {
    // Try raw parse first
    const trimmed = text.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return trimmed;
    }

    // Try to extract from markdown code fence
    const jsonMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      return jsonMatch[1].trim();
    }

    // Try to find JSON object in the text
    const objectMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return objectMatch[0];
    }

    return trimmed;
  }

  /**
   * Normalize a UI element from the vision model's response.
   */
  private normalizeElement(el: Record<string, unknown>): UIElement {
    return {
      type: String(el.type || 'unknown'),
      label: String(el.label || ''),
      bounds: el.bounds && typeof el.bounds === 'object' ? {
        x: Number((el.bounds as Record<string, unknown>).x) || 0,
        y: Number((el.bounds as Record<string, unknown>).y) || 0,
        width: Number((el.bounds as Record<string, unknown>).width) || 0,
        height: Number((el.bounds as Record<string, unknown>).height) || 0,
      } : undefined,
      clickTarget: el.clickTarget && typeof el.clickTarget === 'object' ? {
        x: Number((el.clickTarget as Record<string, unknown>).x) || 0,
        y: Number((el.clickTarget as Record<string, unknown>).y) || 0,
      } : undefined,
      state: el.state ? String(el.state) : undefined,
    };
  }

  /**
   * Clean up old screenshot files, keeping the most recent N.
   */
  private cleanupOldScreenshots(keep: number): void {
    try {
      const files = fs.readdirSync(this.screenshotDir)
        .filter(f => f.startsWith('screen-') && f.endsWith('.png'))
        .sort()
        .reverse();

      for (const file of files.slice(keep)) {
        fs.unlinkSync(path.join(this.screenshotDir, file));
      }
    } catch {
      // Non-critical
    }
  }
}
