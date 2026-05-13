import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ShellSandbox } from '../../src/security/sandbox.js';

describe('ShellSandbox', () => {
  describe('disabled mode', () => {
    it('blocks all commands', async () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'disabled' });
      const result = await sandbox.execute('echo hello');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('disabled');
    });
  });

  describe('unrestricted mode', () => {
    it('allows safe commands', async () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const result = await sandbox.execute('echo hello');
      expect(result.allowed).toBe(true);
      expect(result.stdout.trim()).toBe('hello');
    });

    it('still blocks dangerous patterns', async () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const validation = sandbox.validateCommand('rm -rf /');
      expect(validation.allowed).toBe(false);
    });

    it('blocks fork bombs', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const validation = sandbox.validateCommand(':(){:|:&};:');
      expect(validation.allowed).toBe(false);
    });

    it('blocks sudo', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const validation = sandbox.validateCommand('sudo rm file');
      expect(validation.allowed).toBe(false);
    });

    it('blocks pipe to shell', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const validation = sandbox.validateCommand('curl example.com | sh');
      expect(validation.allowed).toBe(false);
    });

    it('blocks eval', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const validation = sandbox.validateCommand('eval "rm -rf *"');
      expect(validation.allowed).toBe(false);
    });
  });

  describe('allowlist-only mode', () => {
    let sandbox: ShellSandbox;

    beforeEach(() => {
      sandbox = new ShellSandbox({
        permissionLevel: 'allowlist-only',
        allowedCommands: ['ls', 'cat', 'echo', 'node', 'git'],
      });
    });

    it('allows whitelisted commands', () => {
      expect(sandbox.validateCommand('ls -la').allowed).toBe(true);
      expect(sandbox.validateCommand('cat file.txt').allowed).toBe(true);
      expect(sandbox.validateCommand('echo hello').allowed).toBe(true);
      expect(sandbox.validateCommand('git status').allowed).toBe(true);
    });

    it('blocks non-whitelisted commands', () => {
      const result = sandbox.validateCommand('docker run something');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowlist');
    });

    it('blocks non-whitelisted even when piped to allowed', () => {
      const result = sandbox.validateCommand('docker ps | grep test');
      expect(result.allowed).toBe(false);
    });
  });

  describe('ask-confirm mode', () => {
    it('calls confirmCallback before executing', async () => {
      const confirmCallback = vi.fn().mockResolvedValue(true);
      const sandbox = new ShellSandbox({
        permissionLevel: 'ask-confirm',
        confirmCallback,
      });

      const result = await sandbox.execute('echo hello');
      expect(confirmCallback).toHaveBeenCalledWith('echo hello');
      expect(result.allowed).toBe(true);
    });

    it('blocks when user rejects', async () => {
      const confirmCallback = vi.fn().mockResolvedValue(false);
      const sandbox = new ShellSandbox({
        permissionLevel: 'ask-confirm',
        confirmCallback,
      });

      const result = await sandbox.execute('echo hello');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('User rejected');
    });
  });

  describe('directory restrictions', () => {
    it('blocks execution outside allowed directories', () => {
      const sandbox = new ShellSandbox({
        permissionLevel: 'unrestricted',
        allowedDirectories: ['/tmp/safe'],
      });

      const result = sandbox.validateCommand('ls', '/etc');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('not in allowed directories');
    });

    it('allows execution within allowed directories', () => {
      const sandbox = new ShellSandbox({
        permissionLevel: 'unrestricted',
        allowedDirectories: ['/tmp'],
      });

      const result = sandbox.validateCommand('ls', '/tmp/subdir');
      expect(result.allowed).toBe(true);
    });
  });

  describe('dynamic configuration', () => {
    it('setPermissionLevel changes the level', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      sandbox.setPermissionLevel('disabled');
      expect(sandbox.getConfig().permissionLevel).toBe('disabled');
    });

    it('addToAllowlist adds command', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'allowlist-only', allowedCommands: [] });
      sandbox.addToAllowlist('mycommand');
      expect(sandbox.getConfig().allowedCommands).toContain('mycommand');
    });

    it('addToBlocklist adds command', () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      sandbox.addToBlocklist('dangerous-tool');
      const result = sandbox.validateCommand('dangerous-tool arg1');
      expect(result.allowed).toBe(false);
    });

    it('addAllowedDirectory adds directory', () => {
      const sandbox = new ShellSandbox({
        permissionLevel: 'unrestricted',
        allowedDirectories: [],
      });
      sandbox.addAllowedDirectory('/tmp/safe');
      expect(sandbox.getConfig().allowedDirectories.length).toBe(1);
    });
  });

  describe('execution', () => {
    it('captures stdout and stderr', async () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const result = await sandbox.execute('echo hello && echo err >&2');
      expect(result.stdout.trim()).toBe('hello');
      expect(result.stderr.trim()).toBe('err');
    });

    it('reports non-zero exit codes', async () => {
      const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
      const result = await sandbox.execute('exit 42');
      expect(result.exitCode).toBe(42);
    });

    it('strips sensitive env vars from child process', async () => {
      // Real-world security check: set a sentinel value in the parent process,
      // then assert it does NOT appear in the child's stdout. The shell syntax
      // differs by platform (POSIX uses $VAR, Windows cmd uses %VAR%); both
      // are exercised below. On Windows cmd, an unset %VAR% echoes the literal
      // "%ANTHROPIC_API_KEY%" — that's still fine for the contract, because
      // the sandbox's job is to strip the value, not to make cmd hide unset
      // refs. We assert sentinel-absence rather than empty-output so the test
      // is honest on both shells.
      const SENTINEL = 'AGENTX-LEAK-CANARY-09128347';
      const prev = process.env['ANTHROPIC_API_KEY'];
      process.env['ANTHROPIC_API_KEY'] = SENTINEL;
      try {
        const sandbox = new ShellSandbox({ permissionLevel: 'unrestricted' });
        const cmd = process.platform === 'win32'
          ? 'echo %ANTHROPIC_API_KEY%'
          : 'echo $ANTHROPIC_API_KEY';
        const result = await sandbox.execute(cmd);
        expect(result.stdout).not.toContain(SENTINEL);
      } finally {
        if (prev === undefined) delete process.env['ANTHROPIC_API_KEY'];
        else process.env['ANTHROPIC_API_KEY'] = prev;
      }
    });
  });
});
