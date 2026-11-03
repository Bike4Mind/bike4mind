# @bike4mind/sdk

## 1.5.0

### Minor Changes

- [#5295](https://github.com/Bike4Mind/bike4mind/pull/5295) [`0f38820`](https://github.com/Bike4Mind/bike4mind/commit/0f38820d54edcac762192b46712657086dbcdc1a) Thanks [@jjmarfa](https://github.com/jjmarfa)! - add current_model_details tool and drop the identity line when it is offered

- [#5498](https://github.com/Bike4Mind/bike4mind/pull/5498) [`42f4f4a`](https://github.com/Bike4Mind/bike4mind/commit/42f4f4afb5370de9cffc4fed26440ee0cd59404c) Thanks [@onoya](https://github.com/onoya)! - admin-only confidence overrides to force the confidence gate

- [#5617](https://github.com/Bike4Mind/bike4mind/pull/5617) [`22b2349`](https://github.com/Bike4Mind/bike4mind/commit/22b23498c5ea66602b8661a64fb05b8a78d6b1a1) Thanks [@vinchi777](https://github.com/vinchi777)! - show monthly credit allowance in footer

- [#5652](https://github.com/Bike4Mind/bike4mind/pull/5652) [`a898007`](https://github.com/Bike4Mind/bike4mind/commit/a8980077a897e584a0da483a212e505e749cc117) Thanks [@biletskiy6](https://github.com/biletskiy6)! - show a still image on release notes without a video

- [#5667](https://github.com/Bike4Mind/bike4mind/pull/5667) [`e92f61a`](https://github.com/Bike4Mind/bike4mind/commit/e92f61a01812a1cd701eaf17efb49ec3fd345412) Thanks [@jjmarfa](https://github.com/jjmarfa)! - curate and price the FLUX.2 image models

- [#5781](https://github.com/Bike4Mind/bike4mind/pull/5781) [`4dfe085`](https://github.com/Bike4Mind/bike4mind/commit/4dfe085dd929e3ac7eb4304cbf95914ea8441a19) Thanks [@choyno](https://github.com/choyno)! - tighten request quotas for API keys of new accounts

- [#5784](https://github.com/Bike4Mind/bike4mind/pull/5784) [`9602802`](https://github.com/Bike4Mind/bike4mind/commit/9602802b6673fdf1e893f6c46440fd62ebfba6c5) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - daily spend cap for free-tier accounts

- [#5786](https://github.com/Bike4Mind/bike4mind/pull/5786) [`cf89ad9`](https://github.com/Bike4Mind/bike4mind/commit/cf89ad9847ccf2631f797799eab0bf92c1192262) Thanks [@onoya](https://github.com/onoya)! - restrict free-tier accounts to an admin-set model allowlist

- [#5925](https://github.com/Bike4Mind/bike4mind/pull/5925) [`dcc1738`](https://github.com/Bike4Mind/bike4mind/commit/dcc1738d6bb757e0de97a87a4d4baf5af1a673f3) Thanks [@julsanchez](https://github.com/julsanchez)! - serve Skill Market authoring to API keys under /api/v1 with a skills:write scope

- [#5935](https://github.com/Bike4Mind/bike4mind/pull/5935) [`f34fcb5`](https://github.com/Bike4Mind/bike4mind/commit/f34fcb5daa8cc8e0db1e3f26ef2a8be6814f7569) Thanks [@julsanchez](https://github.com/julsanchez)! - ship a skill's scripts and references through the Skill Market

- [#5936](https://github.com/Bike4Mind/bike4mind/pull/5936) [`a3d1905`](https://github.com/Bike4Mind/bike4mind/commit/a3d19057eb8569eef3f10f23085f9ac8a0171123) Thanks [@julsanchez](https://github.com/julsanchez)! - Skill Market bundles as one Claude Code plugin

- [#5948](https://github.com/Bike4Mind/bike4mind/pull/5948) [`02c94cf`](https://github.com/Bike4Mind/bike4mind/commit/02c94cf3eb94ba6c25427ce0e657d1119f2dacb4) Thanks [@julsanchez](https://github.com/julsanchez)! - review the Skill Market queue with a skills:review API key

- [#5960](https://github.com/Bike4Mind/bike4mind/pull/5960) [`775a594`](https://github.com/Bike4Mind/bike4mind/commit/775a5948673a9b346747a11e82ddd053c578f36a) Thanks [@ken-b4m](https://github.com/ken-b4m)! - return Claude Code tools and supporting files in the v1 listing snapshot

- [#5974](https://github.com/Bike4Mind/bike4mind/pull/5974) [`79bace3`](https://github.com/Bike4Mind/bike4mind/commit/79bace3daa0069f297a11dbc178c8091bbdb2739) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - publish the agent authoring assistants as v1 contracts

### Patch Changes

- [#5463](https://github.com/Bike4Mind/bike4mind/pull/5463) [`dd17bbe`](https://github.com/Bike4Mind/bike4mind/commit/dd17bbe1c5a148e550b00452944e6aef178ca809) Thanks [@vinchi777](https://github.com/vinchi777)! - reject unsupported assistant prefill

- [#5558](https://github.com/Bike4Mind/bike4mind/pull/5558) [`b057019`](https://github.com/Bike4Mind/bike4mind/commit/b0570190c06f5370569c182a92facd62f20de8a1) Thanks [@onoya](https://github.com/onoya)! - queue ElevenLabs calls behind shared concurrency slots

- [#5594](https://github.com/Bike4Mind/bike4mind/pull/5594) [`d2097fc`](https://github.com/Bike4Mind/bike4mind/commit/d2097fc17c7ee638326a4b2d34dbb56fc97a63b8) Thanks [@onoya](https://github.com/onoya)! - make the admin Moderate action block AI features

- [#5752](https://github.com/Bike4Mind/bike4mind/pull/5752) [`4bfc517`](https://github.com/Bike4Mind/bike4mind/commit/4bfc517ba4e36a7cbb6315c5d1f296c756b2a0fa) Thanks [@onoya](https://github.com/onoya)! - meter text refinement and keep unmetered AI helpers off API keys

- [#5940](https://github.com/Bike4Mind/bike4mind/pull/5940) [`2707102`](https://github.com/Bike4Mind/bike4mind/commit/27071028499e8fd833868eebc158e5c7a32d8a34) Thanks [@jjmarfa](https://github.com/jjmarfa)! - classify reasoning output-budget exhaustion as a documented 422/502

- [#5955](https://github.com/Bike4Mind/bike4mind/pull/5955) [`a295054`](https://github.com/Bike4Mind/bike4mind/commit/a2950546d13fbf978e70ee33156e6094db9aabcd) Thanks [@ken-b4m](https://github.com/ken-b4m)! - clear open Dependabot alerts with in-major overrides and bumps

- [#6074](https://github.com/Bike4Mind/bike4mind/pull/6074) [`be31cb6`](https://github.com/Bike4Mind/bike4mind/commit/be31cb636173debf4646a25802af9529c7a388bf) Thanks [@vinchi777](https://github.com/vinchi777)! - retire the shut-down Veo 3.1 Fast preview model

## 1.4.0

### Minor Changes

- [#5159](https://github.com/Bike4Mind/bike4mind/pull/5159) [`e0f2069`](https://github.com/Bike4Mind/bike4mind/commit/e0f2069b4640c1323b66161ed9d6e7a5ffd61c04) Thanks [@biletskiy6](https://github.com/biletskiy6)! - show a product video in a What's New slide

- [#5164](https://github.com/Bike4Mind/bike4mind/pull/5164) [`edecc8d`](https://github.com/Bike4Mind/bike4mind/commit/edecc8dd12d0b7bd99123b1b64cba319bb8bcc1c) Thanks [@julsanchez](https://github.com/julsanchez)! - serve an org's Skill Market listings as a Claude Code plugin marketplace

- [#5256](https://github.com/Bike4Mind/bike4mind/pull/5256) [`0e0284e`](https://github.com/Bike4Mind/bike4mind/commit/0e0284e08221bbb80caf0e317192759ca66935e5) Thanks [@onoya](https://github.com/onoya)! - record per-turn timing and retries on the quest

- [#5428](https://github.com/Bike4Mind/bike4mind/pull/5428) [`d0f839c`](https://github.com/Bike4Mind/bike4mind/commit/d0f839cb64f6db020c5184c038dca4a971cfed47) Thanks [@jebie](https://github.com/jebie)! - native tool search on Bedrock

- [#5434](https://github.com/Bike4Mind/bike4mind/pull/5434) [`55fbaf1`](https://github.com/Bike4Mind/bike4mind/commit/55fbaf1aa3906a8c1fbd73960aa6e3cfaa4f66c9) Thanks [@onoya](https://github.com/onoya)! - role-tagged video generation inputs

- [#5520](https://github.com/Bike4Mind/bike4mind/pull/5520) [`b13304e`](https://github.com/Bike4Mind/bike4mind/commit/b13304e18ae26ccac766546e4495d9f0f88ef0f1) Thanks [@jjmarfa](https://github.com/jjmarfa)! - publish text refinement as a v1 contract

### Patch Changes

- [#5035](https://github.com/Bike4Mind/bike4mind/pull/5035) [`556feb1`](https://github.com/Bike4Mind/bike4mind/commit/556feb12ee8f51a8d6876317a4b95043acfc87b2) Thanks [@julsanchez](https://github.com/julsanchez)! - hold or gate credits before TTS, transcription, tools and agent runs

- [#5460](https://github.com/Bike4Mind/bike4mind/pull/5460) [`0741792`](https://github.com/Bike4Mind/bike4mind/commit/074179264f77d6c72938e1d9769c906727d1b801) Thanks [@vinchi777](https://github.com/vinchi777)! - classify upstream caller errors

- [#5461](https://github.com/Bike4Mind/bike4mind/pull/5461) [`318e6a5`](https://github.com/Bike4Mind/bike4mind/commit/318e6a5f7b1ab8a512eb7fb44dee7d634ae20c75) Thanks [@vinchi777](https://github.com/vinchi777)! - reject empty effective messages

- [#5499](https://github.com/Bike4Mind/bike4mind/pull/5499) [`74c6ac2`](https://github.com/Bike4Mind/bike4mind/commit/74c6ac23923bcf866c76efdfccd44abbb1ca66e1) Thanks [@jjmarfa](https://github.com/jjmarfa)! - document prompt_upsampling in the public image API

## 1.3.0

### Minor Changes

- [#5191](https://github.com/Bike4Mind/bike4mind/pull/5191) [`a68d013`](https://github.com/Bike4Mind/bike4mind/commit/a68d013d2a4c7a59268f3bfbb2ed9b343a0a36c0) Thanks [@jjmarfa](https://github.com/jjmarfa)! - add a decide tool for agent loops and the CLI

### Patch Changes

- [#5173](https://github.com/Bike4Mind/bike4mind/pull/5173) [`7bc69c7`](https://github.com/Bike4Mind/bike4mind/commit/7bc69c780cf2e3def64cd650fb82412c6fa91a53) Thanks [@onoya](https://github.com/onoya)! - bill an org-billed API key's organization on agent runs and /api/ai/llm

## 1.2.0

### Minor Changes

- [#5134](https://github.com/Bike4Mind/bike4mind/pull/5134) [`d1d146c`](https://github.com/Bike4Mind/bike4mind/commit/d1d146c73a2adebe4bd3ecf54facccd7a8514e14) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - accept mid-conversation tool changes on Anthropic models

### Patch Changes

- [#5038](https://github.com/Bike4Mind/bike4mind/pull/5038) [`9f6f66b`](https://github.com/Bike4Mind/bike4mind/commit/9f6f66b28964425db2fa7b1fecee47fcc5fc2aaa) Thanks [@julsanchez](https://github.com/julsanchez)! - bind uploads to their measured size and moderate every animation frame

- [#5139](https://github.com/Bike4Mind/bike4mind/pull/5139) [`f43c31e`](https://github.com/Bike4Mind/bike4mind/commit/f43c31e5001a396f02d17121b2d4654e50cc980c) Thanks [@poysama](https://github.com/poysama)! - note npm trusted publishing in client-auth and sdk READMEs

## 1.1.1

### Patch Changes

- [#5037](https://github.com/Bike4Mind/bike4mind/pull/5037) [`a467516`](https://github.com/Bike4Mind/bike4mind/commit/a467516775c4123320ca7079babce53aeec52869) Thanks [@julsanchez](https://github.com/julsanchez)! - hold and settle credits for research configs, thinking budgets and aborted turns

- [#5056](https://github.com/Bike4Mind/bike4mind/pull/5056) [`73c675c`](https://github.com/Bike4Mind/bike4mind/commit/73c675c64e0be1189c0aa8e4c1c59a86ab388104) Thanks [@jjmarfa](https://github.com/jjmarfa)! - bill sound effects and speech to the selected account

- [#5061](https://github.com/Bike4Mind/bike4mind/pull/5061) [`6f32290`](https://github.com/Bike4Mind/bike4mind/commit/6f322902280cea3fb7ed745e10ea49d47a186f8d) Thanks [@jjmarfa](https://github.com/jjmarfa)! - accept organization_id alias on image generation and edit bodies

- [#5085](https://github.com/Bike4Mind/bike4mind/pull/5085) [`d299e48`](https://github.com/Bike4Mind/bike4mind/commit/d299e483d13449ccf91cd3471dde95f0e83cc487) Thanks [@erikbethke](https://github.com/erikbethke)! - align model prices with provider rate cards

## 1.1.0

### Minor Changes

- [#4654](https://github.com/Bike4Mind/bike4mind/pull/4654) [`57d3468`](https://github.com/Bike4Mind/bike4mind/commit/57d3468c31107cd5b5e7fa819d2ad8b224f02498) Thanks [@jebie](https://github.com/jebie)! - native tool search on direct Anthropic

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
