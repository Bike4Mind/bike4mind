# @bike4mind/infra

## 0.8.0

### Minor Changes

- [#1037](https://github.com/Bike4Mind/bike4mind/pull/1037) [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592) Thanks [@onoya](https://github.com/onoya)! - persist generated TTS/sound-effect audio as browsable FabFiles

- [#1454](https://github.com/Bike4Mind/bike4mind/pull/1454) [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reserve attached-file budget and warn when a file will not fit

- [#1547](https://github.com/Bike4Mind/bike4mind/pull/1547) [`cfe3660`](https://github.com/Bike4Mind/bike4mind/commit/cfe366047a212f9fa0a76e3483f462426d4f2560) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add files to a data lake from '@datalake add'

- [#532](https://github.com/Bike4Mind/bike4mind/pull/532) [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948) Thanks [@cgtorniado](https://github.com/cgtorniado)! - add public visibility for data lakes

- [#936](https://github.com/Bike4Mind/bike4mind/pull/936) [`18b70a8`](https://github.com/Bike4Mind/bike4mind/commit/18b70a8bc2fc8d5303682dec03994a3173ea1e78) Thanks [@wescarda](https://github.com/wescarda)! - add bobRunQueue + DLQ + worker subscription for premium-bob async runs

### Patch Changes

- [#1085](https://github.com/Bike4Mind/bike4mind/pull/1085) [`811276a`](https://github.com/Bike4Mind/bike4mind/commit/811276ac7f883b42411726a4136f03eaaf02f46e) Thanks [@StormyEmery](https://github.com/StormyEmery)! - raise sreFix lambda memory so fix dispatch can boot

- [#1116](https://github.com/Bike4Mind/bike4mind/pull/1116) [`1a1e9b3`](https://github.com/Bike4Mind/bike4mind/commit/1a1e9b337b577fb1ea37f0ccfb63b5ada0be50f6) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - allow the admin settings PUT past the WAF CommonRuleSet

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
