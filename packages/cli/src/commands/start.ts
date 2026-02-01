import { Command } from 'commander';
import { Agent, ShutdownManager, createLogger } from '@agentx/core';
import { cliConfirmCallback } from '../confirm.js';

const log = createLogger('cli:start');

export const startCommand = new Command('start')
  .description('Start the AgentX daemon with integrations')
  .option('--telegram', 'Enable Telegram integration')
  .option('--discord', 'Enable Discord integration')
  .option('--slack', 'Enable Slack integration')
  .option('--whatsapp', 'Enable WhatsApp integration')
  .option('--signal', 'Enable Signal integration')
  .option('--imessage', 'Enable iMessage integration (macOS only)')
  .option('--web', 'Enable Web UI')
  .option('--google', 'Enable Google (Gmail + Calendar) integration')
  .option('--obsidian', 'Enable Obsidian vault integration')
  .option('--health', 'Enable health check server')
  .option('--heartbeat', 'Enable heartbeat/proactive messaging')
  .option('--skills-watch', 'Enable skill hot-reload file watcher')
  .action(async (options) => {
    console.log('Starting AgentX daemon...\n');

    const shutdownManager = new ShutdownManager();
    const agent = new Agent();

    // Wire shell confirm callback for ask-confirm mode
    agent.setShellConfirmCallback(cliConfirmCallback);

    // Register agent shutdown handler
    shutdownManager.register('agent', () => agent.shutdown());

    // Track active integrations and their instances for heartbeat wiring
    const integrations: string[] = [];
    const integrationInstances: Array<{
      name: string;
      instance: { stop(): Promise<void>; sendMessage?(...args: unknown[]): Promise<void> };
    }> = [];

    // ─── Telegram ────────────────────────────────────────────────────────────
    if (options.telegram) {
      try {
        const { TelegramIntegration } = await import('@agentx/telegram' as string);
        const telegram = new TelegramIntegration(agent);
        await telegram.start();
        integrations.push('Telegram');
        integrationInstances.push({ name: 'telegram', instance: telegram });
        shutdownManager.register('telegram', () => telegram.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start Telegram integration');
        console.error('Failed to start Telegram:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Discord ─────────────────────────────────────────────────────────────
    if (options.discord) {
      try {
        const { DiscordIntegration } = await import('@agentx/discord' as string);
        const discord = new DiscordIntegration(agent);
        await discord.start();
        integrations.push('Discord');
        integrationInstances.push({ name: 'discord', instance: discord });
        shutdownManager.register('discord', () => discord.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start Discord integration');
        console.error('Failed to start Discord:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Slack ───────────────────────────────────────────────────────────────
    if (options.slack) {
      try {
        const { SlackIntegration } = await import('@agentx/slack' as string);
        const slack = new SlackIntegration(agent);
        await slack.start();
        integrations.push('Slack');
        integrationInstances.push({ name: 'slack', instance: slack });
        shutdownManager.register('slack', () => slack.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start Slack integration');
        console.error('Failed to start Slack:', error instanceof Error ? error.message : error);
      }
    }

    // ─── WhatsApp ────────────────────────────────────────────────────────────
    if (options.whatsapp) {
      try {
        const { WhatsAppIntegration } = await import('@agentx/whatsapp' as string);
        const whatsapp = new WhatsAppIntegration(agent);
        await whatsapp.start();
        integrations.push('WhatsApp');
        integrationInstances.push({ name: 'whatsapp', instance: whatsapp });
        shutdownManager.register('whatsapp', () => whatsapp.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start WhatsApp integration');
        console.error('Failed to start WhatsApp:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Signal ──────────────────────────────────────────────────────────────
    if (options.signal) {
      try {
        const { SignalIntegration } = await import('@agentx/signal' as string);
        const signal = new SignalIntegration(agent);
        await signal.start();
        integrations.push('Signal');
        integrationInstances.push({ name: 'signal', instance: signal });
        shutdownManager.register('signal', () => signal.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start Signal integration');
        console.error('Failed to start Signal:', error instanceof Error ? error.message : error);
      }
    }

    // ─── iMessage ────────────────────────────────────────────────────────────
    if (options.imessage) {
      try {
        const { IMessageIntegration } = await import('@agentx/imessage' as string);
        const imessage = new IMessageIntegration(agent);
        await imessage.start();
        integrations.push('iMessage');
        integrationInstances.push({ name: 'imessage', instance: imessage });
        shutdownManager.register('imessage', () => imessage.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start iMessage integration');
        console.error('Failed to start iMessage:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Google Integration (Gmail + Calendar) ─────────────────────────────
    if (options.google) {
      try {
        const { GoogleIntegration } = await import('@agentx/google' as string);
        const config = agent.getConfig();
        const googleConfig = (config as unknown as Record<string, unknown>)['google'] as {
          clientId: string; clientSecret: string; redirectUri: string; scopes: string[];
        } | undefined;

        if (googleConfig?.clientId) {
          const google = new GoogleIntegration(agent, googleConfig);
          await google.start();

          // Register Google tools with the agent
          const registry = agent.getToolRegistry();
          for (const tool of google.getTools()) {
            registry.register(tool);
          }

          integrations.push('Google');
          integrationInstances.push({ name: 'google', instance: google });
          shutdownManager.register('google', () => google.stop());
        } else {
          console.log('Google integration skipped: clientId not configured.');
        }
      } catch (error) {
        log.error({ error }, 'Failed to start Google integration');
        console.error('Failed to start Google:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Obsidian Integration ─────────────────────────────────────────────
    if (options.obsidian) {
      try {
        const { ObsidianIntegration } = await import('@agentx/obsidian' as string);
        const config = agent.getConfig();
        const obsidianConfig = (config as unknown as Record<string, unknown>)['obsidian'] as {
          vaultPath: string; dailyNotesFolder?: string; dailyNoteFormat?: string;
        } | undefined;

        if (obsidianConfig?.vaultPath) {
          const obsidian = new ObsidianIntegration(agent, obsidianConfig);
          await obsidian.start();

          // Register Obsidian tools with the agent
          const registry = agent.getToolRegistry();
          for (const tool of obsidian.getTools()) {
            registry.register(tool);
          }

          integrations.push('Obsidian');
          integrationInstances.push({ name: 'obsidian', instance: obsidian });
          shutdownManager.register('obsidian', () => obsidian.stop());
        } else {
          console.log('Obsidian integration skipped: vaultPath not configured.');
        }
      } catch (error) {
        log.error({ error }, 'Failed to start Obsidian integration');
        console.error('Failed to start Obsidian:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Voice (Twilio) — register make_phone_call tool ──────────────────
    let voiceCaller: unknown = null;
    try {
      const config = agent.getConfig();
      const voiceConfig = (config as unknown as Record<string, unknown>)['voice'] as {
        twilio?: { accountSid: string; authToken: string; phoneNumber: string; webhookBaseUrl: string };
      } | undefined;

      if (voiceConfig?.twilio?.accountSid) {
        const { VoiceCaller, createPhoneCallTool } = await import('@agentx/voice' as string);
        const { VoiceManager } = await import('@agentx/voice' as string);
        const voiceManager = new VoiceManager();
        const caller = new VoiceCaller(voiceConfig.twilio, voiceManager.getTTS());
        const phoneTool = createPhoneCallTool(caller);
        agent.getToolRegistry().register(phoneTool);
        voiceCaller = caller;
        integrations.push('Voice');
        log.info('Voice calling (Twilio) tools registered');
      }
    } catch (error) {
      log.error({ error }, 'Failed to register voice tools');
    }

    // ─── Skill Generator — register create_skill tool ─────────────────────
    try {
      const { SkillGenerator, createSkillGeneratorTool } = await import('@agentx/skills' as string);
      const config = agent.getConfig();
      const generator = new SkillGenerator(config.skills.directory);

      // Wire the LLM completer through the agent
      generator.setCompleter(async (opts: { messages: Array<{ content: string }>; systemPrompt?: string; maxTokens?: number }) => {
        const resp = await agent.chat(
          opts.messages[0]?.content ?? '',
          'skill-generator',
        );
        return { content: resp };
      });

      const skillTool = createSkillGeneratorTool(generator);
      agent.getToolRegistry().register(skillTool);
      log.info('Skill generator tool registered');
    } catch (error) {
      log.error({ error }, 'Failed to register skill generator tool');
    }

    // ─── Check at least one integration was specified ─────────────────────────
    const flagNames = ['telegram', 'discord', 'slack', 'whatsapp', 'signal', 'imessage', 'web', 'google', 'obsidian'];
    const anyFlagSet = flagNames.some((f) => options[f]);

    if (!anyFlagSet) {
      console.log('No integrations specified. Use flags to enable:');
      console.log('  --telegram  --discord  --slack  --whatsapp  --signal  --imessage');
      console.log('  --web       --google   --obsidian');
      console.log('\nExample: agentx start --telegram --discord --web');
      await agent.shutdown();
      return;
    }

    if (integrations.length > 0) {
      console.log(`Active integrations: ${integrations.join(', ')}`);
    }

    // ─── Web UI ──────────────────────────────────────────────────────────────
    if (options.web) {
      try {
        const { WebServer } = await import('@agentx/web' as string);
        const config = agent.getConfig();
        const webConfig = (config as unknown as Record<string, unknown>)['web'] as {
          port?: number; host?: string; authToken?: string;
        } | undefined;

        const webServer = new WebServer({
          port: webConfig?.port ?? 3001,
          host: webConfig?.host ?? '0.0.0.0',
          agent,
          authToken: webConfig?.authToken || undefined,
          voiceCaller: voiceCaller as { updateCallStatus(s: string, st: string): void; buildGatherResponse(r: string): string; getAudioDir(): string } | undefined,
        });
        await webServer.start();
        console.log(`Web UI running on http://${webConfig?.host ?? '0.0.0.0'}:${webConfig?.port ?? 3001}`);
        integrations.push('Web UI');
        shutdownManager.register('web', () => webServer.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start Web UI');
        console.error('Failed to start Web UI:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Health server ───────────────────────────────────────────────────────
    if (options.health) {
      const healthServer = agent.getHealthServer();
      if (!healthServer.isRunning()) {
        try {
          await healthServer.start();
          console.log(`Health server running on port ${healthServer.getPort()}`);
          shutdownManager.register('health', () => healthServer.stop());
        } catch (error) {
          log.error({ error }, 'Failed to start health server');
          console.error('Failed to start health server:', error instanceof Error ? error.message : error);
        }
      }
    }

    // ─── Heartbeat wiring ────────────────────────────────────────────────────
    if (options.heartbeat) {
      const heartbeat = agent.getHeartbeatManager();

      // Wire message sender to route through active integrations
      heartbeat.setMessageSender(async (recipient: string, platform: string, message: string) => {
        const integration = integrationInstances.find((i) => i.name === platform);
        if (!integration) {
          log.warn({ platform, recipient }, 'No integration available for heartbeat target');
          return;
        }

        if (typeof integration.instance.sendMessage === 'function') {
          await integration.instance.sendMessage(recipient, message);
        } else {
          log.warn({ platform }, 'Integration does not support sendMessage');
        }
      });

      heartbeat.start();
      console.log('Heartbeat manager started');
      shutdownManager.register('heartbeat', async () => heartbeat.stop());

      // Wire monitor skills to send alerts through heartbeat
      const heartbeatAlertSender = async (message: string) => {
        // Send alert to all configured heartbeat targets
        for (const target of heartbeat.getTargets()) {
          await heartbeat.sendAlert(target.userId, target.platform, message);
        }
      };

      try {
        const monitorWebsite = await import('@agentx/skills/builtin/monitor-website' as string);
        if (typeof monitorWebsite.setAlertSender === 'function') {
          monitorWebsite.setAlertSender(heartbeatAlertSender);
        }
      } catch { /* monitor-website skill not available */ }

      try {
        const monitorFile = await import('@agentx/skills/builtin/monitor-file' as string);
        if (typeof monitorFile.setAlertSender === 'function') {
          monitorFile.setAlertSender(heartbeatAlertSender);
        }
      } catch { /* monitor-file skill not available */ }

      try {
        const monitorCommand = await import('@agentx/skills/builtin/monitor-command' as string);
        if (typeof monitorCommand.setAlertSender === 'function') {
          monitorCommand.setAlertSender(heartbeatAlertSender);
        }
      } catch { /* monitor-command skill not available */ }

      log.info('Monitor alert senders wired through heartbeat');
    }

    // ─── Skill watcher ───────────────────────────────────────────────────────
    if (options.skillsWatch) {
      try {
        const { SkillManager, SkillWatcher } = await import('@agentx/skills' as string);
        const config = agent.getConfig();
        const skillManager = new SkillManager(config.skills.directory);
        skillManager.setPermissionManager(agent.getPermissionManager());

        // Load existing skills
        await skillManager.loadAll();

        const watcher = new SkillWatcher(
          config.skills.directory,
          async (skillName: string) => {
            log.info({ skillName }, 'Hot-reloading skill');
            try {
              await skillManager.reloadSkill(skillName);
              // Re-register tools from reloaded skill
              const skill = skillManager.getSkill(skillName);
              if (skill) {
                const registry = agent.getToolRegistry();
                for (const tool of skill.tools) {
                  registry.register(tool);
                }
              }
            } catch (error) {
              log.error({ skillName, error }, 'Skill hot-reload failed');
            }
          },
        );

        watcher.start();
        console.log('Skill watcher started');
        shutdownManager.register('skill-watcher', () => watcher.stop());
      } catch (error) {
        log.error({ error }, 'Failed to start skill watcher');
        console.error('Failed to start skill watcher:', error instanceof Error ? error.message : error);
      }
    }

    // ─── Listen for shutdown signals ─────────────────────────────────────────
    console.log('\nAgentX is running. Press Ctrl+C to stop.\n');
    shutdownManager.listen();
  });
