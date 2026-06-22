import { writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Command } from 'commander';
import { requireAuth } from '../guards.js';
import { trpcQuery, TrpcError } from '../trpc.js';
import {
  zChartDataInput,
  operators as OPERATORS,
  type ChartDataInputInput,
} from '../schemas.js';
import {
  c,
  info,
  isJsonMode,
  printJson,
  render,
  success,
  table,
  toCsv,
  warn,
} from '../output.js';

/**
 * `openpanel data` — pull the actual numbers (read-only).
 *
 * Calls OpenPanel's internal `chart.chart` query (the same procedure the
 * dashboard uses to render a chart), so the numbers match the dashboard by
 * construction. Works for an ad-hoc query (event + range + grouping + filters
 * + breakdown) or a saved report (`--report <id>` → fetched via `report.get`
 * and fed to the same engine). Output as a terminal table, JSON, or CSV.
 */

// ── FinalChart wire shape returned by chart.chart (OpenPanel's chart engine) ──
/**
 * A previous-period stat. Newer OpenPanel returns a plain number; the deployed
 * instances we target return `{ value, diff, state }` (value = previous total,
 * diff = % change magnitude, state = 'positive' | 'negative'). Handle both.
 */
type PrevStat = number | { value: number; diff?: number; state?: string };
interface FinalChartMetrics {
  sum: number;
  average: number;
  min: number;
  max: number;
  /** Non-additive total (e.g. true unique count), when applicable. */
  count?: number;
  previous?: {
    sum: PrevStat;
    average: PrevStat;
    min: PrevStat;
    max: PrevStat;
    count?: PrevStat;
  };
}
interface FinalChartSeries {
  id: string;
  names: string[];
  event?: { id?: string; name?: string; breakdowns?: Record<string, string> };
  metrics: FinalChartMetrics;
  data: Array<{ date: string; count: number; previous?: number | null }>;
}
interface FinalChart {
  series: FinalChartSeries[];
  metrics: Omit<FinalChartMetrics, 'previous'>;
}

interface SavedReport {
  id: string;
  name: string;
  projectId: string;
  chartType: string;
  interval: string;
  range: string;
  series: unknown[];
  breakdowns?: unknown[];
  startDate?: string | null;
  endDate?: string | null;
  previous?: boolean;
  formula?: string;
  metric?: string;
  options?: unknown;
  lineType?: string;
  unit?: string;
  limit?: number;
}

/** A series after normalization — ready to render. */
interface NormalSeries {
  label: string;
  metrics: FinalChartMetrics;
  data: Array<{ date: string; count: number; previous?: number | null }>;
  byDate: Map<string, number>;
}
interface Normalized {
  meta: { source: string; projectId: string; range?: string; interval?: string };
  periods: string[];
  series: NormalSeries[];
  global: FinalChart['metrics'];
}

const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

// Chart types the chart engine (chart.chart) does not produce row/series data for.
const UNSUPPORTED_CHART_TYPES = new Set([
  'funnel',
  'retention',
  'conversion',
  'sankey',
]);

