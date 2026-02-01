#!/usr/bin/env node

import { Command } from 'commander';
import { chatCommand } from './commands/chat.js';
import { onboardCommand } from './commands/onboard.js';
import { startCommand } from './commands/start.js';
import { skillsCommand } from './commands/skills.js';
import { configCommand } from './commands/config.js';
import { sessionCommand, statusCommand } from './commands/session.js';

const program = new Command();

program
  .name('agentx')
  .description('AgentX - Cross-platform AI agent')
  .version('0.1.0');

program.addCommand(chatCommand);
program.addCommand(onboardCommand);
program.addCommand(startCommand);
program.addCommand(skillsCommand);
program.addCommand(configCommand);
program.addCommand(sessionCommand);
program.addCommand(statusCommand);

program.parse();
