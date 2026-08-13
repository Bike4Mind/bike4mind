# @bike4mind/hearth

## 0.2.0

### Minor Changes

- [#1024](https://github.com/Bike4Mind/bike4mind/pull/1024) [`7649b72`](https://github.com/Bike4Mind/bike4mind/commit/7649b72711987dc50e07b21cb0659c4b32f56221) Thanks [@erikbethke](https://github.com/erikbethke)! - profile toggle, gated sidenav entry, gears reveal, and per-actor colors

- [#1081](https://github.com/Bike4Mind/bike4mind/pull/1081) [`a25e9ff`](https://github.com/Bike4Mind/bike4mind/commit/a25e9ff98a714cbca6980a8902e309bb6263de5e) Thanks [@erikbethke](https://github.com/erikbethke)! - per-session actor identity and tiered hook disclosure

- [#1084](https://github.com/Bike4Mind/bike4mind/pull/1084) [`04f4964`](https://github.com/Bike4Mind/bike4mind/commit/04f4964b1630bdf1e5cd178d7d6bff1bc28adb58) Thanks [@erikbethke](https://github.com/erikbethke)! - presence roster projection

- [#1088](https://github.com/Bike4Mind/bike4mind/pull/1088) [`8a899b2`](https://github.com/Bike4Mind/bike4mind/commit/8a899b26677a9fab54b5652ba9c06f429b2a5abe) Thanks [@erikbethke](https://github.com/erikbethke)! - cc-bridge writes presence into the Hearth log

- [#1091](https://github.com/Bike4Mind/bike4mind/pull/1091) [`25bc463`](https://github.com/Bike4Mind/bike4mind/commit/25bc46318510bc2631d86692995c1335397d62a6) Thanks [@erikbethke](https://github.com/erikbethke)! - expire presence events, keep facts permanent

- [#695](https://github.com/Bike4Mind/bike4mind/pull/695) [`db1655c`](https://github.com/Bike4Mind/bike4mind/commit/db1655c7072131f55b3dbdeb5a212768786fe9ef) Thanks [@erikbethke](https://github.com/erikbethke)! - add hearth core package with append-only event log, actors, cursors, channels

- [#749](https://github.com/Bike4Mind/bike4mind/pull/749) [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6) Thanks [@erikbethke](https://github.com/erikbethke)! - server API routes, Mongo store, WS fanout, and SPA channel view

### Patch Changes

- [#1023](https://github.com/Bike4Mind/bike4mind/pull/1023) [`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989) Thanks [@erikbethke](https://github.com/erikbethke)! - scope API keys, reserve the human actor kind, cap machine payloads

- [#1094](https://github.com/Bike4Mind/bike4mind/pull/1094) [`ccd97cd`](https://github.com/Bike4Mind/bike4mind/commit/ccd97cda43b3344ca99b5a8fa81f7819ff701ade) Thanks [@erikbethke](https://github.com/erikbethke)! - gate bridge dual-write on EnableHearth and fail closed on malformed disclosure

- [#1097](https://github.com/Bike4Mind/bike4mind/pull/1097) [`42b99f8`](https://github.com/Bike4Mind/bike4mind/commit/42b99f8a22137a01c951a60ab67cef7273e9f43b) Thanks [@erikbethke](https://github.com/erikbethke)! - derive presence state from the hook event name at low disclosure tiers

- [#1145](https://github.com/Bike4Mind/bike4mind/pull/1145) [`87425da`](https://github.com/Bike4Mind/bike4mind/commit/87425dafa8b98d5bae718dd52763483b24aee1b5) Thanks [@erikbethke](https://github.com/erikbethke)! - give each CLI session its own actor, and color actors in the CLI

- [#1155](https://github.com/Bike4Mind/bike4mind/pull/1155) [`dd5355f`](https://github.com/Bike4Mind/bike4mind/commit/dd5355f5c98d23fc93a603dc9a24a5da18226b16) Thanks [@erikbethke](https://github.com/erikbethke)! - harden the presence roster against bad reasons, races, and growth

- [#1455](https://github.com/Bike4Mind/bike4mind/pull/1455) [`fc5bfd8`](https://github.com/Bike4Mind/bike4mind/commit/fc5bfd8c3e5b14453c7d79ecfe589537b9f5eec6) Thanks [@vinchi777](https://github.com/vinchi777)! - converge bridge and hook onto one presence contract
