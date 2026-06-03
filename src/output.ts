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
