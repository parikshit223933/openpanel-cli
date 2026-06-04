import type { Command } from 'commander';
import prompts from 'prompts';
import { requireAuth } from '../guards.js';
import { trpcMutate, trpcQuery, TrpcError } from '../trpc.js';
import { zCreateReference, type CreateReferenceInput } from '../schemas.js';
import { c, render, success, table, warn } from '../output.js';

interface Reference {
  id: string;
  title: string;
  description?: string | null;
  date?: string | Date;
  projectId?: string;
}

export function registerReferenceCommands(program: Command): void {
  const references = program
    .command('references')
    .alias('reference')
    .description('Manage references (annotation markers shown on time-series charts)');

  references
    .command('list')
    .description('List references in a project')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .action(async (opts) => {
      requireAuth();
      const list =
        (await trpcQuery<Reference[]>('reference.getReferences', {
          projectId: opts.project,
        })) ?? [];
      render(list, () =>
        table(
          list.map((r) => ({
            title: r.title,
            id: r.id,
            date: r.date ?? '',
            description: r.description ?? '',
          })),
          ['title', 'id', 'date', 'description'],
        ),
      );
    });

  references
    .command('create')
    .description('Create a reference marker on charts')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .requiredOption('-t, --title <title>', 'Marker title (e.g. "Deployed v2")')
    .option('--description <text>', 'Optional longer description')
    .option('--date <datetime>', 'When the marker sits (ISO date/time). Defaults to now.')
    .action(async (opts) => {
      requireAuth();

      const datetime = resolveDatetime(opts.date);
      const input: CreateReferenceInput = {
        title: opts.title,
        description: opts.description,
        projectId: opts.project,
        datetime,
      };

      const parsed = zCreateReference.safeParse(input);
      if (!parsed.success) {
        throw new TrpcError(
          `Invalid reference:\n${parsed.error.issues
            .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n')}`,
        );
      }

      const created = await trpcMutate<Reference>('reference.create', parsed.data);
      render(created, () => {
        success(`Created reference ${c.bold(created.title)} @ ${datetime}`);
        success(`ID: ${c.bold(created.id)}`);
      });
    });

  references
    .command('delete')
    .description('Delete a reference')
    .requiredOption('-i, --id <referenceId>', 'Reference ID')
    .option('-y, --yes', 'Skip confirmation', false)
    .action(async (opts) => {
      requireAuth();
      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Delete reference ${opts.id}?`,
          initial: false,
        });
        if (!ok) {
          warn('Aborted.');
          return;
        }
      }
      await trpcMutate('reference.delete', { id: opts.id });
      render({ deleted: opts.id }, () => success(`Deleted reference ${opts.id}`));
    });
}

/** Resolve a user-supplied date string (or default to now) into an ISO string. */
function resolveDatetime(value?: string): string {
  if (!value || value.toLowerCase() === 'now') {
    return new Date().toISOString();
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new TrpcError(
      `--date "${value}" is not a valid date. Use an ISO date/time like 2026-06-01 or 2026-06-01T10:00:00Z.`,
    );
  }
  return d.toISOString();
}
