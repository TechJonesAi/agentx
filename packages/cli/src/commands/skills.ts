import { Command } from 'commander';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDataDir } from '@agentx/core';

export const skillsCommand = new Command('skills')
  .description('Manage AgentX skills');

skillsCommand
  .command('list')
  .description('List installed skills')
  .action(() => {
    const skillsDir = path.join(resolveDataDir(), 'skills');

    if (!fs.existsSync(skillsDir)) {
      console.log('No skills installed.');
      return;
    }

    const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    if (entries.length === 0) {
      console.log('No skills installed.');
      return;
    }

    console.log('\nInstalled skills:\n');
    for (const entry of entries) {
      const manifestPath = path.join(skillsDir, entry.name, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        console.log(`  ${manifest.name} v${manifest.version} - ${manifest.description}`);
      } else {
        console.log(`  ${entry.name} (no manifest)`);
      }
    }
    console.log();
  });

skillsCommand
  .command('add <path>')
  .description('Install a skill from a directory')
  .action((skillPath: string) => {
    const resolved = path.resolve(skillPath);
    if (!fs.existsSync(resolved)) {
      console.error(`Skill path not found: ${resolved}`);
      process.exit(1);
    }

    const manifestPath = path.join(resolved, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.error('No manifest.json found in skill directory.');
      process.exit(1);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    const skillsDir = path.join(resolveDataDir(), 'skills');
    const dest = path.join(skillsDir, manifest.name);

    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }

    fs.cpSync(resolved, dest, { recursive: true });
    console.log(`Installed skill: ${manifest.name} v${manifest.version}`);
  });

skillsCommand
  .command('remove <name>')
  .description('Remove an installed skill')
  .action((name: string) => {
    const skillsDir = path.join(resolveDataDir(), 'skills');
    const skillDir = path.join(skillsDir, name);

    if (!fs.existsSync(skillDir)) {
      console.error(`Skill not found: ${name}`);
      process.exit(1);
    }

    fs.rmSync(skillDir, { recursive: true });
    console.log(`Removed skill: ${name}`);
  });
