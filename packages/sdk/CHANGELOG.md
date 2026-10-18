# @bike4mind/sdk

## 1.0.1

### Patch Changes

- [#4895](https://github.com/Bike4Mind/bike4mind/pull/4895) [`0b84602`](https://github.com/Bike4Mind/bike4mind/commit/0b846026127703d2925a1891afc73aec4ffaa236) Thanks [@onoya](https://github.com/onoya)! - end wait=true chat turns at a deadline instead of the Lambda timeout

## 1.0.0

### Major Changes

- [#4462](https://github.com/Bike4Mind/bike4mind/pull/4462) [`3e46049`](https://github.com/Bike4Mind/bike4mind/commit/3e46049023bdb7a05e69eb6fa2fd18577dca76a5) Thanks [@onoya](https://github.com/onoya)! - save every generated asset through saveGeneratedAsset

- [#4724](https://github.com/Bike4Mind/bike4mind/pull/4724) [`6711c5f`](https://github.com/Bike4Mind/bike4mind/commit/6711c5fe5f8d9c9f1d37e5ba7739fd9a3678a13a) Thanks [@onoya](https://github.com/onoya)! - serve generated media through short-lived signed URLs

- [#4775](https://github.com/Bike4Mind/bike4mind/pull/4775) [`a786791`](https://github.com/Bike4Mind/bike4mind/commit/a786791da684d73d4bf6ccccbb5713af175c3509) Thanks [@onoya](https://github.com/onoya)! - honour a cancel before the provider call and refuse it once a song is rendering

### Minor Changes

- [#4211](https://github.com/Bike4Mind/bike4mind/pull/4211) [`9f7195a`](https://github.com/Bike4Mind/bike4mind/commit/9f7195a28ff0128a595428a065bdf3a8c986c0bf) Thanks [@julsanchez](https://github.com/julsanchez)! - add a typed @bike4mind/sdk client generated from the OpenAPI spec

- [#4277](https://github.com/Bike4Mind/bike4mind/pull/4277) [`36ba5dd`](https://github.com/Bike4Mind/bike4mind/commit/36ba5dd550bdff2d69e677100843c5a248d38553) Thanks [@onoya](https://github.com/onoya)! - honour reasoningEffort on Claude for the completions API

- [#4602](https://github.com/Bike4Mind/bike4mind/pull/4602) [`9656d79`](https://github.com/Bike4Mind/bike4mind/commit/9656d7988332702d1c31040a31e0dc24db20d585) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add stable errorCode and byte counts to quota refusals

- [#4608](https://github.com/Bike4Mind/bike4mind/pull/4608) [`76dc400`](https://github.com/Bike4Mind/bike4mind/commit/76dc4002c6e409fc8c69b67bbce9f11182fc35b4) Thanks [@vinchi777](https://github.com/vinchi777)! - expose reasoning behaviour on GET /api/v1/models

- [#4636](https://github.com/Bike4Mind/bike4mind/pull/4636) [`d82d8b3`](https://github.com/Bike4Mind/bike4mind/commit/d82d8b309fcf73291434ad6d1add189bc84ea03e) Thanks [@jebie](https://github.com/jebie)! - advertise native tool search support on GET /api/v1/models

- [#4670](https://github.com/Bike4Mind/bike4mind/pull/4670) [`70eb763`](https://github.com/Bike4Mind/bike4mind/commit/70eb7633ee731cce9f4a41667cccd0e37bd87419) Thanks [@vinchi777](https://github.com/vinchi777)! - add the Electron desktop client

- [#4676](https://github.com/Bike4Mind/bike4mind/pull/4676) [`9052a9d`](https://github.com/Bike4Mind/bike4mind/commit/9052a9d5ddcbfad02b978dc4218e4b26c530f281) Thanks [@onoya](https://github.com/onoya)! - add the public music generation API

- [#4729](https://github.com/Bike4Mind/bike4mind/pull/4729) [`e841be1`](https://github.com/Bike4Mind/bike4mind/commit/e841be14c6840bd30f86ff8e618ddf4d0427f532) Thanks [@onoya](https://github.com/onoya)! - deprecate the sync /api/ai/music route

- [#4767](https://github.com/Bike4Mind/bike4mind/pull/4767) [`0722e63`](https://github.com/Bike4Mind/bike4mind/commit/0722e630193fedaf627e3465404c8a1d121cd62f) Thanks [@poysama](https://github.com/poysama)! - let an ai:generate key create a bare session

- [#4786](https://github.com/Bike4Mind/bike4mind/pull/4786) [`0c814ff`](https://github.com/Bike4Mind/bike4mind/commit/0c814ffd06baa6d5f9199c8c9eaaee07a137f1c6) Thanks [@onoya](https://github.com/onoya)! - typed model-call errors and one retry decision

- [#4819](https://github.com/Bike4Mind/bike4mind/pull/4819) [`c6990f9`](https://github.com/Bike4Mind/bike4mind/commit/c6990f9de2dba3e7523c15c82c3986ea3e72f2c9) Thanks [@erikbethke](https://github.com/erikbethke)! - resolve team-plan seats for plan, tier and rate limits

- [#4863](https://github.com/Bike4Mind/bike4mind/pull/4863) [`0bab465`](https://github.com/Bike4Mind/bike4mind/commit/0bab4656ac106d0513dc34a53e789ae03bd76430) Thanks [@vinchi777](https://github.com/vinchi777)! - report reasoning tokens in the completions usage event

### Patch Changes

- [#4414](https://github.com/Bike4Mind/bike4mind/pull/4414) [`d075a46`](https://github.com/Bike4Mind/bike4mind/commit/d075a46d5310069e45521a88928ec9ac710b325e) Thanks [@jarlacut](https://github.com/jarlacut)! - return real HTTP status for pre-stream completion failures

- [#4518](https://github.com/Bike4Mind/bike4mind/pull/4518) [`d9dfddf`](https://github.com/Bike4Mind/bike4mind/commit/d9dfddfa6cfff9dc63857e641b37af5963de3b35) Thanks [@jarlacut](https://github.com/jarlacut)! - return unknown_model for unrecognised completion model ids

- [#4590](https://github.com/Bike4Mind/bike4mind/pull/4590) [`32923a0`](https://github.com/Bike4Mind/bike4mind/commit/32923a0af533f65121be2f29b928bfdef4417549) Thanks [@erikbethke](https://github.com/erikbethke)! - bill video generations to the account selected in the switcher

- [#4615](https://github.com/Bike4Mind/bike4mind/pull/4615) [`aca73ca`](https://github.com/Bike4Mind/bike4mind/commit/aca73ca6908301a25aca1457c18a15b21ddd2185) Thanks [@onoya](https://github.com/onoya)! - list only the decision models the caller can use

- [#4774](https://github.com/Bike4Mind/bike4mind/pull/4774) [`268235b`](https://github.com/Bike4Mind/bike4mind/commit/268235b2a7ab08d9f6e166eedc6019d6b1d07e23) Thanks [@onoya](https://github.com/onoya)! - bill v1 media generations to the API key's billing organization

- [#4789](https://github.com/Bike4Mind/bike4mind/pull/4789) [`34d23d0`](https://github.com/Bike4Mind/bike4mind/commit/34d23d0c1dd22dc5df8f8867c9cd751c2069c0ac) Thanks [@onoya](https://github.com/onoya)! - validate ElevenLabs output format and harden the credit hold paths

- [#4805](https://github.com/Bike4Mind/bike4mind/pull/4805) [`bef1cdf`](https://github.com/Bike4Mind/bike4mind/commit/bef1cdfe235fa4dcb1e83b2c34f1854b9a601b69) Thanks [@erikbethke](https://github.com/erikbethke)! - declare BUSL-1.1 license on the CLI and SDK packages

- [#4821](https://github.com/Bike4Mind/bike4mind/pull/4821) [`769a1c8`](https://github.com/Bike4Mind/bike4mind/commit/769a1c8d6fa0557d77a46bdd3de2534ea458f3b9) Thanks [@maconard](https://github.com/maconard)! - make an existing chat search the data lake picked for it
