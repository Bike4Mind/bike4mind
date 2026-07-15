# TodoStore write-through cache specification (WorkItem sync)

Status: DRAFT - pending sign-off (CTO + one senior dev)
Blocks: Q-WT-4 of the B4M-native work-tracking feature. No cache code lands
until this spec is approved.

## Background

Today `TodoStore` (`packages/cli/src/tools/writeTodosTool.ts`) is an in-memory
`{ todos: TodoItem[] }` that the `write_todos` tool replaces wholesale on every
call. It is ephemeral: todos die with the process and never leave the machine.

The work-tracking feature adds a Mongo-backed `WorkItem` collection behind a
REST API, with a typed `WorkItemsClient` in the CLI. This spec defines how
`TodoStore` becomes a **write-through cache** over `WorkItemsClient`: reads are
served locally, writes apply locally first and are flushed to the backend, and
the CLI keeps working when the backend is unreachable.

### Data-model bridge

`TodoItem` and `WorkItem` use different status enums. The cache maps them 1:1:

| TodoItem status | WorkItem status |
|-----------------|-----------------|
| `pending`       | `open`          |
| `in_progress`   | `in_progress`   |
| `completed`     | `closed` (sets `closedAt`) |
| `cancelled`     | `closed` (sets `closedAt`; `resolution: 'cancelled'` if the model grows one, otherwise plain close) |

`WorkItem.status = 'blocked'` has no `TodoItem` equivalent; the cache surfaces
blocked items as `pending` with a `(blocked)` suffix in display output and never
writes `blocked` itself (that transition belongs to the `work_item_update`
tool, which talks to the client directly).

The cache keys every entry by the server `_id`. Items created offline get a
client-generated UUID recorded as `clientId`; the server `_id` replaces it as
the key when the create flushes (see section 2).

## 1. Cache write semantics

**Decision: cache-first-then-flush (asynchronous write-through).**

- A write (from `write_todos` or the `work_item_*` tools routed through the
  store) mutates the in-memory cache and appends to the flush queue
  **synchronously**, then returns. The tool result renders from the cache.
- A background flusher drains the queue to `WorkItemsClient` in order,
  immediately when online (so the common case is sub-second write-through) and
  on the retry schedule in section 5 when not.

**Latency UX:** the tool call never blocks on the network. The status bar shows
a sync indicator with three states: `synced` (queue empty), `syncing (N)` (N
queued mutations), and `offline (N)` (backend unreachable, N queued). No
spinners or blocking prompts on the todo write path.

**Rationale:** `write_todos` sits on the agent hot path and is called after
nearly every step of a multi-step task. Synchronous-first would add a round
trip (or a multi-second timeout when offline) to every agent iteration, and the
existing tool contract ("update as soon as state changes, never batch") makes
that cost recurring. Local state is authoritative for the session; the backend
is the durability and sync layer, not the source of truth mid-session.

## 2. Offline queue

**Decision: durable FIFO on disk with per-item squashing.**

