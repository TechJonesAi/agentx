import { Command } from 'commander';
import * as readline from 'node:readline';
import { Agent } from '@agentx/core';

export const chatCommand = new Command('chat')
  .description('Start an interactive chat session')
  .option('-p, --provider <provider>', 'LLM provider (anthropic, openai, ollama)')
  .option('-s, --session <id>', 'Resume a previous session')
  .action(async (options) => {
    const agent = new Agent();

    if (options.provider) {
      agent.setProvider(options.provider);
    }

    const session = agent.getSessionManager().getOrCreate(options.session);
    console.log(`\n🤖 AgentX Chat (session: ${session.id.slice(0, 8)}...)`);
    console.log('Type "exit" or Ctrl+C to quit.\n');

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const prompt = () => {
      rl.question('You: ', async (input) => {
        const trimmed = input.trim();
        if (!trimmed || trimmed.toLowerCase() === 'exit') {
          console.log('\nGoodbye!');
          await agent.shutdown();
          rl.close();
          process.exit(0);
        }

        try {
          const response = await agent.chat(trimmed, session.id);
          console.log(`\nAgentX: ${response}\n`);
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          console.error(`\n[Error]: ${msg}\n`);
        }

        prompt();
      });
    };

    prompt();
  });
