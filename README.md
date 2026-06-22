# openpanel-cli

A command-line tool to **create, manage, and pull data from [OpenPanel](https://openpanel.dev) dashboards, reports, references, and notification rules** — the analytics actions the public OpenPanel API and the OpenPanel MCP server can't do.

```bash
openpanel login --email you@example.com
openpanel projects list
openpanel dashboards create -P <projectId> -n "Growth"
openpanel reports create -d <dashboardId> -n "Signups" -e signup -c bar   # 7-day window by default
openpanel data -P <projectId> -e signup -r 7d -i day                     # pull the actual numbers
openpanel references create -P <projectId> -t "Launched v2"
openpanel rules create -P <projectId> -n "New signup" -e signup --app
```

---

## Why this exists (and how it works)

OpenPanel has **two** APIs:

| API | Auth | Can it create dashboards/reports/rules? |
|-----|------|------------------------------------------|
| Public REST (`/track`, `/export/*`) — used by the SDKs & the OpenPanel MCP | client id/secret | ❌ No — these endpoints only ingest events and export data |
| Internal **tRPC** API (`/api/trpc/*`) — powers the dashboard UI | **user session cookie** | ✅ Yes |

Creating dashboards, reports, and notification rules requires the **internal tRPC API**, and those procedures (`dashboard.create`, `report.create`, `notification.createOrUpdateRule`) are `protectedProcedure`s that need a logged-in **user** (`session.userId`) — a client id/secret is not enough.

So this CLI:
1. **Logs in as a user** (`auth.signInEmail`, with TOTP support) and stores the resulting `session` cookie, **or** accepts a `session` cookie you paste from your browser.
2. Talks to the tRPC API at `<instance>/api/trpc/<router>.<procedure>` using the same **superjson** wire format the dashboard uses.

Default instance: `https://dashboard.openpanel.dev` (OpenPanel Cloud). Point it at your own (self-hosted) instance with `OPENPANEL_INSTANCE` or `openpanel config set-instance <url>`.

---

## Scope — analytics only (by design)

This CLI builds **analytics artifacts**: dashboards, reports (charts / metrics), references (chart annotations), and notification rules. That's the whole job.

It intentionally has **no admin or settings functionality**. Project settings, organization & member management, integration setup, API clients, billing, and instance configuration belong in the OpenPanel **dashboard**, not here. The only state the CLI keeps locally is which instance to talk to and your session.

This keeps it safe to hand to a product/analytics team — or an AI agent — to create and manage dashboards, without exposing anything that changes how the instance is configured.

> **Reports default to a 7-day window** to limit load on ClickHouse. Pass `-r 30d` (etc.) only when you need a wider range; viewers can always widen it in the UI.

See [`CLAUDE.md`](./CLAUDE.md) for agent guidance and [`docs/COMMANDS.md`](./docs/COMMANDS.md) for the full command reference.

---

## Install

Requires **Node.js ≥ 18.17** (Node 20+ recommended).

```bash
# from this directory
npm install
npm run build

# option A: run directly
node dist/index.js --help

# option B: install the `openpanel` command globally (symlink)
npm link
openpanel --help
```

---

## Authentication

### Email + password (default)

```bash
openpanel login --email you@example.com
# prompts for password (hidden); prompts for a 2FA code if your account has TOTP enabled
```

You can pass `--password` (not recommended — it lands in shell history) or set env vars for non-interactive use:

```bash
OPENPANEL_EMAIL=you@example.com OPENPANEL_PASSWORD=… openpanel login
```

### Google / GitHub SSO accounts → paste a session cookie

If your OpenPanel account signs in via SSO (no password), grab the `session` cookie from your browser:

1. Open your OpenPanel instance while logged in.
2. DevTools → **Application** → **Cookies** → copy the value of the `session` cookie.
3. ```bash
   openpanel login --cookie "<paste-session-value>"
   ```

### CI / scripting

Set `OPENPANEL_SESSION` to a valid session token and skip `login` entirely:

```bash
OPENPANEL_SESSION=<token> openpanel projects list
```

### Other auth commands

```bash
openpanel whoami     # show the current user
openpanel logout     # invalidate the session and clear local credentials
```

Credentials are stored in `~/.config/openpanel-cli/config.json` (file mode `600`).

---

## Usage

> Add `--json` (anywhere) to any command for machine-readable output — great for piping into `jq` or scripts.

### Find your project IDs

```bash
openpanel projects list
```

```
organization     project          projectId
───────────────  ───────────────  ─────────────────
Acme             Web              proj_abc123
Acme             Mobile           proj_def456
```

### Dashboards

```bash
openpanel dashboards list   -P <projectId>
openpanel dashboards create -P <projectId> -n "Growth"
openpanel dashboards delete -i <dashboardId> [--force] [--yes]
```

`--force` also deletes the reports inside the dashboard. `--yes` skips the confirmation prompt.

### Reports (chart tiles inside a dashboard)

Quick, flag-based:

```bash
# Bar chart of signups over the last 7 days
openpanel reports create -d <dashboardId> -n "Signups" -e signup -c bar -r 7d

# Unique users per week, broken down by country
openpanel reports create -d <dashboardId> -n "WAU by country" \
  -e session_start -s user -i week -b country

# Place it on the dashboard grid (x,y,w,h)
openpanel reports create -d <dashboardId> -n "Signups" -e signup --layout 0,0,6,3
```

Full control via a JSON spec (see [`examples/`](./examples)):

```bash
openpanel reports create -d <dashboardId> --file examples/report.example.json
```

```bash
openpanel reports list   -d <dashboardId> -P <projectId>
openpanel reports delete -i <reportId> [--yes]
```

**Report flags**

| Flag | Meaning | Default |
|------|---------|---------|
| `-n, --name` | Report name | (required) |
| `-e, --event` | Event to chart (repeatable) | (required) |
| `-s, --segment` | `event`, `user`, `session`, `property_sum`, … | `event` |
| `-c, --chart-type` | `linear`, `bar`, `histogram`, `pie`, `metric`, `area`, `map`, `funnel`, … | `linear` |
| `-i, --interval` | `minute`, `hour`, `day`, `week`, `month` | `day` |
| `-r, --range` | `7d`, `30d`, `today`, `lastMonth`, … | **`7d`** (keeps ClickHouse load low) |
| `-b, --breakdown` | Breakdown property (repeatable) | — |
| `-m, --metric` | `count`, `sum`, `average`, `min`, `max` | `sum` |
| `--unit` | Y-axis unit label | — |
| `--previous` | Add previous-period comparison | off |
| `--layout` | Grid placement `x,y,w,h` | — |
| `-f, --file` | JSON report spec (overrides the flags) | — |

### Data (pull the actual numbers)

Get the numbers, not just build the chart — as a table, JSON, or CSV. Read-only.

```bash
# Ad-hoc: one event over a date range, grouped by day
openpanel data -P <projectId> -e screen_view -r 7d -i day

# Filter + breakdown (one row per breakdown value)
openpanel data -P <projectId> -e screen_view -r 30d -i week --filter "device is mobile" -b country

# A saved report's current numbers, saved to CSV
openpanel data -R <reportId> -o report.csv

# Discover events / properties to query
openpanel data -P <projectId> --list-events
```

The default output is a table of the value per period plus a per-series summary
(`total`, `average`, `min`, `max`, and `unique` for non-additive counts). Add
`--json` or `--format csv` (or `-o file.json` / `-o file.csv`) for machine
formats — they hold the same numbers.

`data` calls OpenPanel's internal `chart.chart` query — the same one the
dashboard tile uses — so the totals match what you see in the browser. Funnel /
retention / conversion / sankey reports aren't covered (view those in the
dashboard). See [`docs/COMMANDS.md`](./docs/COMMANDS.md#data-pull-the-actual-numbers)
for the full flag list and filter syntax.

### References (chart annotations)

Markers overlaid on time-series charts — e.g. "Deployed v2", "Campaign launched".

```bash
openpanel references create -P <projectId> -t "Deployed v2" [--description "..."] [--date 2026-06-01]
openpanel references list   -P <projectId>
openpanel references delete -i <referenceId> [--yes]
```

`--date` accepts an ISO date/time and defaults to now.

### Notification rules

```bash
# Notify the in-app inbox whenever a "signup" event fires
openpanel rules create -P <projectId> -n "New signup" -e signup --app

# Email + Slack on purchase (slack-integration-id is an existing integration's ID)
openpanel rules create -P <projectId> -n "Purchase" -e purchase \
  --email --integration <slack-integration-id>

# Funnel-type rule from a file
openpanel rules create -P <projectId> --file examples/rule.example.json

openpanel rules list   -P <projectId>
openpanel rules delete -i <ruleId> [--yes]

# Update an existing rule
openpanel rules create -P <projectId> --id <ruleId> -n "Renamed" -e signup --app
```

**Rule flags**

| Flag | Meaning | Default |
|------|---------|---------|
| `-n, --name` | Rule name | (required) |
| `-t, --type` | `events` or `funnel` | `events` |
| `-e, --event` | Triggering event (repeatable) | (required) |
| `--app` | Deliver to the in-app inbox | — |
| `--email` | Deliver by email | — |
| `--integration` | Extra integration ID, e.g. Slack/Discord/webhook (repeatable) | — |
| `--template` | Custom message template | — |
| `--id` | Update an existing rule instead of creating | — |
| `-f, --file` | JSON rule spec (overrides the flags) | — |

> If you don't specify any delivery channel, the rule defaults to in-app (`--app`).

---

## Configuration

```bash
openpanel config show                     # show instance, login status, config path
openpanel config set-instance <url>       # point at a different OpenPanel instance
```

| Env var | Purpose |
|---------|---------|
| `OPENPANEL_INSTANCE` | Base URL (default `https://dashboard.openpanel.dev`) |
| `OPENPANEL_TRPC_URL` | Override the full tRPC base URL (advanced) |
| `OPENPANEL_SESSION` | Use a session token directly (skip `login`) |
| `OPENPANEL_EMAIL` / `OPENPANEL_PASSWORD` | Non-interactive login |
| `OPENPANEL_JSON=1` | Force JSON output |

---

## Troubleshooting

- **`Not authenticated` / 401** — your session expired or is invalid. Run `openpanel login` again (or refresh `OPENPANEL_SESSION`).
- **`Too many sign-in attempts`** — the server rate-limits logins (3 per 30s). Wait and retry.
- **`Reset your password, old password has expired`** — your account predates the current password system; reset it from the OpenPanel UI, then `login`.
- **Self-hosted / different host** — set `OPENPANEL_INSTANCE` (or `openpanel config set-instance`). If the API lives on a non-standard path, set `OPENPANEL_TRPC_URL`.

---

## Development

```bash
npm run dev        # rebuild on change (tsup --watch)
npm run typecheck  # tsc --noEmit
npm run build      # bundle to dist/index.js
```

Source layout:

```
src/
  index.ts            # CLI entrypoint, command wiring, global --json + error handling
  config.ts           # credential/instance store (~/.config/openpanel-cli)
  trpc.ts             # minimal tRPC client (superjson, cookie auth, error mapping)
  schemas.ts          # Zod schemas vendored from @openpanel/validation
  guards.ts           # requireAuth()
  output.ts           # tables / JSON / colored status lines
  commands/           # auth, config, projects, dashboards, reports, rules
```

The Zod schemas in `src/schemas.ts` are vendored copies of OpenPanel's internal
`@openpanel/validation` + `@openpanel/constants`. If OpenPanel changes its report
or notification-rule shapes, update that file to match.

## License

MIT
