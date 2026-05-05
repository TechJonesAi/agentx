/**
 * Builder V2 Types
 *
 * Core types for the new app-building pipeline.
 * These provide strict contracts for each stage of the build process.
 */

export type CodePlatform = 'ios' | 'web' | 'python' | 'node' | 'generic';
export type AppComplexity = 'simple' | 'medium' | 'complex';
export type ArchitectureStyle = 'mvvm' | 'mvc' | 'layered' | 'modular' | 'functional';

// ─── Spec Normalization ─────────────────────────────────────────────────────

export interface AppSpec {
  /** User's natural language app description */
  description: string;
  /** Detected or specified platform (ios, web, python, etc.) */
  platform: CodePlatform;
  /** App name/project name */
  appName: string;
  /** Estimated complexity */
  complexity: AppComplexity;
  /** Additional constraints or preferences */
  constraints?: Record<string, string>;
}

export interface NormalizedSpec extends AppSpec {
  /** Normalized version of the request */
  normalized: string;
  /** Detected keywords for pattern matching */
  keywords: string[];
}

// ─── Architecture Contract ──────────────────────────────────────────────────

export interface TypeDefinition {
  /** Type name */
  name: string;
  /** Kind: class, struct, enum, interface, etc. */
  kind: string;
  /** Module that owns this type */
  ownerModule: string;
  /** External types it depends on */
  dependencies: string[];
}

export interface FileContract {
  /** Relative file path */
  filePath: string;
  /** Language/extension */
  language: string;
  /** What this file is responsible for */
  responsibility: string;
  /** Types this file exports */
  exportedTypes: TypeDefinition[];
  /** Files it can import from */
  allowedImports: string[];
  /** Order priority (lower = earlier) */
  priority: number;
}

export interface ArchitectureContract {
  /** Application name */
  appName: string;
  /** Target platform */
  platform: CodePlatform;
  /** Estimated complexity */
  complexity: AppComplexity;
  /** Architecture style */
  architectureStyle: ArchitectureStyle;
  /** All files in the project */
  files: FileContract[];
  /** Entry point file */
  entryPoint: string;
  /** Overall type ownership rules */
  typeOwnershipRules: Record<string, string>;
  /** Build targets or configuration files needed */
  buildConfig: string[];
}

// ─── File Generation ────────────────────────────────────────────────────────

export interface GeneratedFile {
  /** File path relative to project root */
  filePath: string;
  /** Raw source code (no JSON wrapper) */
  content: string;
  /** Language/type of file */
  language: string;
  /** Whether generation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Model used to generate */
  modelUsed?: string;
  /** Tokens consumed */
  tokensUsed?: number;
}

// ─── Build Validation ──────────────────────────────────────────────────────

export interface CompileError {
  /** File path */
  filePath: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column number if available */
  column?: number;
  /** Error message */
  message: string;
  /** Full original error line */
  originalLine: string;
  /** Confidence that this error belongs to this file (0-1) */
  confidence: number;
}

export interface BuildValidationResult {
  /** Whether compilation succeeded */
  success: boolean;
  /** All parsed errors */
  errors: CompileError[];
  /** Number of errors */
  errorCount: number;
  /** Files with errors */
  brokenFiles: Set<string>;
  /** Number of unattributed errors */
  unattributedErrorCount: number;
  /** Raw build output for inspection */
  rawOutput: string;
}

// ─── Repair ────────────────────────────────────────────────────────────────

export interface RepairAttempt {
  /** File being repaired */
  filePath: string;
  /** Original code before repair */
  originalCode: string;
  /** Repaired code */
  repairedCode: string;
  /** Errors before repair */
  errorsBefore: CompileError[];
  /** Errors after repair */
  errorsAfter: CompileError[];
  /** Did it help? */
  improved: boolean;
  /** Model used */
  modelUsed?: string;
}

// ─── Build Session ────────────────────────────────────────────────────────

export interface BuildSession {
  /** Unique session ID */
  sessionId: string;
  /** App specification */
  spec: NormalizedSpec;
  /** Architecture contract */
  contract: ArchitectureContract;
  /** Files generated so far */
  generatedFiles: Map<string, GeneratedFile>;
  /** Repair attempts made */
  repairAttempts: RepairAttempt[];
  /** Overall build status */
  status: 'pending' | 'generating' | 'preparing' | 'building' | 'repairing' | 'complete' | 'failed';
  /** Final result */
  result?: BuildValidationResult;
  /** Start time */
  startTime: number;
  /** End time */
  endTime?: number;
  /** Structured logs */
  logs: LogEntry[];
}

// ─── Logging ────────────────────────────────────────────────────────────────

export interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error' | 'debug';
  stage: string;
  message: string;
  metadata?: Record<string, unknown>;
}

// ─── LLM Interface ────────────────────────────────────────────────────────

export interface LLMRequest {
  messages: Array<{ role: 'user' | 'system' | 'assistant'; content: string }>;
  systemPrompt?: string;
  maxTokens?: number;
  model?: string;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  finishReason: 'stop' | 'length' | 'error';
  error?: string;
}

export interface Builder2LLM {
  complete(request: LLMRequest): Promise<LLMResponse>;
}

// ─── Pattern Library Interface ────────────────────────────────────────────

export interface CodePattern {
  id: string;
  name: string;
  platform: CodePlatform;
  appType?: string;
  fileType?: string;
  keywords: string[];
  code: string;
  description: string;
  successRate: number; // 0-1
  lastUsed?: number;
}

export interface PatternContext {
  platform: CodePlatform;
  complexity: AppComplexity;
  fileType?: string;
  keywords: string[];
}

export interface PatternProvider {
  queryPatterns(context: PatternContext, limit?: number): Promise<CodePattern[]>;
}
