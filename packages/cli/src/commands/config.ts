import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, resolveDataDir } from '@agentx/core';

export const configCommand = new Command('config')
  .description('View and manage AgentX configuration');

configCommand
  .command('show')
  .description('Show current configuration')
  .action(() => {
    const config = loadConfig();
    console.log(JSON.stringify(config, null, 2));
  });

configCommand
  .command('path')
  .description('Show configuration file paths')
  .action(() => {
    const dataDir = resolveDataDir();
    console.log(`Data directory: ${dataDir}`);
    console.log(`Config file:    ${path.join(dataDir, 'config.json')}`);
    console.log(`Environment:    ${path.join(dataDir, '.env')}`);
    console.log(`Skills:         ${path.join(dataDir, 'skills')}`);
    console.log(`Database:       ${path.join(dataDir, 'agentx.db')}`);
  });

configCommand
  .command('set <key> <value>')
  .description('Set a configuration value')
  .action((key: string, value: string) => {
    const dataDir = resolveDataDir();
    const configPath = path.join(dataDir, 'config.json');

    let config: Record<string, unknown> = {};
    if (fs.existsSync(configPath)) {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }

    // Support dot notation: agent.name -> { agent: { name: value } }
    const keys = key.split('.');
    let current: Record<string, unknown> = config;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]!;
      if (!current[k] || typeof current[k] !== 'object') {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }
    current[keys[keys.length - 1]!] = value;

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    console.log(`Set ${key} = ${value}`);
  });
