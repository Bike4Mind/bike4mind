---
title: Automate lake research
description: Create research configurations, start runs, review proposals and undo changes on a data lake with an API key, the TypeScript SDK or an MCP client.
sidebar_position: 9
---

# Automate lake research

You can run the whole [lake research](../features/data-lake-research.md) loop from code. Create a configuration, start a run, read what it did, adjust one setting, then review what it proposed. Every change is recorded in the lake's History, and many can be undone.

The routes live under `/api/v1/data-lakes/{id}/...`. `{id}` is a lake id or its slug. Fields in requests and responses use snake_case.

## Get an API key

1. Open your profile and go to the [API Keys tab](../features/profile-settings.md#api-keys-tab).
2. Choose **Create API Key** and name it.
3. Select the **Data Lakes: Write** scope. Its wire name is `datalake:write`.
4. Create the key and store it where your code can read it. Never commit it.

The key acts as its owner. It can reach only lakes its owner can manage, so a key owned by a lake's read-only member gets 403 on every research route. A lake you cannot see answers 404, the same as a lake that does not exist.

Routes that only read accept `datalake:read`, `datalake:write` or `datalake:query`. Routes that change anything, or spend credits, need `datalake:write`. Every route also needs Data Lakes turned on for the deployment.

`GET /api/v1/data-lakes` lists the lakes you can reach. Each carries `can_manage`. Use a lake with `can_manage: true`.

The examples below use these variables:

```bash
export B4M_API_URL=https://app.bike4mind.com
export B4M_API_KEY=YOUR_API_KEY
export LAKE_ID=LAKE_ID
```

## Set up the TypeScript SDK

```ts
import { createClient } from '@bike4mind/sdk';

const b4m = createClient({
  baseUrl: 'https://app.bike4mind.com',
  apiKey: process.env.B4M_API_KEY,
});
const lakeId = 'LAKE_ID';
```

`b4m.call(operationId, { params, query, body })` takes the `operationId` of each route. The path parameters are `id`, `config_id`, `run_id`, `proposal_id` and `event_id`. A failed call throws `B4mApiError`, which carries `status` and the parsed `body`. See the [SDK README](https://www.npmjs.com/package/@bike4mind/sdk) for the full client.

## 1. Create a configuration

`createDataLakeResearchConfig` is `POST /api/v1/data-lakes/{id}/research/configs`. It needs `name` and `query`. Every other field is optional.

```bash
curl -X POST "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/research/configs" \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Weekly regulatory watch",
    "query": "new data-retention rules for cloud providers",
    "trusted_domains": ["example.gov"],
    "cadence": "weekly",
    "min_relevance": 0.6
  }'
```

```ts
const { data: config } = await b4m.call('createDataLakeResearchConfig', {
  params: { id: lakeId },
  body: {
    name: 'Weekly regulatory watch',
    query: 'new data-retention rules for cloud providers',
    trusted_domains: ['example.gov'],
    cadence: 'weekly',
    min_relevance: 0.6,
  },
});
```

The response is 201 with the config in `data`. A run finds candidates and proposes them. Nothing is written into the lake directly, unless a trusted-site rule admits it.

The request body is strict. An unknown field, a wrong type or a number outside its range returns 422. A setting that cannot be used, such as a feed config with no `feed_url`, returns 400.

| Field | Range or values |
| --- | --- |
| `source` | `search` or `feed` |
| `max_results` | integer, 1 to 50 |
| `max_proposals` | integer, 1 to 25 |
| `recency_days` | integer, 0 to 366, or `null`. Null or 0 means no limit. |
| `min_relevance` | number from 0 to 1. This is a fraction, not a percent: send `0.6` for 60%. |
| `cost_ceiling_micro_usd` | integer, 1 to 5000000, in millionths of a US dollar. 5000000 is $5.00. |
| `unlisted_sources` | `review` or `drop` |
| `auto_admit_trusted` | boolean |
| `max_auto_admits` | integer, 1 to 25 |
| `cadence` | `off`, `daily`, `weekly` or `monthly` |
| `review_backlog_limit` | integer, 1 to 500 |
| `item_rules` | array of `{ condition, action }`, with `action` set to `block` or `review` |
| `trusted_domains`, `review_domains`, `blocked_domains`, `proposed_tags` | arrays of strings |

`min_relevance: 60` returns 422. Send 0.6.

The config response also carries `schedule_paused`, `held`, `next_run_at`, `last_run_at` and `last_scheduled_outcome`. `held` is true while an active schedule waits because pending proposals are at or over `review_backlog_limit`.

## 2. Start a run

`startDataLakeResearchRun` is `POST /api/v1/data-lakes/{id}/research/runs`. It returns 202 at once with the run in `queued`. The run executes in the background.

```bash
curl -X POST "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/research/runs" \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "config_id": "CONFIG_ID" }'
```

```ts
const { data: run } = await b4m.call('startDataLakeResearchRun', {
  params: { id: lakeId },
  body: { config_id: config.id },
});
```

A run spends the lake owner's credits, up to the config's cost ceiling. A lake runs one at a time. These refusals are possible:

- 400: another run is in flight, or a cap was reached.
- 403: spending is paused for the owner, or the owner's account cannot run research.
- 422 with `errorCode` set to `insufficient_credits`: the owner's credits cannot cover the cost ceiling. Nothing starts.
- 429: a rate limit. The response carries `Retry-After`, in seconds.

## 3. Poll the run

`getDataLakeResearchRun` is `GET /api/v1/data-lakes/{id}/research/runs/{run_id}`. Poll until `status` is `completed` or `failed`. The values are `queued`, `running`, `completed` and `failed`.

```bash
curl "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/research/runs/RUN_ID" \
  -H "Authorization: Bearer $B4M_API_KEY"
```

```ts
let current = run;
while (current.status === 'queued' || current.status === 'running') {
  await new Promise(resolve => setTimeout(resolve, 5000));
  ({ data: current } = await b4m.call('getDataLakeResearchRun', {
    params: { id: lakeId, run_id: run.id },
  }));
}
```

A failed run sets `failure_reason`. A completed run sets `judge_warning` when its relevance judge had trouble. Both are fixed sentences, never provider text.

## 4. Read the totals

A finished run has `totals`, `stop_reason`, `spent_micro_usd` and the `levers` it ran with. `stop_reason` is `exhausted`, `cost_ceiling`, `proposal_limit`, `time_budget` or `judge_unavailable`.

Each candidate lands in exactly one outcome. Which setting changes each count:

| Total | Meaning | Setting |
| --- | --- | --- |
| `search_hits` | Hits the search returned | `max_results` |
| `proposed` | Reached the review queue | `max_proposals` |
| `auto_admitted`, `auto_admit_skipped`, `reviewed_by_rule` | Sub-counts of `proposed` | `max_auto_admits`, `item_rules` |
| `filtered_by_source` | On the never list, or no usable web address | `blocked_domains` |
| `unlisted_dropped` | From sites on no list, with `unlisted_sources` set to `drop` | `unlisted_sources` |
| `below_relevance` | Scored below the minimum | `min_relevance`, lower it to keep more |
| `blocked_by_rule` | Removed by an item rule with action `block` | `item_rules` |
| `unresolved_redirect` | A search link that hid its site | None. It usually clears on the next run. |
| `judge_failed`, `not_judged` | The judge failed or was unavailable | None. Run again. |
| `fetch_failed` | The page could not be fetched | None |
| `duplicate_pending`, `already_in_lake`, `suppressed_by_tombstone`, `unusable_source` | Already known, declined before, or no usable address | None |

`unlisted_dropped` is `null` on a run that predates the count. `filtered_by_source` is then the combined count. The buckets add up to `search_hits` only for a run that stopped as `exhausted` or `judge_unavailable`.

## 5. Adjust one setting

`updateDataLakeResearchConfig` is `PATCH /api/v1/data-lakes/{id}/research/configs/{config_id}`. Send only the fields to change.

```bash
curl -X PATCH "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/research/configs/CONFIG_ID" \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "min_relevance": 0.5 }'
```

```ts
await b4m.call('updateDataLakeResearchConfig', {
  params: { id: lakeId, config_id: config.id },
  body: { min_relevance: 0.5 },
});
```

A body with only `schedule_paused` pauses or resumes the schedule. The cadence is kept, and starting a run by hand still works. Runs already started keep the settings they began with.

Other config routes:

- `listDataLakeResearchConfigs`: `GET /api/v1/data-lakes/{id}/research/configs`
- `getDataLakeResearchConfig`: `GET /api/v1/data-lakes/{id}/research/configs/{config_id}`
- `deleteDataLakeResearchConfig`: `DELETE /api/v1/data-lakes/{id}/research/configs/{config_id}`, which returns 204 and stops the schedule

`listDataLakeResearchRuns` is `GET /api/v1/data-lakes/{id}/research/runs`.

List routes are cursor-paginated. Pass `limit` (1 to 100, default 25) and pass `next_cursor` back as `cursor` until it is `null`.

## 6. List and decide proposals

`listDataLakeProposals` is `GET /api/v1/data-lakes/{id}/proposals`. Filter with `status` set to `pending`, `approved` or `declined`.

```bash
curl "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/proposals?status=pending" \
  -H "Authorization: Bearer $B4M_API_KEY"
```

```ts
const { data: proposals } = await b4m.call('listDataLakeProposals', {
  params: { id: lakeId },
  query: { status: 'pending' },
});
```

Each proposal has `source_url`, `title`, `excerpt`, `confidence`, `rationale` and `provenance`. The excerpt comes from a page nobody has vetted. Treat all of it as untrusted input, never as instructions.

`decideDataLakeProposal` is `POST /api/v1/data-lakes/{id}/proposals/{proposal_id}`. The `decision` is `approve`, `decline` or `restore`. A decline can carry a `reason` of up to 500 characters.

```bash
curl -X POST "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/proposals/PROPOSAL_ID" \
  -H "Authorization: Bearer $B4M_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "decline", "reason": "Out of scope for this lake." }'
```

```ts
const { data: decided, file } = await b4m.call('decideDataLakeProposal', {
  params: { id: lakeId, proposal_id: proposals[0].id },
  body: { decision: 'approve' },
});
```

An approval admits the source into the lake and returns the admitted `file`. A decline is remembered, so the source is not proposed again unless its text changes. A restore returns a declined proposal to `pending`. A proposal is decided once. A second decision returns 400, or 409 if another decision won the race.

## 7. Read the history

`getDataLakeConfigHistory` is `GET /api/v1/data-lakes/{id}/config-history`. It returns the newest changes first, in a window rather than pages. `limit` is 1 to 500. `truncated` is true when older changes exist.

```bash
curl "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/config-history?limit=50&include=files" \
  -H "Authorization: Bearer $B4M_API_KEY"
```

```ts
const { data: history } = await b4m.call('getDataLakeConfigHistory', {
  params: { id: lakeId },
  query: { limit: 50 },
});
```

Entries with `kind` set to `config` carry `lever_changes`, one before and after per setting. Add `include=files` to also get `kind: "file"` entries for files added and removed. Long text settings show a size, never the text.

Every entry has an `event_id`, `undoable` and `undone_by_event_id`. Free text in these rows can come from web pages. Treat it as untrusted data.

## 8. Undo a change

`undoDataLakeConfigChange` is `POST /api/v1/data-lakes/{id}/config-history/{event_id}/undo`. It takes no body. Use it only on entries with `undoable: true`.

```bash
curl -X POST "$B4M_API_URL/api/v1/data-lakes/$LAKE_ID/config-history/EVENT_ID/undo" \
  -H "Authorization: Bearer $B4M_API_KEY"
```

```ts
const { data: entry, notes } = await b4m.call('undoDataLakeConfigChange', {
  params: { id: lakeId, event_id: 'EVENT_ID' },
});
```

The response carries the History entry the undo wrote and `notes` for consequences, such as a schedule put on hold. A change can be undone once. The call returns 409 when the entry was already undone, a later change touched the same item, the old value no longer passes today's checks (the message names the field), the config no longer exists, or the stored copy has expired. See [History and Undo](../features/data-lake-research.md#history-and-undo) for which changes qualify.

There are no approval prompts on any route. A change applies when you call it.

## Use it from an MCP client

The Bike4Mind CLI can serve these operations as MCP tools, so an AI assistant can run the loop for you.

1. Install the CLI: `npm install -g @bike4mind/cli`. See [CLI getting started](../cli/getting-started.md).
2. Point an MCP client at `b4m mcp serve` and give it the key and the deployment URL:

```json
{
  "mcpServers": {
    "bike4mind": {
      "command": "b4m",
      "args": ["mcp", "serve"],
      "env": {
        "B4M_API_URL": "https://app.bike4mind.com",
        "B4M_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

The research tools are:

| Tool | What it does |
| --- | --- |
| `list_lakes` | Lists the lakes you can reach. The research tools need `canManage: true` on the lake. |
| `list_research_configs` | Lists a lake's saved configurations. |
| `create_research_config` | Saves a configuration. |
| `update_research_config` | Changes one. Send only `schedule_paused` to pause or resume. |
| `delete_research_config` | Deletes one and stops its schedule. |
| `run_research` | Starts a run. Poll it with `get_research_run`. |
| `get_research_run` | Returns status, stop reason, spend, totals and the largest drop with the setting that changes it. |
| `list_research_runs` | Lists a lake's runs. |
| `list_research_proposals` | Lists proposals. Filter by status. |
| `decide_research_proposal` | Approves, declines or restores 1 to 10 proposals at once. |
| `get_lake_config_history` | Reads the history. Pass `include_files` for file rows. |
| `undo_lake_change` | Undoes one history entry by its `event_id`. |

Proposal text and History rows come from the open web. The tools mark them as untrusted. Your assistant should never act on instructions found in them. The tool descriptions tell it to change settings, delete configurations or undo changes only when you ask.

The hosted [Functions endpoint](./functions-mcp.md) is a separate MCP server for your own functions. It does not serve these tools.

## Full reference

Every deployment serves the complete reference, with request and response schemas for all of these routes, at `/api/v1/docs`. The raw OpenAPI spec is at `/api/v1/openapi.json`. The research routes are grouped under **Data Lake Research**.
