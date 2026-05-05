/**
 * Single-File Repair Loop
 *
 * Repairs one file at a time, with rebuild after each repair.
 * Key improvements:
 * - Only repair files with actual compilation errors
 * - Track error delta (before/after)
 * - No blind multi-file repairs
 * - Log repair effectiveness
 */

import { createLogger } from './logger.js';
import type {
  Builder2LLM,
  RepairAttempt,
  CompileError,
  ArchitectureContract,
} from './types.js';

const log = createLogger('builder-v2:single-file-repair');

export class SingleFileRepair {
  constructor(private llm: Builder2LLM) {}

  /**
   * Repair a single broken file.
   * Returns the repaired code if successful, original code if repair fails.
   */
  async repair(
    filePath: string,
    originalCode: string,
    errors: CompileError[],
    contract: ArchitectureContract,
  ): Promise<RepairAttempt> {
    const startTime = Date.now();

    log.info(
      {
        filePath,
        errorCount: errors.length,
      },
      'Starting repair attempt',
    );

    const relevantErrors = errors.filter((e) => e.filePath === filePath);
    if (relevantErrors.length === 0) {
      log.warn(
        { filePath },
        'No errors found for file; repair not needed',
      );
      return {
        filePath,
        originalCode,
        repairedCode: originalCode,
        errorsBefore: [],
        errorsAfter: [],
        improved: false,
      };
    }

    const repairPrompt = this.buildRepairPrompt(
      filePath,
      originalCode,
      relevantErrors,
      contract,
    );

    try {
      const response = await this.llm.complete({
        messages: [
          {
            role: 'user',
            content: repairPrompt,
          },
        ],
        systemPrompt: REPAIR_SYSTEM_PROMPT,
        maxTokens: 8192,
      });

      const repairedCode = this.extractCode(response.content);

      const attempt: RepairAttempt = {
        filePath,
        originalCode,
        repairedCode,
        errorsBefore: relevantErrors,
        errorsAfter: [], // Will be filled in by build validator
        improved: false, // Will be determined by comparing error counts
        modelUsed: response.content ? 'unknown' : undefined,
      };

      log.info(
        {
          filePath,
          durationMs: Date.now() - startTime,
          codeSize: repairedCode.length,
        },
        'Repair completed',
      );

      return attempt;
    } catch (error) {
      log.error(
        {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        },
        'Repair failed',
      );

      // Return original code on LLM failure
      return {
        filePath,
        originalCode,
        repairedCode: originalCode,
        errorsBefore: relevantErrors,
        errorsAfter: relevantErrors,
        improved: false,
      };
    }
  }

  /**
   * Build a focused repair prompt that includes:
   * - The file being repaired
   * - Only relevant errors
   * - Type context from the contract
   */
  private buildRepairPrompt(
    filePath: string,
    originalCode: string,
    errors: CompileError[],
    contract: ArchitectureContract,
  ): string {
    const fileContract = contract.files.find(
      (f) => f.filePath === filePath,
    );

    const errorSummary = errors
      .map(
        (e) =>
          `Line ${e.line}${e.column ? `:${e.column}` : ''}: ${e.message}`,
      )
      .join('\n');

    const imports = fileContract?.allowedImports.join(', ') || 'none';
    const exports = fileContract?.exportedTypes
      .map((t) => t.name)
      .join(', ') || 'none';

    return `Fix the compilation errors in this file.

**File:** ${filePath}
**Responsibility:** ${fileContract?.responsibility || 'Unknown'}
**Exports:** ${exports}
**Can import from:** ${imports}

**Current Code:**
\`\`\`${this.languageFromPath(filePath)}
${originalCode}
\`\`\`

**Compilation Errors:**
\`\`\`
${errorSummary}
\`\`\`

**Requirements:**
1. Fix ALL compilation errors listed above
2. Do NOT add imports from files not in "Can import from" list
3. Do NOT export types not in the "Exports" list
4. Keep the file's responsibility: ${fileContract?.responsibility || 'Unknown'}
5. Return ONLY the corrected source code, no explanation

Provide the complete fixed file:`;
  }

  /**
   * Extract raw code from LLM response.
   * Handles markdown code blocks and raw code.
   */
  private extractCode(response: string): string {
    // Try to extract from markdown code block
    const codeBlockMatch = response.match(/```[\w]*\n?([\s\S]*?)```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1]!.trim();
    }

    // If no code block, return the response as-is
    return response.trim();
  }

  /**
   * Guess the language from file extension.
   */
  private languageFromPath(filePath: string): string {
    if (filePath.endsWith('.swift')) return 'swift';
    if (filePath.endsWith('.tsx')) return 'typescript';
    if (filePath.endsWith('.ts')) return 'typescript';
    if (filePath.endsWith('.jsx')) return 'javascript';
    if (filePath.endsWith('.js')) return 'javascript';
    if (filePath.endsWith('.py')) return 'python';
    if (filePath.endsWith('.go')) return 'go';
    if (filePath.endsWith('.rs')) return 'rust';
    if (filePath.endsWith('.java')) return 'java';
    return '';
  }
}

const REPAIR_SYSTEM_PROMPT = `You are an expert code repair system for AgentX Builder V2.
Your job is to fix compilation errors in source files while respecting strict architectural contracts.

Rules:
1. Only modify what's necessary to fix errors
2. Never add imports from files not explicitly allowed
3. Never export types not defined in the contract
4. Keep code clean and minimal
5. Return ONLY the corrected source code`;
