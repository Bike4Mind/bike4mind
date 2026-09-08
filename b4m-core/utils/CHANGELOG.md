# @bike4mind/utils

## 4.2.0

### Minor Changes

- [#1887](https://github.com/Bike4Mind/bike4mind/pull/1887) [`b76236b`](https://github.com/Bike4Mind/bike4mind/commit/b76236b0d4698acfb4403329fb1bbb1ff1e2f49d) Thanks [@onoya](https://github.com/onoya)! - owner-triggered convergence toward the chunk policy ([#1681](https://github.com/Bike4Mind/bike4mind/issues/1681))

### Patch Changes

- [#1755](https://github.com/Bike4Mind/bike4mind/pull/1755) [`bf81dd1`](https://github.com/Bike4Mind/bike4mind/commit/bf81dd10ad034b8579b6224ce45c7296b69ee1e9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - populate promptMeta fields nothing ever wrote

- [#1823](https://github.com/Bike4Mind/bike4mind/pull/1823) [`184cb4e`](https://github.com/Bike4Mind/bike4mind/commit/184cb4e36e68d42eb26d92b6c2851214f261ac12) Thanks [@dea0030](https://github.com/dea0030)! - stop dropping image-generation params at invoke boundary

- [#1847](https://github.com/Bike4Mind/bike4mind/pull/1847) [`fdcf36a`](https://github.com/Bike4Mind/bike4mind/commit/fdcf36ae431604a775e689db8ca7f5d72b8804ba) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - bound QuestMaster history replay and close two redaction gaps

- [#1997](https://github.com/Bike4Mind/bike4mind/pull/1997) [`8f68920`](https://github.com/Bike4Mind/bike4mind/commit/8f68920798c2e5617368531d43d6ea80c8855fe9) Thanks [@onoya](https://github.com/onoya)! - make the passage-rebuild marker atomic with the reset that creates the state

- [#2068](https://github.com/Bike4Mind/bike4mind/pull/2068) [`1901bb2`](https://github.com/Bike4Mind/bike4mind/commit/1901bb2489b4b0c797d501ff2848f3658077c84a) Thanks [@vinchi777](https://github.com/vinchi777)! - send the user message once in raw prompt mode

- [#2154](https://github.com/Bike4Mind/bike4mind/pull/2154) [`63d0783`](https://github.com/Bike4Mind/bike4mind/commit/63d0783fb8120b7d4249aec0348986c0ee4e33f4) Thanks [@onoya](https://github.com/onoya)! - degrade rapid-reply to its fallback chain instead of hard-failing on a sunset model

- Updated dependencies [[`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367), [`525f033`](https://github.com/Bike4Mind/bike4mind/commit/525f03368f978196a3ea434f7ee39a48e45243a2), [`37454b6`](https://github.com/Bike4Mind/bike4mind/commit/37454b686642fc0da72cb33e4be0113091489ad2), [`bf81dd1`](https://github.com/Bike4Mind/bike4mind/commit/bf81dd10ad034b8579b6224ce45c7296b69ee1e9), [`f5ba462`](https://github.com/Bike4Mind/bike4mind/commit/f5ba46259b065515d8ff4f053235ddc0b1c5c795), [`f1edc9c`](https://github.com/Bike4Mind/bike4mind/commit/f1edc9cce1a8c9133a45d37fb844991e3c0de076), [`595a3c4`](https://github.com/Bike4Mind/bike4mind/commit/595a3c4d054a121f3147c2be08a610ab917b1427), [`0e33727`](https://github.com/Bike4Mind/bike4mind/commit/0e33727cd5a086a9d730d35462af72e48f34ac9b), [`da0acd2`](https://github.com/Bike4Mind/bike4mind/commit/da0acd2ec1311888cf8ad2395c05f7ad38666f6e), [`3bd4ad6`](https://github.com/Bike4Mind/bike4mind/commit/3bd4ad6828ea78f7b1e6d9897ccaa7fda08e964b), [`3e7c1e9`](https://github.com/Bike4Mind/bike4mind/commit/3e7c1e9ab0becb26160db8d93e6d6af3fa5b97b5), [`c4b7962`](https://github.com/Bike4Mind/bike4mind/commit/c4b7962f5fbd52b283548cafc775ea065c5f85b0), [`a19bf36`](https://github.com/Bike4Mind/bike4mind/commit/a19bf362a74750595cd23302fbab2fd4a5bc86d8), [`fd148e9`](https://github.com/Bike4Mind/bike4mind/commit/fd148e9746eec8a4bcf7754f0154b6905c9d6f07), [`95c7198`](https://github.com/Bike4Mind/bike4mind/commit/95c7198d085d3e10411605fe267975da44fd1bcd), [`d1c8650`](https://github.com/Bike4Mind/bike4mind/commit/d1c8650647bb49ad2b22310310fae75e6550391c), [`8bfaf05`](https://github.com/Bike4Mind/bike4mind/commit/8bfaf056e6ab009116ac5563c9ac8d1f417aaaa4), [`e49346a`](https://github.com/Bike4Mind/bike4mind/commit/e49346a617d10bc8ec15b05e0626975d85e2a720), [`cdf7dc9`](https://github.com/Bike4Mind/bike4mind/commit/cdf7dc927716e0034811ac6c4075b0a6de481f1f), [`3e60eac`](https://github.com/Bike4Mind/bike4mind/commit/3e60eac7a5c1929aaebde34ef1c40c3eb1c3d9fc), [`184cb4e`](https://github.com/Bike4Mind/bike4mind/commit/184cb4e36e68d42eb26d92b6c2851214f261ac12), [`eb230ef`](https://github.com/Bike4Mind/bike4mind/commit/eb230ef2a0d2bf5ebde4e950001bf0f7a571d4d3), [`bf8b6c1`](https://github.com/Bike4Mind/bike4mind/commit/bf8b6c1133763432bac2443d7724403a2ac84f80), [`2aa3254`](https://github.com/Bike4Mind/bike4mind/commit/2aa32546e79f795cb51af3afe7254af1b925060c), [`376856f`](https://github.com/Bike4Mind/bike4mind/commit/376856fa2433e0333c4e31c01b09a3ccc9917729), [`d9bc5f0`](https://github.com/Bike4Mind/bike4mind/commit/d9bc5f0d08e261177ecac2c1e70da801d80e2386), [`4fda73d`](https://github.com/Bike4Mind/bike4mind/commit/4fda73dffcd208127a2cdf258469ff5ce8654ad4), [`8da0adc`](https://github.com/Bike4Mind/bike4mind/commit/8da0adcb9e74a7afd6ed7633f66691330c6fad44), [`ec0a7a9`](https://github.com/Bike4Mind/bike4mind/commit/ec0a7a99ff43dabd963597ebd940bcf21b866966), [`c115fec`](https://github.com/Bike4Mind/bike4mind/commit/c115fec6c74f414940cd9597c3168fafefe3e8b0), [`b76236b`](https://github.com/Bike4Mind/bike4mind/commit/b76236b0d4698acfb4403329fb1bbb1ff1e2f49d), [`7edcf84`](https://github.com/Bike4Mind/bike4mind/commit/7edcf84060227e9384274dccbbde54c197d25425), [`2180d34`](https://github.com/Bike4Mind/bike4mind/commit/2180d347c173445b5d01a5b4862292e71c16b21a), [`6265d9a`](https://github.com/Bike4Mind/bike4mind/commit/6265d9a82abd90580b554e707866a9330ebca75a), [`a7dac96`](https://github.com/Bike4Mind/bike4mind/commit/a7dac96d93e989399e0675df482a43fdfbdce7b5), [`61aa2be`](https://github.com/Bike4Mind/bike4mind/commit/61aa2bedbea473630009bf3cb817233d09bc3d8e), [`aee1ae9`](https://github.com/Bike4Mind/bike4mind/commit/aee1ae92e282fd948ebaa9c0155dc915a4014d7c), [`8f530a3`](https://github.com/Bike4Mind/bike4mind/commit/8f530a32d6b20d0c5fb93841b80f3b6a499e6c27), [`79e9515`](https://github.com/Bike4Mind/bike4mind/commit/79e9515a622c9176551d8285e958d07560185803), [`914da78`](https://github.com/Bike4Mind/bike4mind/commit/914da7856b153c94e3c308e1c290cda7ec25d2fe), [`7ceea1e`](https://github.com/Bike4Mind/bike4mind/commit/7ceea1e54bfdc3259d8068134f2ddbafd56a262a), [`1a19d8f`](https://github.com/Bike4Mind/bike4mind/commit/1a19d8f089fbe9075c6129abe6954bb693258374), [`da1b102`](https://github.com/Bike4Mind/bike4mind/commit/da1b102bf15adf7bd960d8d104b98d822d7151a1), [`12e6b6a`](https://github.com/Bike4Mind/bike4mind/commit/12e6b6a42e19b78176d67d75bdec1d9f195e1c44), [`461fcd7`](https://github.com/Bike4Mind/bike4mind/commit/461fcd7ed0bcf1c4089329ba055915caf9f66e5e), [`a4fcb93`](https://github.com/Bike4Mind/bike4mind/commit/a4fcb93eeae40df65f14bf17910a00c9f57e8437), [`4c7122b`](https://github.com/Bike4Mind/bike4mind/commit/4c7122bbbc5e3c03e73b2c4cac9c8b45579df7dc), [`c97f73d`](https://github.com/Bike4Mind/bike4mind/commit/c97f73d5a6f2231ac8e581f1789f43af9e69b9c7), [`b255a0d`](https://github.com/Bike4Mind/bike4mind/commit/b255a0d03cc04b417355fe6cf33d66863f134662), [`08cf107`](https://github.com/Bike4Mind/bike4mind/commit/08cf1075eb2834b155adf461f2e03ed2e37e6a11), [`c3e5ab6`](https://github.com/Bike4Mind/bike4mind/commit/c3e5ab69e2e30bde319565b847acc24aa00387df), [`d775d5c`](https://github.com/Bike4Mind/bike4mind/commit/d775d5c3308bb443b15ea62547d6ff0d5cddfbe8), [`1445c44`](https://github.com/Bike4Mind/bike4mind/commit/1445c44b596f24f86f5f33bbf590e6d11210759d), [`d575bb0`](https://github.com/Bike4Mind/bike4mind/commit/d575bb0a5b90fa1729f2b4fb8a060d14ff34746b), [`8f68920`](https://github.com/Bike4Mind/bike4mind/commit/8f68920798c2e5617368531d43d6ea80c8855fe9), [`3d788bd`](https://github.com/Bike4Mind/bike4mind/commit/3d788bd9365c3e7dc2b344e20e32ac6153ad2beb), [`644ae9e`](https://github.com/Bike4Mind/bike4mind/commit/644ae9e289640b3f4e56f9eb6e3a9e7ad5d2d72e), [`36c26fd`](https://github.com/Bike4Mind/bike4mind/commit/36c26fd1bb6b3a08072032738c25b301b166a5e8), [`fe42856`](https://github.com/Bike4Mind/bike4mind/commit/fe4285649365d4494bbfa4ba8ea56030373cdb74), [`f79d864`](https://github.com/Bike4Mind/bike4mind/commit/f79d8641c802e50ec0f5f6e9e74b5ce7ab24444a), [`75cf435`](https://github.com/Bike4Mind/bike4mind/commit/75cf4359a3ac18de8c7a6dae4dbace495b4d8bef), [`e55790f`](https://github.com/Bike4Mind/bike4mind/commit/e55790f6daa2281cc45a786821221b81c0893d4b), [`cefb930`](https://github.com/Bike4Mind/bike4mind/commit/cefb930d19a48c800d8199071284b16dd8907e21), [`0b24f62`](https://github.com/Bike4Mind/bike4mind/commit/0b24f6272a8a56b06e2df321b848a26a95333a9f), [`9158cf0`](https://github.com/Bike4Mind/bike4mind/commit/9158cf086acd1b9d7863a9ea76b932280d4460ac), [`323718c`](https://github.com/Bike4Mind/bike4mind/commit/323718c8691d506cbe26cd74f7cfd4a73e28ff61), [`83a6254`](https://github.com/Bike4Mind/bike4mind/commit/83a625434a791a0bbbbcd38ddb93d3a20db23160), [`dbcf733`](https://github.com/Bike4Mind/bike4mind/commit/dbcf733569d659bb818818f11d8298ec3062a0f1), [`2068806`](https://github.com/Bike4Mind/bike4mind/commit/206880678ce77b39c4782b94d63715bdea4d35c6), [`6185bb1`](https://github.com/Bike4Mind/bike4mind/commit/6185bb10f611fc32dc06b88941c81799027ced75), [`6d3390e`](https://github.com/Bike4Mind/bike4mind/commit/6d3390e0989a0acfd1dcbe8b26f6ed3bb3db3bb6), [`5da4b0a`](https://github.com/Bike4Mind/bike4mind/commit/5da4b0a44a12b48745c4bef70ae9ac65b6cf640b), [`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367), [`dde7b36`](https://github.com/Bike4Mind/bike4mind/commit/dde7b365998accc4f97ff0475df46d00b477e019), [`4981f5a`](https://github.com/Bike4Mind/bike4mind/commit/4981f5a0ffd69e716a1d3879aac99ede78a3cfef), [`deb6ddf`](https://github.com/Bike4Mind/bike4mind/commit/deb6ddfe8d8083a8bcca715cbc730d778a3fe43b), [`9e29782`](https://github.com/Bike4Mind/bike4mind/commit/9e2978286aaa5c6b1e2a08c9744a98f0ff62ee4b)]:
  - @bike4mind/common@6.0.0
  - @bike4mind/fab-pipeline@1.2.0
  - @bike4mind/llm-adapters@0.12.0

## 4.1.0

### Minor Changes

- [#1734](https://github.com/Bike4Mind/bike4mind/pull/1734) [`472f90d`](https://github.com/Bike4Mind/bike4mind/commit/472f90d7f9387a879757ffa81746845ad93a93b2) Thanks [@Illia025](https://github.com/Illia025)! - cost governance - spend levers in the admin panel, enforced at the vectorize gate

### Patch Changes

- [#1528](https://github.com/Bike4Mind/bike4mind/pull/1528) [`da0f7ab`](https://github.com/Bike4Mind/bike4mind/commit/da0f7abd8decb98b13cb3c006a2a4f21e294a974) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - don't race a fresh upload against the knowledge tool

- [#1754](https://github.com/Bike4Mind/bike4mind/pull/1754) [`cb58a53`](https://github.com/Bike4Mind/bike4mind/commit/cb58a5394c377c8250ff7dafa0a251652be2a87a) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - shrink the always-on chat prompt footprint

- Updated dependencies [[`3a3aef0`](https://github.com/Bike4Mind/bike4mind/commit/3a3aef0b59afe349f2f5e78ff3c693ea98f616e7), [`8e03a0e`](https://github.com/Bike4Mind/bike4mind/commit/8e03a0ed6430e40280db316e2301a0f20a8ddc57), [`c9f2085`](https://github.com/Bike4Mind/bike4mind/commit/c9f208569698a2a1ec8210923493d1c460cefbca), [`0b4e580`](https://github.com/Bike4Mind/bike4mind/commit/0b4e58050f10e92ec4f6fad32017d28c54a9d0ae), [`9fad658`](https://github.com/Bike4Mind/bike4mind/commit/9fad658b6504fa00b85045b028aa23c8d27d7bb2), [`472f90d`](https://github.com/Bike4Mind/bike4mind/commit/472f90d7f9387a879757ffa81746845ad93a93b2), [`9fc991e`](https://github.com/Bike4Mind/bike4mind/commit/9fc991e214af4fd2b1442759dc37528e74b33f11), [`de702ea`](https://github.com/Bike4Mind/bike4mind/commit/de702ea4ada1f91ad26167f2d7899a336cf647da), [`50b52a5`](https://github.com/Bike4Mind/bike4mind/commit/50b52a5fb5f3344b56bd4644b3a2154ca51fe31e), [`7c8240c`](https://github.com/Bike4Mind/bike4mind/commit/7c8240ce7aa7ab839ad3ac7cc42aa51bc4fa9055), [`c46c8a4`](https://github.com/Bike4Mind/bike4mind/commit/c46c8a46e33df208d4547be6cd07b79add171ef2), [`e805cbe`](https://github.com/Bike4Mind/bike4mind/commit/e805cbe54ebd5c7d1113769d9e28875b79a71fe9), [`1507c14`](https://github.com/Bike4Mind/bike4mind/commit/1507c143605a375cce15735d4a953c3ee470bc7d)]:
  - @bike4mind/common@5.0.0
  - @bike4mind/fab-pipeline@1.1.0
  - @bike4mind/llm-adapters@0.11.2

## 4.0.0

### Major Changes

- [#1688](https://github.com/Bike4Mind/bike4mind/pull/1688) [`851e2c2`](https://github.com/Bike4Mind/bike4mind/commit/851e2c26928c92c574d9310e2eec8e268f672882) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - return debug info from buildAndSortMessages

### Minor Changes

- [#1713](https://github.com/Bike4Mind/bike4mind/pull/1713) [`ed20c15`](https://github.com/Bike4Mind/bike4mind/commit/ed20c1595a1a3bdfcd2b67302b1a0d05a713e826) Thanks [@onoya](https://github.com/onoya)! - scoped settings resolver (platform -> org -> owner -> lake)

### Patch Changes

- Updated dependencies [[`abc90f5`](https://github.com/Bike4Mind/bike4mind/commit/abc90f562e15caa46428fc94afa3ffff410e5d5c)]:
  - @bike4mind/common@4.0.1
  - @bike4mind/fab-pipeline@1.0.1
  - @bike4mind/llm-adapters@0.11.1

## 3.1.0

### Minor Changes

- [#1013](https://github.com/Bike4Mind/bike4mind/pull/1013) [`9699565`](https://github.com/Bike4Mind/bike4mind/commit/96995652963393c86779a40386a261b4b2385cd5) Thanks [@onoya](https://github.com/onoya)! - compact context under token pressure and surface it

- [#1025](https://github.com/Bike4Mind/bike4mind/pull/1025) [`fc6307a`](https://github.com/Bike4Mind/bike4mind/commit/fc6307a5df18ccb7cf807ff4304914b363e4ea62) Thanks [@maconard](https://github.com/maconard)! - replace hardcoded model lists with a live discovery-driven registry

- [#1037](https://github.com/Bike4Mind/bike4mind/pull/1037) [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592) Thanks [@onoya](https://github.com/onoya)! - persist generated TTS/sound-effect audio as browsable FabFiles

- [#1089](https://github.com/Bike4Mind/bike4mind/pull/1089) [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b) Thanks [@erikbethke](https://github.com/erikbethke)! - add Moonshot (Kimi) as a model provider, direct and via Bedrock

- [#1454](https://github.com/Bike4Mind/bike4mind/pull/1454) [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reserve attached-file budget and warn when a file will not fit

- [#586](https://github.com/Bike4Mind/bike4mind/pull/586) [`a08949c`](https://github.com/Bike4Mind/bike4mind/commit/a08949cb625d2d3d6f7bc2c86f3828eb20d483e4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - multi-hop provider-outage fallback + fallback badge clarity

- [#625](https://github.com/Bike4Mind/bike4mind/pull/625) [`e2e2b03`](https://github.com/Bike4Mind/bike4mind/commit/e2e2b03b1c41be581801e8b6197d3341e0bf6b02) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - app-slice operational hardening follow-ups

- [#628](https://github.com/Bike4Mind/bike4mind/pull/628) [`aa16cd8`](https://github.com/Bike4Mind/bike4mind/commit/aa16cd8e54883812cc99632ba9baf46cd124a1a3) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - enable React artifact publishing

- [#698](https://github.com/Bike4Mind/bike4mind/pull/698) [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4) Thanks [@maconard](https://github.com/maconard)! - add offline RAG ingestion and a background worker

- [#705](https://github.com/Bike4Mind/bike4mind/pull/705) [`c8da52b`](https://github.com/Bike4Mind/bike4mind/commit/c8da52b42a7509f2b94c9436d2c3cb9b66c67c14) Thanks [@maconard](https://github.com/maconard)! - local image generation via a self-hosted Stable Diffusion backend

- [#728](https://github.com/Bike4Mind/bike4mind/pull/728) [`ab88253`](https://github.com/Bike4Mind/bike4mind/commit/ab882537269a1ccb83d18b2e71a89f2fd32934b8) Thanks [@onoya](https://github.com/onoya)! - provider-agnostic sound-effects generation API

- [#742](https://github.com/Bike4Mind/bike4mind/pull/742) [`5c2e209`](https://github.com/Bike4Mind/bike4mind/commit/5c2e209c36e487ed468a1c067d692b5051ba595d) Thanks [@onoya](https://github.com/onoya)! - unified multi-provider text-to-speech API

- [#906](https://github.com/Bike4Mind/bike4mind/pull/906) [`ee85861`](https://github.com/Bike4Mind/bike4mind/commit/ee85861d2821767d0d0648a960303ba66a19bb00) Thanks [@onoya](https://github.com/onoya)! - add languageCode passthrough for ElevenLabs

- [#946](https://github.com/Bike4Mind/bike4mind/pull/946) [`000c0b5`](https://github.com/Bike4Mind/bike4mind/commit/000c0b515913da4a894de023937131a355aa868a) Thanks [@erikbethke](https://github.com/erikbethke)! - add Claude Opus 5 (claude-opus-5)

### Patch Changes

- [#1004](https://github.com/Bike4Mind/bike4mind/pull/1004) [`c09e844`](https://github.com/Bike4Mind/bike4mind/commit/c09e84486c087c8a108b802cf5d9d1b63ea5fa91) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - Guarantee attached-file content a share of the chat token budget, and tell the model whenever content was cut.

  An attached file could lose the whole input budget to conversation history and arrive empty, while the
  model answered confidently from nothing - indistinguishable from a correct answer unless you already
  held the file. Attached content now has a floor of the assembly budget, and unused reserve flows back
  to history.

  Cuts are now declared at every stage that makes one. A head-sliced file, a set of similarity-ranked
  excerpts, and a truncated fetched page each carry their own wording, so the model no longer reads a
  fragment as a whole document or names a mid-file row as the last. `truncationMethod` distinguishes a
  budget loss from configured history windowing instead of reporting the latter for both.

  Also fixed: `cosineSearch` returns up to ten chunks rather than three, which was starving small
  embedders, and excerpts arrive in file order rather than score order. A vectorized file delivered
  whole but with its last chunk cut to fit is now marked as truncated rather than as a set of
  non-contiguous excerpts.

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

- [#1028](https://github.com/Bike4Mind/bike4mind/pull/1028) [`55cc590`](https://github.com/Bike4Mind/bike4mind/commit/55cc5901ca051b8b5d9c4de02a42c5828b18adfe) Thanks [@ken-b4m](https://github.com/ken-b4m)! - gzip large counterLogs responses to stay under Lambda's response limit

- [#1029](https://github.com/Bike4Mind/bike4mind/pull/1029) [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - keep uploaded documents in notebook context so the model can use them

- [#1030](https://github.com/Bike4Mind/bike4mind/pull/1030) [`9d1ac0a`](https://github.com/Bike4Mind/bike4mind/commit/9d1ac0aef0622d2187e1e394d0c3ea0ecdc2d6e3) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - detect and warn on elided artifact bodies

- [#1159](https://github.com/Bike4Mind/bike4mind/pull/1159) [`cdd3a09`](https://github.com/Bike4Mind/bike4mind/commit/cdd3a09854f08fee25a71a53b42b76fb64a33c7d) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from notificationDeduplicator

- [#642](https://github.com/Bike4Mind/bike4mind/pull/642) [`f29a8ef`](https://github.com/Bike4Mind/bike4mind/commit/f29a8eff394568438a6126610b557f3985dc1c93) Thanks [@baboosh](https://github.com/baboosh)! - prevent artifact fragmentation from multi-line tags and special characters

- [#643](https://github.com/Bike4Mind/bike4mind/pull/643) [`c19b591`](https://github.com/Bike4Mind/bike4mind/commit/c19b59168e6c10fff8b7c4663eaa0365a3decacf) Thanks [@StormyEmery](https://github.com/StormyEmery)! - exclude unlistable lake files from knowledge-base retrieval

- [#699](https://github.com/Bike4Mind/bike4mind/pull/699) [`7901ec1`](https://github.com/Bike4Mind/bike4mind/commit/7901ec1e668fe2a55e1e128d2c2c5b26dcca5e12) Thanks [@maconard](https://github.com/maconard)! - recover small-model tool-call artifacts and deliver images to vision models

- [#739](https://github.com/Bike4Mind/bike4mind/pull/739) [`c324761`](https://github.com/Bike4Mind/bike4mind/commit/c324761fd20870fea316f5da63214e7fbb07c55d) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from image generation services

- [#793](https://github.com/Bike4Mind/bike4mind/pull/793) [`d083562`](https://github.com/Bike4Mind/bike4mind/commit/d08356278004a036c0c90d079b655ecb8260ba21) Thanks [@onoya](https://github.com/onoya)! - stop bundling server-only services/utils code into the CLI ([#660](https://github.com/Bike4Mind/bike4mind/issues/660))

- [#802](https://github.com/Bike4Mind/bike4mind/pull/802) [`3261fac`](https://github.com/Bike4Mind/bike4mind/commit/3261facacc4e53a356dfb4d213cb335d29a89462) Thanks [@dea0030](https://github.com/dea0030)! - anchor attribute values to their opening quote so apostrophes survive ([#795](https://github.com/Bike4Mind/bike4mind/issues/795))

- [#809](https://github.com/Bike4Mind/bike4mind/pull/809) [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8) Thanks [@poysama](https://github.com/poysama)! - remediate transitive Dependabot vulns via pnpm overrides

- [#987](https://github.com/Bike4Mind/bike4mind/pull/987) [`51f3f35`](https://github.com/Bike4Mind/bike4mind/commit/51f3f3522f254ad095857daea891b644a5766efc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop workbench hydration from persisting a lost update

- [#991](https://github.com/Bike4Mind/bike4mind/pull/991) [`ec61517`](https://github.com/Bike4Mind/bike4mind/commit/ec6151734c62cb681c85866e003776040f776bed) Thanks [@ktdejesus](https://github.com/ktdejesus)! - remove pre-cutover tracker references from logs and a test title

- Updated dependencies [[`c09e844`](https://github.com/Bike4Mind/bike4mind/commit/c09e84486c087c8a108b802cf5d9d1b63ea5fa91), [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305), [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9), [`393cf48`](https://github.com/Bike4Mind/bike4mind/commit/393cf482cbf13dc77e4c26e9b8a7d395fe3353d9), [`ad5921f`](https://github.com/Bike4Mind/bike4mind/commit/ad5921f531fdd2db2fa4a2a783ebde60f2566034), [`847c3a3`](https://github.com/Bike4Mind/bike4mind/commit/847c3a359ec1ee8d6374dd3819de8f8bb6ea269d), [`6d01a12`](https://github.com/Bike4Mind/bike4mind/commit/6d01a124b85c54ac76d532773a44d42091ed7b83), [`9699565`](https://github.com/Bike4Mind/bike4mind/commit/96995652963393c86779a40386a261b4b2385cd5), [`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989), [`fc6307a`](https://github.com/Bike4Mind/bike4mind/commit/fc6307a5df18ccb7cf807ff4304914b363e4ea62), [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9), [`9d1ac0a`](https://github.com/Bike4Mind/bike4mind/commit/9d1ac0aef0622d2187e1e394d0c3ea0ecdc2d6e3), [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592), [`42b0798`](https://github.com/Bike4Mind/bike4mind/commit/42b0798e751b28190fb2757fa37d5ab345e08eae), [`1e3699a`](https://github.com/Bike4Mind/bike4mind/commit/1e3699a72f4d87b6ab0465fd401901544c3fed76), [`67c107a`](https://github.com/Bike4Mind/bike4mind/commit/67c107ae7e40c9f5b30875853bb12a4c016c7437), [`9b746b6`](https://github.com/Bike4Mind/bike4mind/commit/9b746b6c560ac2feb66193075c929c71953ec3d6), [`05c9e5c`](https://github.com/Bike4Mind/bike4mind/commit/05c9e5cd4393667099f0bc324599311b5eff3d6a), [`5990451`](https://github.com/Bike4Mind/bike4mind/commit/5990451279e3ee9058615051711a6e243218a587), [`d9d28d3`](https://github.com/Bike4Mind/bike4mind/commit/d9d28d3d89097ee33782dd2d631e77fd2db0f381), [`120b37c`](https://github.com/Bike4Mind/bike4mind/commit/120b37c7a6abf5be317062dae10c3996a97d76e8), [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b), [`6e84c0d`](https://github.com/Bike4Mind/bike4mind/commit/6e84c0d760ca11a1175f9a8042c53eab4276a0b6), [`a8d15d3`](https://github.com/Bike4Mind/bike4mind/commit/a8d15d3aa4f3a8a6dbc309731db1aa5dd49ef4ba), [`59088ab`](https://github.com/Bike4Mind/bike4mind/commit/59088ab8f1cd217d12110770041bb43c79840142), [`c6b9eb1`](https://github.com/Bike4Mind/bike4mind/commit/c6b9eb1c0e62077e43e57ff6c78d7263c3e56dad), [`dc52359`](https://github.com/Bike4Mind/bike4mind/commit/dc5235923732a525f1b9dac2846426bb64a227ba), [`4845a87`](https://github.com/Bike4Mind/bike4mind/commit/4845a87b855e9016e52c4a9514008a22edb5260e), [`cc97fe6`](https://github.com/Bike4Mind/bike4mind/commit/cc97fe6a79940598e7f1700dc38113d597d7ebb1), [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb), [`90717f8`](https://github.com/Bike4Mind/bike4mind/commit/90717f8a4c080738fe2ce0bddadd4fc02b6361c4), [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305), [`1d26e34`](https://github.com/Bike4Mind/bike4mind/commit/1d26e34a64bc0e1497acf37bee3dc35d61a7f3cc), [`bf8548e`](https://github.com/Bike4Mind/bike4mind/commit/bf8548e646a33e97afc2ed229cbb676c7c6033ab), [`76d7e98`](https://github.com/Bike4Mind/bike4mind/commit/76d7e988422ddd811cd57d2c797f91dd95a729dc), [`95fbfa4`](https://github.com/Bike4Mind/bike4mind/commit/95fbfa4d70eb2e24a8981544d174a41583994fa8), [`5ff3797`](https://github.com/Bike4Mind/bike4mind/commit/5ff3797b6b83ec20629efb24c5216288a90a84f8), [`c632544`](https://github.com/Bike4Mind/bike4mind/commit/c632544d07271bb44d124fd3dfeb9876fc6dc536), [`89f72cb`](https://github.com/Bike4Mind/bike4mind/commit/89f72cbdd9e7e93d59c01c51f7c55fe0396283c6), [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948), [`cf2c553`](https://github.com/Bike4Mind/bike4mind/commit/cf2c5531ca947f6c3be6ffd6175ea94f0cc390c1), [`fab1452`](https://github.com/Bike4Mind/bike4mind/commit/fab1452922c8564495fb9209b346c1b91f0c7aa2), [`cc085b0`](https://github.com/Bike4Mind/bike4mind/commit/cc085b047884f1733b6c84958da4400da1712cd4), [`758f406`](https://github.com/Bike4Mind/bike4mind/commit/758f406376efa5ef605f79b65f576d97854c7689), [`2a3162b`](https://github.com/Bike4Mind/bike4mind/commit/2a3162b2db07090b7fd74fb1ac628bcb2f421cf0), [`ebed878`](https://github.com/Bike4Mind/bike4mind/commit/ebed87812a188eda01788349489e33956f1de44a), [`19abb8c`](https://github.com/Bike4Mind/bike4mind/commit/19abb8c2662979fc4d0648dabfa7364ca6cdb81e), [`40a35ea`](https://github.com/Bike4Mind/bike4mind/commit/40a35ea7f4c530fdbcbc99cf9bee771762b2da96), [`b69313e`](https://github.com/Bike4Mind/bike4mind/commit/b69313ec9147a1da341e0c32f26d6af499c09fea), [`e2e2b03`](https://github.com/Bike4Mind/bike4mind/commit/e2e2b03b1c41be581801e8b6197d3341e0bf6b02), [`aa16cd8`](https://github.com/Bike4Mind/bike4mind/commit/aa16cd8e54883812cc99632ba9baf46cd124a1a3), [`4dffc64`](https://github.com/Bike4Mind/bike4mind/commit/4dffc64de320f4a59257febe89b1124fbe96e536), [`d4c3719`](https://github.com/Bike4Mind/bike4mind/commit/d4c3719a98b76093127057d7e7d5a265eebcc810), [`f29a8ef`](https://github.com/Bike4Mind/bike4mind/commit/f29a8eff394568438a6126610b557f3985dc1c93), [`c19b591`](https://github.com/Bike4Mind/bike4mind/commit/c19b59168e6c10fff8b7c4663eaa0365a3decacf), [`27096e3`](https://github.com/Bike4Mind/bike4mind/commit/27096e3d34e80a23fa40a0c9060498d3cdf27bf4), [`96dd741`](https://github.com/Bike4Mind/bike4mind/commit/96dd7415e5465cc1c0318ccfe0d64c9478411024), [`36b0c67`](https://github.com/Bike4Mind/bike4mind/commit/36b0c67c39b9b8b1645572202255685e2ca770e1), [`7b452e9`](https://github.com/Bike4Mind/bike4mind/commit/7b452e92621fe836eec4acf1c2bd6dff06a8f95e), [`4585043`](https://github.com/Bike4Mind/bike4mind/commit/4585043f39f4e57e052047239834fa281dc34141), [`26257f4`](https://github.com/Bike4Mind/bike4mind/commit/26257f4992c219acd095b209a48bf914b4ccff0a), [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4), [`7901ec1`](https://github.com/Bike4Mind/bike4mind/commit/7901ec1e668fe2a55e1e128d2c2c5b26dcca5e12), [`43b8c8d`](https://github.com/Bike4Mind/bike4mind/commit/43b8c8d65e1743f81eedad36fa4c32d3e4685738), [`c8da52b`](https://github.com/Bike4Mind/bike4mind/commit/c8da52b42a7509f2b94c9436d2c3cb9b66c67c14), [`e60f14a`](https://github.com/Bike4Mind/bike4mind/commit/e60f14aa734c6fc41a6c59ae1fd57bb9b386aa08), [`c4d2da6`](https://github.com/Bike4Mind/bike4mind/commit/c4d2da628bcba7c7a553dd4e9a26ff04ad258bb8), [`a3ca585`](https://github.com/Bike4Mind/bike4mind/commit/a3ca585906fee85628701c6975062b6f16590106), [`ab88253`](https://github.com/Bike4Mind/bike4mind/commit/ab882537269a1ccb83d18b2e71a89f2fd32934b8), [`7b6f99b`](https://github.com/Bike4Mind/bike4mind/commit/7b6f99beb0d58e4d4382c0e8e9e90925a7f5e350), [`1332668`](https://github.com/Bike4Mind/bike4mind/commit/133266801e52d4402150e5605a994a0d8522d8fa), [`5c2e209`](https://github.com/Bike4Mind/bike4mind/commit/5c2e209c36e487ed468a1c067d692b5051ba595d), [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6), [`c2f4cbc`](https://github.com/Bike4Mind/bike4mind/commit/c2f4cbc864b653c47c05c94e07495fa757331a51), [`6b4f36e`](https://github.com/Bike4Mind/bike4mind/commit/6b4f36edfe3ff42542357eaa1a91dca90045d4dc), [`c604eba`](https://github.com/Bike4Mind/bike4mind/commit/c604eba580c0ebea8b58e01bba0a3d424628b789), [`5d81e2c`](https://github.com/Bike4Mind/bike4mind/commit/5d81e2c64712792a7d65690e0f4755f4a19d2ff4), [`a948fb9`](https://github.com/Bike4Mind/bike4mind/commit/a948fb9ffe34d0e76de5a85bbb96c857f081bb6c), [`886d408`](https://github.com/Bike4Mind/bike4mind/commit/886d40823384c9ff06ee84ab8da20ebbac3e8d3f), [`2e2c285`](https://github.com/Bike4Mind/bike4mind/commit/2e2c28547d92487ee89ded3129970bf27692a74b), [`9d1c73b`](https://github.com/Bike4Mind/bike4mind/commit/9d1c73b1c51bd6aa1380b3c2da27fc35e9e49ae0), [`7dd0442`](https://github.com/Bike4Mind/bike4mind/commit/7dd0442f5bf54c04019da953d2187ff557ff4e0f), [`ab05d21`](https://github.com/Bike4Mind/bike4mind/commit/ab05d2112dbb61f124ff37227b40c92b667ee1d1), [`9023927`](https://github.com/Bike4Mind/bike4mind/commit/90239272090b220c0356b2b84f525316b1dcafb9), [`3261fac`](https://github.com/Bike4Mind/bike4mind/commit/3261facacc4e53a356dfb4d213cb335d29a89462), [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8), [`a392018`](https://github.com/Bike4Mind/bike4mind/commit/a3920185ffd1a31c1f1c228b24011ea4d58926bd), [`4ca1471`](https://github.com/Bike4Mind/bike4mind/commit/4ca14711bbb459fe30969c9f58358adda37631fe), [`3d7d6f6`](https://github.com/Bike4Mind/bike4mind/commit/3d7d6f6f7601375e40dc4d36f95a088137ecb58f), [`ef8492a`](https://github.com/Bike4Mind/bike4mind/commit/ef8492afbeb06ea552665841efb547448786f1a4), [`399f2c7`](https://github.com/Bike4Mind/bike4mind/commit/399f2c7c941954e0dfd5b37e010bbeaa54ea2140), [`44b63f2`](https://github.com/Bike4Mind/bike4mind/commit/44b63f28de85494f5ee71203e74670bdef1ccd04), [`1557271`](https://github.com/Bike4Mind/bike4mind/commit/15572713aeafb5eab086833ea7faedcdd8867d32), [`ee85861`](https://github.com/Bike4Mind/bike4mind/commit/ee85861d2821767d0d0648a960303ba66a19bb00), [`61025c3`](https://github.com/Bike4Mind/bike4mind/commit/61025c3651db5aa06c7acd4ce292e445f05c00ed), [`8ca1a70`](https://github.com/Bike4Mind/bike4mind/commit/8ca1a70c2b0bfbf7bccb33620cdbff83fd77cb47), [`3d37217`](https://github.com/Bike4Mind/bike4mind/commit/3d3721797e898732b5d597815c4fdfd0581de715), [`eb23f3a`](https://github.com/Bike4Mind/bike4mind/commit/eb23f3a16f66c7758e84f6e486ae3058f9e13e93), [`91cdd07`](https://github.com/Bike4Mind/bike4mind/commit/91cdd07bef6e972688f64694a06c2d4b4ab23010), [`000c0b5`](https://github.com/Bike4Mind/bike4mind/commit/000c0b515913da4a894de023937131a355aa868a), [`5d96e19`](https://github.com/Bike4Mind/bike4mind/commit/5d96e197961cd634cc7c4ae1fdcc1878500b7545), [`b960ba8`](https://github.com/Bike4Mind/bike4mind/commit/b960ba8d6229df95f787c842eb315c3331d6ba2f), [`cc63f75`](https://github.com/Bike4Mind/bike4mind/commit/cc63f75ab8119a9a2160d906c0b789626ffcd960), [`bf8dbbd`](https://github.com/Bike4Mind/bike4mind/commit/bf8dbbd8f050608d52588b32108ce098a2a5047e), [`c95fe24`](https://github.com/Bike4Mind/bike4mind/commit/c95fe2462e911310f9cbb0a7b3155dc95e1b1077), [`beca7a0`](https://github.com/Bike4Mind/bike4mind/commit/beca7a095c9266cef2dd22169a005f5b96e44ccf), [`c1f563e`](https://github.com/Bike4Mind/bike4mind/commit/c1f563ee248317485e4262289dec13c16e864dd7), [`51f3f35`](https://github.com/Bike4Mind/bike4mind/commit/51f3f3522f254ad095857daea891b644a5766efc), [`68b36d1`](https://github.com/Bike4Mind/bike4mind/commit/68b36d1945ac9ba757f6c59b0a3e7417cb95223c), [`01ab7af`](https://github.com/Bike4Mind/bike4mind/commit/01ab7afbef983a8fe27c260c37828667122902a4), [`0de8b32`](https://github.com/Bike4Mind/bike4mind/commit/0de8b3205b15b307b53ae45896905a29f0d9e073)]:
  - @bike4mind/llm-adapters@0.11.0
  - @bike4mind/common@4.0.0
  - @bike4mind/fab-pipeline@1.0.0

## 3.0.0

### Major Changes

- reprice credits to a uniform 1.2x markup with stochastic rounding

### Minor Changes

- chatCompletion container in self-host and improve latency of public chat completion api.

- record operational-model and KB embedding usage

- add OpenAI GPT-5.6 Sol, Luna, and Terra models

- subdomain-aware domain-gated artifact visibility + audit

- extend AI-powered file editing to .docx and .xlsx

- cross-path fallback for sustained Bedrock outages

### Patch Changes

- render AI HTML articles as preview, not raw source

- replace exceljs with write-excel-file in excel_generation

- Updated dependencies:
  - @bike4mind/common@3.0.0
  - @bike4mind/llm-adapters@0.10.0
  - @bike4mind/fab-pipeline@0.5.1
