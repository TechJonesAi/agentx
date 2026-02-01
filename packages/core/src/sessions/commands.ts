import type { SessionEntry } from '../types.js';
import { createLogger } from '../logger.js';
import { estimateMessageTokens } from '../context-manager.js';
import type { Message, AgentConfig } from '../types.js';

const log = createLogger('sessions:commands');

export interface CommandResult {
  /** Whether a command was detected and handled */
  handled: boolean;
  /** The command name that was handled (without /) */
  command?: string;
  /** Response message to show the user */
  response?: string;
  /** If true, the session should be reset */
  shouldReset?: boolean;
  /** If true, the current run should be aborted */
  shouldStop?: boolean;
  /** New model to switch to */
  newModel?: string;
  /** Remaining message text after command parsing */
  remainder?: string;
  /** If true, trigger manual compaction */
  shouldCompact?: boolean;
  /** Custom compaction instructions */
  compactInstructions?: string;
}

export interface CommandContext {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | null;
  messages: Message[];
  config: AgentConfig;
  contextTokens: number;
  maxContextTokens: number;
}

/**
 * Parse and handle in-chat slash commands.
 * Returns null if no command was detected.
 */
export function parseCommand(input: string, context: CommandContext): CommandResult | null {
  const trimmed = input.trim();

  if (!trimmed.startsWith('/')) {
    return null;
  }

  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (cmd) {
    case '/new':
    case '/reset':
      return handleReset(args);

    case '/status':
      return handleStatus(context);

    case '/context':
      return handleContext(args, context);

    case '/stop':
      return handleStop();

    case '/compact':
      return handleCompact(args);

    case '/send':
      return handleSend(args);

    default:
      return null;
  }
}

function handleReset(args: string[]): CommandResult {
  let newModel: string | undefined;
  let remainder = '';

  if (args.length > 0) {
    const first = args[0];
    // Model names typically contain dashes, dots, or version numbers
    if (first.includes('-') || first.includes('.') || /^[a-z]+\d/.test(first)) {
      newModel = first;
      remainder = args.slice(1).join(' ');
    } else {
      remainder = args.join(' ');
    }
  }

  return {
    handled: true,
    command: 'reset',
    response: newModel
      ? `Session reset. Switching to model: ${newModel}`
      : 'Session reset. Starting fresh conversation.',
    shouldReset: true,
    newModel,
    remainder,
  };
}

function handleStatus(context: CommandContext): CommandResult {
  const entry = context.sessionEntry;
  const lines: string[] = [
    '**Session Status**',
    `Session ID: \`${context.sessionId.slice(0, 12)}...\``,
    `Session Key: \`${context.sessionKey}\``,
  ];

  if (entry) {
    lines.push(`Created: ${entry.createdAt}`);
    lines.push(`Updated: ${entry.updatedAt}`);
    lines.push(`Tokens — Input: ${entry.inputTokens}, Output: ${entry.outputTokens}, Total: ${entry.totalTokens}`);
    lines.push(`Context: ${entry.contextTokens} tokens`);
    lines.push(`Channel: ${entry.origin.provider}`);
    if (entry.displayName) lines.push(`Display Name: ${entry.displayName}`);
  }

  lines.push(`Messages: ${context.messages.length}`);
  lines.push(`Context Usage: ${context.contextTokens} / ${context.maxContextTokens} tokens (${Math.round(context.contextTokens / context.maxContextTokens * 100)}%)`);

  return {
    handled: true,
    command: 'status',
    response: lines.join('\n'),
  };
}

function handleContext(args: string[], context: CommandContext): CommandResult {
  const subcommand = args[0]?.toLowerCase();

  if (subcommand === 'detail') {
    // Show context with token counts per message
    const lines: string[] = ['**Context Detail**', ''];
    let totalTokens = 0;

    for (let i = 0; i < context.messages.length; i++) {
      const msg = context.messages[i];
      const tokens = estimateMessageTokens(msg);
      totalTokens += tokens;
      const preview = msg.content.slice(0, 60).replace(/\n/g, ' ');
      lines.push(`${i + 1}. [${msg.role}] ~${tokens} tokens: ${preview}${msg.content.length > 60 ? '...' : ''}`);
    }

    lines.push('');
    lines.push(`**Total: ${totalTokens} tokens across ${context.messages.length} messages**`);
    lines.push(`Budget: ${context.maxContextTokens} tokens`);

    return {
      handled: true,
      command: 'context',
      response: lines.join('\n'),
    };
  }

  // Default: list summary
  const roleGroups = new Map<string, number>();
  let totalTokens = 0;

  for (const msg of context.messages) {
    const tokens = estimateMessageTokens(msg);
    totalTokens += tokens;
    roleGroups.set(msg.role, (roleGroups.get(msg.role) ?? 0) + tokens);
  }

  const lines: string[] = [
    '**Context Summary**',
    `Messages: ${context.messages.length}`,
    `Total Tokens: ~${totalTokens}`,
    `Budget: ${context.maxContextTokens}`,
    `Usage: ${Math.round(totalTokens / context.maxContextTokens * 100)}%`,
    '',
    '**By Role:**',
  ];

  for (const [role, tokens] of roleGroups) {
    lines.push(`  ${role}: ~${tokens} tokens`);
  }

  return {
    handled: true,
    command: 'context',
    response: lines.join('\n'),
  };
}

function handleStop(): CommandResult {
  return {
    handled: true,
    command: 'stop',
    response: 'Run aborted. Queue cleared.',
    shouldStop: true,
  };
}

function handleCompact(args: string[]): CommandResult {
  const instructions = args.length > 0 ? args.join(' ') : undefined;

  return {
    handled: true,
    command: 'compact',
    response: instructions
      ? `Compacting with instructions: ${instructions}`
      : 'Compacting session...',
    shouldCompact: true,
    compactInstructions: instructions,
  };
}

function handleSend(args: string[]): CommandResult {
  const action = args[0]?.toLowerCase();

  if (action === 'on' || action === 'off' || action === 'inherit') {
    return {
      handled: true,
      command: 'send',
      response: `Send policy set to: ${action}`,
    };
  }

  return {
    handled: true,
    command: 'send',
    response: 'Usage: /send on | /send off | /send inherit',
  };
}
