/**
 * Web Search Provider for Reasoning Service
 *
 * Provides real internet search results for the reasoning layer.
 * Uses DuckDuckGo Instant Answer API (no API key required) as default.
 *
 * Results are:
 *   - Sanitized
 *   - Source-attributed
 *   - Limited to top N results
 *   - Clearly separate from memory evidence
 */

import type { InternetResult, InternetSearchProvider } from './reasoning-service.js';
import { logger } from '../logger.js';

/* ------------------------------------------------------------------ */
/*  DuckDuckGo provider (no API key needed)                            */
/* ------------------------------------------------------------------ */

export class DuckDuckGoSearchProvider implements InternetSearchProvider {
  private timeout: number;

  constructor(options?: { timeoutMs?: number }) {
    this.timeout = options?.timeoutMs ?? 5000;
  }

  async search(query: string, maxResults = 3): Promise<InternetResult[]> {
    try {
      const encoded = encodeURIComponent(query);
      const url = `https://api.duckduckgo.com/?q=${encoded}&format=json&no_html=1&skip_disambig=1`;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);

      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'AgentX/1.0 (Reasoning Context)' },
      });

      clearTimeout(timer);

      if (!response.ok) {
        logger.warn(`DuckDuckGo search failed: HTTP ${response.status}`);
        return [];
      }

      const data = await response.json() as any;
      const results: InternetResult[] = [];

      // Abstract (instant answer)
      if (data.AbstractText && data.AbstractSource) {
        results.push({
          snippet: this.sanitize(data.AbstractText).substring(0, 300),
          source: data.AbstractURL || `https://duckduckgo.com/?q=${encoded}`,
          title: data.Heading || data.AbstractSource,
        });
      }

      // Related topics
      if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
        for (const topic of data.RelatedTopics) {
          if (results.length >= maxResults) break;
          if (topic.Text && topic.FirstURL) {
            results.push({
              snippet: this.sanitize(topic.Text).substring(0, 300),
              source: topic.FirstURL,
              title: topic.Text.split(' - ')[0] || undefined,
            });
          }
        }
      }

      // Definition
      if (results.length < maxResults && data.Definition && data.DefinitionSource) {
        results.push({
          snippet: this.sanitize(data.Definition).substring(0, 300),
          source: data.DefinitionURL || `https://duckduckgo.com/?q=${encoded}`,
          title: `${data.DefinitionSource} Definition`,
        });
      }

      return results.slice(0, maxResults);
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        logger.warn('DuckDuckGo search timed out');
      } else {
        logger.warn(
          `DuckDuckGo search failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return [];
    }
  }

  private sanitize(text: string): string {
    return text
      .replace(/<[^>]*>/g, '') // Strip HTML
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }
}
