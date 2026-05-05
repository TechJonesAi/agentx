/**
 * Spec Normalizer
 *
 * Converts a user's natural language app request into a structured AppSpec.
 * Performs platform detection, complexity assessment, and keyword extraction.
 */

import { createLogger } from './logger.js';
import type { AppSpec, CodePlatform, AppComplexity, NormalizedSpec } from './types.js';

const log = createLogger('builder-v2:spec-normalizer');

export class SpecNormalizer {
  normalize(
    description: string,
    suggestedName?: string,
    suggestedPlatform?: CodePlatform,
  ): NormalizedSpec {
    const platform = suggestedPlatform || this.detectPlatform(description);
    const complexity = this.assessComplexity(description);
    const appName = suggestedName || this.extractAppName(description);
    const keywords = this.extractKeywords(description);

    const normalized = this.normalizeDescription(description);

    log.info(
      {
        appName,
        platform,
        complexity,
        keywordCount: keywords.length,
      },
      'Spec normalized',
    );

    return {
      description,
      platform,
      appName,
      complexity,
      normalized,
      keywords,
    };
  }

  private detectPlatform(text: string): CodePlatform {
    const lower = text.toLowerCase();

    // Explicit mentions
    if (/\b(xcode|xcodeproj|swiftui|swift|ios|iphone|ipad)\b/i.test(text))
      return 'ios';
    if (
      /\b(react|nextjs|vue|angular|html|css|javascript|typescript|web|browser|webpage|website)\b/i.test(
        text,
      )
    )
      return 'web';
    if (/\b(python|\.py|flask|django|fastapi|jupyter)\b/i.test(text))
      return 'python';
    if (/\b(node|npm|yarn|express|nodejs)\b/i.test(text)) return 'node';

    // Default
    return 'generic';
  }

  private assessComplexity(text: string): AppComplexity {
    const lower = text.toLowerCase();

    // Count complexity indicators
    let score = 0;

    // Database/backend
    if (/\b(database|sql|firebase|backend|server|api|endpoint)\b/i.test(text))
      score += 2;

    // Multiple features/pages
    if (
      /\b(multiple|screens|pages|views|tabs|navigation|dashboard)\b/i.test(
        text,
      )
    )
      score += 1;
    if (/\b(real.?time|sync|offline|cache|storage)\b/i.test(text)) score += 1;

    // Authentication/security
    if (/\b(auth|login|user|account|permission)\b/i.test(text)) score += 1;

    // Integration
    if (/\b(integrate|third.?party|api|service|connect)\b/i.test(text))
      score += 1;

    // Analytics/logging
    if (/\b(analytics|tracking|logging|metrics|reporting)\b/i.test(text))
      score += 0.5;

    if (score >= 4) return 'complex';
    if (score >= 2) return 'medium';
    return 'simple';
  }

  private extractAppName(text: string): string {
    // Try quoted names first
    const quoted = text.match(
      /(?:call(?:ed)?|name[d]?|app|name|create|build)\s+(?:it\s+)?["'](\w+)["']/i,
    );
    if (quoted) return quoted[1];

    // Try unquoted patterns
    const named = text.match(
      /(?:call(?:ed)?|name[d]?|app|build|create)\s+(?:it\s+)?(\w+)/i,
    );
    if (named) {
      const name = named[1];
      const stopWords = new Set([
        'a',
        'an',
        'the',
        'and',
        'or',
        'it',
        'its',
        'this',
        'that',
        'with',
        'for',
        'from',
        'as',
        'by',
        'on',
        'in',
        'to',
        'of',
        'app',
      ]);
      if (!stopWords.has(name.toLowerCase())) return name;
    }

    // Default fallback
    return 'MyApp';
  }

  private extractKeywords(text: string): string[] {
    const keywords: Set<string> = new Set();

    // Platform keywords
    if (
      /\b(ios|swift|swiftui|xcode|iphone|ipad)\b/i.test(text)
    )
      keywords.add('ios');
    if (/\b(web|react|vue|angular|html|css)\b/i.test(text))
      keywords.add('web');
    if (/\b(python|flask|django)\b/i.test(text)) keywords.add('python');
    if (/\b(node|express|typescript)\b/i.test(text)) keywords.add('node');

    // Feature keywords
    if (/\b(todo|task|list)\b/i.test(text)) keywords.add('todo');
    if (/\b(habit|tracker|tracking)\b/i.test(text)) keywords.add('habit');
    if (/\b(calculator|calc|math)\b/i.test(text)) keywords.add('calculator');
    if (/\b(theme|dark|light|settings)\b/i.test(text)) keywords.add('theme');
    if (/\b(mood|emotion|journal|diary)\b/i.test(text)) keywords.add('mood');
    if (/\b(inventory|stock|item)\b/i.test(text)) keywords.add('inventory');

    // Architecture keywords
    if (/\b(mvvm|mvc|layered|modular)\b/i.test(text)) keywords.add('architecture');
    if (/\b(database|sql|firebase|storage)\b/i.test(text))
      keywords.add('persistence');
    if (/\b(animation|ui|ux|design)\b/i.test(text)) keywords.add('ui');
    if (/\b(auth|login|user|account)\b/i.test(text)) keywords.add('auth');

    return Array.from(keywords);
  }

  private normalizeDescription(text: string): string {
    return (
      text
        // Remove extra whitespace
        .replace(/\s+/g, ' ')
        // Remove common filler phrases
        .replace(
          /\b(please|could you|i need|i want|can you|build me|create me|make me)\b/gi,
          '',
        )
        .trim()
    );
  }
}
