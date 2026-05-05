/**
 * Builder V2 - Public API
 *
 * Main exports for the new app-building pipeline.
 */

export { BuilderV2 } from './builder-v2.js';
export { SpecNormalizer } from './spec-normalizer.js';
export { ArchitectureContractGenerator } from './architecture-contract.js';
export { SequentialFileGenerator } from './file-generator.js';
export { BuildValidator } from './build-validator.js';
export { SingleFileRepair } from './single-file-repair.js';
export { ErrorParser, groupErrorsByFile } from './error-parser.js';

// Export all types
export type {
  CodePlatform,
  AppComplexity,
  ArchitectureStyle,
  AppSpec,
  NormalizedSpec,
  TypeDefinition,
  FileContract,
  ArchitectureContract,
  GeneratedFile,
  CompileError,
  BuildValidationResult,
  RepairAttempt,
  BuildSession,
  LogEntry,
  LLMRequest,
  LLMResponse,
  Builder2LLM,
  CodePattern,
  PatternContext,
  PatternProvider,
} from './types.js';
