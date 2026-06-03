import type { Command } from 'commander';
import {
  configPath,
  getInstance,
  loadConfig,
  setInstance,
} from '../config.js';
import { getTrpcUrl } from '../config.js';
import { info, render, success } from '../output.js';

export function registerConfigCommands(program: Command): void {
  const config = program
    .command('config')
    .description('View or change CLI configuration');

  config
    .command('set-instance <url>')
    .description('Set and persist the OpenPanel base URL')
    .action((url: string) => {
      setInstance(url);
      success(`Instance set to ${getInstance()}`);
    });

  config
    .command('show', { isDefault: true })
    .description('Show current configuration')
    .action(() => {
      const cfg = loadConfig();
      const out = {
        instance: getInstance(),
        trpcUrl: getTrpcUrl(),
        loggedIn: !!cfg.auth?.sessionToken,
        email: cfg.auth?.email ?? null,
        expiresAt: cfg.auth?.expiresAt ?? null,
        configPath: configPath(),
      };
      render(out, () => {
        info(`Instance:    ${out.instance}`);
        info(`tRPC URL:    ${out.trpcUrl}`);
        info(`Logged in:   ${out.loggedIn ? 'yes' : 'no'}${out.email ? ` (${out.email})` : ''}`);
        if (out.expiresAt) info(`Expires:     ${out.expiresAt}`);
        info(`Config file: ${out.configPath}`);
      });
    });
}
