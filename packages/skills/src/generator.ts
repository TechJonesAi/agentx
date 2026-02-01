import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '@agentx/core';
import type { SkillManifest, Tool, LLMRequestOptions } from '@agentx/core';

const log = createLogger('skills:generator');

export interface GeneratedSkill {
  skillName: string;
  manifest: SkillManifest;
  code: string;
  skillDir: string;
}

type LLMCompleter = (options: LLMRequestOptions) => Promise<{ content: string }>;

/**
 * SkillGenerator: creates new skills from natural language descriptions.
 * The agent can use this to extend its own capabilities at runtime.
 */
export class SkillGenerator {
  private skillsDir: string;
  private completer: LLMCompleter | null = null;

  constructor(skillsDir: string) {
    this.skillsDir = skillsDir;
  }

  setCompleter(completer: LLMCompleter): void {
    this.completer = completer;
  }

  /**
   * Generate a new skill from a natural language request.
   * Returns the generated skill for review before installation.
   */
  async generate(request: string, suggestedName?: string): Promise<GeneratedSkill> {
    if (!this.completer) {
      throw new Error('LLM completer not configured for skill generation');
    }

    log.info({ request, suggestedName }, 'Generating skill');

    const prompt = this.buildGenerationPrompt(request, suggestedName);
    const response = await this.completer({
      messages: [{
        role: 'user',
        content: prompt,
        timestamp: Date.now(),
      }],
      systemPrompt: SKILL_GENERATION_SYSTEM_PROMPT,
      maxTokens: 4096,
    });

    const parsed = this.parseResponse(response.content);

    // Validate the generated manifest
    this.validateManifest(parsed.manifest);

    // Validate permissions are reasonable
    this.validatePermissions(parsed.manifest.permissions, request);

    // Write to skills directory
    const skillDir = path.join(this.skillsDir, parsed.skillName);
    if (!fs.existsSync(skillDir)) {
      fs.mkdirSync(skillDir, { recursive: true });
    }

    fs.writeFileSync(
      path.join(skillDir, 'manifest.json'),
      JSON.stringify(parsed.manifest, null, 2),
    );
    fs.writeFileSync(
      path.join(skillDir, 'index.ts'),
      parsed.code,
    );

    log.info({ skillName: parsed.skillName, skillDir }, 'Skill generated successfully');

    return {
      skillName: parsed.skillName,
      manifest: parsed.manifest,
      code: parsed.code,
      skillDir,
    };
  }