export function registerDataCommand(program: Command): void {
  program
    .command('data')
    .alias('pull')
    .description(
      'Pull the actual numbers for an ad-hoc query or a saved report (read-only)',
    )
    // ── source ──
    .option('-P, --project <projectId>', 'Project ID (required for an ad-hoc query)')
    .option('-R, --report <reportId>', 'Pull a saved report by ID instead of an ad-hoc query')
    // ── ad-hoc query (same vocabulary as `reports create`) ──
    .option('-e, --event <name>', 'Event to query (repeatable)', collect, [])
    .option('-s, --segment <segment>', 'Aggregation segment (event|user|session|…)', 'event')
    .option('-i, --interval <interval>', 'Time grouping (minute|hour|day|week|month)', 'day')
    .option('-r, --range <range>', 'Range (7d|30d|today|…) — default 7d to limit ClickHouse load', '7d')
    .option('--start <date>', 'Custom start date (ISO); overrides --range')
    .option('--end <date>', 'Custom end date (ISO); overrides --range')
    .option('-b, --breakdown <property>', 'Breakdown property (repeatable)', collect, [])
    .option('--limit <n>', 'Cap how many series are returned (top N by total)')
    .option('-m, --metric <metric>', 'Metric (count|sum|average|min|max)', 'sum')
    .option('-c, --chart-type <type>', 'Chart type (linear|bar|metric|area|…)', 'linear')
    .option(
      '--filter <expr>',
      'Filter "<property> <operator> [v1,v2]" e.g. "country is IN" (repeatable)',
      collect,
      [],
    )
    .option('--previous', 'Include previous-period comparison', false)
    // ── output ──
    .option('--format <fmt>', 'Output format: table | json | csv (default table)')
    .option('-o, --out <path>', 'Write the result to a file (format inferred from extension)')
    .option('--summary-only', 'Print only the per-series summary (skip per-period rows)', false)
    // ── discovery helpers ──
    .option('--list-events', 'List the available events for the project and exit', false)
    .option('--list-properties', 'List the available filter/breakdown properties and exit', false)
    .action(runData);
}

async function runData(opts: any, command: Command): Promise<void> {
  requireAuth();

  if (opts.listEvents) return listEvents(opts);
  if (opts.listProperties) return listProperties(opts);

  const built = opts.report
    ? await buildFromReport(opts, command)
    : await buildFromFlags(opts);

  const result = await trpcQuery<FinalChart>('chart.chart', built.input);
  const normalized = normalize(result ?? { series: [], metrics: emptyMetrics() }, built.meta);
  output(normalized, opts);
}

// ── Input builders ───────────────────────────────────────────────────────────

async function buildFromFlags(
  opts: any,
): Promise<{ input: ChartDataInputInput; meta: Normalized['meta'] }> {
  const projectId: string | undefined = opts.project;
  if (!projectId) {
    throw new TrpcError(
      'Missing -P/--project. Run `openpanel projects list` to find the id, or use -R <reportId> to pull a saved report.',
    );
  }
  const events: string[] = opts.event ?? [];
  if (events.length === 0) {
    throw new TrpcError(
      'A query needs at least one event. Pass -e <event> (repeatable). Run `openpanel data -P <id> --list-events` to see what is available.',
    );
  }

  // Authoritative event-name check (clear error on a typo), then best-effort
  // property resolution so `country`/`path` etc. map to the right ClickHouse key.
  await validateEvents(projectId, events);
  const propsList = await fetchProperties(projectId, events[0]).catch(() => [] as string[]);

  const breakdowns = (opts.breakdown ?? []).map((name: string) => ({
    name: resolveProperty(name, propsList, 'breakdown'),
  }));
  // Attach filters to each event series rather than `globalFilters`: the chart
  // engine applies per-series filters reliably across OpenPanel versions,
  // whereas top-level globalFilters is only merged by newer builds (and by the
  // funnel/sankey procedures), so it is silently ignored on some instances.
  const filters = (opts.filter ?? []).map((f: string) => parseFilter(f, propsList));

  const hasCustomDates = Boolean(opts.start || opts.end);
  const input: ChartDataInputInput = {
    projectId,
    name: events.join(', '),
    chartType: opts.chartType,
    interval: opts.interval,
    range: hasCustomDates ? 'custom' : opts.range,
    startDate: opts.start ?? null,
    endDate: opts.end ?? null,
    metric: opts.metric,
    previous: !!opts.previous,
    breakdowns,
    limit: parseLimit(opts.limit),
    series: events.map((name) => ({
      type: 'event' as const,
      name,
      segment: opts.segment,
      filters,
    })),
  };

  const parsed = zChartDataInput.safeParse(input);
  if (!parsed.success) {
    throw new TrpcError(
      `Invalid query:\n${parsed.error.issues
        .map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('\n')}`,
    );
  }

  return {
    input: parsed.data,
    meta: {
      source: `events: ${events.join(', ')}`,
      projectId,
      range: input.range,
      interval: opts.interval,
    },
  };
}