- **Location:** `~/.bike4mind/work-items-queue.json` (same convention as the
  rest of the CLI's state under `~/.bike4mind/`).
- **Durability:** every enqueue/dequeue rewrites the file via write-to-temp +
  atomic rename, file mode `0o600` (directory `0o700`), matching the pattern in
  `utils/handoff.ts` and `utils/updateChecker.ts`. A crash between the cache
  mutation and the flush loses nothing: the queue entry is written before the
  tool call returns.
- **Ordering:** FIFO across distinct WorkItems. Causal order matters only
  per-item (a create must precede its updates) and FIFO preserves that.
- **Squashing:** multiple queued mutations targeting the same WorkItem are
  coalesced:
  - `create` + later `update`s -> one `create` carrying the final field values.
  - `update` + `update` -> one `update`; later fields win per field.
  - anything + `close` -> the prior entry with `status: closed` folded in; a
    `create` + `close` while offline still flushes (the item existed, briefly)
    so history is truthful, as a single `create` with closed status.
  - Squashing happens at enqueue time, so the queue length is bounded by the
    number of distinct items touched offline, not the number of edits.
- **Queue entry shape:** `{ opId, clientId, serverId?, op: 'create'|'update',
  fields, baseUpdatedAt?, enqueuedAt }`. When a `create` flushes, the returned
  `_id` is written into the cache and into any queued entries still referencing
  the `clientId`.
- **Bound:** the queue holds at most one entry per WorkItem (post-squash). No
  size cap is needed for a personal todo list; if the file fails to parse at
  startup it is moved aside to `work-items-queue.corrupt-<timestamp>.json` and
  a warning is shown rather than silently dropping writes.

## 3. Conflict resolution

**Decision: field-level last-write-wins, arbitrated by the server; no vector
clocks, no CRDTs.**

- Flushes send `PATCH` with **only the changed fields** plus `baseUpdatedAt`
  (the `updatedAt` the client last saw for the item).
- Server behavior on `PATCH`:
  - `baseUpdatedAt` matches current `updatedAt` -> apply, bump `updatedAt`.
  - `baseUpdatedAt` is stale -> **merge, do not reject**: apply the patched
    fields anyway (last writer wins per field), leave untouched fields at their
    current server values, and return the full merged document. The client
    replaces its cached copy with the response.
- **Per-field strategy:** the same LWW rule for every field, including
  `dependencies`. `status`, `title`, `description` are scalars where LWW is the
  obvious choice. `dependencies` is an array where LWW can drop a concurrent
  edit from another machine; we accept that tradeoff for the MVP because
  concurrent dependency edits by one user on two offline machines is a corner
  case, and set-merge semantics (add/remove ops) can be added behind the same
  PATCH surface later without changing the client contract.
- **Why not stronger:** this is a single-user list (org visibility is out of
  scope). The realistic conflict is one human on two machines, where "the edit
  I made most recently wins" matches user intent. Vector clocks and CRDTs buy
  convergence guarantees this use case does not need, at real complexity cost
  in a soft-deleted Mongo collection.
- **Arbitration clock:** server receipt order, never client wall clocks
  (laptops skew). "Last write" means "last PATCH the server processed".
- **Deletes:** `close` is a status write and merges like any field. A PATCH to
  an item another machine already closed re-opens or edits it per LWW; a PATCH
  to a hard-missing id (404) drops the op with a warning (section 5).

## 4. Initial sync (cold start on a new machine)

**Decision: paginated full fetch of active items, disk-cached, serve-stale-
while-revalidate.**

- **What:** on startup the store fetches all items with status in
  `open | in_progress | blocked` for the user (`GET /api/work-items` with a
  status filter), paginated at 200/page until exhausted. Closed items are
  fetched lazily (only when a tool asks for history) - the active set is what
  the todo UX needs and is expected to be small (well under 1k).
- **Disk cache:** the merged result persists to
  `~/.bike4mind/work-items-cache.json` (same atomic-rename + `0o600` handling
  as the queue), stamped with `fetchedAt`.
- **Startup order:** load disk cache -> replay the offline queue over it (so
  local unflushed edits win locally) -> render immediately -> background
  refresh from the API -> merge per section 3 and re-render. Startup never
  blocks on the network.
- **Freshness:** within a running session the cache is trusted; a background
  refresh runs at startup and then only on demand (a `work_item_ready` or
  `work_item_graph` call, or an explicit sync command), not on a polling
  timer. If `fetchedAt` is older than 24h at startup the UI shows the data as
  possibly stale until the refresh lands. Real-time push (WebSocket fan-out)
  is a natural follow-up but out of scope here.

## 5. Failure modes

- **Backend unreachable at startup:** serve the disk cache (stale reads) with
  the `offline` indicator; with no disk cache, start empty in offline mode.
  Writes queue normally either way. This is the "TodoStore still works
  offline" acceptance criterion.
- **5xx / network error / timeout during flush:** retryable. Exponential
  backoff per queue (not per entry): 1s, 2s, 4s, ... capped at 60s, retrying
  as long as the process lives; the queue is durable, so unflushed work also
  survives restarts and resumes on next launch. Any successful request resets
  the backoff. There is no max-attempts cutoff - abandoning a durable queue
  would silently lose user data, and the squashed queue is small.
- **Non-retryable 4xx (400/403/404/422) during flush:** the op is wrong, not
  the transport. Drop the entry, move it to
  `~/.bike4mind/work-items-queue.dead.json` for postmortem, and surface a
  one-line warning. Retrying would wedge the FIFO queue behind a poison entry.
- **Auth token expired mid-write (401):** delegated entirely to the existing
  `ApiClient` interceptor (`packages/cli/src/auth/ApiClient.ts`):
  refresh-on-401 with a single retry, the fresh-token heuristic for transient
  401s, and `AuthInvalidError` only on definitive revocation. `WorkItemsClient`
  issues requests through `ApiClient`, so the cache inherits this for free. On
  `AuthInvalidError` the flusher **pauses** (queue intact, cache fully
  functional offline) and the CLI shows its standard re-login prompt; flushing
  resumes on successful re-auth.
- **Conflict responses:** none - section 3's merge-don't-reject design means a
  PATCH never fails for staleness.

## 6. Trust model

**Decision: the user's home directory is trusted; no signing or HMAC on the
queue.**

- The cache and queue files live beside `~/.bike4mind/config.json`, which
  already holds the OAuth refresh token. Any local process that could tamper
  with the queue could instead read that token and call the API directly as
  the user, so signing queued writes adds ceremony without adding a security
  boundary. The key that would sign them would sit in the same directory.
- What we do enforce:
  - File permissions: `0o600` files, `0o700` directory (consistent with
    `updateChecker.ts` / `handoff.ts`).
  - **Server-side validation is the real boundary:** every flushed op is
    authenticated, scoped to the token's `userId`, and schema-validated by the
    REST layer. A tampered queue can at worst corrupt the user's own list.
  - Defensive parsing: cache/queue files are validated on load; unparseable or
    schema-invalid files are quarantined (renamed with a `.corrupt-` prefix),
    never trusted or silently deleted.
- This matches how the CLI already treats sessions, config, and checkpoints on
  disk, and the decision is recorded here per the issue's ask.

## Out of scope

- Org-level sharing/visibility (changes the trust model; revisit section 6
  when it lands).
- Real-time push sync via WebSocket fan-out (replaces the on-demand refresh in
  section 4; the merge rules in section 3 already accommodate it).
- Migration of pre-existing in-memory todos (greenfield per the parent issue).
