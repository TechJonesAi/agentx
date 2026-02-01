import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/tools/index.js';
import { PermissionManager } from '../../src/security/permissions.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Tool, ToolDefinition } from '../../src/types.js';

function makeTool(name: string, description = `Tool ${name}`): Tool {
  return {
    definition: { name, description, parameters: { type: 'object', properties: {} } },
    execute: async () => `Result from ${name}`,
  };
}

describe('Skill loading and tool registration', () => {
  let registry: ToolRegistry;
  let tmpDir: string;
  let pm: PermissionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-skill-test-'));
    pm = new PermissionManager(tmpDir);
    registry = new ToolRegistry();
    registry.setPermissionManager(pm);
  });

  describe('tool registration', () => {
    it('registers and retrieves tools', () => {
      registry.register(makeTool('search_web'));
      registry.register(makeTool('read_file'));

      const defs = registry.getDefinitions();
      expect(defs).toHaveLength(2);
      expect(defs.map((d) => d.name)).toContain('search_web');
      expect(defs.map((d) => d.name)).toContain('read_file');
    });

    it('overwrites tool on re-registration', () => {
      registry.register(makeTool('search_web', 'v1'));
      registry.register(makeTool('search_web', 'v2'));

      const defs = registry.getDefinitions();
      expect(defs).toHaveLength(1);
      expect(defs[0]!.description).toBe('v2');
    });

    it('executes registered tools', async () => {
      registry.register(makeTool('search_web'));

      const result = await registry.execute('search_web', {}, {
        sessionId: 'test',
        agent: {} as any,
      });

      expect(result).toBe('Result from search_web');
    });

    it('throws for unregistered tools', async () => {
      await expect(registry.execute('nonexistent', {}, {
        sessionId: 'test',
        agent: {} as any,
      })).rejects.toThrow();
    });
  });

  describe('skill permission enforcement', () => {
    it('blocks tool execution when skill lacks permission for mapped tool', async () => {
      // 'shell' is in TOOL_PERMISSION_MAP → requires 'shell' permission
      const tool: Tool = {
        definition: { name: 'shell', description: 'Run shell', parameters: {} },
        execute: async () => 'executed',
      };

      registry.register(tool);

      // No permissions granted for 'my-skill'
      const result = await registry.execute('shell', {}, {
        sessionId: 'test',
        skillName: 'my-skill',
        agent: {} as any,
      });

      expect(result).toContain('Permission Denied');
    });

    it('allows execution when permissions are granted', async () => {
      // 'web_search' requires 'network' permission
      const tool: Tool = {
        definition: { name: 'web_search', description: 'Search web', parameters: {} },
        execute: async () => 'search result',
      };

      pm.grantPermissions('my-skill', ['network']);
      registry.register(tool);

      const result = await registry.execute('web_search', {}, {
        sessionId: 'test',
        skillName: 'my-skill',
        agent: {} as any,
      });

      expect(result).toBe('search result');
    });

    it('allows tools not in permission map without restrictions', async () => {
      const tool: Tool = {
        definition: { name: 'custom_tool', description: 'Custom', parameters: {} },
        execute: async () => 'custom result',
      };

      registry.register(tool);

      const result = await registry.execute('custom_tool', {}, {
        sessionId: 'test',
        skillName: 'my-skill',
        agent: {} as any,
      });

      expect(result).toBe('custom result');
    });

    it('getDefinitionsForSkill filters by permissions', () => {
      registry.register(makeTool('shell'));
      registry.register(makeTool('web_search'));
      registry.register(makeTool('custom_tool'));

      // No permissions granted — shell and web_search should be filtered out
      const defs = registry.getDefinitionsForSkill('my-skill');
      const names = defs.map((d) => d.name);

      expect(names).toContain('custom_tool');
      expect(names).not.toContain('shell');
      expect(names).not.toContain('web_search');
    });
  });
});
