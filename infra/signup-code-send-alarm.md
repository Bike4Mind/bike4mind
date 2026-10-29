# Signup abuse alarms

All thresholds are read from the deployer's environment, are listed in
`infra/deploy-contract.json`, and must be integers of at least 1. Invalid values
fail deployment (or, for the scheduled worker, fail the run).

| Variable                                 | Default                | Alarm                                                               |
| ---------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| `SIGNUP_CODE_SEND_ALARM_PER_HOUR`        | unset: no hourly alarm | Sign-in code sends, hourly `Sum`                                    |
| `SIGNUP_CODE_SEND_ALARM_PER_5MIN`        | 15                     | Sign-in code sends, 5-minute `Sum`                                  |
| `API_KEY_CREATE_ALARM_PER_5MIN`          | 10                     | User API key creations, 5-minute `Sum`                              |
| `SIGNUP_EDGE_SIGNAL_ALARM_PER_5MIN`      | 5                      | WAF-labelled `/api/otc/` requests, 5-minute `Sum`                   |
| `YOUNG_ACCOUNT_SPEND_ALERT_CREDITS`      | 5000                   | Hourly credits spent by accounts under 7 days old                   |
| `YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS`     | 25                     | Hourly count of distinct accounts under 7 days old that spent       |
| `LLM_SPEND_ALARM_USD_PER_5MIN`           | 25                     | Estimated LLM USD per provider, 5-minute `Sum`                      |
| `YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR` | 2                      | Estimated LLM USD per hour by accounts under 7 days old             |
| `SIGNUP_ALARM_PER_HOUR`                  | 8                      | Accounts created per hour (hourly census)                           |
| `NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR`     | 5                      | User API keys created within 24h of signup per hour (hourly census) |

Monitoring runs on `dev` and `production`; another stage also needs
`ENABLE_MONITORING=true`. The WAF edge alarm and the young-account spend worker
run in `production` only (the edge alarm also needs `ENABLE_WAF=true`).

## Server log alarms (`infra/signupAlarms.ts`)

The sign-in code alarms count sign-in code email events accepted by
`EmailEvents.Send.publish`, including codes for existing accounts. They do not
count rejected requests or failed publication, and they do not prove email
delivery or account creation. A dispatch still counts if the request
subsequently fails token confirmation. No email address, code, or token is added
to the dispatch log message.

The Next.js server log group emits `otc-code-dispatched` and
`user-api-key-created` as the JSON message field. New API key records are logged
by the shared mint service after creation succeeds, covering dashboard, API, CLI,
bridge, admin, and exchange entry points. Rotations update an existing record and
do not count as new key creation. Each filter reads that field
inside Lambda-prefixed log lines. The metrics are `SignupCodeSends` and
`ApiKeyCreations` in `<app-name>/<stage>/Signup`, so stages and applications in
the same account do not combine their counts. Each alarm compares its `Sum` with
the configured threshold using `GreaterThanOrEqualToThreshold`; missing data is
not breaching.

ALARM and OK transitions go to the DLQ alarm topic (Slack; its handler drops OK)
and to the out-of-band topic (`OPS_ALERT_EMAIL`). Each alarm notifies on an ALARM transition. A non-breaching evaluation returns it
to OK, allowing a later burst to notify again; a continuous breach remains one
alarm episode.

## WAF edge alarm (`infra/waf.ts`)

A metric filter on the WAF log group (us-east-1) counts requests whose
`httpRequest.uri` starts with `/api/otc/` and whose `labels` include the
anonymous-IP hosting-provider label or any bot-control `signal:` label. Labels are
logged whether the managed rule blocks or counts. The metric is
`OtcEdgeSignalRequests` in `<app-name>/<stage>/Signup` in us-east-1. Alarm actions
must share the alarm's region, so this alarm routes to the us-east-1 WAF topics:
`wafAiRateLimitAlarmTopic` (Slack) and `wafOobAlarmTopic` (`OPS_ALERT_EMAIL`).

## Young-account spend (`apps/workers/src/cron/youngAccountSpendAlert.ts`)

Hourly, production only. Uses the scheduled event time as the end of a fixed
`[end - 1 hour, end)` window, so delayed delivery and retries query the same spend.
The target clears SST's default literal input so EventBridge passes the original
scheduled event, including `time`. Missing or invalid timestamps fail the run
instead of silently shifting the window on a retry.
Sums AI credit spend by accounts created in the 7 days before that end time and posts to the LiveOps Slack webhook when the total
exceeds `YOUNG_ACCOUNT_SPEND_ALERT_CREDITS` or the number of distinct spending
accounts exceeds `YOUNG_ACCOUNT_SPEND_ALERT_ACCOUNTS`. The message lists the top
10 user ids by spend, the counts, and the window. It does not include emails.
Each run logs `young-account-spend` with `windowStart`, `windowEnd` and the totals.

