import type { Command } from 'commander';
import prompts from 'prompts';
import { requireAuth } from '../guards.js';
import { trpcMutate, trpcQuery } from '../trpc.js';
import { c, render, success, table, warn } from '../output.js';

interface Dashboard {
  id: string;
  name: string;
  projectId?: string;
  createdAt?: string | Date;
}

export async function listDashboards(projectId: string): Promise<Dashboard[]> {
  return (await trpcQuery<Dashboard[]>('dashboard.list', { projectId })) ?? [];
}

export function registerDashboardCommands(program: Command): void {
  const dashboards = program
    .command('dashboards')
    .alias('dashboard')
    .description('Manage dashboards');

  dashboards
    .command('list')
    .description('List dashboards in a project')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .action(async (opts) => {
      requireAuth();
      const list = await listDashboards(opts.project);
      render(list, () =>
        table(
          list.map((d) => ({
            name: d.name,
            id: d.id,
            createdAt: d.createdAt ?? '',
          })),
          ['name', 'id', 'createdAt'],
        ),
      );
    });

  dashboards
    .command('create')
    .description('Create a dashboard')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .requiredOption('-n, --name <name>', 'Dashboard name')
    .action(async (opts) => {
      requireAuth();
      const created = await trpcMutate<Dashboard>('dashboard.create', {
        name: opts.name,
        projectId: opts.project,
      });
      render(created, () => {
        success(`Created dashboard ${c.bold(created.name)}`);
        success(`ID: ${c.bold(created.id)}`);
      });
    });

  dashboards
    .command('delete')
    .description('Delete a dashboard')
    .requiredOption('-i, --id <dashboardId>', 'Dashboard ID')
    .option('-f, --force', 'Also delete all reports inside the dashboard', false)
    .option('-y, --yes', 'Skip confirmation', false)
    .action(async (opts) => {
      requireAuth();
      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Delete dashboard ${opts.id}${
            opts.force ? ' and all its reports' : ''
          }?`,
          initial: false,
        });
        if (!ok) {
          warn('Aborted.');
          return;
        }
      }
      await trpcMutate('dashboard.delete', {
        id: opts.id,
        forceDelete: !!opts.force,
      });
      render({ deleted: opts.id }, () => success(`Deleted dashboard ${opts.id}`));
    });
}
