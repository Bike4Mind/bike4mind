# Admin morning brief

Daily delivery is disabled by default. Deploy with `ADMIN_MORNING_BRIEF_ENVIRONMENTS` containing the explicit stage names (comma-separated). Scheduled stages are production and dev; the job runs at 08:00 UTC. It uses the existing LiveOps webhook configuration and `APP_URL` for admin links. Never opt an environment in unless its LiveOps destination is appropriate for that environment.

The job stores facts before model work or Slack delivery. The AI configuration's global and morningBrief switches and budgets control summarization, independently of plain-facts delivery. Shadow summaries are stored as suggestions but not published.

Delivery is **at most one attempt**, not exactly once. A persisted environment/UTC-day claim prevents concurrent or repeated sends. A timeout or crash after claiming is unconfirmed, not sent, and is never automatically resent. The Dashboard retains the facts for manual handling. A scheduled-event replay retains the event's original day.

Counts use the sidebar's capped queries. Oldest timestamps currently share indexed readers for feedback, domain holds and moderation review; other queues explicitly state why age is unavailable. Audit and approval counts use a system viewer rather than a particular admin. AI handled/uncertainty totals describe suggestion records, not every legacy AI workflow. Monthly spend includes budget holds. Unresolved alarms come from the existing regional alarm reader; a partial read is marked unavailable or partial.