  /**
   * Compile a generated TypeScript skill to JavaScript.
   * Uses a simple transpilation approach.
   */
  async compile(skillDir: string): Promise<void> {
    const tsPath = path.join(skillDir, 'index.ts');
    if (!fs.existsSync(tsPath)) {
      throw new Error(`No index.ts found in ${skillDir}`);
    }

    // Use dynamic import for typescript compiler
    try {
      const ts = await import('typescript');
      const source = fs.readFileSync(tsPath, 'utf-8');
      const result = ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.Node16,
          target: ts.ScriptTarget.ES2022,
          esModuleInterop: true,
          strict: true,
        },
      });

      fs.writeFileSync(
        path.join(skillDir, 'index.js'),
        result.outputText,
      );

      log.info({ skillDir }, 'Skill compiled successfully');
    } catch (error) {
      log.error({ skillDir, error }, 'Failed to compile skill');
      throw new Error(`Compilation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private buildGenerationPrompt(request: string, suggestedName?: string): string {
    const nameHint = suggestedName ? `\nSuggested name: ${suggestedName}` : '';
    return `Create a new AgentX skill for the following request:

${request}${nameHint}

Generate a complete skill with:
1. A kebab-case skill name
2. A manifest.json structure
3. Full TypeScript implementation in index.ts

The skill should export a \`tools\` array of Tool objects.

Each Tool must have this structure:
\`\`\`typescript
interface Tool {
  definition: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required?: string[];
    };
  };
  execute(args: Record<string, unknown>, context: any): Promise<string>;
}
\`\`\`

Available permissions: network, filesystem.read, filesystem.write, shell, memory.read, memory.write, browser, integrations, scheduler, credentials

Respond with EXACTLY this JSON structure (no markdown, no explanation):
{
  "skillName": "example-skill",
  "manifest": {
    "name": "example-skill",
    "version": "1.0.0",
    "description": "...",
    "triggers": ["keyword1", "keyword2"],
    "permissions": ["network"]
  },
  "code": "// Full TypeScript source code..."
}`;
  }

  private parseResponse(content: string): { skillName: string; manifest: SkillManifest; code: string } {
    // Try to extract JSON from the response
    let jsonStr = content.trim();

    // Handle markdown code blocks
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1]!.trim();
    }

    try {
      const parsed = JSON.parse(jsonStr) as {
        skillName: string;
        manifest: SkillManifest;
        code: string;
      };

      if (!parsed.skillName || !parsed.manifest || !parsed.code) {
        throw new Error('Missing required fields: skillName, manifest, code');
      }

      return parsed;
    } catch (error) {
      throw new Error(`Failed to parse skill generation response: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private validateManifest(manifest: SkillManifest): void {
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error('Manifest must have a valid name');
    }
    if (!manifest.version || typeof manifest.version !== 'string') {
      throw new Error('Manifest must have a valid version');
    }
    if (!manifest.description || typeof manifest.description !== 'string') {
      throw new Error('Manifest must have a valid description');
    }
    if (!Array.isArray(manifest.triggers)) {
      throw new Error('Manifest must have a triggers array');
    }
    if (!Array.isArray(manifest.permissions)) {
      throw new Error('Manifest must have a permissions array');
    }
  }

  private validatePermissions(permissions: string[], request: string): void {
    const VALID_PERMISSIONS = [
      'network', 'filesystem.read', 'filesystem.write', 'shell',
      'memory.read', 'memory.write', 'browser', 'integrations',
      'scheduler', 'credentials',
    ];

    for (const perm of permissions) {
      if (!VALID_PERMISSIONS.includes(perm)) {
        throw new Error(`Invalid permission: ${perm}. Valid: ${VALID_PERMISSIONS.join(', ')}`);
      }
    }

    // Warn about high-risk permissions
    const highRisk = permissions.filter((p) => ['shell', 'credentials', 'filesystem.write'].includes(p));
    if (highRisk.length > 0) {
      log.warn({ highRisk, request }, 'Generated skill requests high-risk permissions');
    }
  }
}

/**
 * Create the create_skill tool for the agent.
 */
export function createSkillGeneratorTool(generator: SkillGenerator): Tool {
  return {
    definition: {
      name: 'create_skill',
      description: 'Create a new skill to extend my capabilities. The skill will be generated from a description and requires approval before installation.',
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'What the skill should do',
          },
          suggestedName: {
            type: 'string',
            description: 'Optional kebab-case name for the skill',
          },
        },
        required: ['description'],
      },
    },
    async execute(args) {
      try {
        const result = await generator.generate(
          args['description'] as string,
          args['suggestedName'] as string | undefined,
        );

        await generator.compile(result.skillDir);

        return JSON.stringify({
          success: true,
          skillName: result.skillName,
          description: result.manifest.description,
          permissions: result.manifest.permissions,
          skillDir: result.skillDir,
          message: `Skill '${result.skillName}' has been generated and compiled. It requires these permissions: [${result.manifest.permissions.join(', ')}]. Load it to make it available.`,
        });
      } catch (error) {
        return `Failed to generate skill: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}

const SKILL_GENERATION_SYSTEM_PROMPT = `You are a skill generator for AgentX, an AI agent framework.
You create self-contained skill modules that extend the agent's capabilities.

Rules:
- Generate clean, working TypeScript code
- Export a \`tools\` array from the module
- Only request permissions that are actually needed
- Use fetch() for HTTP requests (available globally)
- Use node:fs, node:path, node:child_process for system operations
- Keep code focused and minimal
- Include error handling in tool execute functions
- Always return strings from execute functions`;
