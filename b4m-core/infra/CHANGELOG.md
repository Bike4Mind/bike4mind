# @bike4mind/infra

## 0.8.0

### Minor Changes

- [#532](https://github.com/Bike4Mind/bike4mind/pull/532) [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948) Thanks [@cgtorniado](https://github.com/cgtorniado)! - add public visibility for data lakes

### Patch Changes

- [#549](https://github.com/Bike4Mind/bike4mind/pull/549) [`05374cb`](https://github.com/Bike4Mind/bike4mind/commit/05374cbaaf2037cc65b80b5ab905b462ae17b7fa) Thanks [@jjmarfa](https://github.com/jjmarfa)! - report per-record batch failures for SQS subscribers

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
