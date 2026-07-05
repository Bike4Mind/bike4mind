# Daily Analytics Report Script (Local Testing)

## Prerequisites

- Node.js v20 or later
- MongoDB running locally with replica set
- pnpm installed (`npm install -g pnpm`)

## Setup Steps

### Install project dependencies

From the root of the repository (lumina5):

```bash
pnpm install
```

### Configure environment variables

Make sure you have a `.env` file in the lumina5 directory with these variables:

```env
MONGODB_URI=mongodb://localhost:27017/groktool?replicaSet=rs0&directConnection=true
STAGE=development
DEBUG=true  # For local testing
APP_NAME=Bike4Mind  # Your application name
NEXT_PUBLIC_APP_NAME=Bike4Mind  # For client-side usage
```

## Running the Script

### Generate and Preview Report

From the lumina5 directory:

```bash
# Make sure you're in the lumina5 directory
cd path/to/lumina5

# Run the script in debug mode for today's report (shows only formatted message)
DEBUG=true npx tsx b4m-core/packages/core/scripts/generateUserReport.ts

# Run with verbose mode to see raw data and API responses
DEBUG=true npx tsx b4m-core/packages/core/scripts/generateUserReport.ts --verbose

# Run the script for a specific date
DEBUG=true npx tsx b4m-core/packages/core/scripts/generateUserReport.ts --date="2024-12-12"

# Run the script for a date range
DEBUG=true npx tsx b4m-core/packages/core/scripts/generateUserReport.ts --startDate="2024-12-01" --endDate="2024-12-12"

# Run the script for last N days
DEBUG=true npx tsx b4m-core/packages/core/scripts/generateUserReport.ts --days=7  # Last 7 days
```

## Debug Mode

Debug mode (`DEBUG=true`) is required for local testing because:

- It prevents accidentally sending messages to Slack
- It prints the formatted message to your terminal
- It helps verify the report formatting

## Script Options

```bash
Options:
  --date        Generate report for a specific date (YYYY-MM-DD)
  --startDate   Start date for date range (YYYY-MM-DD)
  --endDate     End date for date range (YYYY-MM-DD)
  --days        Generate reports for last N days
  --verbose     Show raw data and API responses (default: false)
  --debug       Run in debug mode (default: false)
```

## Expected Output

### Default Output (Debug Mode)

``` markdown
📈 Daily Analytics Report - Bike4Mind
Generated for December 12, 2024 at 7:54 AM CT
───────────────────────────

⚡ Core Engagement Metrics
🔥 Highest Growth: Prompt Heard
• Last 24h: `52` events
• This Week: `450` vs `391` last week ⬆️ (+15%)
• This Month: `1,850` vs `1,516` last month ⬆️ (+22%)

📊 Core KPIs (7-day trailing)
• Prompt Heard: `450` ⬆️ (+15%)
• New Users: `28` ⬆️ (+5%)
• Notebooks: `89` ⬇️ (-2%)
• Files: `32` ⬆️ (+8%)

👥 User Activity (Last 7 Days)
• Total Users: `145`
• Internal: `28` @milliononmars.com
• External: `117` other domains

🏆 Top External Users by Activity
1st sarah@company.com: `45` interactions
```

### Verbose Mode Output

In addition to the formatted message above, you'll also see:

#### 1. Raw Analytics Data

```json
{
  "metrics": {
    "Prompt Heard": {
      "last24h": 52,
      "weeklyTotal": 450,
      "lastWeekTotal": 391,
      "monthlyTotal": 1850,
      "lastMonthTotal": 1516,
      "weekOverWeekChange": 15,
      "monthOverMonthChange": 22
    }
  },
  "userActivity": {
    "totalUniqueUsers": 145,
    "internalUsers": 28,
    "externalUsers": 117,
    "topUsers": [
      {
        "email": "sarah@company.com",
        "interactions": 45
      }
    ]
  }
}
```

#### 2. API Response Data

```json
{
  "success": true,
  "statusCode": 200,
  "data": {
    // ... API response details
  }
}
```

## Troubleshooting

- If you get MongoDB connection errors, make sure your MongoDB replica set is running
- If you get module resolution errors:
  - Ensure you're running the command from the lumina5 directory
  - Try running `pnpm install` again to ensure all dependencies are installed
- If you get TypeScript errors, verify that `pnpm install` completed successfully
- If you get environment variable errors:
  - Make sure the `.env` file exists in the lumina5 directory
  - Verify that all required variables are set in the `.env` file
  - Try printing the environment variables: `cat .env`

---

# Agent Execute WebSocket Tester

