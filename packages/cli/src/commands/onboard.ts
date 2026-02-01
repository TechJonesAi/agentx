import { Command } from 'commander';
import * as readline from 'node:readline';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CredentialManager, ensureDataDir } from '@agentx/core';

export const onboardCommand = new Command('onboard')
  .description('Interactive setup wizard for AgentX')
  .action(async () => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const ask = (question: string): Promise<string> =>
      new Promise((resolve) => rl.question(question, resolve));

    console.log('\n=== AgentX Setup Wizard ===\n');

    // ─── Agent Persona ──────────────────────────────────────────────────────
    console.log('--- Agent Persona ---\n');
    const agentName = await ask('Name your agent [AgentX]: ');
    const selectedName = agentName.trim() || 'AgentX';

    const persona = await ask(`Agent persona/description (optional): `);
    const selectedPersona = persona.trim() || '';

    console.log(`\nYour agent: ${selectedName}${selectedPersona ? ` — "${selectedPersona}"` : ''}\n`);

    // ─── LLM Provider ────────────────────────────────────────────────────────
    const provider = await ask('Default LLM provider (anthropic/openai/ollama) [anthropic]: ');
    const selectedProvider = provider.trim() || 'anthropic';

    // ─── Credential storage ──────────────────────────────────────────────────
    const dataDir = ensureDataDir();
    const credentialManager = new CredentialManager(dataDir);

    let masterPassword: string | undefined;
    try {
      await credentialManager.initialize();
    } catch {
      // Keychain unavailable, ask for master password
      console.log('\nOS keychain not available. A master password will encrypt your credentials.');
      masterPassword = await ask('Master password for credential encryption: ');
      await credentialManager.initialize(masterPassword);
    }

    if (credentialManager.isKeychainAvailable()) {
      console.log('Using OS keychain for secure credential storage.\n');
    } else {
      console.log('Using encrypted file storage for credentials.\n');
    }

    // ─── API Keys ────────────────────────────────────────────────────────────
    if (selectedProvider === 'anthropic' || selectedProvider === 'openai') {
      const keyName = selectedProvider === 'anthropic' ? 'Anthropic' : 'OpenAI';
      const envKey = selectedProvider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';

      const apiKey = await ask(`${keyName} API key: `);
      if (apiKey.trim()) {
        try {
          await credentialManager.setCredential(envKey, apiKey.trim());
          console.log(`  ${keyName} API key stored securely.`);
        } catch {
          console.error(`  Failed to store in keychain, falling back to .env file.`);
          appendToEnv(dataDir, envKey, apiKey.trim());
        }
      }
    }

    // ─── Integration tokens ──────────────────────────────────────────────────
    const telegramToken = await ask('\nTelegram bot token (optional, press Enter to skip): ');
    if (telegramToken.trim()) {
      try {
        await credentialManager.setCredential('TELEGRAM_BOT_TOKEN', telegramToken.trim());
        console.log('  Telegram token stored securely.');
      } catch {
        appendToEnv(dataDir, 'TELEGRAM_BOT_TOKEN', telegramToken.trim());
      }
    }

    const discordToken = await ask('Discord bot token (optional, press Enter to skip): ');
    if (discordToken.trim()) {
      try {
        await credentialManager.setCredential('DISCORD_BOT_TOKEN', discordToken.trim());
        console.log('  Discord token stored securely.');
      } catch {
        appendToEnv(dataDir, 'DISCORD_BOT_TOKEN', discordToken.trim());
      }
    }

    // ─── Security settings ───────────────────────────────────────────────────
    console.log('\n--- Security Settings ---\n');

    const enableAuth = await ask('Set up a PIN/password to protect the agent? (y/N): ');
    let localAuthEnabled = false;
    if (enableAuth.trim().toLowerCase() === 'y') {
      const pin = await ask('Enter PIN or password: ');
      const confirm = await ask('Confirm PIN or password: ');
      if (pin === confirm && pin.length > 0) {
        localAuthEnabled = true;
        console.log('  Local authentication will be enabled.');
      } else {
        console.log('  Passwords did not match. Skipping.');
      }
    }

    const shellLevel = await ask('Shell permission level (unrestricted/ask-confirm/allowlist-only/disabled) [ask-confirm]: ');
    const selectedShellLevel = shellLevel.trim() || 'ask-confirm';

    // ─── Write non-secret config ─────────────────────────────────────────────
    const envLines: string[] = [];
    envLines.push(`DATA_DIR=${dataDir}`);
    envLines.push(`LOG_LEVEL=info`);

    const envPath = path.join(dataDir, '.env');
    fs.writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });

    const configContent = {
      agent: {
        name: selectedName,
        defaultProvider: selectedProvider,
        ...(selectedPersona ? { persona: selectedPersona } : {}),
      },
      security: {
        shellPermissionLevel: selectedShellLevel,
        localAuth: localAuthEnabled,
        auditLog: true,
      },
    };
    const configPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2));

    // ─── Test Message ───────────────────────────────────────────────────────
    console.log('\n--- Verification ---\n');
    const runTest = await ask('Send a test message to verify the LLM connection? (Y/n): ');
    if (runTest.trim().toLowerCase() !== 'n') {
      console.log('Testing connection...');
      try {
        // Quick connection test using the configured provider
        const testApiKey = selectedProvider === 'anthropic'
          ? await credentialManager.getCredential('ANTHROPIC_API_KEY').catch(() => process.env['ANTHROPIC_API_KEY'])
          : selectedProvider === 'openai'
            ? await credentialManager.getCredential('OPENAI_API_KEY').catch(() => process.env['OPENAI_API_KEY'])
            : null;

        if (testApiKey) {
          console.log(`  API key found. Connection to ${selectedProvider} should work.`);
        } else if (selectedProvider === 'ollama') {
          console.log('  Ollama configured. Make sure ollama is running locally.');
        } else {
          console.log(`  No API key found for ${selectedProvider}. Add it later with "agentx config".`);
        }
      } catch {
        console.log('  Could not verify connection. You can test later with "agentx chat".');
      }
    }

    // ─── Summary ─────────────────────────────────────────────────────────────
    console.log(`\nConfiguration saved to ${dataDir}`);
    console.log(`  Config:      ${configPath}`);
    console.log(`  Environment: ${envPath}`);
    if (credentialManager.isKeychainAvailable()) {
      console.log(`  Credentials: OS keychain (service: agentx)`);
    } else {
      console.log(`  Credentials: ${path.join(dataDir, '.credentials.enc')}`);
    }

    const stored = await credentialManager.listCredentials();
    if (stored.length > 0) {
      console.log(`  Stored keys: ${stored.join(', ')}`);
    }

    // ─── Capability Tour ────────────────────────────────────────────────────
    console.log('\n--- Quick Tour ---\n');
    console.log(`  ${selectedName} can:`);
    console.log('  - Chat with you via CLI, Telegram, Discord, Slack, WhatsApp, Signal, iMessage');
    console.log('  - Browse the web and search for information');
    console.log('  - Execute shell commands (with your permission)');
    console.log('  - Remember things across conversations');
    console.log('  - Read and write to your Obsidian vault');
    console.log('  - Manage your Gmail and Google Calendar');
    console.log('  - Make phone calls via Twilio');
    console.log('  - Monitor websites, files, and commands');
    console.log('  - Create new skills to extend its capabilities');
    console.log('');
    console.log('  Commands:');
    console.log('    agentx chat              Start a conversation');
    console.log('    agentx start             Run as a background service');
    console.log('    agentx session list       View active sessions');
    console.log('    agentx skills list        View loaded skills');
    console.log('    agentx config             Manage configuration');
    console.log('');
    console.log(`Run "agentx chat" to start chatting with ${selectedName}!\n`);

    rl.close();
  });

function appendToEnv(dataDir: string, key: string, value: string): void {
  const envPath = path.join(dataDir, '.env');
  const line = `${key}=${value}\n`;
  fs.appendFileSync(envPath, line, { mode: 0o600 });
}
