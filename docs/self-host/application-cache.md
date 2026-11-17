# Optional application cache

No cache service is required. With `B4M_CACHE_BACKEND` unset (or `memory`), the
application uses a bounded in-memory cache. To share the integration circuit
breaker cache across app and worker replicas, set these variables on every
participating process and restart them:

```sh
B4M_CACHE_BACKEND=redis-http
B4M_CACHE_REDIS_HTTP_URL=https://your-redis-command-endpoint.example
B4M_CACHE_REDIS_HTTP_TOKEN=<secret-bearer-token>
B4M_CACHE_PREFIX=<unique-deployment-and-database-name>
```

The endpoint must implement the Redis command-over-HTTP API: POST a JSON command
array with bearer authentication and receive `{ "result": ... }` (or an `error`).
This works with Upstash Redis REST and compatible self-hosted Redis gateways. A
bare `redis://` TCP endpoint is not supported. Use HTTPS outside a trusted local
network. No Redis client dependency or mandatory infrastructure is installed.
Never share a prefix across unrelated databases, stages or deployments. The
Redis identity needs GET, SET, PSETEX and EVAL permissions. Revision keys must not
be evicted independently of data keys; use a dedicated `noeviction` Redis store
(data expires after five minutes). Invalidation revision keys do not expire.

Reads and writes time out after one second. On read failure, the application
reads the database directly; it does not serve a stale local fallback. Write
failure returns the freshly loaded database value without caching it.
Invalidation failures propagate to the admin request instead of acknowledging
success; the database write may already have committed, so retry the override
request. During an outage or a mixed-version rollout, uninvalidated entries can
remain until their five-minute TTL. Requests already in progress can return
their pre-edit snapshot, but cannot repopulate the cache after invalidation.
There is no local L1 in shared mode.

## Cache classification

| Cache from the issue | Classification | Behavior |
| --- | --- | --- |
| RapidReplyMappingsCache | stale-tolerant | Model mappings retain their existing local 15-minute TTL (one minute in development); no coordinated mutation path currently uses its invalidators. |
| ToolCacheManager | stale-tolerant, execution-local | Tool failure/retry state belongs to a ChatCompletionProcess session; sharing it would spread transient execution failures to other processes. Retains its existing TTL and reset semantics. |
| intentClassifier.cache | stale-tolerant | Deterministic per-user routing optimization; bounded local LRU and one-hour TTL remain. Duplicate classification work is acceptable. |
| systemPrompts/loader | stale-tolerant | Only the base identity message is cached, for 60 seconds; other prompt content is read from the database. Retains the documented admin-edit delay. The client path is a re-export of server-utils. |
| integrationCircuitBreaker | needs-shared | Uses the configured cache. Admin overrides await namespace invalidation across replicas. Automatic probe results retain their five-minute TTL. |

Namespace invalidation uses a random revision and atomic Redis Lua reads and
conditional writes. It clears the small set of integration statuses together,
without scanning keys. Concurrent loads from an earlier revision cannot publish
their results into the current revision. Both modes use the same asynchronous
`ApplicationCache` interface (`getOrLoad`, `invalidate`).
