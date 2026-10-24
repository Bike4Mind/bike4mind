# Signup code send alarm

Set `SIGNUP_CODE_SEND_ALARM_PER_HOUR` in the deployer's environment to an integer
of at least 1 and pass it through to the SST deploy. An unset, empty, or
whitespace-only value creates neither the metric filter nor the alarm. Invalid
values fail deployment. Monitoring runs on `dev` and `production`; another stage
also needs `ENABLE_MONITORING=true`.

The alarm counts sign-in code email events accepted by `EmailEvents.Send.publish`,
including codes for existing accounts. It does not count rejected requests or
failed publication, and it does not prove email delivery or account creation.
A dispatch still counts if the request subsequently fails token confirmation.
No email address, code, or token is added to the dispatch log message.

The Next.js server log group emits `otc-code-dispatched` as the JSON message
field. The filter reads that field inside Lambda-prefixed log lines. The metric
is `SignupCodeSends` in `<app-name>/<stage>/Signup`, so stages and applications
in the same account do not combine their counts. The alarm compares its hourly
`Sum` with the configured threshold using `GreaterThanOrEqualToThreshold`.
Missing data is not breaching. ALARM transitions use the existing DLQ alarm SNS
topic and its Slack subscriber.

If alerts do not arrive:

- Check the deployed environment and stage gate first; a missing threshold
  intentionally leaves monitoring disabled.
- Check for the dispatch message after a successful email publication. Cloud
  logging must retain JSON info messages; suppressing info logs prevents counts.
- Check that the metric filter and alarm reference the same app/stage namespace
  and server log group. Filters process new log events, not historical traffic.
- Check the shared alarm topic's Slack subscription and notification handler DLQ.
  Repeated breaching data does not send another notification without an alarm
  state transition.

Run `pnpm exec vitest run --dir infra` for the resource wiring and parser tests.
From `apps/client`, run
`pnpm exec vitest run --project node pages/api/otc/__tests__/send.test.ts`
for dispatch success, failure, and rejected-request coverage.
