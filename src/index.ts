import { Command } from 'commander';
import { registerAuthCommands } from './commands/auth.js';
import { registerConfigCommands } from './commands/config.js';
import { registerProjectCommands } from './commands/projects.js';
import { registerDashboardCommands } from './commands/dashboards.js';
import { registerReportCommands } from './commands/reports.js';
import { registerDataCommand } from './commands/data.js';
import { registerRuleCommands } from './commands/rules.js';
import { registerReferenceCommands } from './commands/references.js';
import { TrpcError } from './trpc.js';
import { errorLine, isJsonMode, printJson, setJsonMode } from './output.js';

const VERSION = '0.3.0';

function buildProgram(): Command {
  const program = new Command();
  program
    .name('openpanel')
    .description(
      'CLI for OpenPanel — create and manage dashboards, reports, and notification rules.',
    )
    .version(VERSION, '-v, --version')
    .option('-j, --json', 'Output machine-readable JSON')
    .showHelpAfterError();

  registerAuthCommands(program);
  registerConfigCommands(program);
  registerProjectCommands(program);
  registerDashboardCommands(program);
  registerReportCommands(program);
  registerDataCommand(program);
  registerRuleCommands(program);
  registerReferenceCommands(program);

  program.addHelpText(
    'after',
    `
Examples:
  $ openpanel login --email you@example.com
  $ openpanel projects list
  $ openpanel dashboards create -P <projectId> -n "Growth"
  $ openpanel reports create -d <dashboardId> -n "Signups" -e signup -c bar -r 7d
  $ openpanel data -P <projectId> -e signup -r 7d -i day
  $ openpanel data -R <reportId> --format csv -o signups.csv
  $ openpanel rules create -P <projectId> -n "New signups" -e signup --app
  $ openpanel references create -P <projectId> -t "Deployed v2"
  $ openpanel --json projects list

Environment:
  OPENPANEL_INSTANCE   Base URL (default https://dashboard.openpanel.dev)
  OPENPANEL_SESSION    Session token (skip 'login', e.g. for CI)
  OPENPANEL_EMAIL      Email for non-interactive login
  OPENPANEL_PASSWORD   Password for non-interactive login
`,
  );

  return program;
}

/**
 * Pre-scan argv for the global --json/-j flag so it can appear anywhere
 * (before or after the subcommand) without commander rejecting it.
 */
function extractJsonFlag(argv: string[]): string[] {
  if (process.env.OPENPANEL_JSON === '1' || process.env.OPENPANEL_JSON === 'true') {
    setJsonMode(true);
  }
  const filtered: string[] = [];
  for (const arg of argv) {
    if (arg === '--json' || arg === '-j') {
      setJsonMode(true);
      continue;
    }
    filtered.push(arg);
  }
  return filtered;
}

async function main(): Promise<void> {
  const [node, script, ...rest] = process.argv;
  const argv = [node ?? 'node', script ?? 'openpanel', ...extractJsonFlag(rest)];

  const program = buildProgram();

  try {
    await program.parseAsync(argv);
  } catch (err) {
    handleError(err);
    process.exitCode = process.exitCode || 1;
  }
}

function handleError(err: unknown): void {
  if (err instanceof TrpcError) {
    if (isJsonMode()) {
      printJson({
        error: err.message,
        httpStatus: err.httpStatus ?? null,
        code: err.code ?? null,
        zodError: err.zodError ?? null,
      });
    } else {
      errorLine(err.message);
      if (err.isAuthError) {
        errorLine('→ Try `openpanel login` (or set OPENPANEL_SESSION).');
      } else if (err.isAccessError) {
        errorLine(
          '→ Check you have access to this project, or that you are logged into the right account (`openpanel whoami`).',
        );
      } else if (err.isNotFound) {
        errorLine('→ Run the matching `list` command to find valid ids.');
      }
      if (err.zodError) {
        errorLine(`Validation details: ${JSON.stringify(err.zodError)}`);
      }
    }
    return;
  }

  const message = err instanceof Error ? err.message : String(err);
  if (isJsonMode()) {
    printJson({ error: message });
  } else {
    errorLine(message);
  }
}

void main();
