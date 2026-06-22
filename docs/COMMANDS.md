# OpenPanel CLI — Command Reference

Full reference for every command. For an overview and install instructions see
the [README](../README.md); for agent guidance see [CLAUDE.md](../CLAUDE.md).

> **Scope:** this CLI manages **analytics artifacts only** — dashboards, reports,
> references, and notification rules. Admin/settings (projects, members,
> integrations, billing, instance config) are intentionally **not** supported;
> use the OpenPanel dashboard for those.

Global flags:

| Flag | Effect |
|------|--------|
| `--json`, `-j` | Machine-readable JSON output (works anywhere on the line) |
| `--version`, `-v` | Print version |
| `--help`, `-h` | Help for any command |

Environment:

| Var | Purpose |
|-----|---------|
| `OPENPANEL_INSTANCE` | Base URL (default `https://dashboard.openpanel.dev`) |
| `OPENPANEL_TRPC_URL` | Override the full tRPC base URL (advanced) |
| `OPENPANEL_SESSION` | Session token (skip `login`, e.g. CI) |
| `OPENPANEL_EMAIL` / `OPENPANEL_PASSWORD` | Non-interactive login |
| `OPENPANEL_JSON=1` | Force JSON output |

---

## Authentication

```bash
openpanel login [--email <e>] [--password <p>] [--cookie <session>] [--instance <url>]
openpanel logout
openpanel whoami
```

- **Email + password:** `openpanel login --email you@example.com` (prompts for
  password; asks for a 2FA code if enabled).
- **Session cookie (SSO-friendly):** log into OpenPanel in your browser, copy the
  `session` cookie from DevTools, then `openpanel login --cookie "<value>"`.
- Credentials are stored in `~/.config/openpanel-cli/config.json` (mode `600`).

A **user session** is required for everything below — a project client id/secret
cannot create dashboards/reports/rules/references.

---

## Config (CLI-local only)

```bash
openpanel config show                # instance, login status, config path
openpanel config set-instance <url>  # persist which OpenPanel instance to use
```

This is the CLI's own configuration (which instance, your session). It does **not**
change any OpenPanel-side settings.

---

## Projects (read-only discovery)

```bash
openpanel projects list            # organizations + projects (+ projectId)
openpanel --json projects list     # parse to grab a projectId
```

