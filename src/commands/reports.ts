import { readFileSync } from 'node:fs';
import type { Command } from 'commander';
import prompts from 'prompts';
import { requireAuth } from '../guards.js';
import { trpcMutate, trpcQuery, TrpcError } from '../trpc.js';
import {
  zReportForCreate,
  type ReportForCreateInput,
} from '../schemas.js';
import { c, render, success, table, warn } from '../output.js';

interface Report {
  id: string;
  name: string;
  chartType?: string;
  range?: string;
  dashboardId?: string;
}

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

export function registerReportCommands(program: Command): void {
  const reports = program
    .command('reports')
    .alias('report')
    .description('Manage reports (chart tiles inside a dashboard)');

  reports
    .command('list')
    .description('List reports in a dashboard')
    .requiredOption('-d, --dashboard <dashboardId>', 'Dashboard ID')
    .requiredOption('-P, --project <projectId>', 'Project ID')
    .action(async (opts) => {
      requireAuth();
      const list =
        (await trpcQuery<Report[]>('report.list', {
          dashboardId: opts.dashboard,
          projectId: opts.project,
        })) ?? [];
      render(list, () =>
        table(
          list.map((r) => ({
            name: r.name,
            id: r.id,
            chartType: r.chartType ?? '',
            range: r.range ?? '',
          })),
          ['name', 'id', 'chartType', 'range'],
        ),
      );
    });

  reports
    .command('create')
    .description('Create a report inside a dashboard')
    .requiredOption('-d, --dashboard <dashboardId>', 'Dashboard ID')
    .option('-n, --name <name>', 'Report name')
    .option('-e, --event <name>', 'Event to chart (repeatable)', collect, [])
    .option('-s, --segment <segment>', 'Aggregation segment for events (event|user|session|…)', 'event')
    .option('-c, --chart-type <type>', 'Chart type (linear|bar|pie|metric|area|map|funnel|…)', 'linear')
    .option('-i, --interval <interval>', 'Interval (minute|hour|day|week|month)', 'day')
    .option('-r, --range <range>', 'Range (7d|30d|today|…)', '30d')
    .option('-b, --breakdown <property>', 'Breakdown property (repeatable)', collect, [])
    .option('-m, --metric <metric>', 'Metric (count|sum|average|min|max)', 'sum')
    .option('--line-type <lineType>', 'Line type for line charts', 'monotone')
    .option('--unit <unit>', 'Y-axis unit label (e.g. $, %, users)')
    .option('--previous', 'Include previous-period comparison', false)
    .option('--layout <x,y,w,h>', 'Grid placement, e.g. 0,0,6,3')
    .option('-f, --file <path>', 'Path to a JSON report spec (overrides the flags above except --dashboard/--layout)')
    .action(async (opts) => {
      requireAuth();

      const reportInput: ReportForCreateInput = opts.file
        ? loadReportFile(opts.file)
        : buildReportFromFlags(opts);

      const parsed = zReportForCreate.safeParse(reportInput);
      if (!parsed.success) {
        throw new TrpcError(
          `Invalid report spec:\n${parsed.error.issues
            .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n')}`,
        );
      }

      const created = await trpcMutate<Report>('report.create', {
        dashboardId: opts.dashboard,
        report: parsed.data,
      });

      // Optional grid placement.
      if (opts.layout) {
        const layout = parseLayout(opts.layout);
        await trpcMutate('report.updateLayout', {
          reportId: created.id,
          layout,
        });
      }

      render(created, () => {
        success(`Created report ${c.bold(created.name)}`);
        success(`ID: ${c.bold(created.id)}`);
      });
    });

  reports
    .command('delete')
    .description('Delete a report')
    .requiredOption('-i, --id <reportId>', 'Report ID')
    .option('-y, --yes', 'Skip confirmation', false)
    .action(async (opts) => {
      requireAuth();
      if (!opts.yes) {
        const { ok } = await prompts({
          type: 'confirm',
          name: 'ok',
          message: `Delete report ${opts.id}?`,
          initial: false,
        });
        if (!ok) {
          warn('Aborted.');
          return;
        }
      }
      await trpcMutate('report.delete', { reportId: opts.id });
      render({ deleted: opts.id }, () => success(`Deleted report ${opts.id}`));
    });
}

function buildReportFromFlags(opts: any): ReportForCreateInput {
  const events: string[] = opts.event ?? [];
  if (events.length === 0) {
    throw new TrpcError(
      'A report needs at least one event. Pass --event <name> (repeatable) or --file <spec.json>.',
    );
  }
  if (!opts.name) {
    throw new TrpcError('Missing --name for the report (or provide it in --file).');
  }

  return {
    name: opts.name,
    chartType: opts.chartType,
    interval: opts.interval,
    range: opts.range,
    metric: opts.metric,
    lineType: opts.lineType,
    unit: opts.unit,
    previous: !!opts.previous,
    breakdowns: (opts.breakdown ?? []).map((name: string) => ({ name })),
    series: events.map((name) => ({
      type: 'event' as const,
      name,
      segment: opts.segment,
      filters: [],
    })),
  };
}

function loadReportFile(path: string): ReportForCreateInput {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new TrpcError(
      `Could not read report file ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new TrpcError(`Report file ${path} is not valid JSON: ${String(e)}`);
  }
  // Accept either the report object directly or { report: {...} }.
  return (json.report ?? json) as ReportForCreateInput;
}

function parseLayout(value: string): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const parts = value.split(',').map((n) => Number(n.trim()));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new TrpcError('--layout must be four numbers: x,y,w,h (e.g. 0,0,6,3)');
  }
  const [x, y, w, h] = parts as [number, number, number, number];
  return { x, y, w, h };
}
