# @bike4mind/common

## 7.0.0

### Major Changes

- [#2147](https://github.com/Bike4Mind/bike4mind/pull/2147) [`49f96c3`](https://github.com/Bike4Mind/bike4mind/commit/49f96c3ca5303a29ac6acb318d6178a7ec7efa48) Thanks [@vinchi777](https://github.com/vinchi777)! - Chunk-stall markers move off `FabFile.notes` into their own fields. `findDataLakeHealthMembers` and
  `findLakeConvergenceMembers` rename a required `notes: string | null` to
  `chunkStallReason: ChunkStallReason | null`; the deprecated note-string aliases cannot cover that.
  `IndexStateFile` renames the same field, optional on both sides - a caller still passing the old
  shape type-checks but reads `undefined` and silently never trips `isChunkStalled`, which is why the
  services bump is a major too.

- [#2197](https://github.com/Bike4Mind/bike4mind/pull/2197) [`2351bad`](https://github.com/Bike4Mind/bike4mind/commit/2351bad305a9ea7a249669078792d970f40e73a6) Thanks [@onoya](https://github.com/onoya)! - bound embedding throughput by tokens, and by membership not batchId

- [#2216](https://github.com/Bike4Mind/bike4mind/pull/2216) [`354f3c6`](https://github.com/Bike4Mind/bike4mind/commit/354f3c65b4a9e84401801e3e868f217c7454cd3f) Thanks [@onoya](https://github.com/onoya)! - make the membership predicate express registry lakes

  BREAKING CHANGE: `DataLakeMembershipScope` is now a discriminated union and requires a `kind`
  discriminant (`'owned'` | `'registry'`). Any construction site must say which membership model it
  means; the compiler flags each one. Previously a creator-less scope silently degraded to
  meta-tag-only matching, which under-counted registry lakes against their own file list.

### Minor Changes

- [#1932](https://github.com/Bike4Mind/bike4mind/pull/1932) [`1bdf739`](https://github.com/Bike4Mind/bike4mind/commit/1bdf7391cc8f83d42b2b00ecab7b528e5a3c0d09) Thanks [@vinchi777](https://github.com/vinchi777)! - verifiable permanent deletion for one lake document

- [#2072](https://github.com/Bike4Mind/bike4mind/pull/2072) [`70ec2a6`](https://github.com/Bike4Mind/bike4mind/commit/70ec2a68decf31e67edc8d354115b0ef7299730f) Thanks [@onoya](https://github.com/onoya)! - expose the agent-executor pipeline over REST

- [#2196](https://github.com/Bike4Mind/bike4mind/pull/2196) [`1d65698`](https://github.com/Bike4Mind/bike4mind/commit/1d656985af6f8c2b3b2a486d932feca5e541a9cd) Thanks [@onoya](https://github.com/onoya)! - show partial knowledge-base coverage on the reply itself

- [#2207](https://github.com/Bike4Mind/bike4mind/pull/2207) [`55fb6c3`](https://github.com/Bike4Mind/bike4mind/commit/55fb6c39ffc7e881293dc715594770f43c865e1a) Thanks [@onoya](https://github.com/onoya)! - instrument forced retrieval's abstain exits

- [#2227](https://github.com/Bike4Mind/bike4mind/pull/2227) [`68cfd6b`](https://github.com/Bike4Mind/bike4mind/commit/68cfd6b0458c9c45a387cd24ab46399ed5afbca9) Thanks [@onoya](https://github.com/onoya)! - separate an unindexed corpus from a genuine failure in the retrieval outcome

- [#2252](https://github.com/Bike4Mind/bike4mind/pull/2252) [`f191816`](https://github.com/Bike4Mind/bike4mind/commit/f19181619bceed9c225ca4586305fb219cdb2589) Thanks [@ken-b4m](https://github.com/ken-b4m)! - make lake-member removal reversible by any lake manager

- [#2262](https://github.com/Bike4Mind/bike4mind/pull/2262) [`f712bb8`](https://github.com/Bike4Mind/bike4mind/commit/f712bb827c37af41c43d26ef9e5b4c607ee7f056) Thanks [@vinchi777](https://github.com/vinchi777)! - ingest a very large Drive folder across several runs

- [#2264](https://github.com/Bike4Mind/bike4mind/pull/2264) [`1cd2b7d`](https://github.com/Bike4Mind/bike4mind/commit/1cd2b7d520bd9150e54c3f8a3df2f1bc2b51afcd) Thanks [@onoya](https://github.com/onoya)! - record whether a turn's retrieval was forced or merely offered

- [#2268](https://github.com/Bike4Mind/bike4mind/pull/2268) [`9b317ab`](https://github.com/Bike4Mind/bike4mind/commit/9b317ab5825776b433e69a1d8f255a12e8be625b) Thanks [@onoya](https://github.com/onoya)! - read the embedding provider's real rate limits from the admin panel

- [#2270](https://github.com/Bike4Mind/bike4mind/pull/2270) [`32f72a1`](https://github.com/Bike4Mind/bike4mind/commit/32f72a160b0bb5827dd9a458ea16a6adb7abae39) Thanks [@choyno](https://github.com/choyno)! - give lake health a membership dimension

- [#2274](https://github.com/Bike4Mind/bike4mind/pull/2274) [`b0b13bf`](https://github.com/Bike4Mind/bike4mind/commit/b0b13bf82601945d456dd0bf59b3aecf19eed137) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add a lake-scoped door to set a file's tags under a lake's prefix

- [#2277](https://github.com/Bike4Mind/bike4mind/pull/2277) [`ea49d82`](https://github.com/Bike4Mind/bike4mind/commit/ea49d82a08e85ff27a43699b7ecdd85a526857c5) Thanks [@juicewaa](https://github.com/juicewaa)! - collapse superseded lake members before ranking, scoped per lake

- [#2282](https://github.com/Bike4Mind/bike4mind/pull/2282) [`8c183d3`](https://github.com/Bike4Mind/bike4mind/commit/8c183d3f6b7ce48eaf1e8bfe61e82e18332cf9b2) Thanks [@vinchi777](https://github.com/vinchi777)! - surface membership arm and allow attaching existing files

- [#2312](https://github.com/Bike4Mind/bike4mind/pull/2312) [`cc0e8e3`](https://github.com/Bike4Mind/bike4mind/commit/cc0e8e3ae147c45f375e8ddecea5503e97fb78e7) Thanks [@juicewaa](https://github.com/juicewaa)! - make the candidate-selection rule visible and lake-attributable

### Patch Changes

- [#1929](https://github.com/Bike4Mind/bike4mind/pull/1929) [`920a061`](https://github.com/Bike4Mind/bike4mind/commit/920a061ec7c079a86b8e4b8a2627b631af8e8fef) Thanks [@vinchi777](https://github.com/vinchi777)! - Price the pre-flight credit hold on a realistic output size instead of the model's
  full max-output ceiling, so a turn that will not actually use the ceiling no longer
  gets blocked by a worst-case reservation. Reasoning models that spend reasoning
  tokens inside their output budget get a larger reservation ceiling than other
  models. The per-member organization credit cap is unaffected by this change: it is
  still priced on the unshrunk ceiling at both the chat and CLI completion paths, and
  on the CLI path that unshrunk figure is now used where an unrelated, smaller default
  budget was used before - callers without an explicit output budget on an org-billed
  key may see the per-member cap trigger sooner than before.

- [#1930](https://github.com/Bike4Mind/bike4mind/pull/1930) [`51b306b`](https://github.com/Bike4Mind/bike4mind/commit/51b306b8b5c12062e54bd586f51a80c35e581f99) Thanks [@vinchi777](https://github.com/vinchi777)! - make Discover show gated public lakes to gate holders

- [#2064](https://github.com/Bike4Mind/bike4mind/pull/2064) [`787c867`](https://github.com/Bike4Mind/bike4mind/commit/787c867b9445547e05a4ab32c69cd58716aa3c53) Thanks [@vinchi777](https://github.com/vinchi777)! - claim the transitional lifecycle statuses atomically

- [#2066](https://github.com/Bike4Mind/bike4mind/pull/2066) [`116346b`](https://github.com/Bike4Mind/bike4mind/commit/116346b680d797c539e5112086aae7ed91f36273) Thanks [@jarlacut](https://github.com/jarlacut)! - stop one unusable id from failing a whole notebook export

- [#2100](https://github.com/Bike4Mind/bike4mind/pull/2100) [`f2f9b3d`](https://github.com/Bike4Mind/bike4mind/commit/f2f9b3d6ae4dc69aa763b15bfc5af3f8e7ada12c) Thanks [@jarlacut](https://github.com/jarlacut)! - skip ids that cannot address a row instead of throwing

- [#2103](https://github.com/Bike4Mind/bike4mind/pull/2103) [`a467b99`](https://github.com/Bike4Mind/bike4mind/commit/a467b99c43e695a3c1657a08ddd874da4e2438ca) Thanks [@choyno](https://github.com/choyno)! - validate and bound failedFileIds on upload-complete

- [#2126](https://github.com/Bike4Mind/bike4mind/pull/2126) [`1c39465`](https://github.com/Bike4Mind/bike4mind/commit/1c394654b3ace280b8b0941742d09fbb01a236a8) Thanks [@choyno](https://github.com/choyno)! - exclude convergence-paused files from the chunk rescue sweep

- [#2131](https://github.com/Bike4Mind/bike4mind/pull/2131) [`95d158a`](https://github.com/Bike4Mind/bike4mind/commit/95d158a96782d16dceb7e56e9984ed7ab7bb5cd9) Thanks [@vinchi777](https://github.com/vinchi777)! - guard the partial vectorize rollup against a stale write

- [#2143](https://github.com/Bike4Mind/bike4mind/pull/2143) [`469c391`](https://github.com/Bike4Mind/bike4mind/commit/469c391f0e9d48ba9285210f00f597bdafb26810) Thanks [@vinchi777](https://github.com/vinchi777)! - make a failed vectorize enqueue recoverable

- [#2159](https://github.com/Bike4Mind/bike4mind/pull/2159) [`545e51b`](https://github.com/Bike4Mind/bike4mind/commit/545e51b5a17c439ba7bd303bd4033fe0b8d4cd37) Thanks [@choyno](https://github.com/choyno)! - treat a zero or elapsed Retry-After as no hint, not as zero backoff

- [#2204](https://github.com/Bike4Mind/bike4mind/pull/2204) [`e465103`](https://github.com/Bike4Mind/bike4mind/commit/e465103247d17e39750edc7bc9a7dddee249db7e) Thanks [@vinchi777](https://github.com/vinchi777)! - release the Drive connection when its lake is purged

- [#2219](https://github.com/Bike4Mind/bike4mind/pull/2219) [`ad5801f`](https://github.com/Bike4Mind/bike4mind/commit/ad5801f5d44cfd198e424af10c9780aff3c04643) Thanks [@choyno](https://github.com/choyno)! - honour a Retry-After only when it asks the caller to wait

- [#2220](https://github.com/Bike4Mind/bike4mind/pull/2220) [`7703e89`](https://github.com/Bike4Mind/bike4mind/commit/7703e8901332dc54d0533f0784dbfbb21df7772d) Thanks [@onoya](https://github.com/onoya)! - stamp TTFVT on the first visible token, not the first chunk

- [#2234](https://github.com/Bike4Mind/bike4mind/pull/2234) [`3ac67a8`](https://github.com/Bike4Mind/bike4mind/commit/3ac67a8ef1540c89b885458d2dedb4be77a3d752) Thanks [@erikbethke](https://github.com/erikbethke)! - deliver attachment content on the agent path and report every drop

- [#2249](https://github.com/Bike4Mind/bike4mind/pull/2249) [`4af59ad`](https://github.com/Bike4Mind/bike4mind/commit/4af59adbd76c4de00d78db6c8f3d2ed9eeea7085) Thanks [@erikbethke](https://github.com/erikbethke)! - stop agent mode auto-engaging on ordinary prompts and dropping Smart Tools

- [#2250](https://github.com/Bike4Mind/bike4mind/pull/2250) [`72430db`](https://github.com/Bike4Mind/bike4mind/commit/72430db9a825facba11528fbd04ad620d91761f7) Thanks [@ken-b4m](https://github.com/ken-b4m)! - make the fileName and fileSize sorts a total order so paging cannot drop members

- [#2254](https://github.com/Bike4Mind/bike4mind/pull/2254) [`8fd5c09`](https://github.com/Bike4Mind/bike4mind/commit/8fd5c09dc29ac2b516552a1d289d5113631520d0) Thanks [@ken-b4m](https://github.com/ken-b4m)! - anchor retrieval's dynamic-lake prefix arm to the lake's creator

- [#2273](https://github.com/Bike4Mind/bike4mind/pull/2273) [`201bf43`](https://github.com/Bike4Mind/bike4mind/commit/201bf436ba987b47c363ebc7a6c7b4ece8801860) Thanks [@ken-b4m](https://github.com/ken-b4m)! - anchor the aggregate browse and forced retrieval to lake membership

## 6.0.0

### Major Changes

- [#1999](https://github.com/Bike4Mind/bike4mind/pull/1999) [`644ae9e`](https://github.com/Bike4Mind/bike4mind/commit/644ae9e289640b3f4e56f9eb6e3a9e7ad5d2d72e) Thanks [@onoya](https://github.com/onoya)! - retire the /api/ai/tts convention exemptions (402 for credits, no required scope)

### Minor Changes

- [#1730](https://github.com/Bike4Mind/bike4mind/pull/1730) [`525f033`](https://github.com/Bike4Mind/bike4mind/commit/525f03368f978196a3ea434f7ee39a48e45243a2) Thanks [@onoya](https://github.com/onoya)! - add lake-level Rebuild Passages action

- [#1759](https://github.com/Bike4Mind/bike4mind/pull/1759) [`f5ba462`](https://github.com/Bike4Mind/bike4mind/commit/f5ba46259b065515d8ff4f053235ddc0b1c5c795) Thanks [@onoya](https://github.com/onoya)! - incremental re-sync poll for connected Drive folders (E1)

- [#1766](https://github.com/Bike4Mind/bike4mind/pull/1766) [`f1edc9c`](https://github.com/Bike4Mind/bike4mind/commit/f1edc9cce1a8c9133a45d37fb844991e3c0de076) Thanks [@dea0030](https://github.com/dea0030)! - instrument retrieval surfaces with access-audit events

- [#1772](https://github.com/Bike4Mind/bike4mind/pull/1772) [`595a3c4`](https://github.com/Bike4Mind/bike4mind/commit/595a3c4d054a121f3147c2be08a610ab917b1427) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - stamp the acting principal on every lake config write

- [#1776](https://github.com/Bike4Mind/bike4mind/pull/1776) [`0e33727`](https://github.com/Bike4Mind/bike4mind/commit/0e33727cd5a086a9d730d35462af72e48f34ac9b) Thanks [@onoya](https://github.com/onoya)! - admission contract for every ingestion door ([#1679](https://github.com/Bike4Mind/bike4mind/issues/1679))

- [#1779](https://github.com/Bike4Mind/bike4mind/pull/1779) [`3bd4ad6`](https://github.com/Bike4Mind/bike4mind/commit/3bd4ad6828ea78f7b1e6d9897ccaa7fda08e964b) Thanks [@cgtorniado](https://github.com/cgtorniado)! - inline settings and graceful layout for PR digest tab

- [#1782](https://github.com/Bike4Mind/bike4mind/pull/1782) [`c4b7962`](https://github.com/Bike4Mind/bike4mind/commit/c4b7962f5fbd52b283548cafc775ea065c5f85b0) Thanks [@onoya](https://github.com/onoya)! - derived retrievability health, report-only ([#1666](https://github.com/Bike4Mind/bike4mind/issues/1666))

- [#1786](https://github.com/Bike4Mind/bike4mind/pull/1786) [`a19bf36`](https://github.com/Bike4Mind/bike4mind/commit/a19bf362a74750595cd23302fbab2fd4a5bc86d8) Thanks [@onoya](https://github.com/onoya)! - resolve tag/entitlement grants at read time into an ephemeral membership view

- [#1787](https://github.com/Bike4Mind/bike4mind/pull/1787) [`fd148e9`](https://github.com/Bike4Mind/bike4mind/commit/fd148e9746eec8a4bcf7754f0154b6905c9d6f07) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - cost attribution, spend view, and notifications

- [#1797](https://github.com/Bike4Mind/bike4mind/pull/1797) [`d1c8650`](https://github.com/Bike4Mind/bike4mind/commit/d1c8650647bb49ad2b22310310fae75e6550391c) Thanks [@onoya](https://github.com/onoya)! - owner-facing access and membership view with CSV export

- [#1799](https://github.com/Bike4Mind/bike4mind/pull/1799) [`8bfaf05`](https://github.com/Bike4Mind/bike4mind/commit/8bfaf056e6ab009116ac5563c9ac8d1f417aaaa4) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - turn on '@datalake add' and harden the live URL fetch path

- [#1825](https://github.com/Bike4Mind/bike4mind/pull/1825) [`eb230ef`](https://github.com/Bike4Mind/bike4mind/commit/eb230ef2a0d2bf5ebde4e950001bf0f7a571d4d3) Thanks [@onoya](https://github.com/onoya)! - publish the audio generation endpoints as OpenAPI contracts

- [#1827](https://github.com/Bike4Mind/bike4mind/pull/1827) [`bf8b6c1`](https://github.com/Bike4Mind/bike4mind/commit/bf8b6c1133763432bac2443d7724403a2ac84f80) Thanks [@ken-b4m](https://github.com/ken-b4m)! - allow admins to rebuild passages on static registry lakes

- [#1845](https://github.com/Bike4Mind/bike4mind/pull/1845) [`d9bc5f0`](https://github.com/Bike4Mind/bike4mind/commit/d9bc5f0d08e261177ecac2c1e70da801d80e2386) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - record who changed a lake's configuration, and what moved

- [#1848](https://github.com/Bike4Mind/bike4mind/pull/1848) [`4fda73d`](https://github.com/Bike4Mind/bike4mind/commit/4fda73dffcd208127a2cdf258469ff5ce8654ad4) Thanks [@onoya](https://github.com/onoya)! - enforce the retrievability contract at admission ([#1680](https://github.com/Bike4Mind/bike4mind/issues/1680))

- [#1858](https://github.com/Bike4Mind/bike4mind/pull/1858) [`8da0adc`](https://github.com/Bike4Mind/bike4mind/commit/8da0adcb9e74a7afd6ed7633f66691330c6fad44) Thanks [@onoya](https://github.com/onoya)! - cost tiers for individual- vs organization-owned lakes

- [#1860](https://github.com/Bike4Mind/bike4mind/pull/1860) [`ec0a7a9`](https://github.com/Bike4Mind/bike4mind/commit/ec0a7a99ff43dabd963597ebd940bcf21b866966) Thanks [@ken-b4m](https://github.com/ken-b4m)! - make the forced-retrieval char budget admin-configurable

- [#1887](https://github.com/Bike4Mind/bike4mind/pull/1887) [`b76236b`](https://github.com/Bike4Mind/bike4mind/commit/b76236b0d4698acfb4403329fb1bbb1ff1e2f49d) Thanks [@onoya](https://github.com/onoya)! - owner-triggered convergence toward the chunk policy ([#1681](https://github.com/Bike4Mind/bike4mind/issues/1681))

- [#1908](https://github.com/Bike4Mind/bike4mind/pull/1908) [`a7dac96`](https://github.com/Bike4Mind/bike4mind/commit/a7dac96d93e989399e0675df482a43fdfbdce7b5) Thanks [@onoya](https://github.com/onoya)! - persist the cache-write token count on settled turns

- [#1917](https://github.com/Bike4Mind/bike4mind/pull/1917) [`8f530a3`](https://github.com/Bike4Mind/bike4mind/commit/8f530a32d6b20d0c5fb93841b80f3b6a499e6c27) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - owner-facing data lake configuration history

- [#1923](https://github.com/Bike4Mind/bike4mind/pull/1923) [`914da78`](https://github.com/Bike4Mind/bike4mind/commit/914da7856b153c94e3c308e1c290cda7ec25d2fe) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add stage-aware routing for the email delivery channel

- [#1928](https://github.com/Bike4Mind/bike4mind/pull/1928) [`1a19d8f`](https://github.com/Bike4Mind/bike4mind/commit/1a19d8f089fbe9075c6129abe6954bb693258374) Thanks [@onoya](https://github.com/onoya)! - proposal queue with review and approval

- [#1934](https://github.com/Bike4Mind/bike4mind/pull/1934) [`da1b102`](https://github.com/Bike4Mind/bike4mind/commit/da1b102bf15adf7bd960d8d104b98d822d7151a1) Thanks [@onoya](https://github.com/onoya)! - deprecate the undocumented `name` field in error bodies

- [#1945](https://github.com/Bike4Mind/bike4mind/pull/1945) [`a4fcb93`](https://github.com/Bike4Mind/bike4mind/commit/a4fcb93eeae40df65f14bf17910a00c9f57e8437) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add the scoped-override writer with baked-in cache invalidation

- [#1949](https://github.com/Bike4Mind/bike4mind/pull/1949) [`4c7122b`](https://github.com/Bike4Mind/bike4mind/commit/4c7122bbbc5e3c03e73b2c4cac9c8b45579df7dc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - make kb-search default results admin-configurable

- [#1965](https://github.com/Bike4Mind/bike4mind/pull/1965) [`b255a0d`](https://github.com/Bike4Mind/bike4mind/commit/b255a0d03cc04b417355fe6cf33d66863f134662) Thanks [@erikbethke](https://github.com/erikbethke)! - freeform tags and generated covers for Live Artifacts

- [#1970](https://github.com/Bike4Mind/bike4mind/pull/1970) [`08cf107`](https://github.com/Bike4Mind/bike4mind/commit/08cf1075eb2834b155adf461f2e03ed2e37e6a11) Thanks [@ken-b4m](https://github.com/ken-b4m)! - admin-settable session defaults for static registry lakes

- [#1971](https://github.com/Bike4Mind/bike4mind/pull/1971) [`c3e5ab6`](https://github.com/Bike4Mind/bike4mind/commit/c3e5ab69e2e30bde319565b847acc24aa00387df) Thanks [@ken-b4m](https://github.com/ken-b4m)! - record the per-turn retrieval summary, including the zero case

- [#1985](https://github.com/Bike4Mind/bike4mind/pull/1985) [`d575bb0`](https://github.com/Bike4Mind/bike4mind/commit/d575bb0a5b90fa1729f2b4fb8a060d14ff34746b) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add Feedback foreign keys and retention split

- [#2009](https://github.com/Bike4Mind/bike4mind/pull/2009) [`75cf435`](https://github.com/Bike4Mind/bike4mind/commit/75cf4359a3ac18de8c7a6dae4dbace495b4d8bef) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add a token budget and relevance floor to kb search

- [#2039](https://github.com/Bike4Mind/bike4mind/pull/2039) [`0b24f62`](https://github.com/Bike4Mind/bike4mind/commit/0b24f6272a8a56b06e2df321b848a26a95333a9f) Thanks [@ken-b4m](https://github.com/ken-b4m)! - turn linkage and similarity scores on LakeAccessEvent

- [#2070](https://github.com/Bike4Mind/bike4mind/pull/2070) [`83a6254`](https://github.com/Bike4Mind/bike4mind/commit/83a625434a791a0bbbbcd38ddb93d3a20db23160) Thanks [@onoya](https://github.com/onoya)! - expose structured tool payloads to API callers

- [#2134](https://github.com/Bike4Mind/bike4mind/pull/2134) [`dde7b36`](https://github.com/Bike4Mind/bike4mind/commit/dde7b365998accc4f97ff0475df46d00b477e019) Thanks [@onoya](https://github.com/onoya)! - add OptiHashi API-key scopes and a staged scope rollout

### Patch Changes

- [#2121](https://github.com/Bike4Mind/bike4mind/pull/2121) [`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367) Thanks [@biletskiy6](https://github.com/biletskiy6)! - bound, non-sliding recovery rotation for the auth session store

  `IAuthSessionRepository` gains a required `recoverRotateHash`, and two existing signatures tighten:
  `rotateHash`'s `newExpiresAt` is now required, and `recoverRotateHash` takes `maxRecoveries` and no
  `newExpiresAt` at all. That asymmetry is deliberate and load-bearing - only a rotation from the
  CURRENT secret earns a slide, so a superseded secret can never extend the session it is used
  against - and it is encoded in the types so a call site cannot regress it silently. Any caller
  passing the real `authSessionRepository` is unaffected; a hand-rolled minimal adapter will fail to
  compile against this patch.

  `AuthSession` also gains a `recoveries` counter (schema default `0`, absent on pre-existing rows and
  handled by the filter, so no migration is required).

- [#1755](https://github.com/Bike4Mind/bike4mind/pull/1755) [`bf81dd1`](https://github.com/Bike4Mind/bike4mind/commit/bf81dd10ad034b8579b6224ce45c7296b69ee1e9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - populate promptMeta fields nothing ever wrote

- [#1778](https://github.com/Bike4Mind/bike4mind/pull/1778) [`da0acd2`](https://github.com/Bike4Mind/bike4mind/commit/da0acd2ec1311888cf8ad2395c05f7ad38666f6e) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop counting personally-shared files in per-user tag totals

- [#1781](https://github.com/Bike4Mind/bike4mind/pull/1781) [`3e7c1e9`](https://github.com/Bike4Mind/bike4mind/commit/3e7c1e9ab0becb26160db8d93e6d6af3fa5b97b5) Thanks [@dea0030](https://github.com/dea0030)! - publish session-update contract in the OpenAPI spec

- [#1790](https://github.com/Bike4Mind/bike4mind/pull/1790) [`95c7198`](https://github.com/Bike4Mind/bike4mind/commit/95c7198d085d3e10411605fe267975da44fd1bcd) Thanks [@biletskiy6](https://github.com/biletskiy6)! - stop describing the lake systemPrompt as unconsumed or always-on

- [#1801](https://github.com/Bike4Mind/bike4mind/pull/1801) [`e49346a`](https://github.com/Bike4Mind/bike4mind/commit/e49346a617d10bc8ec15b05e0626975d85e2a720) Thanks [@onoya](https://github.com/onoya)! - stop benign concurrent refreshes from revoking healthy sessions

- [#1808](https://github.com/Bike4Mind/bike4mind/pull/1808) [`cdf7dc9`](https://github.com/Bike4Mind/bike4mind/commit/cdf7dc927716e0034811ac6c4075b0a6de481f1f) Thanks [@ken-b4m](https://github.com/ken-b4m)! - bound the chunk-size policy at the detection threshold

- [#1810](https://github.com/Bike4Mind/bike4mind/pull/1810) [`3e60eac`](https://github.com/Bike4Mind/bike4mind/commit/3e60eac7a5c1929aaebde34ef1c40c3eb1c3d9fc) Thanks [@ken-b4m](https://github.com/ken-b4m)! - hold the chunk claim for the whole run

- [#1823](https://github.com/Bike4Mind/bike4mind/pull/1823) [`184cb4e`](https://github.com/Bike4Mind/bike4mind/commit/184cb4e36e68d42eb26d92b6c2851214f261ac12) Thanks [@dea0030](https://github.com/dea0030)! - stop dropping image-generation params at invoke boundary

- [#1832](https://github.com/Bike4Mind/bike4mind/pull/1832) [`2aa3254`](https://github.com/Bike4Mind/bike4mind/commit/2aa32546e79f795cb51af3afe7254af1b925060c) Thanks [@onoya](https://github.com/onoya)! - define public API conventions and gate them in the contract layer

- [#1841](https://github.com/Bike4Mind/bike4mind/pull/1841) [`376856f`](https://github.com/Bike4Mind/bike4mind/commit/376856fa2433e0333c4e31c01b09a3ccc9917729) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - close out review nits from the tag-count fix

- [#1891](https://github.com/Bike4Mind/bike4mind/pull/1891) [`7edcf84`](https://github.com/Bike4Mind/bike4mind/commit/7edcf84060227e9384274dccbbde54c197d25425) Thanks [@onoya](https://github.com/onoya)! - stop reasoning from starving the visible answer

- [#1899](https://github.com/Bike4Mind/bike4mind/pull/1899) [`2180d34`](https://github.com/Bike4Mind/bike4mind/commit/2180d347c173445b5d01a5b4862292e71c16b21a) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop feedback delivery from failing silently

- [#1905](https://github.com/Bike4Mind/bike4mind/pull/1905) [`6265d9a`](https://github.com/Bike4Mind/bike4mind/commit/6265d9a82abd90580b554e707866a9330ebca75a) Thanks [@onoya](https://github.com/onoya)! - unify the org-membership predicate behind the switcher and lake reads

- [#1909](https://github.com/Bike4Mind/bike4mind/pull/1909) [`61aa2be`](https://github.com/Bike4Mind/bike4mind/commit/61aa2bedbea473630009bf3cb817233d09bc3d8e) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - stop a long lake name deriving an unusable data lake tag prefix

- [#1921](https://github.com/Bike4Mind/bike4mind/pull/1921) [`79e9515`](https://github.com/Bike4Mind/bike4mind/commit/79e9515a622c9176551d8285e958d07560185803) Thanks [@dea0030](https://github.com/dea0030)! - taxonomy P3 cleanup pass - errors, bounds, logging

- [#1926](https://github.com/Bike4Mind/bike4mind/pull/1926) [`7ceea1e`](https://github.com/Bike4Mind/bike4mind/commit/7ceea1e54bfdc3259d8068134f2ddbafd56a262a) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - claim a purging status at purge-accept time ([#1744](https://github.com/Bike4Mind/bike4mind/issues/1744))

- [#1960](https://github.com/Bike4Mind/bike4mind/pull/1960) [`c97f73d`](https://github.com/Bike4Mind/bike4mind/commit/c97f73d5a6f2231ac8e581f1789f43af9e69b9c7) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - self-host feedback-Slack routes like production

- [#1979](https://github.com/Bike4Mind/bike4mind/pull/1979) [`d775d5c`](https://github.com/Bike4Mind/bike4mind/commit/d775d5c3308bb443b15ea62547d6ff0d5cddfbe8) Thanks [@baboosh](https://github.com/baboosh)! - add descriptions to Notion MCP tool registrations

- [#1983](https://github.com/Bike4Mind/bike4mind/pull/1983) [`1445c44`](https://github.com/Bike4Mind/bike4mind/commit/1445c44b596f24f86f5f33bbf590e6d11210759d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - move classifyStage into a pure module

- [#1997](https://github.com/Bike4Mind/bike4mind/pull/1997) [`8f68920`](https://github.com/Bike4Mind/bike4mind/commit/8f68920798c2e5617368531d43d6ea80c8855fe9) Thanks [@onoya](https://github.com/onoya)! - make the passage-rebuild marker atomic with the reset that creates the state

- [#1998](https://github.com/Bike4Mind/bike4mind/pull/1998) [`3d788bd`](https://github.com/Bike4Mind/bike4mind/commit/3d788bd9365c3e7dc2b344e20e32ac6153ad2beb) Thanks [@onoya](https://github.com/onoya)! - actually revoke the Google grant on disconnect

- [#2006](https://github.com/Bike4Mind/bike4mind/pull/2006) [`fe42856`](https://github.com/Bike4Mind/bike4mind/commit/fe4285649365d4494bbfa4ba8ea56030373cdb74) Thanks [@onoya](https://github.com/onoya)! - rebind promptMeta.session when copying quests into a new session

- [#2007](https://github.com/Bike4Mind/bike4mind/pull/2007) [`f79d864`](https://github.com/Bike4Mind/bike4mind/commit/f79d8641c802e50ec0f5f6e9e74b5ce7ab24444a) Thanks [@vinchi777](https://github.com/vinchi777)! - honor the selected model in the image-edit queue handler

- [#2019](https://github.com/Bike4Mind/bike4mind/pull/2019) [`cefb930`](https://github.com/Bike4Mind/bike4mind/commit/cefb930d19a48c800d8199071284b16dd8907e21) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - source the slug bounds and pattern from common

- [#2057](https://github.com/Bike4Mind/bike4mind/pull/2057) [`9158cf0`](https://github.com/Bike4Mind/bike4mind/commit/9158cf086acd1b9d7863a9ea76b932280d4460ac) Thanks [@MattTan257](https://github.com/MattTan257)! - rename the "Feedbacks" UI label/id to "Feedback"

- [#2084](https://github.com/Bike4Mind/bike4mind/pull/2084) [`dbcf733`](https://github.com/Bike4Mind/bike4mind/commit/dbcf733569d659bb818818f11d8298ec3062a0f1) Thanks [@choyno](https://github.com/choyno)! - make the whole attach-scope tag clickable, not just the radio dot

- [#2097](https://github.com/Bike4Mind/bike4mind/pull/2097) [`2068806`](https://github.com/Bike4Mind/bike4mind/commit/206880678ce77b39c4782b94d63715bdea4d35c6) Thanks [@choyno](https://github.com/choyno)! - claim the restoring status on unarchive instead of a blind write

- [#2102](https://github.com/Bike4Mind/bike4mind/pull/2102) [`6185bb1`](https://github.com/Bike4Mind/bike4mind/commit/6185bb10f611fc32dc06b88941c81799027ced75) Thanks [@choyno](https://github.com/choyno)! - guard the batch PUT status write so a settled batch is not resurrected

- [#2105](https://github.com/Bike4Mind/bike4mind/pull/2105) [`6d3390e`](https://github.com/Bike4Mind/bike4mind/commit/6d3390e0989a0acfd1dcbe8b26f6ed3bb3db3bb6) Thanks [@choyno](https://github.com/choyno)! - stop a missing OpenSearch index wedging a lake in purging

- [#2108](https://github.com/Bike4Mind/bike4mind/pull/2108) [`5da4b0a`](https://github.com/Bike4Mind/bike4mind/commit/5da4b0a44a12b48745c4bef70ae9ac65b6cf640b) Thanks [@juicewaa](https://github.com/juicewaa)! - batch the tag-counts per-lake query fan-out

- [#2121](https://github.com/Bike4Mind/bike4mind/pull/2121) [`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367) Thanks [@biletskiy6](https://github.com/biletskiy6)! - recover orphaned refresh rotations and slide session expiry

- [#2144](https://github.com/Bike4Mind/bike4mind/pull/2144) [`4981f5a`](https://github.com/Bike4Mind/bike4mind/commit/4981f5a0ffd69e716a1d3879aac99ede78a3cfef) Thanks [@juicewaa](https://github.com/juicewaa)! - stamp the rebuild marker and convergence origin when re-enqueueing stragglers

- [#2146](https://github.com/Bike4Mind/bike4mind/pull/2146) [`deb6ddf`](https://github.com/Bike4Mind/bike4mind/commit/deb6ddfe8d8083a8bcca715cbc730d778a3fe43b) Thanks [@juicewaa](https://github.com/juicewaa)! - project out file manifests in the stuck-batch scans

- [#2148](https://github.com/Bike4Mind/bike4mind/pull/2148) [`9e29782`](https://github.com/Bike4Mind/bike4mind/commit/9e2978286aaa5c6b1e2a08c9744a98f0ff62ee4b) Thanks [@juicewaa](https://github.com/juicewaa)! - bound monthlyCogsByProvider to a window of whole UTC months

## 5.0.0

### Major Changes

- [#1762](https://github.com/Bike4Mind/bike4mind/pull/1762) [`e805cbe`](https://github.com/Bike4Mind/bike4mind/commit/e805cbe54ebd5c7d1113769d9e28875b79a71fe9) Thanks [@biletskiy6](https://github.com/biletskiy6)! - authorize lakes by org membership set, not the selected-org pointer

### Minor Changes

- [#1520](https://github.com/Bike4Mind/bike4mind/pull/1520) [`3a3aef0`](https://github.com/Bike4Mind/bike4mind/commit/3a3aef0b59afe349f2f5e78ff3c693ea98f616e7) Thanks [@baboosh](https://github.com/baboosh)! - provider spend reconciliation banner

- [#1641](https://github.com/Bike4Mind/bike4mind/pull/1641) [`8e03a0e`](https://github.com/Bike4Mind/bike4mind/commit/8e03a0ed6430e40280db316e2301a0f20a8ddc57) Thanks [@onoya](https://github.com/onoya)! - self-serve Google Drive folder connect (D)

- [#1722](https://github.com/Bike4Mind/bike4mind/pull/1722) [`c9f2085`](https://github.com/Bike4Mind/bike4mind/commit/c9f208569698a2a1ec8210923493d1c460cefbca) Thanks [@onoya](https://github.com/onoya)! - chunk policy at file-owner altitude with the lake as a constraint

- [#1733](https://github.com/Bike4Mind/bike4mind/pull/1733) [`9fad658`](https://github.com/Bike4Mind/bike4mind/commit/9fad658b6504fa00b85045b028aa23c8d27d7bb2) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add lake access audit event model and retention floor

- [#1734](https://github.com/Bike4Mind/bike4mind/pull/1734) [`472f90d`](https://github.com/Bike4Mind/bike4mind/commit/472f90d7f9387a879757ffa81746845ad93a93b2) Thanks [@Illia025](https://github.com/Illia025)! - cost governance - spend levers in the admin panel, enforced at the vectorize gate

- [#1753](https://github.com/Bike4Mind/bike4mind/pull/1753) [`50b52a5`](https://github.com/Bike4Mind/bike4mind/commit/50b52a5fb5f3344b56bd4644b3a2154ca51fe31e) Thanks [@cgtorniado](https://github.com/cgtorniado)! - apply pr-report-generator blueprint (base)

- [#1760](https://github.com/Bike4Mind/bike4mind/pull/1760) [`7c8240c`](https://github.com/Bike4Mind/bike4mind/commit/7c8240ce7aa7ab839ad3ac7cc42aa51bc4fa9055) Thanks [@onoya](https://github.com/onoya)! - org-manageable lakes and ownership succession

- [#1765](https://github.com/Bike4Mind/bike4mind/pull/1765) [`1507c14`](https://github.com/Bike4Mind/bike4mind/commit/1507c143605a375cce15735d4a953c3ee470bc7d) Thanks [@onoya](https://github.com/onoya)! - convergence kill switch with provenance on the message payload

### Patch Changes

- [#1731](https://github.com/Bike4Mind/bike4mind/pull/1731) [`0b4e580`](https://github.com/Bike4Mind/bike4mind/commit/0b4e58050f10e92ec4f6fad32017d28c54a9d0ae) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - derive the retrieval serve cap from the chunk policy

- [#1737](https://github.com/Bike4Mind/bike4mind/pull/1737) [`9fc991e`](https://github.com/Bike4Mind/bike4mind/commit/9fc991e214af4fd2b1442759dc37528e74b33f11) Thanks [@wescarda](https://github.com/wescarda)! - sum FabFile sizes in the DB for recalculateUserStorage

- [#1742](https://github.com/Bike4Mind/bike4mind/pull/1742) [`de702ea`](https://github.com/Bike4Mind/bike4mind/commit/de702ea4ada1f91ad26167f2d7899a336cf647da) Thanks [@wescarda](https://github.com/wescarda)! - align member-add seat accounting to owner-inclusive team size ([#1423](https://github.com/Bike4Mind/bike4mind/issues/1423))

- [#1761](https://github.com/Bike4Mind/bike4mind/pull/1761) [`c46c8a4`](https://github.com/Bike4Mind/bike4mind/commit/c46c8a46e33df208d4547be6cd07b79add171ef2) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop a co-tag from unstamping a lake's archive

- Updated dependencies [[`c7b5854`](https://github.com/Bike4Mind/bike4mind/commit/c7b5854b3a02afdcd4d8c480d93f1005d5ee47c6)]:
  - @bike4mind/hearth@0.3.0

## 4.0.1

### Patch Changes

- [#1598](https://github.com/Bike4Mind/bike4mind/pull/1598) [`abc90f5`](https://github.com/Bike4Mind/bike4mind/commit/abc90f562e15caa46428fc94afa3ffff410e5d5c) Thanks [@onoya](https://github.com/onoya)! - keep grounded chat from inventing customers, deals and figures absent from retrieval

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
