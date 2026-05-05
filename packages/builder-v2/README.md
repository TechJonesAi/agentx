# Builder V2

A new, focused app-building and code generation pipeline for AgentX.

## Motivation

The original builder has been patched repeatedly, leading to:
- Fragile codegen format
- Weak error attribution
- Poor repair targeting
- Unreliable multi-file repair history

Builder V2 replaces the coding pipeline with a clean, measurable architecture.

## Architecture

Builder V2 is organized in stages, each with a clear responsibility:

### 1. Spec Normalization (`spec-normalizer.ts`)
Converts user's natural language request into a structured spec:
- Platform detection (iOS, web, Python, Node, generic)
- Complexity assessment (simple, medium, complex)
- App name extraction
- Keyword extraction for pattern matching

### 2. Architecture Contract (`architecture-contract.ts`)
Generates a strict contract that defines:
- All files that will be generated
- Type ownership and exports per file
- Allowed cross-file imports
- Build order (dependency ordering)
- Entry points and build configuration

This contract prevents files from inventing undeclared cross-file types.

### 3. Sequential File Generation (`file-generator.ts`)
Generates one file at a time:
- One LLM call per file
- Raw source code output (no JSON wrapper)
- Pattern injection from pattern library
- Context-aware prompts

### 4. Build Validation (`build-validator.ts`)
Compiles the project and validates:
- Runs appropriate build command (xcodebuild, tsc, etc.)
- Parses compiler output for errors
- Tracks error progression

### 5. Robust Error Parsing (`error-parser.ts`)
Parses compiler errors with high accuracy:
- Supports multiple formats: xcodebuild, tsc, Python, Node
- Confidence scoring for file attribution
- NO blind fallback to default files
- Distinguishes real errors from noise

### 6. Single-File Repair (`single-file-repair.ts`)
Repairs one broken file at a time:
- Only repairs files with actual compilation errors
- Tracks error delta (before/after)
- Respects architectural contract
- Logs repair effectiveness

## Orchestration

The `BuilderV2` class coordinates the entire pipeline:

```
1. Normalize spec
2. Generate architecture contract
3. Ensure clean project directory
4. Generate files sequentially
5. Validate initial build
6. If errors: repair loop
   - Identify broken file
   - Repair that file only
   - Rebuild
   - Continue until success or max attempts
7. Final validation
```

## Key Improvements

### Error Attribution
- **Before**: Blind fallback to `ContentView.swift`
- **After**: Confidence-scored error attribution with multiple format support

### File Generation
- **Before**: Multi-file JSON responses requiring parsing
- **After**: One file per LLM call, raw code output

### Repair Strategy
- **Before**: Multi-file patches with layered fixes
- **After**: Single-file repair with clear error tracking

### Validation
- **Before**: Fragile error parsing
- **After**: Robust multi-format parsing with unattributed error tracking

## Usage

```typescript
import { BuilderV2 } from '@agentx/builder-v2';

const llm = /* your LLM implementation */;
const builder = new BuilderV2(llm, '/path/to/project');

const session = await builder.build(
  'Build a simple calculator app',
  'Calculator',
  'ios'
);

if (session.result?.success) {
  console.log('Build succeeded!');
  console.log(`Generated ${session.generatedFiles.size} files`);
  console.log(`Repair attempts: ${session.repairAttempts.length}`);
} else {
  console.log(`Build failed with ${session.result?.errorCount} errors`);
  session.logs.forEach(log => {
    console.log(`[${log.stage}] ${log.message}`);
  });
}
```

## Feature Flag Integration

Builder V2 is wired behind a feature flag in AgentX core:

```typescript
// In config
const builderV2Enabled = config.features.builderV2 === true;

// Or via environment variable
const useBuilderV2 = process.env.AGENTX_BUILDER === 'v2';
```

## Benchmark Support

Builder V2 supports the existing 15-run benchmark suite:
- Calculator
- HabitTracker
- ThemeSettings
- MoodRing
- InventoryManager

Run with:
```bash
AGENTX_BUILDER=v2 npm run benchmark
```

## Files

- `types.ts` — Shared type definitions
- `spec-normalizer.ts` — Spec normalization
- `architecture-contract.ts` — Contract generation
- `file-generator.ts` — Sequential file generation
- `build-validator.ts` — Build validation
- `error-parser.ts` — Compiler error parsing
- `single-file-repair.ts` — File repair loop
- `builder-v2.ts` — Main orchestrator
- `index.ts` — Public API

## Logging

All components use structured logging via pino:

```
builder-v2:orchestrator — Main build flow
builder-v2:spec-normalizer — Spec processing
builder-v2:architecture-contract — Contract generation
builder-v2:file-generator — File generation
builder-v2:build-validator — Build validation
builder-v2:error-parser — Error parsing
builder-v2:single-file-repair — File repair
```

Enable debug logs:
```bash
DEBUG=builder-v2:* npm run build
```

## Non-Goals

Builder V2 does NOT:
- Redesign AgentX memory system
- Replace daemon or control UI
- Modify workspace/session system
- Change channel architecture
- Replace tool runtime
- Affect social layer plans

It is a focused replacement for the app-building / code generation pipeline only.
