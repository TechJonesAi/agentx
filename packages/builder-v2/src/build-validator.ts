/**
 * Build Validator
 *
 * Validates builds by:
 * - Running compiler/build commands
 * - Parsing output for errors
 * - Tracking error progression
 * - Validating against contract
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLogger } from './logger.js';
import type { BuildValidationResult } from './types.js';
import { ErrorParser } from './error-parser.js';

const log = createLogger('builder-v2:build-validator');
const execFileAsync = promisify(execFile);

export class BuildValidator {
  private errorParser = new ErrorParser();

  /**
   * Validate a project build by running the appropriate build command.
   */
  async validate(
    projectDir: string,
    platform: string,
  ): Promise<BuildValidationResult> {
    const startTime = Date.now();

    log.info(
      {
        projectDir,
        platform,
      },
      'Starting build validation',
    );

    try {
      const buildCommand = this.getBuildCommand(projectDir, platform);
      const { stdout, stderr } = await execFileAsync(
        buildCommand.cmd,
        buildCommand.args,
        {
          cwd: projectDir,
          maxBuffer: 10 * 1024 * 1024, // 10MB
          timeout: 60000, // 60 seconds
        },
      );

      const rawOutput = stdout + stderr;
      const knownFiles = this.getKnownFiles(projectDir);
      const errors = this.errorParser.parse(rawOutput, knownFiles);

      const result: BuildValidationResult = {
        success: errors.length === 0,
        errors,
        errorCount: errors.length,
        brokenFiles: new Set(errors.map((e) => e.filePath)),
        unattributedErrorCount: errors.filter(
          (e) => e.confidence < 0.5,
        ).length,
        rawOutput,
      };

      log.info(
        {
          durationMs: Date.now() - startTime,
          success: result.success,
          errorCount: result.errorCount,
        },
        'Build validation complete',
      );

      return result;
    } catch (error) {
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      log.error(
        {
          projectDir,
          error: errorMsg,
          durationMs: Date.now() - startTime,
        },
        'Build validation failed',
      );

      // Extract error details from exception output
      const output =
        error instanceof Error && 'stderr' in error
          ? (error as any).stderr || (error as any).stdout || errorMsg
          : errorMsg;

      const knownFiles = this.getKnownFiles(projectDir);
      const errors = this.errorParser.parse(output, knownFiles);

      return {
        success: false,
        errors,
        errorCount: errors.length,
        brokenFiles: new Set(errors.map((e) => e.filePath)),
        unattributedErrorCount: errors.filter(
          (e) => e.confidence < 0.5,
        ).length,
        rawOutput: output,
      };
    }
  }

  /**
   * Get the appropriate build command for the platform.
   */
  private getBuildCommand(
    projectDir: string,
    platform: string,
  ): { cmd: string; args: string[] } {
    if (platform === 'ios') {
      // Try to find Xcode project
      const projects = fs
        .readdirSync(projectDir)
        .filter((f) => f.endsWith('.xcodeproj'));

      if (projects.length > 0) {
        return {
          cmd: 'xcodebuild',
          args: [
            '-project',
            projects[0],
            '-scheme',
            this.extractSchemeName(projects[0]),
            'build',
          ],
        };
      }

      return {
        cmd: 'xcodebuild',
        args: ['build'],
      };
    }

    if (platform === 'web') {
      // Check for package.json and build script
      const pkgJsonPath = path.join(projectDir, 'package.json');
      if (fs.existsSync(pkgJsonPath)) {
        return {
          cmd: 'npm',
          args: ['run', 'build'],
        };
      }

      return {
        cmd: 'tsc',
        args: ['--noEmit'],
      };
    }

    if (platform === 'python') {
      return {
        cmd: 'python',
        args: ['-m', 'py_compile', '.'],
      };
    }

    if (platform === 'node') {
      return {
        cmd: 'npm',
        args: ['run', 'build'],
      };
    }

    // Fallback
    return {
      cmd: 'echo',
      args: ['Generic platform, no build validation'],
    };
  }

  /**
   * Extract scheme name from Xcode project path.
   * E.g., "MyApp.xcodeproj" → "MyApp"
   */
  private extractSchemeName(projectPath: string): string {
    return path.basename(projectPath).replace('.xcodeproj', '');
  }

  /**
   * Get all source files in the project.
   */
  private getKnownFiles(projectDir: string): Set<string> {
    const files = new Set<string>();

    const scan = (dir: string, prefix = '') => {
      if (!fs.existsSync(dir)) return;

      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;

        const fullPath = path.join(dir, entry);
        const relativePath = prefix ? `${prefix}/${entry}` : entry;

        if (fs.statSync(fullPath).isDirectory()) {
          scan(fullPath, relativePath);
        } else if (
          /\.(swift|tsx?|jsx|py|js|go|rs|java|cpp|c|h|hpp)$/.test(entry)
        ) {
          files.add(relativePath);
        }
      }
    };

    scan(projectDir);
    return files;
  }
}
