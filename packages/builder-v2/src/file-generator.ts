/**
 * Sequential File Generator
 *
 * Generates one file at a time with raw code output (no JSON wrapper).
 * Key improvements:
 * - One file per LLM call
 * - Raw source code only
 * - Context window management
 * - Pattern injection for generation prompts
 */

import { createLogger } from './logger.js';
import type {
  Builder2LLM,
  GeneratedFile,
  ArchitectureContract,
  FileContract,
  PatternProvider,
  CodePattern,
} from './types.js';

const log = createLogger('builder-v2:file-generator');

export class SequentialFileGenerator {
  constructor(
    private llm: Builder2LLM,
    private patternProvider?: PatternProvider,
  ) {}

  /**
   * Generate a single file in the project.
   * Returns raw source code (not JSON).
   */
  async generateFile(
    fileContract: FileContract,
    contract: ArchitectureContract,
    appDescription: string,
  ): Promise<GeneratedFile> {
    const startTime = Date.now();

    log.info(
      {
        filePath: fileContract.filePath,
        responsibility: fileContract.responsibility,
      },
      'Generating file',
    );

    try {
      // Get relevant patterns for this file
      const patterns = await this.getRelevantPatterns(fileContract, contract);

      // Build generation prompt
      const prompt = this.buildGenerationPrompt(
        fileContract,
        contract,
        appDescription,
        patterns,
      );

      // Call LLM for raw code generation
      const response = await this.llm.complete({
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
        systemPrompt: this.getSystemPromptForPlatform(contract.platform),
        maxTokens: this.getMaxTokensForFile(fileContract, contract),
        temperature: 0.7, // Slightly lower for code quality
      });

      // Extract raw code (no JSON parsing)
      const code = this.extractCode(response.content);

      const result: GeneratedFile = {
        filePath: fileContract.filePath,
        content: code,
        language: fileContract.language,
        success: code.length > 0,
        modelUsed: response.finishReason === 'stop' ? 'unknown' : undefined,
        tokensUsed: code.length / 4, // rough estimate
      };

      log.info(
        {
          filePath: fileContract.filePath,
          codeLength: code.length,
          durationMs: Date.now() - startTime,
          success: result.success,
        },
        'File generated',
      );

      return result;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      log.error(
        {
          filePath: fileContract.filePath,
          error: errorMsg,
        },
        'File generation failed',
      );

      return {
        filePath: fileContract.filePath,
        content: '',
        language: fileContract.language,
        success: false,
        error: errorMsg,
      };
    }
  }

  /**
   * Get relevant code patterns for this file from the pattern library.
   */
  private async getRelevantPatterns(
    fileContract: FileContract,
    contract: ArchitectureContract,
  ): Promise<CodePattern[]> {
    if (!this.patternProvider) return [];

    try {
      const patterns = await this.patternProvider.queryPatterns(
        {
          platform: contract.platform,
          complexity: contract.complexity,
          fileType: fileContract.language,
          keywords: [fileContract.responsibility],
        },
        3, // Get top 3 patterns
      );

      return patterns;
    } catch (error) {
      log.warn({ error }, 'Failed to fetch patterns');
      return [];
    }
  }

  /**
   * Build a focused generation prompt for a single file.
   */
  private buildGenerationPrompt(
    fileContract: FileContract,
    contract: ArchitectureContract,
    appDescription: string,
    patterns: CodePattern[],
  ): string {
    const imports = fileContract.allowedImports.join(', ') || 'none';
    const exports = fileContract.exportedTypes.map((t) => t.name).join(', ') || 'none';

    let prompt = `Generate the source code for this file in a ${contract.platform} application.

**Application:** ${contract.appName}
**Platform:** ${contract.platform}
**Complexity:** ${contract.complexity}

**About the app:**
${appDescription}

**File Details:**
- Path: ${fileContract.filePath}
- Language: ${fileContract.language}
- Responsibility: ${fileContract.responsibility}
- Exports: ${exports}
- Can import from: ${imports}

`;

    // Include relevant patterns
    if (patterns.length > 0) {
      prompt += `**Relevant Code Patterns:**\n`;
      for (const pattern of patterns) {
        prompt += `
\`\`\`${pattern.fileType || fileContract.language}
// Pattern: ${pattern.name}
${pattern.code}
\`\`\`
`;
      }
      prompt += `\n`;
    }

    prompt += `**Requirements:**
1. Generate complete, working source code for this file
2. Only import from the files listed in "Can import from"
3. Export ONLY the types listed in "Exports"
4. Follow the patterns shown above if applicable
5. Include any needed boilerplate or setup for the platform
6. Return ONLY raw source code (no markdown, no explanation)

Generate the complete source code for ${fileContract.filePath}:`;

    return prompt;
  }

  /**
   * Get platform-specific system prompt.
   */
  private getSystemPromptForPlatform(platform: string): string {
    const basePrompt = `You are an expert code generator for AgentX Builder V2.
Generate clean, working source code that adheres to strict architectural contracts.
Return ONLY raw source code with NO explanations, NO markdown blocks, NO JSON.`;

    if (platform === 'ios') {
      return (
        basePrompt +
        `

iOS/SwiftUI Guidelines:
- Use SwiftUI for UI
- Follow MVVM pattern
- Use @State, @StateObject for state management
- Include proper error handling
- Use view modifiers appropriately`
      );
    }

    if (platform === 'web') {
      return (
        basePrompt +
        `

Web/React Guidelines:
- Use React 18+ with TypeScript
- Functional components only
- Use React hooks (useState, useEffect, useCallback)
- Include proper TypeScript types
- Use CSS-in-JS or inline styles

Design quality bar (a professional must be happy to ship this):
- Deliberate colour palette via CSS custom properties (:root), modern
  typography, generous spacing — never unstyled defaults
- Real layout with flexbox/grid; responsive at mobile widths
- Tasteful polish: subtle shadows, rounded corners, hover/focus states
- Accessible: semantic elements, labels on inputs, sufficient contrast`
      );
    }

    if (platform === 'python') {
      return (
        basePrompt +
        `

Python Guidelines:
- Use Python 3.8+
- Include type hints
- Follow PEP 8 style
- Include docstrings
- Use proper exception handling`
      );
    }

    return basePrompt;
  }

  /**
   * Estimate max tokens based on file type and complexity.
   */
  private getMaxTokensForFile(
    fileContract: FileContract,
    contract: ArchitectureContract,
  ): number {
    const baseTokens = 4096;
    const complexityMultiplier =
      contract.complexity === 'simple'
        ? 1.0
        : contract.complexity === 'medium'
          ? 1.5
          : 2.0;

    return Math.round(baseTokens * complexityMultiplier);
  }

  /**
   * Extract raw code from LLM response.
   * Removes markdown blocks if present, but expects raw code.
   */
  private extractCode(response: string): string {
    let code = response.trim();

    // Remove markdown code blocks if present
    const codeBlockMatch = code.match(/```[\w]*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      code = codeBlockMatch[1]!.trim();
    }

    return code;
  }
}
