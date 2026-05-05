/**
 * Builder V2: Main Orchestrator
 *
 * Coordinates the entire app-building pipeline:
 * 1. Normalize spec
 * 2. Generate architecture contract
 * 3. Clean project directory
 * 4. Generate project scaffolding
 * 5. Sequential file generation
 * 6. Toolchain preparation
 * 7. Build validation
 * 8. Single-file repair loop
 * 9. Final validation
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import { v4 as uuidv4 } from 'uuid';
import { SpecNormalizer } from './spec-normalizer.js';
import { ArchitectureContractGenerator } from './architecture-contract.js';
import { SequentialFileGenerator } from './file-generator.js';
import { BuildValidator } from './build-validator.js';
import { SingleFileRepair } from './single-file-repair.js';
import { generateScaffold, writeScaffoldFiles } from './scaffolder.js';
import { prepareToolchain } from './toolchain-preparation.js';
import type {
  Builder2LLM,
  BuildSession,
  PatternProvider,
  LogEntry,
} from './types.js';
import type { BuildMemoryHints } from './memory/build-learning/build-learning.types.js';

const log = createLogger('builder-v2:orchestrator');

export class BuilderV2 {
  private specNormalizer = new SpecNormalizer();
  private contractGenerator = new ArchitectureContractGenerator();
  private buildValidator = new BuildValidator();
  private session: BuildSession | null = null;

  constructor(
    private llm: Builder2LLM,
    private projectDir: string,
    private patternProvider?: PatternProvider,
  ) {}

  /**
   * Main build orchestration function.
   * Returns success/failure with detailed logs.
   *
   * @param appDescription - User's app description
   * @param suggestedName - Optional app name override
   * @param suggestedPlatform - Optional platform override
   * @param memoryHints - Optional hints from past successful/failed builds
   */
  async build(
    appDescription: string,
    suggestedName?: string,
    suggestedPlatform?: string,
    memoryHints?: BuildMemoryHints,
  ): Promise<BuildSession> {
    const sessionId = uuidv4();
    this.session = {
      sessionId,
      spec: this.specNormalizer.normalize(
        appDescription,
        suggestedName,
        suggestedPlatform as any,
      ),
      contract: {} as any, // Will be filled
      generatedFiles: new Map(),
      repairAttempts: [],
      status: 'pending',
      startTime: Date.now(),
      logs: [],
    };

    this.log('info', 'start', `Starting build session ${sessionId}`);

    // Log memory hints if provided
    if (memoryHints) {
      this.log(
        'info',
        'memory',
        `Using build memory hints: ${memoryHints.similarSuccessfulBuilds.length} similar successes, ${memoryHints.recommendedPatterns.length} recommended patterns`,
      );
      if (memoryHints.warningMessages.length > 0) {
        this.log(
          'warn',
          'memory',
          `Memory warnings: ${memoryHints.warningMessages.join('; ')}`,
        );
      }
    }

    try {
      // Step 1: Normalize spec
      this.session.status = 'pending';
      this.log(
        'info',
        'spec',
        `Normalized spec: ${this.session.spec.appName} (${this.session.spec.platform})`,
      );

      // Step 2: Generate architecture contract
      this.session.contract = this.contractGenerator.generate(
        this.session.spec,
      );
      this.log(
        'info',
        'contract',
        `Generated contract with ${this.session.contract.files.length} files`,
      );

      // Step 3: Clean project directory
      this.ensureCleanProjectDir();
      this.log('info', 'setup', 'Project directory prepared');

      // Step 4: Generate project scaffolding
      const scaffoldFiles = generateScaffold(
        this.session.spec.platform,
        this.projectDir,
        this.session.spec.appName,
      );
      writeScaffoldFiles(scaffoldFiles, this.projectDir);
      this.log(
        'info',
        'scaffold',
        `Created project scaffold with ${scaffoldFiles.length} files`,
      );

      // Step 5: Sequential file generation
      this.session.status = 'generating';
      for (const fileContract of this.session.contract.files) {
        const generator = new SequentialFileGenerator(
          this.llm,
          this.patternProvider,
        );
        const generated = await generator.generateFile(
          fileContract,
          this.session.contract,
          appDescription,
        );

        this.session.generatedFiles.set(fileContract.filePath, generated);

        if (generated.success) {
          // Write file to disk
          this.writeFile(fileContract.filePath, generated.content);
          this.log(
            'info',
            'generate',
            `Generated ${fileContract.filePath} (${generated.content.length} bytes)`,
          );
        } else {
          this.log(
            'error',
            'generate',
            `Failed to generate ${fileContract.filePath}: ${generated.error}`,
          );
        }
      }

      // Step 6: Toolchain preparation
      this.session.status = 'preparing';
      const toolchainResult = prepareToolchain(
        this.projectDir,
        this.session.spec.platform,
      );

      if (toolchainResult.success) {
        this.log(
          'info',
          'toolchain',
          `Toolchain prepared with ${toolchainResult.commandsRun.length} commands: ${toolchainResult.commandsRun.join(', ')}`,
        );
      } else {
        this.log(
          'warn',
          'toolchain',
          `Toolchain preparation completed with issues: ${toolchainResult.errors.join('; ')}`,
        );
      }

      // Step 7: Initial build validation
      this.session.status = 'building';
      const initialBuild = await this.buildValidator.validate(
        this.projectDir,
        this.session.spec.platform,
      );
      this.session.result = initialBuild;

      this.log(
        'info',
        'build',
        `Initial build: ${initialBuild.success ? 'SUCCESS' : `${initialBuild.errorCount} errors`}`,
      );

      // Step 8: Repair loop if needed
      if (!initialBuild.success) {
        this.session.status = 'repairing';
        await this.repairLoop(initialBuild.errorCount);
      }

      // Step 9: Final validation
      const finalBuild = await this.buildValidator.validate(
        this.projectDir,
        this.session.spec.platform,
      );
      this.session.result = finalBuild;
      this.session.status = finalBuild.success ? 'complete' : 'failed';

      this.log(
        'info',
        'complete',
        `Build ${finalBuild.success ? 'succeeded' : 'failed'} with ${finalBuild.errorCount} errors`,
      );

      return this.session;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);
      this.log(
        'error',
        'exception',
        `Unexpected error: ${errorMsg}`,
      );

      if (this.session) {
        this.session.status = 'failed';
      }

      throw error;
    } finally {
      if (this.session) {
        this.session.endTime = Date.now();
      }
    }
  }

  /**
   * Repair loop: fix one file at a time until build succeeds or max attempts reached.
   */
  private async repairLoop(initialErrorCount: number): Promise<void> {
    const maxRepairs = 5;
    let attempt = 0;
    let errorCount = initialErrorCount;

    while (attempt < maxRepairs && errorCount > 0) {
      attempt++;
      this.log(
        'info',
        'repair',
        `Repair attempt ${attempt}/${maxRepairs} (${errorCount} errors)`,
      );

      // Get latest build errors
      const build = await this.buildValidator.validate(
        this.projectDir,
        this.session!.spec.platform,
      );

      if (build.success) {
        this.log('info', 'repair', 'Build succeeded!');
        this.session!.result = build;
        return;
      }

      // Pick the most important file to repair (first in error list)
      const brokenFiles = Array.from(build.brokenFiles);
      if (brokenFiles.length === 0) break;

      const filePath = brokenFiles[0];
      const generated = this.session!.generatedFiles.get(filePath);
      if (!generated) {
        this.log(
          'warn',
          'repair',
          `No generated file for ${filePath}`,
        );
        break;
      }

      // Repair the file
      const repairer = new SingleFileRepair(this.llm);
      const repairAttempt = await repairer.repair(
        filePath,
        generated.content,
        build.errors.filter((e) => e.filePath === filePath),
        this.session!.contract,
      );

      this.session!.repairAttempts.push(repairAttempt);

      // Update the generated file
      this.session!.generatedFiles.set(filePath, {
        filePath,
        content: repairAttempt.repairedCode,
        language: generated.language,
        success: repairAttempt.repairedCode.length > 0,
      });

      // Write repaired file
      this.writeFile(filePath, repairAttempt.repairedCode);

      const prevErrorCount = errorCount;
      errorCount = build.errorCount;
      const delta = prevErrorCount - errorCount;

      this.log(
        'info',
        'repair',
        `Repaired ${filePath} (errors: ${prevErrorCount} → ${errorCount}, delta: ${delta})`,
      );
    }

    if (errorCount > 0) {
      this.log(
        'warn',
        'repair',
        `Repair loop exited with ${errorCount} remaining errors`,
      );
    }
  }

  /**
   * Ensure clean project directory.
   */
  private ensureCleanProjectDir(): void {
    // Create project dir if needed
    fs.mkdirSync(this.projectDir, { recursive: true });

    // Create platform-specific source directories
    const platform = this.session!.spec.platform;
    if (platform === 'ios') {
      fs.mkdirSync(path.join(this.projectDir, 'Sources'), {
        recursive: true,
      });
    } else if (platform === 'web') {
      fs.mkdirSync(path.join(this.projectDir, 'src'), {
        recursive: true,
      });
    } else if (platform === 'python') {
      // Python doesn't need special setup
    }
  }

  /**
   * Write a file to the project directory.
   */
  private writeFile(filePath: string, content: string): void {
    const fullPath = path.join(this.projectDir, filePath);
    const dir = path.dirname(fullPath);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf-8');
  }

  /**
   * Helper: log to session logs.
   */
  private log(
    level: 'info' | 'warn' | 'error' | 'debug',
    stage: string,
    message: string,
  ): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      stage,
      message,
    };

    if (this.session) {
      this.session.logs.push(entry);
    }

    const logFn =
      level === 'info'
        ? log.info
        : level === 'warn'
          ? log.warn
          : level === 'error'
            ? log.error
            : log.debug;

    logFn({ stage }, message);
  }
}