async function buildFromReport(
  opts: any,
  command: Command,
): Promise<{ input: ChartDataInputInput; meta: Normalized['meta'] }> {
  let report: SavedReport | undefined;
  try {
    report = await trpcQuery<SavedReport>('report.get', {
      reportId: opts.report,
    });
  } catch (e) {
    // Surface auth/access problems as-is; otherwise a bad id can come back as a
    // raw Prisma/lookup error — translate it into a clean message.
    if (e instanceof TrpcError && (e.isAuthError || e.isAccessError)) throw e;
    throw new TrpcError(
      `Report "${opts.report}" not found. Check the id with \`openpanel reports list -d <dashboardId> -P <projectId>\`.`,
    );
  }
  if (!report) {
    throw new TrpcError(
      `Report "${opts.report}" not found. Check the id with \`openpanel reports list -d <dashboardId> -P <projectId>\`.`,
    );
  }
  if (UNSUPPORTED_CHART_TYPES.has(report.chartType)) {
    throw new TrpcError(
      `Report "${report.name}" is a ${report.chartType} chart. \`data\` pulls time-series & aggregate charts (event counts, breakdowns); view ${report.chartType} charts in the OpenPanel dashboard.`,
    );
  }

  // The report carries its own range/interval; let the user override either.
  const explicit = (name: string) => command.getOptionValueSource(name) === 'cli';
  const range = explicit('range') ? opts.range : report.range;
  const interval = explicit('interval') ? opts.interval : report.interval;
  const startDate = explicit('start') ? opts.start : report.startDate ?? null;
  const endDate = explicit('end') ? opts.end : report.endDate ?? null;

  const input: ChartDataInputInput = {
    projectId: report.projectId,
    name: report.name,
    chartType: report.chartType as ChartDataInputInput['chartType'],
    interval: interval as ChartDataInputInput['interval'],
    range: range as ChartDataInputInput['range'],
    startDate,
    endDate,
    metric: (report.metric ?? 'sum') as ChartDataInputInput['metric'],
    previous: explicit('previous') ? !!opts.previous : !!report.previous,
    breakdowns: (report.breakdowns ?? []) as ChartDataInputInput['breakdowns'],
    series: report.series as ChartDataInputInput['series'],
    formula: report.formula,
    options: report.options,
    lineType: report.lineType as ChartDataInputInput['lineType'],
    unit: report.unit,
    limit: report.limit,
  };

  return {
    input,
    meta: {
      source: `report: ${report.name} (${report.id})`,
      projectId: report.projectId,
      range: String(range),
      interval: String(interval),
    },
  };
}

// ── Discovery helpers ─────────────────────────────────────────────────────────

async function listEvents(opts: any): Promise<void> {
  const projectId = requireProject(opts);
  const events =
    (await trpcQuery<Array<{ name: string; count: number }>>('chart.events', {
      projectId,
    })) ?? [];
  const rows = events
    .filter((e) => e.name && e.name !== '*')
    .map((e) => ({ event: e.name, count: e.count }));
  render(rows, () => table(rows, ['event', 'count']));
}

async function listProperties(opts: any): Promise<void> {
  const projectId = requireProject(opts);
  const event = (opts.event ?? [])[0];
  const props = await fetchProperties(projectId, event);
  const rows = props.map((p) => ({ property: p }));
  render(rows, () => table(rows, ['property']));
}

function requireProject(opts: any): string {
  if (!opts.project) {
    throw new TrpcError(
      'Missing -P/--project. Run `openpanel projects list` to find the id.',
    );
  }
  return opts.project;
}

