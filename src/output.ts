import pc from 'picocolors';

let jsonMode = false;

export function setJsonMode(value: boolean): void {
  jsonMode = value;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export const c = pc;

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Render structured data. In --json mode, prints JSON. Otherwise calls the
 * human renderer.
 */
export function render(data: unknown, human: () => void): void {
  if (jsonMode) {
    printJson(data);
  } else {
    human();
  }
}

export function success(msg: string): void {
  if (jsonMode) return;
  process.stdout.write(`${pc.green('✓')} ${msg}\n`);
}

export function info(msg: string): void {
  if (jsonMode) return;
  process.stdout.write(`${pc.cyan('ℹ')} ${msg}\n`);
}

export function warn(msg: string): void {
  if (jsonMode) return;
  process.stderr.write(`${pc.yellow('⚠')} ${msg}\n`);
}

export function errorLine(msg: string): void {
  process.stderr.write(`${pc.red('✗')} ${msg}\n`);
}

/** Print a simple aligned table from an array of row objects. */
export function table(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): void {
  if (rows.length === 0) {
    process.stdout.write(pc.dim('(none)\n'));
    return;
  }
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const widths = cols.map((col) =>
    Math.max(
      col.length,
      ...rows.map((r) => formatCell(r[col]).length),
    ),
  );

  const header = cols
    .map((col, i) => pc.bold(col.padEnd(widths[i] ?? col.length)))
    .join('  ');
  process.stdout.write(`${header}\n`);
  process.stdout.write(
    pc.dim(cols.map((_, i) => '─'.repeat(widths[i] ?? 1)).join('  ')) + '\n',
  );

  for (const r of rows) {
    const line = cols
      .map((col, i) => formatCell(r[col]).padEnd(widths[i] ?? 0))
      .join('  ');
    process.stdout.write(`${line}\n`);
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Serialize rows to RFC-4180 CSV (quotes fields containing , " or newlines). */
export function toCsv(
  rows: Array<Record<string, unknown>>,
  columns?: string[],
): string {
  const cols = columns ?? (rows[0] ? Object.keys(rows[0]) : []);
  const escape = (value: unknown): string => {
    const s = formatCell(value);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // Escape the header too — column names can be breakdown values (e.g. page
  // titles) that contain commas/quotes/newlines.
  const lines = [cols.map(escape).join(',')];
  for (const r of rows) {
    lines.push(cols.map((col) => escape(r[col])).join(','));
  }
  return lines.join('\n') + '\n';
}