Both EventBridge delivery failures and exhausted Lambda retries (2, the default)
reach a monitored 14-day DLQ. Each message is one failed hour, and its body is the
original scheduled event. Messages queued before the target cleared SST's `{}`
input have a `{}` body; they cannot be replayed, so purge them.

### Replaying a failed hour

There is no source queue to redrive into. To replay, read the DLQ message body and
check it has a `time`. Invoke the production `youngAccountSpendAlert` function
synchronously (`aws lambda invoke --invocation-type RequestResponse
--cli-binary-format raw-in-base64-out --payload "<body>" out.json`), and delete the
message only once `out.json` shows `ok` or `alerted`. A synchronous invoke is not
retried and does not dead-letter, so a failed replay leaves the original message in
place.

The worker keeps no delivery receipt. A dead-lettered hour has not posted (the
Slack post is its last step), so a replay posts at most once. Replaying an hour
that already succeeded, or one whose post Slack accepted before the response
failed, posts again.

To backfill a gap, invoke with `{"time":"<window end>"}` for each missing hour.
Each run covers `[time - 1 hour, time)` and measures account age from `time`, so a
later run reproduces the hour apart from deleted users. The schedule is
`rate(1 hour)`, so take the minute and second from a scheduled run's `windowEnd`
to make backfilled windows tile against the scheduled ones. Every breaching hour
posts to LiveOps with its window, so tell the channel before a large backfill.

## LLM spend (`infra/llmSpend.ts`)

Every settled text completion on the ChatCompletion service (web chat, the public
completions API, CLI and desktop over the service's WebSocket, embeds) logs one
JSON line with the message `llm-usage-settled`. It carries `provider`
(`anthropic`, `openai`, `bedrock`, `google`, or `other`), the raw `backend`,
`model`, token counts, `usd` (the same per-model price the credit settlement
uses, 6 decimals), `source`, and `isYoungAccount` (account created in the last
168 hours, the young-account spend definition). It has no user id or prompt.
The line is written by a dedicated info-level JSON logger in
`b4m-core/services/src/llm/llmUsageSettledLog.ts`, without inheriting request
metadata. Research completions log each settled configuration, including when
credit enforcement is disabled; aborts carrying settled partial usage count too.

Metric filters on the ChatCompletion log group write to the `<app>/<stage>/LLMSpend`
namespace:

| Metric                      | Value            | Dimensions        |
| --------------------------- | ---------------- | ----------------- |
| `EstimatedUsd`              | `$.usd`          | `Provider`        |
| `TokensOutput`              | `$.outputTokens` | `Provider`        |
| `EstimatedUsdByModel`       | `$.usd`          | `Provider, Model` |
| `EstimatedUsdYoungAccounts` | `$.usd`          | none              |

One alarm per provider fires when `EstimatedUsd` sums to at least
`LLM_SPEND_ALARM_USD_PER_5MIN` (whole USD) in 5 minutes, sending ALARM and OK to
the Slack DLQ topic and the out-of-band email topic. The
`<app>-<stage>-llm-spend` dashboard shows spend per 5 minutes and across the selected dashboard range,
output tokens, spend by model, the young-account share of spend, and the signup
and WAF edge-signal counts from the alarms above.

An hourly alarm on `EstimatedUsdYoungAccounts` fires when accounts under 7 days
old sum to at least `YOUNG_ACCOUNT_SPEND_ALARM_USD_PER_HOUR` (whole USD) and
routes to the same two topics. It is not listed in the dashboard alarm-status widget.

The figures are estimates from our price table, not provider invoices. Paths
outside the ChatCompletion service are not counted: the legacy WebSocket CLI
and Slack quest Lambdas log the same line, but Lambda's text log format hides it
from JSON filters; the agent executor, image, video and voice paths do not log it.

## Mail send failures (`infra/mailAlarms.ts`)

A metric filter on the `email-send` subscriber's log group counts the
`Email delivery failed - check MailService logs for details` line, which that
Lambda logs when the mail transport rejects a send (sign-in codes included). The
metric is `MailSendFailures` in `<app-name>/<stage>/Mail`. The alarm fires when it
sums to at least 1 in an hour and routes to the DLQ alarm topic (Slack).

## If alerts do not arrive

- Check the deployed environment and stage gate first; a missing hourly threshold
  intentionally leaves the hourly alarm disabled.
- Check for the message after a successful email publication or key creation.
  Cloud logging must retain JSON info messages; suppressing info logs prevents
  counts.
- Check that each metric filter and alarm reference the same app/stage namespace
  and log group. Filters process new log events, not historical traffic.
- Check the Slack subscriptions, the notification handler DLQs, and that the
  `OPS_ALERT_EMAIL` subscriptions were confirmed.

Run `pnpm exec vitest run --dir infra` for the resource wiring and parser tests.
From `apps/client`, run
`pnpm exec vitest run --project node pages/api/otc/__tests__/send.test.ts`
for dispatch success, failure, and rejected-request coverage.
