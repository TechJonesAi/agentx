/**
 * Toolchain Preparation Stage
 *
 * Prepares the project environment for actual compilation:
 * - iOS: Runs xcodegen to generate .xcodeproj from project.yml
 * - Web: Runs npm install to install dependencies
 * - Python: Ensures virtualenv/requirements are set up
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from './logger.js';
import type { CodePlatform } from './types.js';

const log = createLogger('builder-v2:toolchain');

export interface ToolchainPreparationResult {
  success: boolean;
  platform: CodePlatform;
  commandsRun: string[];
  errors: string[];
  durationMs: number;
}

/**
 * Prepare the toolchain for a project.
 * Returns success/failure with commands run.
 */
export function prepareToolchain(
  projectDir: string,
  platform: CodePlatform,
): ToolchainPreparationResult {
  const startTime = Date.now();
  const commandsRun: string[] = [];
  const errors: string[] = [];

  log.info(
    { platform, projectDir },
    'Preparing toolchain'
  );

  try {
    switch (platform) {
      case 'ios':
        prepareIOSToolchain(projectDir, commandsRun, errors);
        break;
      case 'web':
        prepareWebToolchain(projectDir, commandsRun, errors);
        break;
      case 'python':
        preparePythonToolchain(projectDir, commandsRun, errors);
        break;
      case 'node':
        prepareNodeToolchain(projectDir, commandsRun, errors);
        break;
    }

    const success = errors.length === 0;

    if (success) {
      log.info(
        { commandsRun, platform },
        'Toolchain preparation succeeded'
      );
    } else {
      log.error(
        { errors, platform },
        'Toolchain preparation failed'
      );
    }

    return {
      success,
      platform,
      commandsRun,
      errors,
      durationMs: Date.now() - startTime,
    };
  } catch (error) {
    const errorMsg =
      error instanceof Error ? error.message : String(error);

    log.error(
      { error: errorMsg, platform },
      'Unexpected error during toolchain preparation'
    );

    return {
      success: false,
      platform,
      commandsRun,
      errors: [errorMsg],
      durationMs: Date.now() - startTime,
    };
  }
}

/**
 * iOS toolchain: Generate .xcodeproj from project.yml using xcodegen.
 */
function prepareIOSToolchain(
  projectDir: string,
  commandsRun: string[],
  errors: string[],
): void {
  const projectYmlPath = path.join(projectDir, 'project.yml');
  const xcodeprjPath = path.join(projectDir, 'project.xcodeproj');

  // Skip if .xcodeproj already exists
  if (fs.existsSync(xcodeprjPath)) {
    log.info(
      { projectDir },
      'Skipping xcodegen: .xcodeproj already exists'
    );
    return;
  }

  // Check if project.yml exists
  if (!fs.existsSync(projectYmlPath)) {
    errors.push('project.yml not found');
    return;
  }

  try {
    log.info(
      { projectDir },
      'Running xcodegen generate'
    );

    execSync('xcodegen generate', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    commandsRun.push('xcodegen generate');

    // Verify .xcodeproj was created
    if (!fs.existsSync(xcodeprjPath)) {
      errors.push('.xcodeproj not created by xcodegen');
    }
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : String(error);
    errors.push(`xcodegen failed: ${msg}`);
  }
}

/**
 * Web toolchain: Run npm install and verify TypeScript.
 */
function prepareWebToolchain(
  projectDir: string,
  commandsRun: string[],
  errors: string[],
): void {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const nodeModulesPath = path.join(projectDir, 'node_modules');

  // Check if package.json exists
  if (!fs.existsSync(packageJsonPath)) {
    errors.push('package.json not found');
    return;
  }

  // Skip if node_modules already exists
  if (fs.existsSync(nodeModulesPath)) {
    log.info(
      { projectDir },
      'Skipping npm install: node_modules already exists'
    );
    return;
  }

  try {
    log.info(
      { projectDir },
      'Running npm install'
    );

    execSync('npm install', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    commandsRun.push('npm install');
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : String(error);
    errors.push(`npm install failed: ${msg}`);
  }
}

/**
 * Python toolchain: Minimal setup (requirements.txt should exist).
 */
function preparePythonToolchain(
  projectDir: string,
  commandsRun: string[],
  errors: string[],
): void {
  const requirementsPath = path.join(projectDir, 'requirements.txt');

  if (!fs.existsSync(requirementsPath)) {
    errors.push('requirements.txt not found');
    return;
  }

  log.info(
    { projectDir },
    'Python toolchain verified'
  );

  // Python projects are ready - no tool commands needed for basic execution
}

/**
 * Node toolchain: Verify package.json exists and install if needed.
 */
function prepareNodeToolchain(
  projectDir: string,
  commandsRun: string[],
  errors: string[],
): void {
  const packageJsonPath = path.join(projectDir, 'package.json');
  const nodeModulesPath = path.join(projectDir, 'node_modules');

  if (!fs.existsSync(packageJsonPath)) {
    errors.push('package.json not found');
    return;
  }

  // Skip if node_modules already exists
  if (fs.existsSync(nodeModulesPath)) {
    log.info(
      { projectDir },
      'Skipping npm install: node_modules already exists'
    );
    return;
  }

  try {
    log.info(
      { projectDir },
      'Running npm install'
    );

    execSync('npm install', {
      cwd: projectDir,
      stdio: 'pipe',
    });

    commandsRun.push('npm install');
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : String(error);
    errors.push(`npm install failed: ${msg}`);
  }
}