// ── Validation / resolution ───────────────────────────────────────────────────

async function validateEvents(projectId: string, events: string[]): Promise<void> {
  let known: string[];
  try {
    const list =
      (await trpcQuery<Array<{ name: string }>>('chart.events', { projectId })) ??
      [];
    known = list.map((e) => e.name).filter((n) => n && n !== '*');
  } catch {
    return; // best-effort — never block the pull if discovery fails
  }
  if (known.length === 0) return;
  const knownSet = new Set(known);
  const missing = events.filter((e) => !knownSet.has(e));
  if (missing.length === 0) return;

  const suggestions = [...new Set(missing.flatMap((m) => closest(m, known)))].slice(0, 5);
  throw new TrpcError(
    `Unknown event${missing.length > 1 ? 's' : ''}: ${missing
      .map((m) => `"${m}"`)
      .join(', ')}.` +
      (suggestions.length
        ? ` Did you mean: ${suggestions.map((s) => `"${s}"`).join(', ')}?`
        : '') +
      ` Run \`openpanel data -P ${projectId} --list-events\` to see available events.`,
  );
}

async function fetchProperties(projectId: string, event?: string): Promise<string[]> {
  const props = await trpcQuery<string[]>('chart.properties', {
    projectId,
    ...(event ? { event } : {}),
  });
  return props ?? [];
}

/**
 * Map a user-given property name to the real ClickHouse key. Accepts the bare
 * name (`country`) or auto-prefixes custom event props (`foo` →
 * `properties.foo`) when that is what exists. Warns (but proceeds) on an
 * unknown name so a sampled/incomplete property list never blocks a valid query.
 */
function resolveProperty(given: string, propsList: string[], kind: string): string {
  if (propsList.length === 0) return given;
  if (propsList.includes(given)) return given;
  const prefixed = `properties.${given}`;
  if (propsList.includes(prefixed)) return prefixed;
  const sugg = closest(given, propsList).slice(0, 5);
  warn(
    `Unknown ${kind} property "${given}"${
      sugg.length ? ` — did you mean ${sugg.map((s) => `"${s}"`).join(', ')}?` : ''
    }. Proceeding; it may return no data.`,
  );
  return given;
}

function parseFilter(expr: string, propsList: string[]): {
  name: string;
  operator: string;
  value: Array<string | number>;
} {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length < 2) {
    throw new TrpcError(
      `Bad --filter "${expr}". Use "<property> <operator> [value1,value2]", e.g. "country is IN".`,
    );
  }
  const [rawName, operator, ...rest] = tokens as [string, string, ...string[]];
  if (!(OPERATORS as readonly string[]).includes(operator)) {
    throw new TrpcError(
      `Unknown filter operator "${operator}" in --filter "${expr}". Valid operators: ${OPERATORS.join(', ')}.`,
    );
  }
  const name = resolveProperty(rawName, propsList, 'filter');
  const noValue = operator === 'isNull' || operator === 'isNotNull';
  const rawValue = rest.join(' ').trim();
  if (!noValue && !rawValue) {
    throw new TrpcError(
      `Filter "${expr}" needs a value, e.g. "${rawName} ${operator} something".`,
    );
  }
  const numeric = new Set(['gt', 'lt', 'gte', 'lte']);
  const value = noValue
    ? []
    : rawValue.split(',').map((v) => {
        const t = v.trim();
        return numeric.has(operator) && /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t;
      });
  return { name, operator, value };
}

