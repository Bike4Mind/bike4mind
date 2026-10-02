# @bike4mind/resource

## 0.9.0

### Minor Changes

- [#3450](https://github.com/Bike4Mind/bike4mind/pull/3450) [`54fc4b3`](https://github.com/Bike4Mind/bike4mind/commit/54fc4b35367733f35396eac6fba51ac3d6114d26) Thanks [@ktdejesus](https://github.com/ktdejesus)! - admin /status page for E2E runs with state-change Slack alarms

- [#3472](https://github.com/Bike4Mind/bike4mind/pull/3472) [`0008ad7`](https://github.com/Bike4Mind/bike4mind/commit/0008ad7aad57b40a93c712b9973fcc5cff4602f1) Thanks [@jarlacut](https://github.com/jarlacut)! - ingest a connected GitHub repository into its lake

- [#3487](https://github.com/Bike4Mind/bike4mind/pull/3487) [`4adcf55`](https://github.com/Bike4Mind/bike4mind/commit/4adcf5576bf96c6293c6b3a0d633230985066d36) Thanks [@onoya](https://github.com/onoya)! - completion callback for queued image and video generation

- [#3542](https://github.com/Bike4Mind/bike4mind/pull/3542) [`2eb7177`](https://github.com/Bike4Mind/bike4mind/commit/2eb71774f1137bb9b991ed90085b9ae5223275bf) Thanks [@onoya](https://github.com/onoya)! - re-sync a GitHub lake when its default branch is pushed

- [#3544](https://github.com/Bike4Mind/bike4mind/pull/3544) [`81f16c6`](https://github.com/Bike4Mind/bike4mind/commit/81f16c6fc9f6bf6d75865a7f9dd290c985f10574) Thanks [@onoya](https://github.com/onoya)! - purge a GitHub lake connection when the App loses access

### Patch Changes

- [#3501](https://github.com/Bike4Mind/bike4mind/pull/3501) [`448494a`](https://github.com/Bike4Mind/bike4mind/commit/448494ac1735f7e8e5d4781df76810e768b95031) Thanks [@aflordelis](https://github.com/aflordelis)! - move event handlers and self-host runner into apps/workers

- [#3687](https://github.com/Bike4Mind/bike4mind/pull/3687) [`d3ad08e`](https://github.com/Bike4Mind/bike4mind/commit/d3ad08e9f47d83b8e9a6f1ace9b341d2e9e3095b) Thanks [@onoya](https://github.com/onoya)! - close GitHub lake revoke/release gaps

## 0.8.0

### Minor Changes

- [#3134](https://github.com/Bike4Mind/bike4mind/pull/3134) [`e4b4032`](https://github.com/Bike4Mind/bike4mind/commit/e4b40325c25d79379755d074379f4f6de2a47d64) Thanks [@onoya](https://github.com/onoya)! - add a model-driven contradiction detection pass

- [#3359](https://github.com/Bike4Mind/bike4mind/pull/3359) [`41d7f2e`](https://github.com/Bike4Mind/bike4mind/commit/41d7f2ec3c2e6dcc5d121c3dc31214e7f97a0229) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - let the Overwatch emitter post for other products

- [#3393](https://github.com/Bike4Mind/bike4mind/pull/3393) [`dd940f7`](https://github.com/Bike4Mind/bike4mind/commit/dd940f709ea10a20393cdaeb6f5a1b35b5d942b6) Thanks [@onoya](https://github.com/onoya)! - connect one GitHub repository to a data lake, read-only

## 0.7.1

### Patch Changes

- [#2957](https://github.com/Bike4Mind/bike4mind/pull/2957) [`7aab21b`](https://github.com/Bike4Mind/bike4mind/commit/7aab21bf76b84a1572904dcd684154f725962b3e) Thanks [@onoya](https://github.com/onoya)! - declare APP_URL so CSRF-protected routes stop returning 403

## 0.7.0

### Minor Changes

- [#2762](https://github.com/Bike4Mind/bike4mind/pull/2762) [`adc900a`](https://github.com/Bike4Mind/bike4mind/commit/adc900ab152e00d3324bc228ac73c98a5cb5e2ef) Thanks [@maconard](https://github.com/maconard)! - add DeepSeek as a first-party provider and close Moonshot gaps

## 0.6.0

### Minor Changes

- [#2178](https://github.com/Bike4Mind/bike4mind/pull/2178) [`c17fbcc`](https://github.com/Bike4Mind/bike4mind/commit/c17fbccb067921f8ab1b9b352eda91285bbd9720) Thanks [@onoya](https://github.com/onoya)! - give image generation and image edit a local queue consumer

- [#2437](https://github.com/Bike4Mind/bike4mind/pull/2437) [`67efe74`](https://github.com/Bike4Mind/bike4mind/commit/67efe744faaf9289b62ac70b31cbe002426b0ee8) Thanks [@onoya](https://github.com/onoya)! - user-triggered research runs with saved configuration

### Patch Changes

- [#2060](https://github.com/Bike4Mind/bike4mind/pull/2060) [`c5c6cc6`](https://github.com/Bike4Mind/bike4mind/commit/c5c6cc6d007bfe49f6c335ebc1c18fa8272ad64b) Thanks [@poysama](https://github.com/poysama)! - register the drive-lake and lake-memory queues, and guard the drift

## 0.5.0

### Minor Changes

- [#1089](https://github.com/Bike4Mind/bike4mind/pull/1089) [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b) Thanks [@erikbethke](https://github.com/erikbethke)! - add Moonshot (Kimi) as a model provider, direct and via Bedrock

- [#1205](https://github.com/Bike4Mind/bike4mind/pull/1205) [`4e355b9`](https://github.com/Bike4Mind/bike4mind/commit/4e355b9916e4fae0a1445ed637bb5f0a37dc1e01) Thanks [@dea0030](https://github.com/dea0030)! - background AI-tag suggestion analysis after upload

- [#698](https://github.com/Bike4Mind/bike4mind/pull/698) [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4) Thanks [@maconard](https://github.com/maconard)! - add offline RAG ingestion and a background worker

## 0.4.0

### Minor Changes

- docker compose stack for self-host

- chatCompletion container in self-host and improve latency of public chat completion api.
