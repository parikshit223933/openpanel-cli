/**
 * Zod schemas vendored from OpenPanel's `@openpanel/validation` and
 * `@openpanel/constants` packages (which are workspace-internal and not
 * published to npm). Kept faithful to the server so the CLI can validate
 * input locally before sending it, surfacing clear errors instead of opaque
 * 400s. If OpenPanel changes these, update here to match.
 */
import { z } from 'zod';

// ── Enum value sets (from @openpanel/constants) ──
export const chartTypes = [
  'linear',
  'bar',
  'histogram',
  'pie',
  'metric',
  'area',
  'map',
  'funnel',
  'retention',
  'conversion',
  'sankey',
] as const;

export const chartSegments = [
  'event',
  'user',
  'session',
  'group',
  'user_average',
  'one_event_per_user',
  'property_sum',
  'property_average',
  'property_max',
  'property_min',
] as const;

export const lineTypes = [
  'monotone',
  'monotoneX',
  'monotoneY',
  'linear',
  'natural',
  'basis',
  'step',
  'stepBefore',
  'stepAfter',
  'basisClosed',
  'basisOpen',
  'bumpX',
  'bumpY',
  'bump',
  'linearClosed',
] as const;

export const intervals = ['minute', 'hour', 'day', 'week', 'month'] as const;

export const metrics = ['count', 'sum', 'average', 'min', 'max'] as const;

export const timeWindows = [
  '30min',
  'lastHour',
  'last24h',
  'today',
  'yesterday',
  '7d',
  '30d',
  '3m',
  '6m',
  '12m',
  'monthToDate',
  'lastMonth',
  'yearToDate',
  'lastYear',
  'custom',
] as const;

export const operators = [
  'is',
  'isNot',
  'contains',
  'doesNotContain',
  'startsWith',
  'endsWith',
  'regex',
  'isNull',
  'isNotNull',
  'gt',
  'lt',
  'gte',
  'lte',
  'inCohort',
  'notInCohort',
] as const;

// Base integration IDs (from @openpanel/db notification.service).
export const APP_NOTIFICATION_INTEGRATION_ID = 'app';
export const EMAIL_NOTIFICATION_INTEGRATION_ID = 'email';

export const zChartType = z.enum(chartTypes);
export const zSegment = z.enum(chartSegments);
export const zLineType = z.enum(lineTypes);
export const zTimeInterval = z.enum(intervals);
export const zMetric = z.enum(metrics);
export const zRange = z.enum(timeWindows);
export const zOperator = z.enum(operators);

// ── Chart building blocks ──
export const zChartEventFilter = z.object({
  id: z.string().optional(),
  name: z.string(),
  operator: zOperator,
  value: z.array(z.string().or(z.number()).or(z.boolean()).or(z.null())),
  cohortId: z.string().optional(),
  cohortIds: z.array(z.string()).optional(),
});

export const zChartEvent = z.object({
  id: z.string().optional(),
  name: z.string(),
  displayName: z.string().optional(),
  property: z.string().optional(),
  segment: zSegment.default('event'),
  filters: z.array(zChartEventFilter).default([]),
});

export const zChartFormula = z.object({
  id: z.string().optional(),
  type: z.literal('formula'),
  formula: z.string(),
  displayName: z.string().optional(),
  hideSeries: z.array(z.string()).optional(),
});

export const zChartEventWithType = zChartEvent.extend({
  type: z.literal('event'),
});

export const zChartEventItem = z.discriminatedUnion('type', [
  zChartEventWithType,
  zChartFormula,
]);

export const zChartBreakdown = z.object({
  id: z.string().optional(),
  name: z.string(),
});

/**
 * Report payload for `report.create` / `report.update`. Mirrors
 * `zReport.omit({ projectId: true })` — the server derives projectId from the
 * parent dashboard. `options` is left permissive (funnel/retention/sankey
 * specifics) since the server validates it strictly anyway.
 */
export const zReportForCreate = z.object({
  name: z.string().default('Untitled'),
  chartType: zChartType.default('linear'),
  interval: zTimeInterval.default('day'),
  series: z.array(zChartEventItem),
  breakdowns: z.array(zChartBreakdown).default([]),
  range: zRange.default('7d'),
  startDate: z.string().nullish(),
  endDate: z.string().nullish(),
  previous: z.boolean().default(false),
  formula: z.string().optional(),
  metric: zMetric.default('sum'),
  limit: z.number().optional(),
  offset: z.number().optional(),
  visibleSeries: z.array(z.string()).nullish(),
  options: z.any().optional(),
  lineType: zLineType.default('monotone'),
  unit: z.string().optional(),
});

export type ReportForCreate = z.infer<typeof zReportForCreate>;
export type ReportForCreateInput = z.input<typeof zReportForCreate>;

/**
 * Input for the read-only `chart.chart` / `chart.aggregate` query procedures —
 * mirrors OpenPanel's `zChartInput` (alias of `zReportInput`). It is the report
 * shape plus an explicit `projectId` (the chart endpoints take it directly,
 * rather than deriving it from a parent dashboard) and `globalFilters`
 * (filters applied across every series). Used by the `data` command.
 */
export const zChartDataInput = zReportForCreate.extend({
  projectId: z.string(),
  globalFilters: z.array(zChartEventFilter).default([]),
});

export type ChartDataInput = z.infer<typeof zChartDataInput>;
export type ChartDataInputInput = z.input<typeof zChartDataInput>;

// ── Notification rules ──
export const zNotificationRuleEventConfig = z.object({
  type: z.literal('events'),
  events: z.array(zChartEvent),
});

export const zNotificationRuleFunnelConfig = z.object({
  type: z.literal('funnel'),
  events: z.array(zChartEvent).min(1),
});

export const zNotificationRuleConfig = z.discriminatedUnion('type', [
  zNotificationRuleEventConfig,
  zNotificationRuleFunnelConfig,
]);

export const zCreateNotificationRule = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  template: z.string().optional(),
  config: zNotificationRuleConfig,
  integrations: z.array(z.string()),
  sendToApp: z.boolean(),
  sendToEmail: z.boolean(),
  projectId: z.string(),
});

export type CreateNotificationRule = z.infer<typeof zCreateNotificationRule>;
export type CreateNotificationRuleInput = z.input<
  typeof zCreateNotificationRule
>;

// ── References (chart annotation markers) ──
export const zCreateReference = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  projectId: z.string(),
  datetime: z.string(),
});

export type CreateReference = z.infer<typeof zCreateReference>;
export type CreateReferenceInput = z.input<typeof zCreateReference>;

// ── Auth ──
export const zSignInEmail = z.object({
  email: z.string().email().min(1),
  password: z.string().min(8),
});
