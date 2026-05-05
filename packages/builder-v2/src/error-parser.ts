/**
 * Compiler Error Parser
 *
 * Robust parsing of build errors from xcodebuild, tsc, Python, Node, etc.
 * Handles:
 * - /path/File.swift:line:col: error: message
 * - File.swift:line: error: message
 * - Nearby file context blocks
 * - Unattributed errors with fallback logic
 *
 * Key improvement over legacy builder: accurate file attribution,
 * no blind fallback to ContentView.swift.
 */

import { createLogger } from './logger.js';
import type { CompileError } from './types.js';

const log = createLogger('builder-v2:error-parser');

export class ErrorParser {
  /**
   * Parse build output and extract compiler errors.
   * Returns a structured list of errors with high-confidence file attribution.
   */
  parse(buildOutput: string, knownFiles: Set<string>): CompileError[] {
    const errors: CompileError[] = [];

    // Try each parser in order
    const fromXcodebuild = this.parseXcodebuild(buildOutput, knownFiles);
    if (fromXcodebuild.length > 0) return fromXcodebuild;

    const fromTsc = this.parseTsc(buildOutput, knownFiles);
    if (fromTsc.length > 0) return fromTsc;

    const fromPython = this.parsePython(buildOutput, knownFiles);
    if (fromPython.length > 0) return fromPython;

    const fromNode = this.parseNode(buildOutput, knownFiles);
    if (fromNode.length > 0) return fromNode;

    // If nothing matched, try generic format
    const generic = this.parseGeneric(buildOutput, knownFiles);

    return generic;
  }

  /**
   * Parse xcodebuild error format:
   * /path/to/File.swift:123:45: error: message here
   * /path/to/File.swift:123: error: message
   */
  private parseXcodebuild(
    output: string,
    knownFiles: Set<string>,
  ): CompileError[] {
    const errors: CompileError[] = [];
    // Matches: /path/File.ext:line:col: error: or /path/File.ext:line: error:
    const regex =
      /^([^\s:]+\.swift):(\d+)(?::(\d+))?: error: (.+)$/gm;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [fullLine, filePath, lineStr, colStr, message] = match;
      const fileName = this.extractFileName(filePath);
      const confidence = this.computeConfidence(
        fileName,
        filePath,
        knownFiles,
        'xcodebuild',
      );

      if (confidence > 0.5) {
        errors.push({
          filePath: this.normalizeFilePath(filePath),
          line: parseInt(lineStr, 10),
          column: colStr ? parseInt(colStr, 10) : undefined,
          message,
          originalLine: fullLine,
          confidence,
        });
      }
    }

