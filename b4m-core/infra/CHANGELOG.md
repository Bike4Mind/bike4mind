# @bike4mind/infra

## 0.7.0

### Minor Changes

- declare deploy image manifest + CI guard

- wire external instance-service secrets + guarded standup

- queue/bucket/function factories + DLQ alarm spec builder

### Patch Changes

- drop '>' from ChatCompletion SG rule descriptions + guard the charset

- add DLQ to EventBridge telemetry-alert rule

- install axios into mcpHandler bundle so Atlassian MCP tools work

- pin fab-file chunk/vectorize SQS subscribers to batch size 1

- namespace external instance-service env/secrets under OPTIHASHI_*

- pin single-record SQS subscribers to batch size 1
