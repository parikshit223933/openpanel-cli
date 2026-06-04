# CLAUDE.md — OpenPanel CLI

Guidance for AI agents (and humans) using or contributing to this CLI.

## What this is

`openpanel` is a CLI for **building and managing OpenPanel analytics artifacts** —
dashboards, reports (charts / metrics), references (chart annotations), and
notification rules — by driving OpenPanel's internal API with a logged-in user
session.

The goal: let a product/analytics team install the CLI and have an agent create
dashboards and reports for them from natural-language requests.

## Scope & design principle (important)

This CLI is intentionally **analytics-only**. It exists to create and manage:

- **Dashboards**
- **Reports** — chart tiles / metrics
- **References** — annotation markers on time-series charts
- **Notification rules** — event / funnel alerts

It deliberately does **NOT** provide admin or settings functionality. Project
settings, organization & member management, integration setup, API clients,
billing, and instance configuration are **out of scope by design** — do those in
the OpenPanel dashboard UI. **Do not add admin/settings commands to this CLI.**

(The only state the CLI stores locally is which instance URL to talk to and your
session token — never OpenPanel-side settings.)

## Auth

Creating/managing these artifacts requires a **user session** — a project
client id/secret is NOT sufficient (those can only ingest events / read exports).

- `openpanel login --email you@example.com` — prompts for password; supports 2FA.
- Or paste a browser `session` cookie: `openpanel login --cookie "<value>"`.
- `openpanel whoami` to check. Session is stored in `~/.config/openpanel-cli/config.json`.
- CI / non-interactive: set `OPENPANEL_SESSION`.

Never ask the user for their password or type it for them — have them run `login`.

## Instance

Default is OpenPanel Cloud. Point at your own instance with
`OPENPANEL_INSTANCE=<url>` or `openpanel config set-instance <url>`.

## Conventions for agents

1. **Check auth first** (`openpanel whoami`); if not logged in, ask the human to
   run `openpanel login`.
2. **Find ids before acting** — use `projects list`, `dashboards list`, etc.
   Never guess ids.
3. **Default to a 7-day range.** Reports default to `range=7d` to limit load on
   ClickHouse. Use longer ranges (`30d`, `3m`, …) only when explicitly asked.
4. **A report lives inside a dashboard** — create or find the dashboard first,
   then add reports using its `dashboardId`.
5. **Don't invent event names** — discover real ones (ask the user, or inspect
   existing reports via `openpanel --json reports list -d <id> -P <id>`).
6. **Use `--json`** to parse ids and chain steps reliably.
7. **Confirm before deletes** — deletes are destructive.

## Core workflow: dashboard + charts

```bash
openpanel whoami
openpanel --json projects list                          # → projectId
openpanel --json dashboards create -P <pid> -n "Growth"  # → dashboardId
openpanel reports create -d <did> -n "Signups" -e signup -c bar   # 7d by default
```

## Command map

| Command | Purpose |
|---------|---------|
| `login` / `logout` / `whoami` | Authentication |
| `config show` / `config set-instance <url>` | CLI-local config only (which instance) |
| `projects list` | Read-only discovery of org/projects + ids |
| `dashboards list \| create \| delete` | Dashboards |
| `reports list \| create \| delete` | Reports — flags or `--file <spec.json>` |
| `references list \| create \| delete` | Chart annotation markers |
| `rules list \| create \| delete` | Notification rules |

See `docs/COMMANDS.md` for the full reference and `README.md` for an overview.

## Developing this repo

- TypeScript, bundled with `tsup` → `dist/index.js`. `npm run build`,
  `npm run typecheck`.
- The Zod schemas in `src/schemas.ts` are **vendored** from OpenPanel's internal
  `@openpanel/validation` / `@openpanel/constants` packages (not published to
  npm). If OpenPanel changes its report / rule / reference shapes, update that
  file to match.
- The tRPC client (`src/trpc.ts`) speaks superjson over `<instance>/api/trpc`,
  authenticating with the `session` cookie.
- **Keep the analytics-only scope** — do not add admin/settings commands.