    return errors;
  }

  /**
   * Parse TypeScript error format:
   * src/file.ts(123,45): error TS1234: message
   */
  private parseTsc(
    output: string,
    knownFiles: Set<string>,
  ): CompileError[] {
    const errors: CompileError[] = [];
    const regex =
      /^([^\s(]+\.tsx?)\((\d+),(\d+)\): error TS\d+: (.+)$/gm;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [fullLine, filePath, lineStr, colStr, message] = match;
      const fileName = this.extractFileName(filePath);
      const confidence = this.computeConfidence(
        fileName,
        filePath,
        knownFiles,
        'tsc',
      );

      if (confidence > 0.5) {
        errors.push({
          filePath: this.normalizeFilePath(filePath),
          line: parseInt(lineStr, 10),
          column: parseInt(colStr, 10),
          message,
          originalLine: fullLine,
          confidence,
        });
      }
    }

    return errors;
  }

  /**
   * Parse Python traceback format:
   * File "script.py", line 123
   *   error message
   */
  private parsePython(
    output: string,
    knownFiles: Set<string>,
  ): CompileError[] {
    const errors: CompileError[] = [];
    const regex = /File "([^"]+)", line (\d+)[\s\S]*?(?:Error|error): (.+)$/gm;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [fullLine, filePath, lineStr, message] = match;
      const fileName = this.extractFileName(filePath);
      const confidence = this.computeConfidence(
        fileName,
        filePath,
        knownFiles,
        'python',
      );

      if (confidence > 0.5) {
        errors.push({
          filePath: this.normalizeFilePath(filePath),
          line: parseInt(lineStr, 10),
          message: message.trim(),
          originalLine: fullLine,
          confidence,
        });
      }
    }

    return errors;
  }

  /**
   * Parse Node.js error format:
   * Error at file.js:123:45
   */
  private parseNode(
    output: string,
    knownFiles: Set<string>,
  ): CompileError[] {
    const errors: CompileError[] = [];
    const regex = /Error (?:at )?([^\s:]+\.(?:js|ts|tsx)):(\d+)(?::(\d+))?: (.+)/g;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [fullLine, filePath, lineStr, colStr, message] = match;
      const fileName = this.extractFileName(filePath);
      const confidence = this.computeConfidence(
        fileName,
        filePath,
        knownFiles,
        'node',
      );

      if (confidence > 0.5) {
        errors.push({
          filePath: this.normalizeFilePath(filePath),
          line: parseInt(lineStr, 10),
          column: colStr ? parseInt(colStr, 10) : undefined,
          message,
          originalLine: fullLine,
          confidence,
        });
      }
    }

    return errors;
  }

  /**
   * Generic fallback: look for patterns like "file.ext:line: error:"
   */
  private parseGeneric(
    output: string,
    knownFiles: Set<string>,
  ): CompileError[] {
    const errors: CompileError[] = [];
    // Match lines with file:line: pattern
    const regex =
      /(?:^|[\n])([^\s:]+\.(?:swift|tsx?|py|js|jsx|go|rs|java|cpp|c)):(\d+)(?::(\d+))?: (?:error|Error|ERROR): (.+?)(?=\n|$)/g;
    let match;

    while ((match = regex.exec(output)) !== null) {
      const [, filePath, lineStr, colStr, message] = match;
      const fileName = this.extractFileName(filePath);
      const confidence = this.computeConfidence(
        fileName,
        filePath,
        knownFiles,
        'generic',
      );

      if (confidence > 0.3) {
        errors.push({
          filePath: this.normalizeFilePath(filePath),
          line: parseInt(lineStr, 10),
          column: colStr ? parseInt(colStr, 10) : undefined,
          message: message.trim(),
          originalLine: match[0],
          confidence,
        });
      }
    }

    return errors;
  }

  /**
   * Compute confidence that an error belongs to a file (0-1).
   * Higher confidence = more certain the attribution is correct.
   */
  private computeConfidence(
    fileName: string,
    fullPath: string,
    knownFiles: Set<string>,
    parser: string,
  ): number {
    let confidence = 0.5; // baseline

    // Full path match is highest confidence
    if (knownFiles.has(fullPath)) confidence = 0.95;
    // File name match
    else if (knownFiles.has(fileName)) confidence = 0.85;
    // Partial match (e.g., file is in a known directory)
    else if (Array.from(knownFiles).some((f) => f.endsWith(fileName)))
      confidence = 0.75;

    // Boost for specific parsers with structured format
    if (parser === 'xcodebuild' || parser === 'tsc')
      confidence = Math.min(1.0, confidence + 0.1);

    return confidence;
  }

  /**
   * Extract just the file name from a full path.
   * E.g., /path/to/File.swift → File.swift
   */
  private extractFileName(path: string): string {
    return path.split('/').pop() || path;
  }

  /**
   * Normalize file path to a consistent format.
   * Removes leading slashes, normalizes separators.
   */
  private normalizeFilePath(path: string): string {
    return (
      path
        .replace(/^\//g, '') // Remove leading slash
        .replace(/\\/g, '/') // Windows backslash to forward slash
        .replace(/\/+/g, '/') // Collapse multiple slashes
    );
  }

  /**
   * Heuristic: is this likely a real error or noise?
   */
  isLikelyRealError(error: CompileError): boolean {
    // Very short messages are likely noise
    if (error.message.length < 5) return false;

    // Some common noise patterns
    const noisePatterns = ['(in module', 'imported from', 'see previous'];
    if (noisePatterns.some((p) => error.message.includes(p)))
      return false;

    return error.confidence > 0.4;
  }
}

/**
 * Helper: group errors by file for easier reporting.
 */
export function groupErrorsByFile(errors: CompileError[]): Record<string, CompileError[]> {
  const grouped: Record<string, CompileError[]> = {};
  for (const error of errors) {
    if (!grouped[error.filePath]) {
      grouped[error.filePath] = [];
    }
    grouped[error.filePath].push(error);
  }
  return grouped;
}