Used to discover the `projectId` that other commands need. The CLI does not
create, edit, or delete projects (that's an admin action — use the dashboard).

---

## Dashboards

```bash
openpanel dashboards list   -P <projectId>
openpanel dashboards create -P <projectId> -n "Growth"
openpanel dashboards delete -i <dashboardId> [--force] [--yes]
```

| Flag | Meaning |
|------|---------|
| `-P, --project` | Project ID (required) |
| `-n, --name` | Dashboard name (create) |
| `-i, --id` | Dashboard ID (delete) |
| `-f, --force` | Also delete the dashboard's reports |
| `-y, --yes` | Skip the confirmation prompt |

---

## Reports (chart tiles inside a dashboard)

```bash
# Flag-based
openpanel reports create -d <dashboardId> -n "Signups" -e signup -c bar
openpanel reports create -d <dashboardId> -n "WAU by country" -e session_start -s user -i week -b country

# Full control from a JSON spec
openpanel reports create -d <dashboardId> --file report.json

openpanel reports list   -d <dashboardId> -P <projectId>
openpanel reports delete -i <reportId> [--yes]
```

| Flag | Meaning | Default |
|------|---------|---------|
| `-d, --dashboard` | Dashboard ID (required) | — |
| `-n, --name` | Report name | — |
| `-e, --event` | Event to chart (repeatable) | — |
| `-s, --segment` | Aggregation segment | `event` |
| `-c, --chart-type` | Chart type | `linear` |
| `-i, --interval` | Time bucket | `day` |
| `-r, --range` | Time range | **`7d`** |
| `-b, --breakdown` | Breakdown property (repeatable) | — |
| `-m, --metric` | Metric | `sum` |
| `--unit` | Y-axis unit label | — |
| `--previous` | Add previous-period comparison | off |
| `--layout` | Grid placement `x,y,w,h` | — |
| `-f, --file` | JSON report spec (overrides flags) | — |

> **Default range is 7 days.** Longer ranges put significantly more load on
> ClickHouse — pass `-r 30d` (etc.) only when you actually need a wider window.
> A dashboard viewer can always widen the range in the UI afterward.

### Report JSON spec

```json
{
  "name": "Screen views from the US",
  "chartType": "linear",
  "interval": "day",
  "range": "7d",
  "metric": "count",
  "series": [
    {
      "type": "event",
      "name": "screen_view",
      "segment": "event",
      "filters": [{ "name": "country", "operator": "is", "value": ["US"] }]
    }
  ],
  "breakdowns": [{ "name": "country" }]
}
```

A **funnel** is a `chartType: "funnel"` with ordered `series` and
`"options": { "type": "funnel" }`. A **formula** series uses
`{ "type": "formula", "formula": "A/B" }` alongside event series.

---

## Data (pull the actual numbers)

Return the numbers — not just build a chart. `data` runs an **ad-hoc query** or
reads a **saved report** and prints the results as a table, JSON, or CSV. It is
**read-only**: it never creates or changes anything.

```bash
# Ad-hoc: one event over a date range, grouped by day
openpanel data -P <projectId> -e screen_view -r 7d -i day

# With a filter and a breakdown (one row per breakdown value)
openpanel data -P <projectId> -e screen_view -r 30d -i week \
  --filter "device is mobile" -b country

# A saved report's current numbers
openpanel data -R <reportId>

# Save to a file (format inferred from the extension) — or force it with --format
openpanel data -P <projectId> -e signup -r 30d -o signups.csv
openpanel data -R <reportId> --format json -o report.json

# Discover what you can query
openpanel data -P <projectId> --list-events
openpanel data -P <projectId> -e screen_view --list-properties
```

| Flag | Meaning | Default |
|------|---------|---------|
| `-P, --project` | Project ID (required for an ad-hoc query) | — |
| `-R, --report` | Pull a saved report by ID (instead of an ad-hoc query) | — |
| `-e, --event` | Event to query (repeatable) | — |
| `-s, --segment` | Aggregation segment (`event`, `user`, `session`, …) | `event` |
| `-i, --interval` | Time grouping (`minute`…`month`; **`day` or `week`** typically) | `day` |
| `-r, --range` | Range (`7d`, `30d`, `today`, …) | **`7d`** |
| `--start` / `--end` | Custom date range (ISO); overrides `--range` | — |
| `-b, --breakdown` | Breakdown property (repeatable) | — |
| `--limit` | Cap how many series are returned (top N by total) | — |
| `-m, --metric` | Metric (`count`, `sum`, `average`, `min`, `max`) | `sum` |
| `-c, --chart-type` | Chart type (`linear`, `bar`, `metric`, `area`, …) | `linear` |
| `--filter` | Filter `"<property> <operator> [v1,v2]"` (repeatable) | — |
| `--previous` | Include previous-period comparison | off |
| `--format` | Output: `table`, `json`, or `csv` | `table` |
| `-o, --out` | Write to a file (format inferred from `.json`/`.csv`) | — |
| `--summary-only` | Print only the per-series summary (skip per-period rows) | off |
| `--list-events` | List the project's events and exit | — |
| `--list-properties` | List filter/breakdown properties (for `-e`) and exit | — |

**Output.** The default table shows the value per time period (one column per
series), then a **summary with one row per series** (`total`, `average`, `min`,
`max`, plus `unique` for non-additive counts and `prev`/`change` with
`--previous`). `--json` and `--csv`/`-o` hold the same numbers in machine form.

**Filters.** `--filter "country is IN"`, `--filter "path contains /pricing"`,
`--filter "revenue gte 100"`, `--filter "city isNull"`. Multiple values:
`--filter "country is IN,US"`. Repeat `--filter` to AND several conditions.
Operators are listed under [Enum reference](#enum-reference). A bare property
name like `country` or a custom `properties.foo` both work — the CLI resolves it
and warns (without failing) on an unknown name.

**Numbers match the dashboard.** `data` calls OpenPanel's internal `chart.chart`
query — the *same* procedure the dashboard tile uses to render — so the totals
equal what you see in the browser (subject to the dashboard's 60-second cache and
live data still streaming in for "today").

> **Not supported:** `funnel`, `retention`, `conversion`, and `sankey` reports —
> `data` covers time-series and aggregate charts (event counts, breakdowns).
> View those chart types in the OpenPanel dashboard. (A saved report of one of
> these types returns a clear message rather than wrong numbers.)

> **Default range is 7 days** to limit ClickHouse load — pass `-r 30d` (etc.)
> only when you need a wider window.

---

## References (chart annotation markers)

Markers (a title at a point in time) overlaid on time-series charts — e.g.
"Deployed v2", "Campaign launched".

```bash
openpanel references create -P <projectId> -t "Deployed v2" [--description "..."] [--date 2026-06-01]
openpanel references list   -P <projectId>
openpanel references delete -i <referenceId> [--yes]
```

| Flag | Meaning | Default |
|------|---------|---------|
| `-P, --project` | Project ID (required) | — |
| `-t, --title` | Marker title | — |
| `--description` | Optional longer description | — |
| `--date` | When the marker sits (ISO date/time) | now |
| `-i, --id` | Reference ID (delete) | — |
| `-y, --yes` | Skip confirmation (delete) | — |

---

## Notification rules

Trigger an alert when an event fires (or a funnel completes), delivered in-app,
by email, or via an existing integration (Slack/Discord/webhook).

```bash
openpanel rules create -P <projectId> -n "New signup" -e signup --app
openpanel rules create -P <projectId> -n "Purchase" -e purchase --email --integration <integrationId>
openpanel rules create -P <projectId> --file rule.json
openpanel rules create -P <projectId> --id <ruleId> -n "Renamed" -e signup --app   # update
openpanel rules list   -P <projectId>
openpanel rules delete -i <ruleId> [--yes]
```

| Flag | Meaning | Default |
|------|---------|---------|
| `-P, --project` | Project ID (required) | — |
| `-n, --name` | Rule name | — |
| `-t, --type` | `events` or `funnel` | `events` |
| `-e, --event` | Triggering event (repeatable) | — |
| `--app` | Deliver to the in-app inbox | — |
| `--email` | Deliver by email | — |
| `--integration` | Existing integration ID (repeatable) | — |
| `--template` | Custom message template | — |
| `--id` | Update an existing rule instead of creating | — |
| `-f, --file` | JSON rule spec (overrides flags) | — |

> Integrations themselves (Slack/Discord/webhook connections) are configured in
> the OpenPanel dashboard — the CLI only references existing integration IDs.

### Rule JSON spec

```json
{
  "name": "Purchase completed",
  "config": {
    "type": "events",
    "events": [{ "name": "purchase", "segment": "event", "filters": [] }]
  },
  "integrations": ["app", "email"],
  "sendToApp": true,
  "sendToEmail": true
}
```

---

## Enum reference

- **chartType:** `linear` `bar` `histogram` `pie` `metric` `area` `map` `funnel` `retention` `conversion` `sankey`
- **interval:** `minute` `hour` `day` `week` `month`
- **range:** `30min` `lastHour` `last24h` `today` `yesterday` `7d` `30d` `3m` `6m` `12m` `monthToDate` `lastMonth` `yearToDate` `lastYear` `custom`
- **metric:** `count` `sum` `average` `min` `max`
- **segment:** `event` `user` `session` `group` `user_average` `one_event_per_user` `property_sum` `property_average` `property_max` `property_min`
- **filter operator:** `is` `isNot` `contains` `doesNotContain` `startsWith` `endsWith` `regex` `isNull` `isNotNull` `gt` `lt` `gte` `lte` `inCohort` `notInCohort`

For `range: "custom"`, also set `startDate` / `endDate` (ISO dates) in a `--file` spec.

---

## Exit codes & errors

- Non-zero exit on any failure; `--json` emits `{ "error": "...", "httpStatus", "code" }`.
- Common cases: not logged in → run `openpanel login`; "no access" → check project
  access / account; "not found" → run the matching `list` to find valid ids.