End-to-end integration tester for the `agent_execute` WebSocket route. Automates login, session/quest creation, and the full WS protocol — no manual setup beyond a base URL and credentials.

Originally built for [PR #8191](https://github.com/MillionOnMars/lumina5/pull/8191) (Phase 2 PR 1: subagent execution + concurrent cap), but designed to be reusable for any future PR that touches this flow.

**Source:** [`testAgentExecuteWs.ts`](./testAgentExecuteWs.ts)

## What it tests

| Test | What it verifies |
|---|---|
| `basic` | Pre-fix regression: `start` → `execution_started` → `iteration_step` → `completed` |
| `delegate` | Subagent lifecycle: `subagent_started` → `subagent_iteration_step` → `subagent_completed`, with matching `childExecutionId` and credit rollup into the parent's `totalCreditsUsed` |
| `concurrent-cap` | Per-user concurrency cap of 3: 4th `start` returns `agent_error { reason: 'concurrent_limit' }` |

## Usage

Default: runs all three against the default test user (`test@test.com`).

```bash
# Against a PR preview env
pnpm --filter @bike4mind/scripts test:agent-execute-ws -- \
  --base-url=https://app.pr8191.preview.bike4mind.com

# Against staging
pnpm --filter @bike4mind/scripts test:agent-execute-ws -- \
  --base-url=https://app.staging.bike4mind.com

# Single test
pnpm --filter @bike4mind/scripts test:agent-execute-ws -- \
  --base-url=https://app.pr8191.preview.bike4mind.com basic
```

Or invoke `tsx` directly with env vars (handy from outside the workspace):

```bash
BASE_URL=https://app.pr8191.preview.bike4mind.com \
  EMAIL=test@test.com PASSWORD='Testing12345!' \
  tsx packages/scripts/testAgentExecuteWs.ts            # all
```

### CLI flags / env vars

| Flag | Env var | Default | Notes |
|---|---|---|---|
| `--base-url=<url>` | `BASE_URL` | — | **Required.** Preview or staging URL. |
| `--email=<email>` | `EMAIL` | `test@test.com` | Test account; must NOT have MFA enforced. |
| `--password=<pw>` | `PASSWORD` | `Testing12345!` | |
| `--model=<id>` | `MODEL` | `gpt-5` | Model passed to `start`. |
| `--ws-url=<wss>` | `WS_URL` | (auto) | Skips the `/api/settings/serverConfig` lookup. |
| `--delegate-query=<q>` | `DELEGATE_QUERY` | bike-fact research prompt | Override the prompt used for `delegate` and `concurrent-cap` tests. |
| `--timeout=<ms>` | `TIMEOUT_MS` | `120000` | Per-event wait timeout. |
| `--quiet` | `QUIET=1` | off | Suppress per-event log lines. |
| (positional) | — | `all` | One of: `basic`, `delegate`, `concurrent-cap`, `all`. |

## Cost expectations

Roughly per full `all` run:

| Test | Approx credits |
|---|---|
| `basic` | ~3–10 |
| `delegate` | ~50–150 (1–2 subagents) |
| `concurrent-cap` | ~30–80 (3 subagents launched, executions aborted shortly after) |

The `concurrent-cap` test aborts the 3 long-running parents as soon as the 4th's verdict arrives, so runaway billing is bounded. Real numbers depend on the model.

## Adding a new test

1. Add a function `testFoo(ctx: Ctx): Promise<void>` near the existing tests.
2. Use `ctx.token`, `ctx.wsUrl`, and the helpers (`createSession`, `createQuest`, `openSocket`, `send`, `startMsg`).
3. Use `sock.waitFor(predicate, label, timeoutMs)` for event-driven waits — it replays already-received events and resolves the moment a match arrives.
4. Throw `SkipError` to mark the test as `SKIP` instead of `FAIL` (e.g., for non-deterministic conditions like "parent didn't choose to delegate").
5. Register it in the `TESTS` map and the `CliArgs['test']` union.

## Known caveats

- **`concurrent-cap` is timing-sensitive.** The cap relies on parents staying in `running` status long enough for the 4th's `countActiveByUserId` query to see count=3. The default delegate query asks for 5 facts with sources to keep the subagent busy ~10–15s. Custom prompts that finish faster may make the test flaky.
- **`delegate` is best-effort.** If the parent agent decides to answer directly without delegating, the test marks itself `SKIP` rather than `FAIL`. Adjust `--delegate-query` if needed.
- **MongoDB inspection is out of scope.** The script prints the exact `db.agentExecutions.findOne(...)` queries to run for parent/child linkage and credit-rollup verification — these need direct DB access.
- **MFA test users.** The script fails fast if the test user has MFA configured. Use a non-MFA account for automated testing.