/** Rank candidate names by rough similarity to a target (for "did you mean"). */
function closest(target: string, candidates: string[]): string[] {
  const t = target.toLowerCase();
  return candidates
    .map((cand) => {
      const c2 = cand.toLowerCase();
      let score = 0;
      if (c2 === t) score = 100;
      else if (c2.includes(t) || t.includes(c2)) score = 40 - Math.abs(c2.length - t.length);
      else {
        let i = 0;
        while (i < c2.length && i < t.length && c2[i] === t[i]) i++;
        if (i >= 2) score = i;
      }
      return { cand, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.cand);
}

// ── Normalization + rendering ─────────────────────────────────────────────────

function normalize(chart: FinalChart, meta: Normalized['meta']): Normalized {
  const series = chart.series ?? [];
  const periods: string[] = [];
  const seen = new Set<string>();
  for (const s of series) {
    for (const d of s.data) {
      if (!seen.has(d.date)) {
        seen.add(d.date);
        periods.push(d.date);
      }
    }
  }

  const labelCounts = new Map<string, number>();
  const norm: NormalSeries[] = series.map((s, i) => {
    const parts = (
      s.names && s.names.length ? s.names : [s.event?.name ?? `series ${i + 1}`]
    ).map((p) => {
      // A null/empty breakdown value comes back as an empty string or NUL
      // bytes — which must not leak into CSV/JSON — so strip and label clearly.
      const clean = String(p ?? '').replace(/\u0000/g, '');
      return clean.trim() === '' ? '(none)' : clean;
    });
    let label = parts.join(' / ');
    const seenN = labelCounts.get(label) ?? 0;
    labelCounts.set(label, seenN + 1);
    if (seenN > 0) label = `${label} #${seenN + 1}`; // de-dupe identical labels
    return {
      label,
      metrics: s.metrics,
      data: s.data,
      byDate: new Map(s.data.map((d) => [d.date, d.count])),
    };
  });

  return { meta, periods, series: norm, global: chart.metrics ?? emptyMetrics() };
}

function output(n: Normalized, opts: any): void {
  // High-cardinality breakdowns can return thousands of series. Nudge toward
  // narrowing (warn goes to stderr, so it never pollutes JSON/CSV on stdout).
  if (!opts.limit && n.series.length > 50) {
    warn(
      `${n.series.length} series returned — pass --limit <n> or add a --filter to narrow it.`,
    );
  }
  if (opts.out) {
    const format = opts.format ?? inferFileFormat(opts.out);
    const content = format === 'json' ? jsonString(n) : renderCsv(n);
    writeFileSync(opts.out, content);
    success(
      `Wrote ${n.series.length} series × ${n.periods.length} period(s) to ${c.bold(
        opts.out,
      )} (${format === 'json' ? 'json' : 'csv'}).`,
    );
    if (n.series.length === 0) info('Note: the query returned no data.');
    return;
  }

  const format = opts.format ?? (isJsonMode() ? 'json' : 'table');
  if (format === 'json') {
    printJson(jsonObject(n));
    return;
  }
  if (format === 'csv') {
    process.stdout.write(renderCsv(n));
    return;
  }
  renderHuman(n, opts);
}

function renderHuman(n: Normalized, opts: any): void {
  info(`Source:   ${n.meta.source}`);
  info(`Project:  ${n.meta.projectId}`);
  info(
    `Range:    ${n.meta.range ?? '(custom)'}${
      n.meta.interval ? ` · by ${n.meta.interval}` : ''
    }`,
  );

  if (n.series.length === 0) {
    warn('No data — the query matched no events for this range/filters.');
    return;
  }

  const labels = n.series.map((s) => s.label);

  // Per-period table (date rows × one column per series).
  if (!opts.summaryOnly && n.periods.length > 0) {
    const rows = n.periods.map((date) => {
      const row: Record<string, unknown> = { date };
      for (const s of n.series) row[s.label] = s.byDate.get(date) ?? 0;
      return row;
    });
    table(rows, ['date', ...labels]);
  }

  // Summary table — one row per series (i.e. one row per breakdown value).
  const hasUnique = n.series.some((s) => typeof s.metrics.count === 'number');
  const hasPrev = n.series.some((s) => s.metrics.previous);
  const summaryRows = n.series.map((s) => {
    const row: Record<string, unknown> = {
      series: s.label,
      total: s.metrics.sum,
      average: s.metrics.average,
      min: s.metrics.min,
      max: s.metrics.max,
    };
    if (hasUnique) row.unique = typeof s.metrics.count === 'number' ? s.metrics.count : '';
    if (hasPrev && s.metrics.previous) {
      const pv = prevValue(s.metrics.previous.sum);
      const pd = prevDiff(s.metrics.previous.sum);
      row.prev = pv ?? '';
      row.change =
        pd != null
          ? `${pd > 0 ? '+' : ''}${pd}%`
          : pv != null
            ? pct(s.metrics.sum, pv)
            : '';
    }
    return row;
  });
  const summaryCols = [
    'series',
    'total',
    'average',
    'min',
    'max',
    ...(hasUnique ? ['unique'] : []),
    ...(hasPrev ? ['prev', 'change'] : []),
  ];
  process.stdout.write(`\n${c.bold('Summary')} ${c.dim('(one row per series)')}\n`);
  table(summaryRows, summaryCols);

  const total = n.global?.sum ?? n.series.reduce((a, s) => a + s.metrics.sum, 0);
  const uniqueNote =
    n.series.length === 1 && typeof n.series[0]?.metrics.count === 'number'
      ? ` · unique ${n.series[0]!.metrics.count}`
      : '';
  success(
    `Total ${total}${uniqueNote} across ${n.series.length} series, ${n.periods.length} period(s).`,
  );
}

/** Per-period wide rows: date + one column per series (used for CSV & table). */
function periodRows(n: Normalized): {
  rows: Array<Record<string, unknown>>;
  cols: string[];
} {
  const labels = n.series.map((s) => s.label);
  const rows = n.periods.map((date) => {
    const row: Record<string, unknown> = { date };
    for (const s of n.series) row[s.label] = s.byDate.get(date) ?? 0;
    return row;
  });
  return { rows, cols: ['date', ...labels] };
}

function renderCsv(n: Normalized): string {
  if (n.series.length === 0) return 'date\n';
  const { rows, cols } = periodRows(n);
  return toCsv(rows, cols);
}

function jsonObject(n: Normalized): unknown {
  return {
    meta: n.meta,
    series: n.series.map((s) => ({
      label: s.label,
      metrics: s.metrics,
      data: s.data.map((d) => ({
        date: d.date,
        value: d.count,
        ...(d.previous != null ? { previous: d.previous } : {}),
      })),
    })),
    summary: n.global,
  };
}

function jsonString(n: Normalized): string {
  return `${JSON.stringify(jsonObject(n), null, 2)}\n`;
}

function inferFileFormat(path: string): 'json' | 'csv' {
  const ext = extname(path).toLowerCase();
  if (ext === '.csv') return 'csv';
  if (ext === '.json') return 'json';
  return 'json';
}

function pct(cur: number, prev: number): string {
  if (!prev) return '—';
  const change = Math.round(((cur - prev) / prev) * 1000) / 10;
  return `${change > 0 ? '+' : ''}${change}%`;
}

/** Previous-period value from a PrevStat (number or { value, diff, state }). */
function prevValue(stat: PrevStat | undefined): number | undefined {
  if (typeof stat === 'number') return stat;
  if (stat && typeof stat.value === 'number') return stat.value;
  return undefined;
}

/** Signed percent change from a PrevStat when the server already computed it. */
function prevDiff(stat: PrevStat | undefined): number | undefined {
  if (stat && typeof stat === 'object' && typeof stat.diff === 'number') {
    return stat.state === 'negative' ? -Math.abs(stat.diff) : Math.abs(stat.diff);
  }
  return undefined;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TrpcError(`--limit must be a positive integer (got "${value}").`);
  }
  return n;
}

function emptyMetrics(): FinalChart['metrics'] {
  return { sum: 0, average: 0, min: 0, max: 0 };
}
