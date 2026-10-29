# Account creation and mail metrics

The two census alarms are on by default on monitored stages: `SIGNUP_ALARM_PER_HOUR`
defaults to 8 and `NEW_ACCOUNT_API_KEY_ALARM_PER_HOUR` to 5. Set either to a positive
integer in deploy configuration to override it. The SES bounce and complaint alarms
below stay opt-in. Existing OTC dispatch monitoring remains configured by
`SIGNUP_CODE_SEND_ALARM_PER_HOUR`.

The census runs five minutes after each UTC hour and reads the preceding complete
hour using the scheduled event time, not invocation time. `SuccessfulSignups` counts
persisted non-system, non-synthetic accounts, including admin-created accounts.
It does not count login attempts, retries, or email verification as new accounts.
`NewAccountApiKeys` counts persisted keys created at an account age in `[0, 24 hours)`.
It includes all mint channels and excludes rotations that update an existing key.
Deleted accounts/keys and synthetic flags changed before a scan can affect the census;
this is not an immutable audit stream.

Metrics use `<app>/<stage>/AccountCreation`, carry no account dimensions, and are
timestamped at the start of the counted hour. Alarms use `Maximum`, not `Sum`, so
redelivery of the same scheduled window does not add counts. An empty hour publishes
zeros. Query or publication failures throw for retry and eventually dead-letter.
A separate missing-census alarm distinguishes silence from a clean scan. Rate alarms
treat missing data as not breaching. Notifications reuse the existing DLQ SNS-to-Slack
subscriber; wiring does not prove delivery. Persistent ALARM state does not send
another notification every hour. No response action is attached.

Run the additive account-creation index migration through the usual migration process
before enabling a census on a large database. Schema declarations alone do not build
indexes where runtime auto-indexing is disabled. Queries are time-bounded and have a
server-side execution timeout. DocumentDB compatibility and query plans require a
stage check; local MongoDB is not equivalent evidence.

## Optional SES monitoring

`ENABLE_OTC_SES_METRICS=true` creates an OTC-only SES configuration set and CloudWatch
event destination on monitored stages. The email worker attaches its configuration-set
header only to explicitly categorized OTC messages. This requires the worker's SMTP
transport to be SES in the same region as the resources; other transports do not publish
these metrics. Validate the transport before enabling, since SES rejects an unknown
configuration set. Self-host mail is unchanged.

Set `OTC_SES_BOUNCE_ALARM_PERCENT` and/or `OTC_SES_COMPLAINT_ALARM_PERCENT` to a value
in `(0, 100]` to enable hourly percentage alarms. The AWS/SES event counts use exactly
the `ses:configuration-set` dimension. Account-wide reputation metrics are not used.
Rates divide the hour's Bounce/Complaint events by Send events, not delivery events.
Feedback can arrive later than its send; these are event-window ratios, not cohort
delivery rates. A failure-only hour is treated as 100 percent rather than ignored.
Missing events are not proof of healthy mail delivery. No mail provider, recipient,
Slack destination, or alarm state is modified by local tests.

SES event publishing reference:
https://docs.aws.amazon.com/ses/latest/dg/event-publishing-add-event-destination-cloudwatch.html
