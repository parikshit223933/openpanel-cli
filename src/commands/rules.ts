import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import prompts from 'prompts';
import { requireAuth } from '../guards.js';
import { trpcMutate, trpcQuery, TrpcError } from '../trpc.js';
import {
  APP_NOTIFICATION_INTEGRATION_ID,
  EMAIL_NOTIFICATION_INTEGRATION_ID,
  zCreateNotificationRule,
  type CreateNotificationRuleInput,
} from '../schemas.js';
import { c, info, render, success, table, warn } from '../output.js';

interface NotificationRule {
  id: string;
  name: string;
  sendToApp?: boolean;
  sendToEmail?: boolean;
  config?: { type?: string };
}

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

export function registerRuleCommands(program: Command): void {
  const rules = program
    .command('rules')
    .alias('rule')
    .description('Manage notification rules');

  rules
    .command('list')
    .description('List notification rules in a project')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .action(async (opts) => {
      requireAuth();
      const list =
        (await trpcQuery<NotificationRule[]>('notification.rules', {
          projectId: opts.project,
        })) ?? [];
      render(list, () =>
        table(
          list.map((r) => ({
            name: r.name,
            id: r.id,
            type: r.config?.type ?? '',
            app: r.sendToApp ? 'yes' : '',
            email: r.sendToEmail ? 'yes' : '',
          })),
          ['name', 'id', 'type', 'app', 'email'],
        ),
      );
    });

  rules
    .command('create')
    .description('Create (or update with --id) a notification rule')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .option('-n, --name <name>', 'Rule name')
    .option('-t, --type <type>', 'Trigger type: events | funnel', 'events')
    .option('-e, --event <name>', 'Event that triggers the rule (repeatable)', collect, [])
    .option('--app', 'Send notification to the in-app inbox', false)
    .option('--email', 'Send notification by email', false)
    .option('--integration <id>', 'Extra integration ID to notify, e.g. Slack/Discord/webhook (repeatable)', collect, [])
    .option('--template <text>', 'Custom message template')
    .option('--id <ruleId>', 'Update an existing rule instead of creating')
    .option('-f, --file <path>', 'Path to a JSON rule spec (overrides flags except --project)')
    .action(async (opts) => {
      requireAuth();

      const ruleInput: CreateNotificationRuleInput = opts.file
        ? loadRuleFile(opts.file, opts.project)
        : buildRuleFromFlags(opts);

      const parsed = zCreateNotificationRule.safeParse(ruleInput);
      if (!parsed.success) {
        throw new TrpcError(
          `Invalid rule spec:\n${parsed.error.issues
            .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n')}`,
        );
      }

      const saved = await trpcMutate<NotificationRule>(
        'notification.createOrUpdateRule',
        parsed.data,
      );
      render(saved, () => {
        success(`${opts.id ? 'Updated' : 'Created'} notification rule ${c.bold(saved.name)}`);
        success(`ID: ${c.bold(saved.id)}`);
      });
    });

  rules
    .command('delete')
    .description('Delete a notification rule')
    .requiredOption('-i, --id <ruleId>', 'Rule ID')
    .option('-y, --yes', 'Skip confirmation', false)
    .action(async (opts) => {
      requireAuth();
      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Delete notification rule ${opts.id}?`,
          initial: false,
        });
        if (!ok) {
          warn('Aborted.');
          return;
        }
      }
      await trpcMutate('notification.deleteRule', { id: opts.id });
      render({ deleted: opts.id }, () => success(`Deleted notification rule ${opts.id}`));
    });
}

function buildRuleFromFlags(opts: any): CreateNotificationRuleInput {
  if (!opts.name) {
    throw new TrpcError('Missing --name for the rule (or provide it in --file).');
  }
  const events: string[] = opts.event ?? [];
  if (events.length === 0) {
    throw new TrpcError(
      'A rule needs at least one --event <name> (repeatable), or use --file <spec.json>.',
    );
  }
  if (opts.type !== 'events' && opts.type !== 'funnel') {
    throw new TrpcError('--type must be "events" or "funnel".');
  }

  let sendToApp = !!opts.app;
  const sendToEmail = !!opts.email;
  const extra: string[] = opts.integration ?? [];

  // Default to in-app delivery if no channel was chosen, so the rule notifies.
  if (!sendToApp && !sendToEmail && extra.length === 0) {
    sendToApp = true;
    info('No delivery channel specified — defaulting to in-app (--app).');
  }

  const integrations = [
    ...(sendToApp ? [APP_NOTIFICATION_INTEGRATION_ID] : []),
    ...(sendToEmail ? [EMAIL_NOTIFICATION_INTEGRATION_ID] : []),
    ...extra,
  ];

  return {
    id: opts.id,
    name: opts.name,
    projectId: opts.project,
    template: opts.template || undefined,
    config: {
      type: opts.type,
      events: events.map((name) => ({
        name,
        segment: 'event' as const,
        filters: [],
      })),
    },
    integrations,
    sendToApp,
    sendToEmail,
  };
}

function loadRuleFile(
  path: string,
  projectId: string,
): CreateNotificationRuleInput {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new TrpcError(
      `Could not read rule file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new TrpcError(`Rule file ${path} is not valid JSON: ${String(e)}`);
  }
  const rule = (json.rule ?? json) as CreateNotificationRuleInput;
  // CLI --project wins so the file is portable across projects.
  return { ...rule, projectId: projectId ?? rule.projectId };
}
