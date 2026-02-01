import { Command } from 'commander';
import { Agent } from '@agentx/core';

export const sessionCommand = new Command('session')
  .description('Manage agent sessions');

// agentx session list [--json] [--active <minutes>]
sessionCommand
  .command('list')
  .description('List all sessions')
  .option('--json', 'Output as JSON')
  .option('--active <minutes>', 'Only show sessions active within N minutes', parseInt)
  .action(async (options) => {
    const agent = new Agent();
    const store = agent.getSessionStore();

    if (!store) {
      console.error('Session store not available. Ensure session config is set.');
      await agent.shutdown();
      return;
    }

    const entries = options.active
      ? store.getActive(options.active)
      : store.list();

    if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
    } else {
      if (entries.length === 0) {
        console.log('No sessions found.');
      } else {
        console.log(`Found ${entries.length} session(s):\n`);
        for (const entry of entries) {
          const age = timeSince(entry.updatedAt);
          console.log(`  ${entry.sessionKey}`);
          console.log(`    ID: ${entry.sessionId.slice(0, 12)}...`);
          console.log(`    Channel: ${entry.origin.provider}`);
          console.log(`    Updated: ${entry.updatedAt} (${age})`);
          console.log(`    Tokens: ${entry.totalTokens} (in: ${entry.inputTokens}, out: ${entry.outputTokens})`);
          if (entry.displayName) console.log(`    Name: ${entry.displayName}`);
          console.log('');
        }
      }
    }

    await agent.shutdown();
  });

// agentx session delete <key>
sessionCommand
  .command('delete <key>')
  .description('Delete a specific session')
  .action(async (key: string) => {
    const agent = new Agent();
    const store = agent.getSessionStore();

    if (!store) {
      console.error('Session store not available.');
      await agent.shutdown();
      return;
    }

    const existed = store.delete(key);
    if (existed) {
      console.log(`Session deleted: ${key}`);
    } else {
      console.log(`Session not found: ${key}`);
    }

    await agent.shutdown();
  });

// agentx session inspect <key>
sessionCommand
  .command('inspect <key>')
  .description('Show detailed session information')
  .action(async (key: string) => {
    const agent = new Agent();
    const store = agent.getSessionStore();

    if (!store) {
      console.error('Session store not available.');
      await agent.shutdown();
      return;
    }

    const entry = store.get(key);
    if (!entry) {
      console.log(`Session not found: ${key}`);
      await agent.shutdown();
      return;
    }

    console.log('Session Details:\n');
    console.log(`  Session ID:    ${entry.sessionId}`);
    console.log(`  Session Key:   ${entry.sessionKey}`);
    console.log(`  Created:       ${entry.createdAt}`);
    console.log(`  Updated:       ${entry.updatedAt}`);
    console.log(`  Input Tokens:  ${entry.inputTokens}`);
    console.log(`  Output Tokens: ${entry.outputTokens}`);
    console.log(`  Total Tokens:  ${entry.totalTokens}`);
    console.log(`  Context Tokens: ${entry.contextTokens}`);
    console.log('');
    console.log('  Origin:');
    console.log(`    Label:    ${entry.origin.label}`);
    console.log(`    Provider: ${entry.origin.provider}`);
    console.log(`    From:     ${entry.origin.from}`);
    console.log(`    To:       ${entry.origin.to}`);
    if (entry.origin.accountId) console.log(`    Account:  ${entry.origin.accountId}`);
    if (entry.origin.threadId) console.log(`    Thread:   ${entry.origin.threadId}`);
    console.log('');
    if (entry.displayName) console.log(`  Display Name: ${entry.displayName}`);
    if (entry.channel) console.log(`  Channel:      ${entry.channel}`);
    if (entry.room) console.log(`  Room:         ${entry.room}`);

    await agent.shutdown();
  });

// agentx status (alias for quick session store overview)
export const statusCommand = new Command('status')
  .description('Show session store status')
  .action(async () => {
    const agent = new Agent();
    const store = agent.getSessionStore();

    if (!store) {
      console.log('Session store: not configured');
      await agent.shutdown();
      return;
    }

    console.log(`Store path: ${store.getStorePath()}`);
    console.log(`Total sessions: ${store.size()}`);

    const recent = store.getActive(60);
    console.log(`Active (last hour): ${recent.length}`);

    if (recent.length > 0) {
      console.log('\nRecent sessions:');
      for (const entry of recent.slice(0, 5)) {
        const age = timeSince(entry.updatedAt);
        console.log(`  ${entry.sessionKey} — ${entry.origin.provider} — ${age}`);
      }
    }

    await agent.shutdown();
  });

function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
