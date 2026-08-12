# @bike4mind/common

## 4.0.0

### Major Changes

- [#1047](https://github.com/Bike4Mind/bike4mind/pull/1047) [`1e3699a`](https://github.com/Bike4Mind/bike4mind/commit/1e3699a72f4d87b6ab0465fd401901544c3fed76) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - bound retrieval and stop silently truncating

- [#1078](https://github.com/Bike4Mind/bike4mind/pull/1078) [`120b37c`](https://github.com/Bike4Mind/bike4mind/commit/120b37c7a6abf5be317062dae10c3996a97d76e8) Thanks [@onoya](https://github.com/onoya)! - unified usage dashboard - generalize org dashboard to cover personal (User) owners

- [#1573](https://github.com/Bike4Mind/bike4mind/pull/1573) [`5ff3797`](https://github.com/Bike4Mind/bike4mind/commit/5ff3797b6b83ec20629efb24c5216288a90a84f8) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - delete the orphaned case-sensitive findByNameAndUserId

### Minor Changes

- [#1461](https://github.com/Bike4Mind/bike4mind/pull/1461) [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305) Thanks [@ken-b4m](https://github.com/ken-b4m)! - Passage-chunk limits (`DEFAULT_PASSAGE_TOKEN_TARGET`, `MIN_PASSAGE_TOKEN_TARGET`) are now exported
  from `@bike4mind/common/constants/chunking` and are the single source of truth for chunk granularity.

  The `DefaultChunkSize` admin setting's DEFAULT changes from 2100 to 512 tokens to match the chunker.
  Behavioural note for anyone bisecting a retrieval-quality change: this is a default only. A deploy
  with a value already stored in `adminsettings` keeps it, and a stored value above 512 makes the
  Knowledge/FilesSection reprocess path produce coarser chunks than `/api/files/reprocess`, which sends
  no override. The setting also gains a `min` bound so it can no longer be saved below the floor the
  chunker would silently clamp to.

- [#1013](https://github.com/Bike4Mind/bike4mind/pull/1013) [`9699565`](https://github.com/Bike4Mind/bike4mind/commit/96995652963393c86779a40386a261b4b2385cd5) Thanks [@onoya](https://github.com/onoya)! - compact context under token pressure and surface it

- [#1025](https://github.com/Bike4Mind/bike4mind/pull/1025) [`fc6307a`](https://github.com/Bike4Mind/bike4mind/commit/fc6307a5df18ccb7cf807ff4304914b363e4ea62) Thanks [@maconard](https://github.com/maconard)! - replace hardcoded model lists with a live discovery-driven registry

- [#1037](https://github.com/Bike4Mind/bike4mind/pull/1037) [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592) Thanks [@onoya](https://github.com/onoya)! - persist generated TTS/sound-effect audio as browsable FabFiles

- [#1061](https://github.com/Bike4Mind/bike4mind/pull/1061) [`9b746b6`](https://github.com/Bike4Mind/bike4mind/commit/9b746b6c560ac2feb66193075c929c71953ec3d6) Thanks [@vinchi777](https://github.com/vinchi777)! - audited read-only support view of a user's session and quests ([#955](https://github.com/Bike4Mind/bike4mind/issues/955))

- [#1067](https://github.com/Bike4Mind/bike4mind/pull/1067) [`d9d28d3`](https://github.com/Bike4Mind/bike4mind/commit/d9d28d3d89097ee33782dd2d631e77fd2db0f381) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add the per-lake system prompt editor ([#843](https://github.com/Bike4Mind/bike4mind/issues/843))

- [#1089](https://github.com/Bike4Mind/bike4mind/pull/1089) [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b) Thanks [@erikbethke](https://github.com/erikbethke)! - add Moonshot (Kimi) as a model provider, direct and via Bedrock

- [#1454](https://github.com/Bike4Mind/bike4mind/pull/1454) [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reserve attached-file budget and warn when a file will not fit

- [#1457](https://github.com/Bike4Mind/bike4mind/pull/1457) [`90717f8`](https://github.com/Bike4Mind/bike4mind/commit/90717f8a4c080738fe2ce0bddadd4fc02b6361c4) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add dormant @datalake command surface behind admin flag

- [#1482](https://github.com/Bike4Mind/bike4mind/pull/1482) [`bf8548e`](https://github.com/Bike4Mind/bike4mind/commit/bf8548e646a33e97afc2ed229cbb676c7c6033ab) Thanks [@onoya](https://github.com/onoya)! - audio_generation LLM tool (model-callable TTS + sound effects)

- [#283](https://github.com/Bike4Mind/bike4mind/pull/283) [`c632544`](https://github.com/Bike4Mind/bike4mind/commit/c632544d07271bb44d124fd3dfeb9876fc6dc536) Thanks [@baboosh](https://github.com/baboosh)! - make splash cards toggleable and add help docs

- [#442](https://github.com/Bike4Mind/bike4mind/pull/442) [`89f72cb`](https://github.com/Bike4Mind/bike4mind/commit/89f72cbdd9e7e93d59c01c51f7c55fe0396283c6) Thanks [@erikbethke](https://github.com/erikbethke)! - Mementos 2.0 - unified principal-scoped memory core

- [#532](https://github.com/Bike4Mind/bike4mind/pull/532) [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948) Thanks [@cgtorniado](https://github.com/cgtorniado)! - add public visibility for data lakes

- [#581](https://github.com/Bike4Mind/bike4mind/pull/581) [`cf2c553`](https://github.com/Bike4Mind/bike4mind/commit/cf2c5531ca947f6c3be6ffd6175ea94f0cc390c1) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - bless remaining React-artifact deps for publish

- [#587](https://github.com/Bike4Mind/bike4mind/pull/587) [`fab1452`](https://github.com/Bike4Mind/bike4mind/commit/fab1452922c8564495fb9209b346c1b91f0c7aa2) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - embed-key data model, scope & origin allow-list (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41) Phase A)

- [#599](https://github.com/Bike4Mind/bike4mind/pull/599) [`758f406`](https://github.com/Bike4Mind/bike4mind/commit/758f406376efa5ef605f79b65f576d97854c7689) Thanks [@vinchi777](https://github.com/vinchi777)! - embed-key admin UI to create, configure & revoke (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41) Phase E)

- [#608](https://github.com/Bike4Mind/bike4mind/pull/608) [`2a3162b`](https://github.com/Bike4Mind/bike4mind/commit/2a3162b2db07090b7fd74fb1ac628bcb2f421cf0) Thanks [@dea0030](https://github.com/dea0030)! - add ImageGenerationTemplate model and CRUD API

- [#613](https://github.com/Bike4Mind/bike4mind/pull/613) [`ebed878`](https://github.com/Bike4Mind/bike4mind/commit/ebed87812a188eda01788349489e33956f1de44a) Thanks [@ktdejesus](https://github.com/ktdejesus)! - margin tolerance bands, filters, adaptive layout, pricing history change log

- [#614](https://github.com/Bike4Mind/bike4mind/pull/614) [`19abb8c`](https://github.com/Bike4Mind/bike4mind/commit/19abb8c2662979fc4d0648dabfa7364ca6cdb81e) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add EnableHardwareCompute dark-ship flag for OptiHashi

- [#622](https://github.com/Bike4Mind/bike4mind/pull/622) [`40a35ea`](https://github.com/Bike4Mind/bike4mind/commit/40a35ea7f4c530fdbcbc99cf9bee771762b2da96) Thanks [@onoya](https://github.com/onoya)! - expose per-org usage dashboards to org owner/manager

- [#623](https://github.com/Bike4Mind/bike4mind/pull/623) [`b69313e`](https://github.com/Bike4Mind/bike4mind/commit/b69313ec9147a1da341e0c32f26d6af499c09fea) Thanks [@onoya](https://github.com/onoya)! - stream tool ui side-effects and add opti-scoped profile

- [#625](https://github.com/Bike4Mind/bike4mind/pull/625) [`e2e2b03`](https://github.com/Bike4Mind/bike4mind/commit/e2e2b03b1c41be581801e8b6197d3341e0bf6b02) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - app-slice operational hardening follow-ups

- [#628](https://github.com/Bike4Mind/bike4mind/pull/628) [`aa16cd8`](https://github.com/Bike4Mind/bike4mind/commit/aa16cd8e54883812cc99632ba9baf46cd124a1a3) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - enable React artifact publishing

- [#635](https://github.com/Bike4Mind/bike4mind/pull/635) [`4dffc64`](https://github.com/Bike4Mind/bike4mind/commit/4dffc64de320f4a59257febe89b1124fbe96e536) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - agent-bound embed completion endpoint w/ origin+CORS & metering (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41) - Phase B.1)

- [#640](https://github.com/Bike4Mind/bike4mind/pull/640) [`d4c3719`](https://github.com/Bike4Mind/bike4mind/commit/d4c3719a98b76093127057d7e7d5a265eebcc810) Thanks [@dea0030](https://github.com/dea0030)! - image settings templates — panel UI, apply, cost preview

- [#646](https://github.com/Bike4Mind/bike4mind/pull/646) [`27096e3`](https://github.com/Bike4Mind/bike4mind/commit/27096e3d34e80a23fa40a0c9060498d3cdf27bf4) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add admin-tunable USD-to-credits rate for hardware compute

- [#649](https://github.com/Bike4Mind/bike4mind/pull/649) [`96dd741`](https://github.com/Bike4Mind/bike4mind/commit/96dd7415e5465cc1c0318ccfe0d64c9478411024) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add per-user hardware compute spend cap settings

- [#651](https://github.com/Bike4Mind/bike4mind/pull/651) [`36b0c67`](https://github.com/Bike4Mind/bike4mind/commit/36b0c67c39b9b8b1645572202255685e2ca770e1) Thanks [@dea0030](https://github.com/dea0030)! - add a by-source breakdown to the Org Usage dashboard

- [#652](https://github.com/Bike4Mind/bike4mind/pull/652) [`7b452e9`](https://github.com/Bike4Mind/bike4mind/commit/7b452e92621fe836eec4acf1c2bd6dff06a8f95e) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - infra hardening (queue offload, reconciler cron, metrics, index drop)

- [#662](https://github.com/Bike4Mind/bike4mind/pull/662) [`26257f4`](https://github.com/Bike4Mind/bike4mind/commit/26257f4992c219acd095b209a48bf914b4ccff0a) Thanks [@MattTan257](https://github.com/MattTan257)! - register bob_panel_read as a premium overlay tool name

- [#698](https://github.com/Bike4Mind/bike4mind/pull/698) [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4) Thanks [@maconard](https://github.com/maconard)! - add offline RAG ingestion and a background worker

- [#700](https://github.com/Bike4Mind/bike4mind/pull/700) [`43b8c8d`](https://github.com/Bike4Mind/bike4mind/commit/43b8c8d65e1743f81eedad36fa4c32d3e4685738) Thanks [@maconard](https://github.com/maconard)! - local web search via searxng and keyless deep-research fallback

- [#705](https://github.com/Bike4Mind/bike4mind/pull/705) [`c8da52b`](https://github.com/Bike4Mind/bike4mind/commit/c8da52b42a7509f2b94c9436d2c3cb9b66c67c14) Thanks [@maconard](https://github.com/maconard)! - local image generation via a self-hosted Stable Diffusion backend

- [#713](https://github.com/Bike4Mind/bike4mind/pull/713) [`e60f14a`](https://github.com/Bike4Mind/bike4mind/commit/e60f14aa734c6fc41a6c59ae1fd57bb9b386aa08) Thanks [@maconard](https://github.com/maconard)! - keyless offline RAG defaults and bundled secure-exposure profiles

- [#717](https://github.com/Bike4Mind/bike4mind/pull/717) [`c4d2da6`](https://github.com/Bike4Mind/bike4mind/commit/c4d2da628bcba7c7a553dd4e9a26ff04ad258bb8) Thanks [@dea0030](https://github.com/dea0030)! - guided prompt builder + parameter guidance

- [#727](https://github.com/Bike4Mind/bike4mind/pull/727) [`a3ca585`](https://github.com/Bike4Mind/bike4mind/commit/a3ca585906fee85628701c6975062b6f16590106) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - per-embed-key spend cap with pre-flight enforcement (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41))

- [#728](https://github.com/Bike4Mind/bike4mind/pull/728) [`ab88253`](https://github.com/Bike4Mind/bike4mind/commit/ab882537269a1ccb83d18b2e71a89f2fd32934b8) Thanks [@onoya](https://github.com/onoya)! - provider-agnostic sound-effects generation API

- [#733](https://github.com/Bike4Mind/bike4mind/pull/733) [`7b6f99b`](https://github.com/Bike4Mind/bike4mind/commit/7b6f99beb0d58e4d4382c0e8e9e90925a7f5e350) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - agent-scoped KB retrieval + hard tool gate for embed chat

- [#737](https://github.com/Bike4Mind/bike4mind/pull/737) [`1332668`](https://github.com/Bike4Mind/bike4mind/commit/133266801e52d4402150e5605a994a0d8522d8fa) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - reduce executive-summary token spend via caching

- [#742](https://github.com/Bike4Mind/bike4mind/pull/742) [`5c2e209`](https://github.com/Bike4Mind/bike4mind/commit/5c2e209c36e487ed468a1c067d692b5051ba595d) Thanks [@onoya](https://github.com/onoya)! - unified multi-provider text-to-speech API

- [#749](https://github.com/Bike4Mind/bike4mind/pull/749) [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6) Thanks [@erikbethke](https://github.com/erikbethke)! - server API routes, Mongo store, WS fanout, and SPA channel view

- [#760](https://github.com/Bike4Mind/bike4mind/pull/760) [`c2f4cbc`](https://github.com/Bike4Mind/bike4mind/commit/c2f4cbc864b653c47c05c94e07495fa757331a51) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - public embed chat widget, serve route, and snippet

- [#782](https://github.com/Bike4Mind/bike4mind/pull/782) [`a948fb9`](https://github.com/Bike4Mind/bike4mind/commit/a948fb9ffe34d0e76de5a85bbb96c857f081bb6c) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reset an API key's rate-limit counters

- [#788](https://github.com/Bike4Mind/bike4mind/pull/788) [`886d408`](https://github.com/Bike4Mind/bike4mind/commit/886d40823384c9ff06ee84ab8da20ebbac3e8d3f) Thanks [@onoya](https://github.com/onoya)! - revoke sessions on logout + add admin force-logout endpoint

- [#789](https://github.com/Bike4Mind/bike4mind/pull/789) [`2e2c285`](https://github.com/Bike4Mind/bike4mind/commit/2e2c28547d92487ee89ded3129970bf27692a74b) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - generate OpenAPI 3.1 spec from Zod for /v1 endpoints (1/3)

- [#797](https://github.com/Bike4Mind/bike4mind/pull/797) [`9d1c73b`](https://github.com/Bike4Mind/bike4mind/commit/9d1c73b1c51bd6aa1380b3c2da27fc35e9e49ae0) Thanks [@erikbethke](https://github.com/erikbethke)! - v5 node-graph data model + flag scaffold

- [#798](https://github.com/Bike4Mind/bike4mind/pull/798) [`7dd0442`](https://github.com/Bike4Mind/bike4mind/commit/7dd0442f5bf54c04019da953d2187ff557ff4e0f) Thanks [@ken-b4m](https://github.com/ken-b4m)! - raise hardware compute spend caps for the High-fidelity tier

- [#799](https://github.com/Bike4Mind/bike4mind/pull/799) [`ab05d21`](https://github.com/Bike4Mind/bike4mind/commit/ab05d2112dbb61f124ff37227b40c92b667ee1d1) Thanks [@maconard](https://github.com/maconard)! - qwen3.5 default local models, qwen2.5-coder for artifacts, and Ollama thinking detection

- [#801](https://github.com/Bike4Mind/bike4mind/pull/801) [`9023927`](https://github.com/Bike4Mind/bike4mind/commit/90239272090b220c0356b2b84f525316b1dcafb9) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add optihashi_cost_chargeup generic-deduct reason

- [#859](https://github.com/Bike4Mind/bike4mind/pull/859) [`a392018`](https://github.com/Bike4Mind/bike4mind/commit/a3920185ffd1a31c1f1c228b24011ea4d58926bd) Thanks [@onoya](https://github.com/onoya)! - typed Zod response schemas at the boundary (respond helper + User)

- [#864](https://github.com/Bike4Mind/bike4mind/pull/864) [`4ca1471`](https://github.com/Bike4Mind/bike4mind/commit/4ca14711bbb459fe30969c9f58358adda37631fe) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - per-embed-key white-label theming and plan-gated branding

- [#881](https://github.com/Bike4Mind/bike4mind/pull/881) [`3d7d6f6`](https://github.com/Bike4Mind/bike4mind/commit/3d7d6f6f7601375e40dc4d36f95a088137ecb58f) Thanks [@dea0030](https://github.com/dea0030)! - allow updating per-key rate limits without rotating

- [#882](https://github.com/Bike4Mind/bike4mind/pull/882) [`ef8492a`](https://github.com/Bike4Mind/bike4mind/commit/ef8492afbeb06ea552665841efb547448786f1a4) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - serve OpenAPI spec + Scalar docs with CI drift gate (2/3)

- [#894](https://github.com/Bike4Mind/bike4mind/pull/894) [`399f2c7`](https://github.com/Bike4Mind/bike4mind/commit/399f2c7c941954e0dfd5b37e010bbeaa54ea2140) Thanks [@dea0030](https://github.com/dea0030)! - record revocation metadata so revoked keys have an audit trail

- [#902](https://github.com/Bike4Mind/bike4mind/pull/902) [`1557271`](https://github.com/Bike4Mind/bike4mind/commit/15572713aeafb5eab086833ea7faedcdd8867d32) Thanks [@cgtorniado](https://github.com/cgtorniado)! - audit admin credit adjustments across both credit paths

- [#906](https://github.com/Bike4Mind/bike4mind/pull/906) [`ee85861`](https://github.com/Bike4Mind/bike4mind/commit/ee85861d2821767d0d0648a960303ba66a19bb00) Thanks [@onoya](https://github.com/onoya)! - add languageCode passthrough for ElevenLabs

- [#934](https://github.com/Bike4Mind/bike4mind/pull/934) [`8ca1a70`](https://github.com/Bike4Mind/bike4mind/commit/8ca1a70c2b0bfbf7bccb33620cdbff83fd77cb47) Thanks [@cgtorniado](https://github.com/cgtorniado)! - add public-lake browse & discover surface

- [#946](https://github.com/Bike4Mind/bike4mind/pull/946) [`000c0b5`](https://github.com/Bike4Mind/bike4mind/commit/000c0b515913da4a894de023937131a355aa868a) Thanks [@erikbethke](https://github.com/erikbethke)! - add Claude Opus 5 (claude-opus-5)

- [#975](https://github.com/Bike4Mind/bike4mind/pull/975) [`c95fe24`](https://github.com/Bike4Mind/bike4mind/commit/c95fe2462e911310f9cbb0a7b3155dc95e1b1077) Thanks [@dea0030](https://github.com/dea0030)! - allow clearing an access gate from lake settings

- [#980](https://github.com/Bike4Mind/bike4mind/pull/980) [`c1f563e`](https://github.com/Bike4Mind/bike4mind/commit/c1f563ee248317485e4262289dec13c16e864dd7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add dormant per-lake systemPrompt model + update schema ([#843](https://github.com/Bike4Mind/bike4mind/issues/843))

- [#993](https://github.com/Bike4Mind/bike4mind/pull/993) [`0de8b32`](https://github.com/Bike4Mind/bike4mind/commit/0de8b3205b15b307b53ae45896905a29f0d9e073) Thanks [@ktdejesus](https://github.com/ktdejesus)! - opt-in purchase and subscription rows in the user credit ledger

### Patch Changes

- [#1029](https://github.com/Bike4Mind/bike4mind/pull/1029) [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - Keep uploaded documents in a notebook's context so the model can use them on later turns.

  Two contract changes ship with it and are not obvious from the title:

  - `ChatCompletionFeature.getContextMessages` drops the unused `max_tokens` parameter and
    gains `attachedFileTokenBudget`. Implementations taking positional arguments must be
    updated; `max_tokens` was declared in several signatures and read in none.
  - `processFabFilesServer` now sizes attached-file content from the model's INPUT window
    rather than its output-token cap, and divides that budget across the text files in the
    turn. A non-positive budget does not mean "unlimited" - downstream it restores a flat
    per-file cap - so callers must pass a positive value.

- [#1006](https://github.com/Bike4Mind/bike4mind/pull/1006) [`ad5921f`](https://github.com/Bike4Mind/bike4mind/commit/ad5921f531fdd2db2fa4a2a783ebde60f2566034) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - keep a computed history count from meaning unlimited

- [#1009](https://github.com/Bike4Mind/bike4mind/pull/1009) [`847c3a3`](https://github.com/Bike4Mind/bike4mind/commit/847c3a359ec1ee8d6374dd3819de8f8bb6ea269d) Thanks [@onoya](https://github.com/onoya)! - widen UiSideEffect payload union for optional solver-run outputs

- [#1010](https://github.com/Bike4Mind/bike4mind/pull/1010) [`6d01a12`](https://github.com/Bike4Mind/bike4mind/commit/6d01a124b85c54ac76d532773a44d42091ed7b83) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - let an owner retrieve their own gated lake

- [#1023](https://github.com/Bike4Mind/bike4mind/pull/1023) [`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989) Thanks [@erikbethke](https://github.com/erikbethke)! - scope API keys, reserve the human actor kind, cap machine payloads

- [#1029](https://github.com/Bike4Mind/bike4mind/pull/1029) [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - keep uploaded documents in notebook context so the model can use them

- [#1030](https://github.com/Bike4Mind/bike4mind/pull/1030) [`9d1ac0a`](https://github.com/Bike4Mind/bike4mind/commit/9d1ac0aef0622d2187e1e394d0c3ea0ecdc2d6e3) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - detect and warn on elided artifact bodies

- [#1042](https://github.com/Bike4Mind/bike4mind/pull/1042) [`42b0798`](https://github.com/Bike4Mind/bike4mind/commit/42b0798e751b28190fb2757fa37d5ab345e08eae) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - clear every membership signal when a file leaves a lake

- [#1054](https://github.com/Bike4Mind/bike4mind/pull/1054) [`67c107a`](https://github.com/Bike4Mind/bike4mind/commit/67c107ae7e40c9f5b30875853bb12a4c016c7437) Thanks [@poysama](https://github.com/poysama)! - mask sensitive admin setting values in API responses

- [#1065](https://github.com/Bike4Mind/bike4mind/pull/1065) [`05c9e5c`](https://github.com/Bike4Mind/bike4mind/commit/05c9e5cd4393667099f0bc324599311b5eff3d6a) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - justify isPlaceholderApiKey by entropy, not key structure

- [#597](https://github.com/Bike4Mind/bike4mind/pull/597) [`cc085b0`](https://github.com/Bike4Mind/bike4mind/commit/cc085b047884f1733b6c84958da4400da1712cd4) Thanks [@onoya](https://github.com/onoya)! - scope organization responses to the caller

- [#642](https://github.com/Bike4Mind/bike4mind/pull/642) [`f29a8ef`](https://github.com/Bike4Mind/bike4mind/commit/f29a8eff394568438a6126610b557f3985dc1c93) Thanks [@baboosh](https://github.com/baboosh)! - prevent artifact fragmentation from multi-line tags and special characters

- [#643](https://github.com/Bike4Mind/bike4mind/pull/643) [`c19b591`](https://github.com/Bike4Mind/bike4mind/commit/c19b59168e6c10fff8b7c4663eaa0365a3decacf) Thanks [@StormyEmery](https://github.com/StormyEmery)! - exclude unlistable lake files from knowledge-base retrieval

- [#762](https://github.com/Bike4Mind/bike4mind/pull/762) [`6b4f36e`](https://github.com/Bike4Mind/bike4mind/commit/6b4f36edfe3ff42542357eaa1a91dca90045d4dc) Thanks [@dea0030](https://github.com/dea0030)! - decouple Kontext dispatch from requiresImageInput

- [#764](https://github.com/Bike4Mind/bike4mind/pull/764) [`c604eba`](https://github.com/Bike4Mind/bike4mind/commit/c604eba580c0ebea8b58e01bba0a3d424628b789) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from AppHomeDataService

- [#765](https://github.com/Bike4Mind/bike4mind/pull/765) [`5d81e2c`](https://github.com/Bike4Mind/bike4mind/commit/5d81e2c64712792a7d65690e0f4755f4a19d2ff4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - drop usdCost from the public embed SSE allowlist

- [#802](https://github.com/Bike4Mind/bike4mind/pull/802) [`3261fac`](https://github.com/Bike4Mind/bike4mind/commit/3261facacc4e53a356dfb4d213cb335d29a89462) Thanks [@dea0030](https://github.com/dea0030)! - anchor attribute values to their opening quote so apostrophes survive ([#795](https://github.com/Bike4Mind/bike4mind/issues/795))

- [#809](https://github.com/Bike4Mind/bike4mind/pull/809) [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8) Thanks [@poysama](https://github.com/poysama)! - remediate transitive Dependabot vulns via pnpm overrides

- [#898](https://github.com/Bike4Mind/bike4mind/pull/898) [`44b63f2`](https://github.com/Bike4Mind/bike4mind/commit/44b63f28de85494f5ee71203e74670bdef1ccd04) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - enforce embed white-label entitlement against the key owner across all layers

- [#931](https://github.com/Bike4Mind/bike4mind/pull/931) [`61025c3`](https://github.com/Bike4Mind/bike4mind/commit/61025c3651db5aa06c7acd4ce292e445f05c00ed) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - roll back orphan lake/FabFiles/batch on failed wizard upload

- [#938](https://github.com/Bike4Mind/bike4mind/pull/938) [`3d37217`](https://github.com/Bike4Mind/bike4mind/commit/3d3721797e898732b5d597815c4fdfd0581de715) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - require org billing for embed:chat keys at the mint layer

- [#940](https://github.com/Bike4Mind/bike4mind/pull/940) [`eb23f3a`](https://github.com/Bike4Mind/bike4mind/commit/eb23f3a16f66c7758e84f6e486ae3058f9e13e93) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - org-admin-aware embed-key writes and org-billing guard

- [#942](https://github.com/Bike4Mind/bike4mind/pull/942) [`91cdd07`](https://github.com/Bike4Mind/bike4mind/commit/91cdd07bef6e972688f64694a06c2d4b4ab23010) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - fail fast and fall back to Ollama on a placeholder self-host embedding key

- [#962](https://github.com/Bike4Mind/bike4mind/pull/962) [`5d96e19`](https://github.com/Bike4Mind/bike4mind/commit/5d96e197961cd634cc7c4ae1fdcc1878500b7545) Thanks [@erikbethke](https://github.com/erikbethke)! - upgrade superseded xAI model pins and guard the deprecation map

- [#987](https://github.com/Bike4Mind/bike4mind/pull/987) [`51f3f35`](https://github.com/Bike4Mind/bike4mind/commit/51f3f3522f254ad095857daea891b644a5766efc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop workbench hydration from persisting a lost update

- [#990](https://github.com/Bike4Mind/bike4mind/pull/990) [`01ab7af`](https://github.com/Bike4Mind/bike4mind/commit/01ab7afbef983a8fe27c260c37828667122902a4) Thanks [@onoya](https://github.com/onoya)! - incrementally cache conversation history across ReAct iterations

- Updated dependencies [[`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989), [`7649b72`](https://github.com/Bike4Mind/bike4mind/commit/7649b72711987dc50e07b21cb0659c4b32f56221), [`a25e9ff`](https://github.com/Bike4Mind/bike4mind/commit/a25e9ff98a714cbca6980a8902e309bb6263de5e), [`04f4964`](https://github.com/Bike4Mind/bike4mind/commit/04f4964b1630bdf1e5cd178d7d6bff1bc28adb58), [`8a899b2`](https://github.com/Bike4Mind/bike4mind/commit/8a899b26677a9fab54b5652ba9c06f429b2a5abe), [`25bc463`](https://github.com/Bike4Mind/bike4mind/commit/25bc46318510bc2631d86692995c1335397d62a6), [`ccd97cd`](https://github.com/Bike4Mind/bike4mind/commit/ccd97cda43b3344ca99b5a8fa81f7819ff701ade), [`42b99f8`](https://github.com/Bike4Mind/bike4mind/commit/42b99f8a22137a01c951a60ab67cef7273e9f43b), [`87425da`](https://github.com/Bike4Mind/bike4mind/commit/87425dafa8b98d5bae718dd52763483b24aee1b5), [`dd5355f`](https://github.com/Bike4Mind/bike4mind/commit/dd5355f5c98d23fc93a603dc9a24a5da18226b16), [`fc5bfd8`](https://github.com/Bike4Mind/bike4mind/commit/fc5bfd8c3e5b14453c7d79ecfe589537b9f5eec6), [`db1655c`](https://github.com/Bike4Mind/bike4mind/commit/db1655c7072131f55b3dbdeb5a212768786fe9ef), [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6)]:
  - @bike4mind/hearth@0.2.0

## 3.0.0

### Major Changes

- reprice credits to a uniform 1.2x markup with stochastic rounding

### Minor Changes

- docker compose stack for self-host

- make credit valuation configurable via environment

- fail loud on models without a published price

- per-user AI token exchange for federated Cognito apps

- extend insufficient-credits CTA to image/video/tool generation paths

- credit lots with expiry + soonest-to-expire consumption

- admin-managed partner signup rules (domain -> entitlements + credits)

- backgroundable + pollable shell sessions for bash_execute

- make fun/novelty tools hidden by default in tools catalog

- separate Role from Product Access in the admin user panel

- record operational-model and KB embedding usage

- add settlement view to admin usage-margin endpoint

- move per-model provider prices to a versioned price catalog

- gate plans behind a launch flag (generic availabilityFlag + EnableLibreOncology)

- unauthenticated public artifact links via share token

- route Diagnostician fix dispatch through EventBridge

- organization API tokens billed to the org credit pool

- settle realtime voice from the model price catalog

- OpenAI-compat top-level params for /v1/completions

- add OpenAI GPT-5.6 Sol, Luna, and Terra models

- embed allowlist for published artifacts

- add SRE activity dashboard widget (#270)

- out-of-the-box local Ollama models (Qwen), no API keys

- per-organization usage dashboards (M1 + M2)

- provider invoice reconciliation and settlement basis report

- surface web_fetch truncation to model, UI, and telemetry

- org transaction-ledger view with filters + drill-down (M3)

- extend AI-powered file editing to .docx and .xlsx

- add xAI Grok 4.5 (grok-4.5)

- transpile React artifacts to inert bundles at publish time

- per-session usage detail with agent-execution breakdown (M4)

- default GitHub owner/repo per channel for ambiguous issue creation

- org-scoped triage connections with per-org isolation

- add EnableHybridCompute dark-ship flag for OptiHashi

- per-API-key usage breakdown on the org dashboard (M4)

### Patch Changes

- settle chat on provider-reported token usage

- rename GrokTool references to Bike4Mind

- surface Add Credits CTA on insufficient-credits chat error

- allow SSO link into unverified pure-OAuth accounts

- count all internal staff domains; unify internal-domain source of truth

- resolve internal-org display name from shared source, not a hardcoded domain

- type Confluence response formatters, drop any

- centralize user response serialization

- remove any from AdvancedAIModal (+ isBflImageModel guard)

- typed authProviders sub-schema + duplicate (strategy,id) integrity check
