# @bike4mind/services

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

- [#2283](https://github.com/Bike4Mind/bike4mind/pull/2283) [`beb8517`](https://github.com/Bike4Mind/bike4mind/commit/beb85175245f55e2aef64469876aa15961df215c) Thanks [@onoya](https://github.com/onoya)! - surface the document date in the retrieval passage headers

### Minor Changes

- [#1855](https://github.com/Bike4Mind/bike4mind/pull/1855) [`b30f155`](https://github.com/Bike4Mind/bike4mind/commit/b30f155a9b329eeed621c56eff9fad3ea9a6b144) Thanks [@vinchi777](https://github.com/vinchi777)! - gate the artifact-emission prompt on caller intent

- [#1932](https://github.com/Bike4Mind/bike4mind/pull/1932) [`1bdf739`](https://github.com/Bike4Mind/bike4mind/commit/1bdf7391cc8f83d42b2b00ecab7b528e5a3c0d09) Thanks [@vinchi777](https://github.com/vinchi777)! - verifiable permanent deletion for one lake document

- [#2178](https://github.com/Bike4Mind/bike4mind/pull/2178) [`c17fbcc`](https://github.com/Bike4Mind/bike4mind/commit/c17fbccb067921f8ab1b9b352eda91285bbd9720) Thanks [@onoya](https://github.com/onoya)! - give image generation and image edit a local queue consumer

- [#2196](https://github.com/Bike4Mind/bike4mind/pull/2196) [`1d65698`](https://github.com/Bike4Mind/bike4mind/commit/1d656985af6f8c2b3b2a486d932feca5e541a9cd) Thanks [@onoya](https://github.com/onoya)! - show partial knowledge-base coverage on the reply itself

- [#2207](https://github.com/Bike4Mind/bike4mind/pull/2207) [`55fb6c3`](https://github.com/Bike4Mind/bike4mind/commit/55fb6c39ffc7e881293dc715594770f43c865e1a) Thanks [@onoya](https://github.com/onoya)! - instrument forced retrieval's abstain exits

- [#2227](https://github.com/Bike4Mind/bike4mind/pull/2227) [`68cfd6b`](https://github.com/Bike4Mind/bike4mind/commit/68cfd6b0458c9c45a387cd24ab46399ed5afbca9) Thanks [@onoya](https://github.com/onoya)! - separate an unindexed corpus from a genuine failure in the retrieval outcome

- [#2252](https://github.com/Bike4Mind/bike4mind/pull/2252) [`f191816`](https://github.com/Bike4Mind/bike4mind/commit/f19181619bceed9c225ca4586305fb219cdb2589) Thanks [@ken-b4m](https://github.com/ken-b4m)! - make lake-member removal reversible by any lake manager

- [#2262](https://github.com/Bike4Mind/bike4mind/pull/2262) [`f712bb8`](https://github.com/Bike4Mind/bike4mind/commit/f712bb827c37af41c43d26ef9e5b4c607ee7f056) Thanks [@vinchi777](https://github.com/vinchi777)! - ingest a very large Drive folder across several runs

- [#2264](https://github.com/Bike4Mind/bike4mind/pull/2264) [`1cd2b7d`](https://github.com/Bike4Mind/bike4mind/commit/1cd2b7d520bd9150e54c3f8a3df2f1bc2b51afcd) Thanks [@onoya](https://github.com/onoya)! - record whether a turn's retrieval was forced or merely offered

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

- [#1784](https://github.com/Bike4Mind/bike4mind/pull/1784) [`c3f48ef`](https://github.com/Bike4Mind/bike4mind/commit/c3f48efb86869b715a4e3776a652a40128a0f88e) Thanks [@wescarda](https://github.com/wescarda)! - run the audited credit ledger before the admin user-doc write

- [#2064](https://github.com/Bike4Mind/bike4mind/pull/2064) [`787c867`](https://github.com/Bike4Mind/bike4mind/commit/787c867b9445547e05a4ab32c69cd58716aa3c53) Thanks [@vinchi777](https://github.com/vinchi777)! - claim the transitional lifecycle statuses atomically

- [#2100](https://github.com/Bike4Mind/bike4mind/pull/2100) [`f2f9b3d`](https://github.com/Bike4Mind/bike4mind/commit/f2f9b3d6ae4dc69aa763b15bfc5af3f8e7ada12c) Thanks [@jarlacut](https://github.com/jarlacut)! - skip ids that cannot address a row instead of throwing

- [#2126](https://github.com/Bike4Mind/bike4mind/pull/2126) [`1c39465`](https://github.com/Bike4Mind/bike4mind/commit/1c394654b3ace280b8b0941742d09fbb01a236a8) Thanks [@choyno](https://github.com/choyno)! - exclude convergence-paused files from the chunk rescue sweep

- [#2204](https://github.com/Bike4Mind/bike4mind/pull/2204) [`e465103`](https://github.com/Bike4Mind/bike4mind/commit/e465103247d17e39750edc7bc9a7dddee249db7e) Thanks [@vinchi777](https://github.com/vinchi777)! - release the Drive connection when its lake is purged

- [#2217](https://github.com/Bike4Mind/bike4mind/pull/2217) [`9c4cbf8`](https://github.com/Bike4Mind/bike4mind/commit/9c4cbf8bb37d0b67c1dcec3edc51f21995733307) Thanks [@choyno](https://github.com/choyno)! - stop an idempotent taxonomy re-apply reporting every file as freshly tagged

- [#2218](https://github.com/Bike4Mind/bike4mind/pull/2218) [`1c16f7f`](https://github.com/Bike4Mind/bike4mind/commit/1c16f7f410648d5ef15bb883a1a7e14d00fe81b9) Thanks [@choyno](https://github.com/choyno)! - keep a disambiguated slug inside MAX_DATA_LAKE_SLUG_LENGTH

- [#2220](https://github.com/Bike4Mind/bike4mind/pull/2220) [`7703e89`](https://github.com/Bike4Mind/bike4mind/commit/7703e8901332dc54d0533f0784dbfbb21df7772d) Thanks [@onoya](https://github.com/onoya)! - stamp TTFVT on the first visible token, not the first chunk

- [#2234](https://github.com/Bike4Mind/bike4mind/pull/2234) [`3ac67a8`](https://github.com/Bike4Mind/bike4mind/commit/3ac67a8ef1540c89b885458d2dedb4be77a3d752) Thanks [@erikbethke](https://github.com/erikbethke)! - deliver attachment content on the agent path and report every drop

- [#2250](https://github.com/Bike4Mind/bike4mind/pull/2250) [`72430db`](https://github.com/Bike4Mind/bike4mind/commit/72430db9a825facba11528fbd04ad620d91761f7) Thanks [@ken-b4m](https://github.com/ken-b4m)! - make the fileName and fileSize sorts a total order so paging cannot drop members

- [#2254](https://github.com/Bike4Mind/bike4mind/pull/2254) [`8fd5c09`](https://github.com/Bike4Mind/bike4mind/commit/8fd5c09dc29ac2b516552a1d289d5113631520d0) Thanks [@ken-b4m](https://github.com/ken-b4m)! - anchor retrieval's dynamic-lake prefix arm to the lake's creator

- [#2273](https://github.com/Bike4Mind/bike4mind/pull/2273) [`201bf43`](https://github.com/Bike4Mind/bike4mind/commit/201bf436ba987b47c363ebc7a6c7b4ece8801860) Thanks [@ken-b4m](https://github.com/ken-b4m)! - anchor the aggregate browse and forced retrieval to lake membership

- Updated dependencies [[`49f96c3`](https://github.com/Bike4Mind/bike4mind/commit/49f96c3ca5303a29ac6acb318d6178a7ec7efa48), [`920a061`](https://github.com/Bike4Mind/bike4mind/commit/920a061ec7c079a86b8e4b8a2627b631af8e8fef), [`51b306b`](https://github.com/Bike4Mind/bike4mind/commit/51b306b8b5c12062e54bd586f51a80c35e581f99), [`1bdf739`](https://github.com/Bike4Mind/bike4mind/commit/1bdf7391cc8f83d42b2b00ecab7b528e5a3c0d09), [`787c867`](https://github.com/Bike4Mind/bike4mind/commit/787c867b9445547e05a4ab32c69cd58716aa3c53), [`116346b`](https://github.com/Bike4Mind/bike4mind/commit/116346b680d797c539e5112086aae7ed91f36273), [`70ec2a6`](https://github.com/Bike4Mind/bike4mind/commit/70ec2a68decf31e67edc8d354115b0ef7299730f), [`f2f9b3d`](https://github.com/Bike4Mind/bike4mind/commit/f2f9b3d6ae4dc69aa763b15bfc5af3f8e7ada12c), [`a467b99`](https://github.com/Bike4Mind/bike4mind/commit/a467b99c43e695a3c1657a08ddd874da4e2438ca), [`1c39465`](https://github.com/Bike4Mind/bike4mind/commit/1c394654b3ace280b8b0941742d09fbb01a236a8), [`95d158a`](https://github.com/Bike4Mind/bike4mind/commit/95d158a96782d16dceb7e56e9984ed7ab7bb5cd9), [`b6bcd64`](https://github.com/Bike4Mind/bike4mind/commit/b6bcd64d712d5231937518f329194d6504b4d3df), [`9c5588c`](https://github.com/Bike4Mind/bike4mind/commit/9c5588c25e8025755ebe0eab77c4af208ef27538), [`469c391`](https://github.com/Bike4Mind/bike4mind/commit/469c391f0e9d48ba9285210f00f597bdafb26810), [`545e51b`](https://github.com/Bike4Mind/bike4mind/commit/545e51b5a17c439ba7bd303bd4033fe0b8d4cd37), [`d6cf4b1`](https://github.com/Bike4Mind/bike4mind/commit/d6cf4b1e7a6bb09d05f3cbf041a0b1d158bb3e2b), [`1d65698`](https://github.com/Bike4Mind/bike4mind/commit/1d656985af6f8c2b3b2a486d932feca5e541a9cd), [`2351bad`](https://github.com/Bike4Mind/bike4mind/commit/2351bad305a9ea7a249669078792d970f40e73a6), [`e465103`](https://github.com/Bike4Mind/bike4mind/commit/e465103247d17e39750edc7bc9a7dddee249db7e), [`55fb6c3`](https://github.com/Bike4Mind/bike4mind/commit/55fb6c39ffc7e881293dc715594770f43c865e1a), [`354f3c6`](https://github.com/Bike4Mind/bike4mind/commit/354f3c65b4a9e84401801e3e868f217c7454cd3f), [`ad5801f`](https://github.com/Bike4Mind/bike4mind/commit/ad5801f5d44cfd198e424af10c9780aff3c04643), [`7703e89`](https://github.com/Bike4Mind/bike4mind/commit/7703e8901332dc54d0533f0784dbfbb21df7772d), [`68cfd6b`](https://github.com/Bike4Mind/bike4mind/commit/68cfd6b0458c9c45a387cd24ab46399ed5afbca9), [`c7ac7d2`](https://github.com/Bike4Mind/bike4mind/commit/c7ac7d2d76150ef30c20e692d0445c4518575b1d), [`3ac67a8`](https://github.com/Bike4Mind/bike4mind/commit/3ac67a8ef1540c89b885458d2dedb4be77a3d752), [`4af59ad`](https://github.com/Bike4Mind/bike4mind/commit/4af59adbd76c4de00d78db6c8f3d2ed9eeea7085), [`72430db`](https://github.com/Bike4Mind/bike4mind/commit/72430db9a825facba11528fbd04ad620d91761f7), [`f191816`](https://github.com/Bike4Mind/bike4mind/commit/f19181619bceed9c225ca4586305fb219cdb2589), [`ed62ab7`](https://github.com/Bike4Mind/bike4mind/commit/ed62ab7149c9af24b36e772a5bbf934d512674b7), [`8fd5c09`](https://github.com/Bike4Mind/bike4mind/commit/8fd5c09dc29ac2b516552a1d289d5113631520d0), [`f712bb8`](https://github.com/Bike4Mind/bike4mind/commit/f712bb827c37af41c43d26ef9e5b4c607ee7f056), [`1cd2b7d`](https://github.com/Bike4Mind/bike4mind/commit/1cd2b7d520bd9150e54c3f8a3df2f1bc2b51afcd), [`9b317ab`](https://github.com/Bike4Mind/bike4mind/commit/9b317ab5825776b433e69a1d8f255a12e8be625b), [`fbc0c09`](https://github.com/Bike4Mind/bike4mind/commit/fbc0c0959bf597d4dc253d5ef1bdf1f7f2b2723b), [`32f72a1`](https://github.com/Bike4Mind/bike4mind/commit/32f72a160b0bb5827dd9a458ea16a6adb7abae39), [`201bf43`](https://github.com/Bike4Mind/bike4mind/commit/201bf436ba987b47c363ebc7a6c7b4ece8801860), [`b0b13bf`](https://github.com/Bike4Mind/bike4mind/commit/b0b13bf82601945d456dd0bf59b3aecf19eed137), [`ea49d82`](https://github.com/Bike4Mind/bike4mind/commit/ea49d82a08e85ff27a43699b7ecdd85a526857c5), [`8c183d3`](https://github.com/Bike4Mind/bike4mind/commit/8c183d3f6b7ce48eaf1e8bfe61e82e18332cf9b2), [`cc0e8e3`](https://github.com/Bike4Mind/bike4mind/commit/cc0e8e3ae147c45f375e8ddecea5503e97fb78e7), [`e285e73`](https://github.com/Bike4Mind/bike4mind/commit/e285e738ff13227869492811f1a10865d6d82f03)]:
  - @bike4mind/common@7.0.0
  - @bike4mind/utils@5.0.0
  - @bike4mind/db-core@0.4.2
  - @bike4mind/llm-adapters@0.12.1
  - @bike4mind/fab-pipeline@1.2.1
  - @bike4mind/agents@0.20.4
  - @bike4mind/auth@0.7.4
  - @bike4mind/mcp@1.41.5

## 6.1.0

### Minor Changes

- [#1730](https://github.com/Bike4Mind/bike4mind/pull/1730) [`525f033`](https://github.com/Bike4Mind/bike4mind/commit/525f03368f978196a3ea434f7ee39a48e45243a2) Thanks [@onoya](https://github.com/onoya)! - add lake-level Rebuild Passages action

- [#1735](https://github.com/Bike4Mind/bike4mind/pull/1735) [`37454b6`](https://github.com/Bike4Mind/bike4mind/commit/37454b686642fc0da72cb33e4be0113091489ad2) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add LINK ingest to the '@datalake add' command

- [#1759](https://github.com/Bike4Mind/bike4mind/pull/1759) [`f5ba462`](https://github.com/Bike4Mind/bike4mind/commit/f5ba46259b065515d8ff4f053235ddc0b1c5c795) Thanks [@onoya](https://github.com/onoya)! - incremental re-sync poll for connected Drive folders (E1)

- [#1766](https://github.com/Bike4Mind/bike4mind/pull/1766) [`f1edc9c`](https://github.com/Bike4Mind/bike4mind/commit/f1edc9cce1a8c9133a45d37fb844991e3c0de076) Thanks [@dea0030](https://github.com/dea0030)! - instrument retrieval surfaces with access-audit events

- [#1772](https://github.com/Bike4Mind/bike4mind/pull/1772) [`595a3c4`](https://github.com/Bike4Mind/bike4mind/commit/595a3c4d054a121f3147c2be08a610ab917b1427) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - stamp the acting principal on every lake config write

- [#1776](https://github.com/Bike4Mind/bike4mind/pull/1776) [`0e33727`](https://github.com/Bike4Mind/bike4mind/commit/0e33727cd5a086a9d730d35462af72e48f34ac9b) Thanks [@onoya](https://github.com/onoya)! - admission contract for every ingestion door ([#1679](https://github.com/Bike4Mind/bike4mind/issues/1679))

- [#1779](https://github.com/Bike4Mind/bike4mind/pull/1779) [`3bd4ad6`](https://github.com/Bike4Mind/bike4mind/commit/3bd4ad6828ea78f7b1e6d9897ccaa7fda08e964b) Thanks [@cgtorniado](https://github.com/cgtorniado)! - inline settings and graceful layout for PR digest tab

- [#1782](https://github.com/Bike4Mind/bike4mind/pull/1782) [`c4b7962`](https://github.com/Bike4Mind/bike4mind/commit/c4b7962f5fbd52b283548cafc775ea065c5f85b0) Thanks [@onoya](https://github.com/onoya)! - derived retrievability health, report-only ([#1666](https://github.com/Bike4Mind/bike4mind/issues/1666))

- [#1786](https://github.com/Bike4Mind/bike4mind/pull/1786) [`a19bf36`](https://github.com/Bike4Mind/bike4mind/commit/a19bf362a74750595cd23302fbab2fd4a5bc86d8) Thanks [@onoya](https://github.com/onoya)! - resolve tag/entitlement grants at read time into an ephemeral membership view

- [#1787](https://github.com/Bike4Mind/bike4mind/pull/1787) [`fd148e9`](https://github.com/Bike4Mind/bike4mind/commit/fd148e9746eec8a4bcf7754f0154b6905c9d6f07) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - cost attribution, spend view, and notifications

- [#1797](https://github.com/Bike4Mind/bike4mind/pull/1797) [`d1c8650`](https://github.com/Bike4Mind/bike4mind/commit/d1c8650647bb49ad2b22310310fae75e6550391c) Thanks [@onoya](https://github.com/onoya)! - owner-facing access and membership view with CSV export

- [#1827](https://github.com/Bike4Mind/bike4mind/pull/1827) [`bf8b6c1`](https://github.com/Bike4Mind/bike4mind/commit/bf8b6c1133763432bac2443d7724403a2ac84f80) Thanks [@ken-b4m](https://github.com/ken-b4m)! - allow admins to rebuild passages on static registry lakes

- [#1845](https://github.com/Bike4Mind/bike4mind/pull/1845) [`d9bc5f0`](https://github.com/Bike4Mind/bike4mind/commit/d9bc5f0d08e261177ecac2c1e70da801d80e2386) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - record who changed a lake's configuration, and what moved

- [#1848](https://github.com/Bike4Mind/bike4mind/pull/1848) [`4fda73d`](https://github.com/Bike4Mind/bike4mind/commit/4fda73dffcd208127a2cdf258469ff5ce8654ad4) Thanks [@onoya](https://github.com/onoya)! - enforce the retrievability contract at admission ([#1680](https://github.com/Bike4Mind/bike4mind/issues/1680))

- [#1858](https://github.com/Bike4Mind/bike4mind/pull/1858) [`8da0adc`](https://github.com/Bike4Mind/bike4mind/commit/8da0adcb9e74a7afd6ed7633f66691330c6fad44) Thanks [@onoya](https://github.com/onoya)! - cost tiers for individual- vs organization-owned lakes

- [#1860](https://github.com/Bike4Mind/bike4mind/pull/1860) [`ec0a7a9`](https://github.com/Bike4Mind/bike4mind/commit/ec0a7a99ff43dabd963597ebd940bcf21b866966) Thanks [@ken-b4m](https://github.com/ken-b4m)! - make the forced-retrieval char budget admin-configurable

- [#1887](https://github.com/Bike4Mind/bike4mind/pull/1887) [`b76236b`](https://github.com/Bike4Mind/bike4mind/commit/b76236b0d4698acfb4403329fb1bbb1ff1e2f49d) Thanks [@onoya](https://github.com/onoya)! - owner-triggered convergence toward the chunk policy ([#1681](https://github.com/Bike4Mind/bike4mind/issues/1681))

- [#1908](https://github.com/Bike4Mind/bike4mind/pull/1908) [`a7dac96`](https://github.com/Bike4Mind/bike4mind/commit/a7dac96d93e989399e0675df482a43fdfbdce7b5) Thanks [@onoya](https://github.com/onoya)! - persist the cache-write token count on settled turns

- [#1917](https://github.com/Bike4Mind/bike4mind/pull/1917) [`8f530a3`](https://github.com/Bike4Mind/bike4mind/commit/8f530a32d6b20d0c5fb93841b80f3b6a499e6c27) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - owner-facing data lake configuration history

- [#1928](https://github.com/Bike4Mind/bike4mind/pull/1928) [`1a19d8f`](https://github.com/Bike4Mind/bike4mind/commit/1a19d8f089fbe9075c6129abe6954bb693258374) Thanks [@onoya](https://github.com/onoya)! - proposal queue with review and approval

- [#1945](https://github.com/Bike4Mind/bike4mind/pull/1945) [`a4fcb93`](https://github.com/Bike4Mind/bike4mind/commit/a4fcb93eeae40df65f14bf17910a00c9f57e8437) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add the scoped-override writer with baked-in cache invalidation

- [#1949](https://github.com/Bike4Mind/bike4mind/pull/1949) [`4c7122b`](https://github.com/Bike4Mind/bike4mind/commit/4c7122bbbc5e3c03e73b2c4cac9c8b45579df7dc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - make kb-search default results admin-configurable

- [#1970](https://github.com/Bike4Mind/bike4mind/pull/1970) [`08cf107`](https://github.com/Bike4Mind/bike4mind/commit/08cf1075eb2834b155adf461f2e03ed2e37e6a11) Thanks [@ken-b4m](https://github.com/ken-b4m)! - admin-settable session defaults for static registry lakes

- [#1971](https://github.com/Bike4Mind/bike4mind/pull/1971) [`c3e5ab6`](https://github.com/Bike4Mind/bike4mind/commit/c3e5ab69e2e30bde319565b847acc24aa00387df) Thanks [@ken-b4m](https://github.com/ken-b4m)! - record the per-turn retrieval summary, including the zero case

- [#2009](https://github.com/Bike4Mind/bike4mind/pull/2009) [`75cf435`](https://github.com/Bike4Mind/bike4mind/commit/75cf4359a3ac18de8c7a6dae4dbace495b4d8bef) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add a token budget and relevance floor to kb search

- [#2013](https://github.com/Bike4Mind/bike4mind/pull/2013) [`e55790f`](https://github.com/Bike4Mind/bike4mind/commit/e55790f6daa2281cc45a786821221b81c0893d4b) Thanks [@erikbethke](https://github.com/erikbethke)! - cover built-in agent model choices in the stale-reference report

- [#2039](https://github.com/Bike4Mind/bike4mind/pull/2039) [`0b24f62`](https://github.com/Bike4Mind/bike4mind/commit/0b24f6272a8a56b06e2df321b848a26a95333a9f) Thanks [@ken-b4m](https://github.com/ken-b4m)! - turn linkage and similarity scores on LakeAccessEvent

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

- [#1888](https://github.com/Bike4Mind/bike4mind/pull/1888) [`d826ca1`](https://github.com/Bike4Mind/bike4mind/commit/d826ca1b796cc6737d6f163d2fdf40d8cdc02e1c) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - bind fork/snip message lookup to the caller's session

  `forkSession`/`snipSession`'s adapter parameter now requires `findBySessionIdAndId` where it
  previously required `findById`, and `deleteSessionMessage`'s now picks `findBySessionIdAndId`/`update`
  off `IChatHistoryItemRepository` instead of declaring them inline. Any caller passing the real
  `questRepository` is unaffected, since `IChatHistoryItemRepository` has carried those methods since
  [#1755](https://github.com/Bike4Mind/bike4mind/issues/1755). A hand-rolled minimal adapter will fail to compile against this patch.

- [#1649](https://github.com/Bike4Mind/bike4mind/pull/1649) [`2c6c3b7`](https://github.com/Bike4Mind/bike4mind/commit/2c6c3b7a2f356e10d04eade48db1b5a036120251) Thanks [@vinchi777](https://github.com/vinchi777)! - purge strips its own tags off a file it spared

- [#1755](https://github.com/Bike4Mind/bike4mind/pull/1755) [`bf81dd1`](https://github.com/Bike4Mind/bike4mind/commit/bf81dd10ad034b8579b6224ce45c7296b69ee1e9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - populate promptMeta fields nothing ever wrote

- [#1771](https://github.com/Bike4Mind/bike4mind/pull/1771) [`920fd2a`](https://github.com/Bike4Mind/bike4mind/commit/920fd2a483b77c58eb4afa9001127fbed6bd4446) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - enforce session ownership before starting a completion

- [#1773](https://github.com/Bike4Mind/bike4mind/pull/1773) [`7db3919`](https://github.com/Bike4Mind/bike4mind/commit/7db39198599411bf8513778117ead9275e1dab74) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reserve tool-schema budget in overflow recovery

- [#1778](https://github.com/Bike4Mind/bike4mind/pull/1778) [`da0acd2`](https://github.com/Bike4Mind/bike4mind/commit/da0acd2ec1311888cf8ad2395c05f7ad38666f6e) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop counting personally-shared files in per-user tag totals

- [#1781](https://github.com/Bike4Mind/bike4mind/pull/1781) [`3e7c1e9`](https://github.com/Bike4Mind/bike4mind/commit/3e7c1e9ab0becb26160db8d93e6d6af3fa5b97b5) Thanks [@dea0030](https://github.com/dea0030)! - publish session-update contract in the OpenAPI spec

- [#1801](https://github.com/Bike4Mind/bike4mind/pull/1801) [`e49346a`](https://github.com/Bike4Mind/bike4mind/commit/e49346a617d10bc8ec15b05e0626975d85e2a720) Thanks [@onoya](https://github.com/onoya)! - stop benign concurrent refreshes from revoking healthy sessions

- [#1810](https://github.com/Bike4Mind/bike4mind/pull/1810) [`3e60eac`](https://github.com/Bike4Mind/bike4mind/commit/3e60eac7a5c1929aaebde34ef1c40c3eb1c3d9fc) Thanks [@ken-b4m](https://github.com/ken-b4m)! - hold the chunk claim for the whole run

- [#1816](https://github.com/Bike4Mind/bike4mind/pull/1816) [`08a7597`](https://github.com/Bike4Mind/bike4mind/commit/08a759724795e52ee13bc70b620c35673b2925b2) Thanks [@ken-b4m](https://github.com/ken-b4m)! - close three follow-ups from the chunk-claim clobber fix

- [#1823](https://github.com/Bike4Mind/bike4mind/pull/1823) [`184cb4e`](https://github.com/Bike4Mind/bike4mind/commit/184cb4e36e68d42eb26d92b6c2851214f261ac12) Thanks [@dea0030](https://github.com/dea0030)! - stop dropping image-generation params at invoke boundary

- [#1841](https://github.com/Bike4Mind/bike4mind/pull/1841) [`376856f`](https://github.com/Bike4Mind/bike4mind/commit/376856fa2433e0333c4e31c01b09a3ccc9917729) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - close out review nits from the tag-count fix

- [#1847](https://github.com/Bike4Mind/bike4mind/pull/1847) [`fdcf36a`](https://github.com/Bike4Mind/bike4mind/commit/fdcf36ae431604a775e689db8ca7f5d72b8804ba) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - bound QuestMaster history replay and close two redaction gaps

- [#1854](https://github.com/Bike4Mind/bike4mind/pull/1854) [`a1e7fa6`](https://github.com/Bike4Mind/bike4mind/commit/a1e7fa6bf7cde7c2ef2c0d28becf39f01f6fce35) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reject an overflow-recovery rebuild that drops system prompts

- [#1857](https://github.com/Bike4Mind/bike4mind/pull/1857) [`f872279`](https://github.com/Bike4Mind/bike4mind/commit/f8722793b9a06881076cb47594e8d1f0be0ea614) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - gate in-process delegation by the per-member credit cap

- [#1891](https://github.com/Bike4Mind/bike4mind/pull/1891) [`7edcf84`](https://github.com/Bike4Mind/bike4mind/commit/7edcf84060227e9384274dccbbde54c197d25425) Thanks [@onoya](https://github.com/onoya)! - stop reasoning from starving the visible answer

- [#1901](https://github.com/Bike4Mind/bike4mind/pull/1901) [`f4b241d`](https://github.com/Bike4Mind/bike4mind/commit/f4b241df70f97039f5106b4ea252b5c3d87edaab) Thanks [@onoya](https://github.com/onoya)! - only offer delegate_to_agent for mentions that name a real agent

- [#1902](https://github.com/Bike4Mind/bike4mind/pull/1902) [`84cbbbb`](https://github.com/Bike4Mind/bike4mind/commit/84cbbbb239a8f819873d4c4754199bc8620b93ba) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - parse invite body at API layer to prevent id override

- [#1926](https://github.com/Bike4Mind/bike4mind/pull/1926) [`7ceea1e`](https://github.com/Bike4Mind/bike4mind/commit/7ceea1e54bfdc3259d8068134f2ddbafd56a262a) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - claim a purging status at purge-accept time ([#1744](https://github.com/Bike4Mind/bike4mind/issues/1744))

- Updated dependencies [[`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367), [`525f033`](https://github.com/Bike4Mind/bike4mind/commit/525f03368f978196a3ea434f7ee39a48e45243a2), [`37454b6`](https://github.com/Bike4Mind/bike4mind/commit/37454b686642fc0da72cb33e4be0113091489ad2), [`bf81dd1`](https://github.com/Bike4Mind/bike4mind/commit/bf81dd10ad034b8579b6224ce45c7296b69ee1e9), [`f5ba462`](https://github.com/Bike4Mind/bike4mind/commit/f5ba46259b065515d8ff4f053235ddc0b1c5c795), [`f1edc9c`](https://github.com/Bike4Mind/bike4mind/commit/f1edc9cce1a8c9133a45d37fb844991e3c0de076), [`595a3c4`](https://github.com/Bike4Mind/bike4mind/commit/595a3c4d054a121f3147c2be08a610ab917b1427), [`0e33727`](https://github.com/Bike4Mind/bike4mind/commit/0e33727cd5a086a9d730d35462af72e48f34ac9b), [`da0acd2`](https://github.com/Bike4Mind/bike4mind/commit/da0acd2ec1311888cf8ad2395c05f7ad38666f6e), [`3bd4ad6`](https://github.com/Bike4Mind/bike4mind/commit/3bd4ad6828ea78f7b1e6d9897ccaa7fda08e964b), [`3e7c1e9`](https://github.com/Bike4Mind/bike4mind/commit/3e7c1e9ab0becb26160db8d93e6d6af3fa5b97b5), [`c4b7962`](https://github.com/Bike4Mind/bike4mind/commit/c4b7962f5fbd52b283548cafc775ea065c5f85b0), [`a19bf36`](https://github.com/Bike4Mind/bike4mind/commit/a19bf362a74750595cd23302fbab2fd4a5bc86d8), [`fd148e9`](https://github.com/Bike4Mind/bike4mind/commit/fd148e9746eec8a4bcf7754f0154b6905c9d6f07), [`95c7198`](https://github.com/Bike4Mind/bike4mind/commit/95c7198d085d3e10411605fe267975da44fd1bcd), [`d1c8650`](https://github.com/Bike4Mind/bike4mind/commit/d1c8650647bb49ad2b22310310fae75e6550391c), [`8bfaf05`](https://github.com/Bike4Mind/bike4mind/commit/8bfaf056e6ab009116ac5563c9ac8d1f417aaaa4), [`e49346a`](https://github.com/Bike4Mind/bike4mind/commit/e49346a617d10bc8ec15b05e0626975d85e2a720), [`cdf7dc9`](https://github.com/Bike4Mind/bike4mind/commit/cdf7dc927716e0034811ac6c4075b0a6de481f1f), [`3e60eac`](https://github.com/Bike4Mind/bike4mind/commit/3e60eac7a5c1929aaebde34ef1c40c3eb1c3d9fc), [`184cb4e`](https://github.com/Bike4Mind/bike4mind/commit/184cb4e36e68d42eb26d92b6c2851214f261ac12), [`eb230ef`](https://github.com/Bike4Mind/bike4mind/commit/eb230ef2a0d2bf5ebde4e950001bf0f7a571d4d3), [`bf8b6c1`](https://github.com/Bike4Mind/bike4mind/commit/bf8b6c1133763432bac2443d7724403a2ac84f80), [`2aa3254`](https://github.com/Bike4Mind/bike4mind/commit/2aa32546e79f795cb51af3afe7254af1b925060c), [`376856f`](https://github.com/Bike4Mind/bike4mind/commit/376856fa2433e0333c4e31c01b09a3ccc9917729), [`d9bc5f0`](https://github.com/Bike4Mind/bike4mind/commit/d9bc5f0d08e261177ecac2c1e70da801d80e2386), [`fdcf36a`](https://github.com/Bike4Mind/bike4mind/commit/fdcf36ae431604a775e689db8ca7f5d72b8804ba), [`4fda73d`](https://github.com/Bike4Mind/bike4mind/commit/4fda73dffcd208127a2cdf258469ff5ce8654ad4), [`8da0adc`](https://github.com/Bike4Mind/bike4mind/commit/8da0adcb9e74a7afd6ed7633f66691330c6fad44), [`ec0a7a9`](https://github.com/Bike4Mind/bike4mind/commit/ec0a7a99ff43dabd963597ebd940bcf21b866966), [`c115fec`](https://github.com/Bike4Mind/bike4mind/commit/c115fec6c74f414940cd9597c3168fafefe3e8b0), [`b76236b`](https://github.com/Bike4Mind/bike4mind/commit/b76236b0d4698acfb4403329fb1bbb1ff1e2f49d), [`7edcf84`](https://github.com/Bike4Mind/bike4mind/commit/7edcf84060227e9384274dccbbde54c197d25425), [`2180d34`](https://github.com/Bike4Mind/bike4mind/commit/2180d347c173445b5d01a5b4862292e71c16b21a), [`6265d9a`](https://github.com/Bike4Mind/bike4mind/commit/6265d9a82abd90580b554e707866a9330ebca75a), [`a7dac96`](https://github.com/Bike4Mind/bike4mind/commit/a7dac96d93e989399e0675df482a43fdfbdce7b5), [`61aa2be`](https://github.com/Bike4Mind/bike4mind/commit/61aa2bedbea473630009bf3cb817233d09bc3d8e), [`aee1ae9`](https://github.com/Bike4Mind/bike4mind/commit/aee1ae92e282fd948ebaa9c0155dc915a4014d7c), [`8f530a3`](https://github.com/Bike4Mind/bike4mind/commit/8f530a32d6b20d0c5fb93841b80f3b6a499e6c27), [`79e9515`](https://github.com/Bike4Mind/bike4mind/commit/79e9515a622c9176551d8285e958d07560185803), [`914da78`](https://github.com/Bike4Mind/bike4mind/commit/914da7856b153c94e3c308e1c290cda7ec25d2fe), [`7ceea1e`](https://github.com/Bike4Mind/bike4mind/commit/7ceea1e54bfdc3259d8068134f2ddbafd56a262a), [`1a19d8f`](https://github.com/Bike4Mind/bike4mind/commit/1a19d8f089fbe9075c6129abe6954bb693258374), [`da1b102`](https://github.com/Bike4Mind/bike4mind/commit/da1b102bf15adf7bd960d8d104b98d822d7151a1), [`12e6b6a`](https://github.com/Bike4Mind/bike4mind/commit/12e6b6a42e19b78176d67d75bdec1d9f195e1c44), [`461fcd7`](https://github.com/Bike4Mind/bike4mind/commit/461fcd7ed0bcf1c4089329ba055915caf9f66e5e), [`a4fcb93`](https://github.com/Bike4Mind/bike4mind/commit/a4fcb93eeae40df65f14bf17910a00c9f57e8437), [`4c7122b`](https://github.com/Bike4Mind/bike4mind/commit/4c7122bbbc5e3c03e73b2c4cac9c8b45579df7dc), [`c97f73d`](https://github.com/Bike4Mind/bike4mind/commit/c97f73d5a6f2231ac8e581f1789f43af9e69b9c7), [`b255a0d`](https://github.com/Bike4Mind/bike4mind/commit/b255a0d03cc04b417355fe6cf33d66863f134662), [`08cf107`](https://github.com/Bike4Mind/bike4mind/commit/08cf1075eb2834b155adf461f2e03ed2e37e6a11), [`c3e5ab6`](https://github.com/Bike4Mind/bike4mind/commit/c3e5ab69e2e30bde319565b847acc24aa00387df), [`d775d5c`](https://github.com/Bike4Mind/bike4mind/commit/d775d5c3308bb443b15ea62547d6ff0d5cddfbe8), [`1445c44`](https://github.com/Bike4Mind/bike4mind/commit/1445c44b596f24f86f5f33bbf590e6d11210759d), [`d575bb0`](https://github.com/Bike4Mind/bike4mind/commit/d575bb0a5b90fa1729f2b4fb8a060d14ff34746b), [`8f68920`](https://github.com/Bike4Mind/bike4mind/commit/8f68920798c2e5617368531d43d6ea80c8855fe9), [`3d788bd`](https://github.com/Bike4Mind/bike4mind/commit/3d788bd9365c3e7dc2b344e20e32ac6153ad2beb), [`644ae9e`](https://github.com/Bike4Mind/bike4mind/commit/644ae9e289640b3f4e56f9eb6e3a9e7ad5d2d72e), [`36c26fd`](https://github.com/Bike4Mind/bike4mind/commit/36c26fd1bb6b3a08072032738c25b301b166a5e8), [`fe42856`](https://github.com/Bike4Mind/bike4mind/commit/fe4285649365d4494bbfa4ba8ea56030373cdb74), [`f79d864`](https://github.com/Bike4Mind/bike4mind/commit/f79d8641c802e50ec0f5f6e9e74b5ce7ab24444a), [`75cf435`](https://github.com/Bike4Mind/bike4mind/commit/75cf4359a3ac18de8c7a6dae4dbace495b4d8bef), [`e55790f`](https://github.com/Bike4Mind/bike4mind/commit/e55790f6daa2281cc45a786821221b81c0893d4b), [`cefb930`](https://github.com/Bike4Mind/bike4mind/commit/cefb930d19a48c800d8199071284b16dd8907e21), [`0b24f62`](https://github.com/Bike4Mind/bike4mind/commit/0b24f6272a8a56b06e2df321b848a26a95333a9f), [`9158cf0`](https://github.com/Bike4Mind/bike4mind/commit/9158cf086acd1b9d7863a9ea76b932280d4460ac), [`323718c`](https://github.com/Bike4Mind/bike4mind/commit/323718c8691d506cbe26cd74f7cfd4a73e28ff61), [`1901bb2`](https://github.com/Bike4Mind/bike4mind/commit/1901bb2489b4b0c797d501ff2848f3658077c84a), [`83a6254`](https://github.com/Bike4Mind/bike4mind/commit/83a625434a791a0bbbbcd38ddb93d3a20db23160), [`dbcf733`](https://github.com/Bike4Mind/bike4mind/commit/dbcf733569d659bb818818f11d8298ec3062a0f1), [`2068806`](https://github.com/Bike4Mind/bike4mind/commit/206880678ce77b39c4782b94d63715bdea4d35c6), [`6185bb1`](https://github.com/Bike4Mind/bike4mind/commit/6185bb10f611fc32dc06b88941c81799027ced75), [`6d3390e`](https://github.com/Bike4Mind/bike4mind/commit/6d3390e0989a0acfd1dcbe8b26f6ed3bb3db3bb6), [`5da4b0a`](https://github.com/Bike4Mind/bike4mind/commit/5da4b0a44a12b48745c4bef70ae9ac65b6cf640b), [`3275023`](https://github.com/Bike4Mind/bike4mind/commit/3275023e309b4e984227299935b8bcd012a72367), [`dde7b36`](https://github.com/Bike4Mind/bike4mind/commit/dde7b365998accc4f97ff0475df46d00b477e019), [`4981f5a`](https://github.com/Bike4Mind/bike4mind/commit/4981f5a0ffd69e716a1d3879aac99ede78a3cfef), [`deb6ddf`](https://github.com/Bike4Mind/bike4mind/commit/deb6ddfe8d8083a8bcca715cbc730d778a3fe43b), [`9e29782`](https://github.com/Bike4Mind/bike4mind/commit/9e2978286aaa5c6b1e2a08c9744a98f0ff62ee4b), [`63d0783`](https://github.com/Bike4Mind/bike4mind/commit/63d0783fb8120b7d4249aec0348986c0ee4e33f4)]:
  - @bike4mind/common@6.0.0
  - @bike4mind/fab-pipeline@1.2.0
  - @bike4mind/llm-adapters@0.12.0
  - @bike4mind/utils@4.2.0
  - @bike4mind/db-core@0.4.1
  - @bike4mind/agents@0.20.3
  - @bike4mind/mcp@1.41.4
  - @bike4mind/auth@0.7.3

## 6.0.0

### Major Changes

- [#1762](https://github.com/Bike4Mind/bike4mind/pull/1762) [`e805cbe`](https://github.com/Bike4Mind/bike4mind/commit/e805cbe54ebd5c7d1113769d9e28875b79a71fe9) Thanks [@biletskiy6](https://github.com/biletskiy6)! - authorize lakes by org membership set, not the selected-org pointer

### Minor Changes

- [#1520](https://github.com/Bike4Mind/bike4mind/pull/1520) [`3a3aef0`](https://github.com/Bike4Mind/bike4mind/commit/3a3aef0b59afe349f2f5e78ff3c693ea98f616e7) Thanks [@baboosh](https://github.com/baboosh)! - provider spend reconciliation banner

- [#1722](https://github.com/Bike4Mind/bike4mind/pull/1722) [`c9f2085`](https://github.com/Bike4Mind/bike4mind/commit/c9f208569698a2a1ec8210923493d1c460cefbca) Thanks [@onoya](https://github.com/onoya)! - chunk policy at file-owner altitude with the lake as a constraint

- [#1733](https://github.com/Bike4Mind/bike4mind/pull/1733) [`9fad658`](https://github.com/Bike4Mind/bike4mind/commit/9fad658b6504fa00b85045b028aa23c8d27d7bb2) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add lake access audit event model and retention floor

- [#1734](https://github.com/Bike4Mind/bike4mind/pull/1734) [`472f90d`](https://github.com/Bike4Mind/bike4mind/commit/472f90d7f9387a879757ffa81746845ad93a93b2) Thanks [@Illia025](https://github.com/Illia025)! - cost governance - spend levers in the admin panel, enforced at the vectorize gate

- [#1753](https://github.com/Bike4Mind/bike4mind/pull/1753) [`50b52a5`](https://github.com/Bike4Mind/bike4mind/commit/50b52a5fb5f3344b56bd4644b3a2154ca51fe31e) Thanks [@cgtorniado](https://github.com/cgtorniado)! - apply pr-report-generator blueprint (base)

- [#1760](https://github.com/Bike4Mind/bike4mind/pull/1760) [`7c8240c`](https://github.com/Bike4Mind/bike4mind/commit/7c8240ce7aa7ab839ad3ac7cc42aa51bc4fa9055) Thanks [@onoya](https://github.com/onoya)! - org-manageable lakes and ownership succession

### Patch Changes

- [#1528](https://github.com/Bike4Mind/bike4mind/pull/1528) [`da0f7ab`](https://github.com/Bike4Mind/bike4mind/commit/da0f7abd8decb98b13cb3c006a2a4f21e294a974) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - don't race a fresh upload against the knowledge tool

- [#1620](https://github.com/Bike4Mind/bike4mind/pull/1620) [`1a01f97`](https://github.com/Bike4Mind/bike4mind/commit/1a01f977b4b3cfff9a325ac2867553f4ee8b79e7) Thanks [@jarlacut](https://github.com/jarlacut)! - type the notebook-import adapters so a wrong implementation is a compile error

- [#1625](https://github.com/Bike4Mind/bike4mind/pull/1625) [`cae26c4`](https://github.com/Bike4Mind/bike4mind/commit/cae26c4026e606cf412aa9996fdb7a9b444a0e8f) Thanks [@onoya](https://github.com/onoya)! - enforce per-member credit cap at reservation

- [#1701](https://github.com/Bike4Mind/bike4mind/pull/1701) [`16a8920`](https://github.com/Bike4Mind/bike4mind/commit/16a8920bd5a64e14d5fdd73fe0eb14da309d7866) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - guard prompt assembly against dropped feature content

- [#1731](https://github.com/Bike4Mind/bike4mind/pull/1731) [`0b4e580`](https://github.com/Bike4Mind/bike4mind/commit/0b4e58050f10e92ec4f6fad32017d28c54a9d0ae) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - derive the retrieval serve cap from the chunk policy

- [#1737](https://github.com/Bike4Mind/bike4mind/pull/1737) [`9fc991e`](https://github.com/Bike4Mind/bike4mind/commit/9fc991e214af4fd2b1442759dc37528e74b33f11) Thanks [@wescarda](https://github.com/wescarda)! - sum FabFile sizes in the DB for recalculateUserStorage

- [#1738](https://github.com/Bike4Mind/bike4mind/pull/1738) [`5139e4e`](https://github.com/Bike4Mind/bike4mind/commit/5139e4e712089049eb47519455232c5e219c0fbd) Thanks [@wescarda](https://github.com/wescarda)! - carry forward the in-force maxOutputTokens when refusing a starved claim

- [#1742](https://github.com/Bike4Mind/bike4mind/pull/1742) [`de702ea`](https://github.com/Bike4Mind/bike4mind/commit/de702ea4ada1f91ad26167f2d7899a336cf647da) Thanks [@wescarda](https://github.com/wescarda)! - align member-add seat accounting to owner-inclusive team size ([#1423](https://github.com/Bike4Mind/bike4mind/issues/1423))

- [#1754](https://github.com/Bike4Mind/bike4mind/pull/1754) [`cb58a53`](https://github.com/Bike4Mind/bike4mind/commit/cb58a5394c377c8250ff7dafa0a251652be2a87a) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - shrink the always-on chat prompt footprint

- [#1758](https://github.com/Bike4Mind/bike4mind/pull/1758) [`82cd12c`](https://github.com/Bike4Mind/bike4mind/commit/82cd12c90c7772735e2c00c79b0a028fc0c890bd) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - wire the key-availability filter into the agent and deep-agent toolbelts

- [#1761](https://github.com/Bike4Mind/bike4mind/pull/1761) [`c46c8a4`](https://github.com/Bike4Mind/bike4mind/commit/c46c8a46e33df208d4547be6cd07b79add171ef2) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop a co-tag from unstamping a lake's archive

- Updated dependencies [[`3a3aef0`](https://github.com/Bike4Mind/bike4mind/commit/3a3aef0b59afe349f2f5e78ff3c693ea98f616e7), [`da0f7ab`](https://github.com/Bike4Mind/bike4mind/commit/da0f7abd8decb98b13cb3c006a2a4f21e294a974), [`8e03a0e`](https://github.com/Bike4Mind/bike4mind/commit/8e03a0ed6430e40280db316e2301a0f20a8ddc57), [`c9f2085`](https://github.com/Bike4Mind/bike4mind/commit/c9f208569698a2a1ec8210923493d1c460cefbca), [`0b4e580`](https://github.com/Bike4Mind/bike4mind/commit/0b4e58050f10e92ec4f6fad32017d28c54a9d0ae), [`9fad658`](https://github.com/Bike4Mind/bike4mind/commit/9fad658b6504fa00b85045b028aa23c8d27d7bb2), [`472f90d`](https://github.com/Bike4Mind/bike4mind/commit/472f90d7f9387a879757ffa81746845ad93a93b2), [`9fc991e`](https://github.com/Bike4Mind/bike4mind/commit/9fc991e214af4fd2b1442759dc37528e74b33f11), [`de702ea`](https://github.com/Bike4Mind/bike4mind/commit/de702ea4ada1f91ad26167f2d7899a336cf647da), [`50b52a5`](https://github.com/Bike4Mind/bike4mind/commit/50b52a5fb5f3344b56bd4644b3a2154ca51fe31e), [`cb58a53`](https://github.com/Bike4Mind/bike4mind/commit/cb58a5394c377c8250ff7dafa0a251652be2a87a), [`7c8240c`](https://github.com/Bike4Mind/bike4mind/commit/7c8240ce7aa7ab839ad3ac7cc42aa51bc4fa9055), [`c46c8a4`](https://github.com/Bike4Mind/bike4mind/commit/c46c8a46e33df208d4547be6cd07b79add171ef2), [`e805cbe`](https://github.com/Bike4Mind/bike4mind/commit/e805cbe54ebd5c7d1113769d9e28875b79a71fe9), [`1507c14`](https://github.com/Bike4Mind/bike4mind/commit/1507c143605a375cce15735d4a953c3ee470bc7d)]:
  - @bike4mind/common@5.0.0
  - @bike4mind/utils@4.1.0
  - @bike4mind/fab-pipeline@1.1.0
  - @bike4mind/db-core@0.4.0
  - @bike4mind/agents@0.20.2
  - @bike4mind/auth@0.7.2
  - @bike4mind/llm-adapters@0.11.2
  - @bike4mind/mcp@1.41.3

## 5.0.0

### Major Changes

- [#1688](https://github.com/Bike4Mind/bike4mind/pull/1688) [`851e2c2`](https://github.com/Bike4Mind/bike4mind/commit/851e2c26928c92c574d9310e2eec8e268f672882) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - return debug info from buildAndSortMessages

### Minor Changes

- [#1594](https://github.com/Bike4Mind/bike4mind/pull/1594) [`549c92d`](https://github.com/Bike4Mind/bike4mind/commit/549c92d2fddda1bd02685b18d667ad785479537b) Thanks [@onoya](https://github.com/onoya)! - make corpus inline-vs-retrieve a per-lake grounding mode

- [#1610](https://github.com/Bike4Mind/bike4mind/pull/1610) [`8cf6d07`](https://github.com/Bike4Mind/bike4mind/commit/8cf6d077b5310ced28da693e2b502b668dd6d326) Thanks [@onoya](https://github.com/onoya)! - ingest a connected Google Drive folder into a data lake ([#1589](https://github.com/Bike4Mind/bike4mind/issues/1589))

- [#1643](https://github.com/Bike4Mind/bike4mind/pull/1643) [`ec81acc`](https://github.com/Bike4Mind/bike4mind/commit/ec81acc5b50a40589c279ac0a92c006bbce3bac5) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - vectorSearch cutover for mixed-embeddingModel lakes

- [#1713](https://github.com/Bike4Mind/bike4mind/pull/1713) [`ed20c15`](https://github.com/Bike4Mind/bike4mind/commit/ed20c1595a1a3bdfcd2b67302b1a0d05a713e826) Thanks [@onoya](https://github.com/onoya)! - scoped settings resolver (platform -> org -> owner -> lake)

- [#1719](https://github.com/Bike4Mind/bike4mind/pull/1719) [`b98acf7`](https://github.com/Bike4Mind/bike4mind/commit/b98acf7bf967471089155ea3e2d7766791b2bfb7) Thanks [@biletskiy6](https://github.com/biletskiy6)! - persist chunk char length and per-file text length, with backfill

- [#1720](https://github.com/Bike4Mind/bike4mind/pull/1720) [`92f199c`](https://github.com/Bike4Mind/bike4mind/commit/92f199cae0be5fe4b55744bfa6d65ad07c109936) Thanks [@onoya](https://github.com/onoya)! - add data lake access-grant relation with roles and expiry

### Patch Changes

- [#1598](https://github.com/Bike4Mind/bike4mind/pull/1598) [`abc90f5`](https://github.com/Bike4Mind/bike4mind/commit/abc90f562e15caa46428fc94afa3ffff410e5d5c) Thanks [@onoya](https://github.com/onoya)! - keep grounded chat from inventing customers, deals and figures absent from retrieval

- [#1704](https://github.com/Bike4Mind/bike4mind/pull/1704) [`b0def05`](https://github.com/Bike4Mind/bike4mind/commit/b0def05de4c614089387779871f381d3b2070045) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - delimit retrieved knowledge-base content as untrusted

- [#1709](https://github.com/Bike4Mind/bike4mind/pull/1709) [`c0d796f`](https://github.com/Bike4Mind/bike4mind/commit/c0d796f274b8985f07fc46fe90980a1f741a0f11) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - preserve data-lake membership on whole-array writes

- Updated dependencies [[`abc90f5`](https://github.com/Bike4Mind/bike4mind/commit/abc90f562e15caa46428fc94afa3ffff410e5d5c), [`851e2c2`](https://github.com/Bike4Mind/bike4mind/commit/851e2c26928c92c574d9310e2eec8e268f672882), [`ed20c15`](https://github.com/Bike4Mind/bike4mind/commit/ed20c1595a1a3bdfcd2b67302b1a0d05a713e826)]:
  - @bike4mind/common@4.0.1
  - @bike4mind/utils@4.0.0
  - @bike4mind/agents@0.20.1
  - @bike4mind/auth@0.7.1
  - @bike4mind/db-core@0.3.1
  - @bike4mind/fab-pipeline@1.0.1
  - @bike4mind/llm-adapters@0.11.1
  - @bike4mind/mcp@1.41.2

## 4.0.0

### Major Changes

- [#1047](https://github.com/Bike4Mind/bike4mind/pull/1047) [`1e3699a`](https://github.com/Bike4Mind/bike4mind/commit/1e3699a72f4d87b6ab0465fd401901544c3fed76) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - bound retrieval and stop silently truncating

### Minor Changes

- [#1008](https://github.com/Bike4Mind/bike4mind/pull/1008) [`bea4af8`](https://github.com/Bike4Mind/bike4mind/commit/bea4af87e0a8ea45fca89ce2ba9885c982f6c185) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - inject a trusted lake's systemPrompt into chat ([#843](https://github.com/Bike4Mind/bike4mind/issues/843))

- [#1013](https://github.com/Bike4Mind/bike4mind/pull/1013) [`9699565`](https://github.com/Bike4Mind/bike4mind/commit/96995652963393c86779a40386a261b4b2385cd5) Thanks [@onoya](https://github.com/onoya)! - compact context under token pressure and surface it

- [#1025](https://github.com/Bike4Mind/bike4mind/pull/1025) [`fc6307a`](https://github.com/Bike4Mind/bike4mind/commit/fc6307a5df18ccb7cf807ff4304914b363e4ea62) Thanks [@maconard](https://github.com/maconard)! - replace hardcoded model lists with a live discovery-driven registry

- [#1037](https://github.com/Bike4Mind/bike4mind/pull/1037) [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592) Thanks [@onoya](https://github.com/onoya)! - persist generated TTS/sound-effect audio as browsable FabFiles

- [#1061](https://github.com/Bike4Mind/bike4mind/pull/1061) [`9b746b6`](https://github.com/Bike4Mind/bike4mind/commit/9b746b6c560ac2feb66193075c929c71953ec3d6) Thanks [@vinchi777](https://github.com/vinchi777)! - audited read-only support view of a user's session and quests ([#955](https://github.com/Bike4Mind/bike4mind/issues/955))

- [#1067](https://github.com/Bike4Mind/bike4mind/pull/1067) [`d9d28d3`](https://github.com/Bike4Mind/bike4mind/commit/d9d28d3d89097ee33782dd2d631e77fd2db0f381) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add the per-lake system prompt editor ([#843](https://github.com/Bike4Mind/bike4mind/issues/843))

- [#1089](https://github.com/Bike4Mind/bike4mind/pull/1089) [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b) Thanks [@erikbethke](https://github.com/erikbethke)! - add Moonshot (Kimi) as a model provider, direct and via Bedrock

- [#1454](https://github.com/Bike4Mind/bike4mind/pull/1454) [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reserve attached-file budget and warn when a file will not fit

- [#1475](https://github.com/Bike4Mind/bike4mind/pull/1475) [`26aad59`](https://github.com/Bike4Mind/bike4mind/commit/26aad59cb0fa6f3747cd59277ea45ec8bad8e3b2) Thanks [@dea0030](https://github.com/dea0030)! - add dismiss action for ready/failed taxonomy suggestions

- [#1479](https://github.com/Bike4Mind/bike4mind/pull/1479) [`1d26e34`](https://github.com/Bike4Mind/bike4mind/commit/1d26e34a64bc0e1497acf37bee3dc35d61a7f3cc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - Atlas $vectorSearch cutover for Data Lake search

- [#1482](https://github.com/Bike4Mind/bike4mind/pull/1482) [`bf8548e`](https://github.com/Bike4Mind/bike4mind/commit/bf8548e646a33e97afc2ed229cbb676c7c6033ab) Thanks [@onoya](https://github.com/onoya)! - audio_generation LLM tool (model-callable TTS + sound effects)

- [#1488](https://github.com/Bike4Mind/bike4mind/pull/1488) [`e935892`](https://github.com/Bike4Mind/bike4mind/commit/e9358920eef4bdde2feeaeb9f1b1b37d52fd7b2c) Thanks [@onoya](https://github.com/onoya)! - data-lake memory profile — fold + wire ([#1440](https://github.com/Bike4Mind/bike4mind/issues/1440))

- [#1543](https://github.com/Bike4Mind/bike4mind/pull/1543) [`1416d3c`](https://github.com/Bike4Mind/bike4mind/commit/1416d3cfe5571f6908be0a19b9310aacd8948b0d) Thanks [@vinchi777](https://github.com/vinchi777)! - price a proposed successor in the model lifecycle queue

- [#1545](https://github.com/Bike4Mind/bike4mind/pull/1545) [`bdc67bf`](https://github.com/Bike4Mind/bike4mind/commit/bdc67bffdbe5c8226bd71c7689c913f44f88280e) Thanks [@vinchi777](https://github.com/vinchi777)! - let grounded chats count the knowledge base instead of confabulating

- [#1547](https://github.com/Bike4Mind/bike4mind/pull/1547) [`cfe3660`](https://github.com/Bike4Mind/bike4mind/commit/cfe366047a212f9fa0a76e3483f462426d4f2560) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add files to a data lake from '@datalake add'

- [#1554](https://github.com/Bike4Mind/bike4mind/pull/1554) [`94ee5ac`](https://github.com/Bike4Mind/bike4mind/commit/94ee5ac284e554619d2562c3fd4dcfc2bace1b23) Thanks [@onoya](https://github.com/onoya)! - bind a preferred system prompt to a data lake

- [#1561](https://github.com/Bike4Mind/bike4mind/pull/1561) [`b7af744`](https://github.com/Bike4Mind/bike4mind/commit/b7af74443a086a9b2980016f36f9ba9d63e863ea) Thanks [@Illia025](https://github.com/Illia025)! - rework the AI Settings model picker and per-model settings

- [#1568](https://github.com/Bike4Mind/bike4mind/pull/1568) [`393cf48`](https://github.com/Bike4Mind/bike4mind/commit/393cf482cbf13dc77e4c26e9b8a7d395fe3353d9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add optional self-host OpenSearch retrieval

- [#1623](https://github.com/Bike4Mind/bike4mind/pull/1623) [`ea548e4`](https://github.com/Bike4Mind/bike4mind/commit/ea548e49da1166e11d969a60ffe0bd8d1fd084be) Thanks [@cgtorniado](https://github.com/cgtorniado)! - label lakes you don't own in the manager

- [#1642](https://github.com/Bike4Mind/bike4mind/pull/1642) [`d8d1359`](https://github.com/Bike4Mind/bike4mind/commit/d8d13590f14db9fb13f9f2d05cd0f12e1f5a73e8) Thanks [@vinchi777](https://github.com/vinchi777)! - return the assembled system prompt text on request

- [#442](https://github.com/Bike4Mind/bike4mind/pull/442) [`89f72cb`](https://github.com/Bike4Mind/bike4mind/commit/89f72cbdd9e7e93d59c01c51f7c55fe0396283c6) Thanks [@erikbethke](https://github.com/erikbethke)! - Mementos 2.0 - unified principal-scoped memory core

- [#532](https://github.com/Bike4Mind/bike4mind/pull/532) [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948) Thanks [@cgtorniado](https://github.com/cgtorniado)! - add public visibility for data lakes

- [#586](https://github.com/Bike4Mind/bike4mind/pull/586) [`a08949c`](https://github.com/Bike4Mind/bike4mind/commit/a08949cb625d2d3d6f7bc2c86f3828eb20d483e4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - multi-hop provider-outage fallback + fallback badge clarity

- [#587](https://github.com/Bike4Mind/bike4mind/pull/587) [`fab1452`](https://github.com/Bike4Mind/bike4mind/commit/fab1452922c8564495fb9209b346c1b91f0c7aa2) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - embed-key data model, scope & origin allow-list (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41) Phase A)

- [#599](https://github.com/Bike4Mind/bike4mind/pull/599) [`758f406`](https://github.com/Bike4Mind/bike4mind/commit/758f406376efa5ef605f79b65f576d97854c7689) Thanks [@vinchi777](https://github.com/vinchi777)! - embed-key admin UI to create, configure & revoke (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41) Phase E)

- [#608](https://github.com/Bike4Mind/bike4mind/pull/608) [`2a3162b`](https://github.com/Bike4Mind/bike4mind/commit/2a3162b2db07090b7fd74fb1ac628bcb2f421cf0) Thanks [@dea0030](https://github.com/dea0030)! - add ImageGenerationTemplate model and CRUD API

- [#617](https://github.com/Bike4Mind/bike4mind/pull/617) [`39e562d`](https://github.com/Bike4Mind/bike4mind/commit/39e562d1fb2fa1136e40f8880ac1126ecf7e20c9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - batch system-prompt removal (fileIds[] in DELETE /systemPrompts)

- [#625](https://github.com/Bike4Mind/bike4mind/pull/625) [`e2e2b03`](https://github.com/Bike4Mind/bike4mind/commit/e2e2b03b1c41be581801e8b6197d3341e0bf6b02) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - app-slice operational hardening follow-ups

- [#628](https://github.com/Bike4Mind/bike4mind/pull/628) [`aa16cd8`](https://github.com/Bike4Mind/bike4mind/commit/aa16cd8e54883812cc99632ba9baf46cd124a1a3) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - enable React artifact publishing

- [#635](https://github.com/Bike4Mind/bike4mind/pull/635) [`4dffc64`](https://github.com/Bike4Mind/bike4mind/commit/4dffc64de320f4a59257febe89b1124fbe96e536) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - agent-bound embed completion endpoint w/ origin+CORS & metering (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41) - Phase B.1)

- [#640](https://github.com/Bike4Mind/bike4mind/pull/640) [`d4c3719`](https://github.com/Bike4Mind/bike4mind/commit/d4c3719a98b76093127057d7e7d5a265eebcc810) Thanks [@dea0030](https://github.com/dea0030)! - image settings templates — panel UI, apply, cost preview

- [#651](https://github.com/Bike4Mind/bike4mind/pull/651) [`36b0c67`](https://github.com/Bike4Mind/bike4mind/commit/36b0c67c39b9b8b1645572202255685e2ca770e1) Thanks [@dea0030](https://github.com/dea0030)! - add a by-source breakdown to the Org Usage dashboard

- [#652](https://github.com/Bike4Mind/bike4mind/pull/652) [`7b452e9`](https://github.com/Bike4Mind/bike4mind/commit/7b452e92621fe836eec4acf1c2bd6dff06a8f95e) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - infra hardening (queue offload, reconciler cron, metrics, index drop)

- [#698](https://github.com/Bike4Mind/bike4mind/pull/698) [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4) Thanks [@maconard](https://github.com/maconard)! - add offline RAG ingestion and a background worker

- [#700](https://github.com/Bike4Mind/bike4mind/pull/700) [`43b8c8d`](https://github.com/Bike4Mind/bike4mind/commit/43b8c8d65e1743f81eedad36fa4c32d3e4685738) Thanks [@maconard](https://github.com/maconard)! - local web search via searxng and keyless deep-research fallback

- [#705](https://github.com/Bike4Mind/bike4mind/pull/705) [`c8da52b`](https://github.com/Bike4Mind/bike4mind/commit/c8da52b42a7509f2b94c9436d2c3cb9b66c67c14) Thanks [@maconard](https://github.com/maconard)! - local image generation via a self-hosted Stable Diffusion backend

- [#713](https://github.com/Bike4Mind/bike4mind/pull/713) [`e60f14a`](https://github.com/Bike4Mind/bike4mind/commit/e60f14aa734c6fc41a6c59ae1fd57bb9b386aa08) Thanks [@maconard](https://github.com/maconard)! - keyless offline RAG defaults and bundled secure-exposure profiles

- [#727](https://github.com/Bike4Mind/bike4mind/pull/727) [`a3ca585`](https://github.com/Bike4Mind/bike4mind/commit/a3ca585906fee85628701c6975062b6f16590106) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - per-embed-key spend cap with pre-flight enforcement (epic [#41](https://github.com/Bike4Mind/bike4mind/issues/41))

- [#728](https://github.com/Bike4Mind/bike4mind/pull/728) [`ab88253`](https://github.com/Bike4Mind/bike4mind/commit/ab882537269a1ccb83d18b2e71a89f2fd32934b8) Thanks [@onoya](https://github.com/onoya)! - provider-agnostic sound-effects generation API

- [#733](https://github.com/Bike4Mind/bike4mind/pull/733) [`7b6f99b`](https://github.com/Bike4Mind/bike4mind/commit/7b6f99beb0d58e4d4382c0e8e9e90925a7f5e350) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - agent-scoped KB retrieval + hard tool gate for embed chat

- [#737](https://github.com/Bike4Mind/bike4mind/pull/737) [`1332668`](https://github.com/Bike4Mind/bike4mind/commit/133266801e52d4402150e5605a994a0d8522d8fa) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - reduce executive-summary token spend via caching

- [#742](https://github.com/Bike4Mind/bike4mind/pull/742) [`5c2e209`](https://github.com/Bike4Mind/bike4mind/commit/5c2e209c36e487ed468a1c067d692b5051ba595d) Thanks [@onoya](https://github.com/onoya)! - unified multi-provider text-to-speech API

- [#760](https://github.com/Bike4Mind/bike4mind/pull/760) [`c2f4cbc`](https://github.com/Bike4Mind/bike4mind/commit/c2f4cbc864b653c47c05c94e07495fa757331a51) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - public embed chat widget, serve route, and snippet

- [#788](https://github.com/Bike4Mind/bike4mind/pull/788) [`886d408`](https://github.com/Bike4Mind/bike4mind/commit/886d40823384c9ff06ee84ab8da20ebbac3e8d3f) Thanks [@onoya](https://github.com/onoya)! - revoke sessions on logout + add admin force-logout endpoint

- [#799](https://github.com/Bike4Mind/bike4mind/pull/799) [`ab05d21`](https://github.com/Bike4Mind/bike4mind/commit/ab05d2112dbb61f124ff37227b40c92b667ee1d1) Thanks [@maconard](https://github.com/maconard)! - qwen3.5 default local models, qwen2.5-coder for artifacts, and Ollama thinking detection

- [#864](https://github.com/Bike4Mind/bike4mind/pull/864) [`4ca1471`](https://github.com/Bike4Mind/bike4mind/commit/4ca14711bbb459fe30969c9f58358adda37631fe) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - per-embed-key white-label theming and plan-gated branding

- [#878](https://github.com/Bike4Mind/bike4mind/pull/878) [`78731c5`](https://github.com/Bike4Mind/bike4mind/commit/78731c5315bb93d447fbee751cb24403a77692c1) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - model-less warnings in embed keys table and agent form

- [#881](https://github.com/Bike4Mind/bike4mind/pull/881) [`3d7d6f6`](https://github.com/Bike4Mind/bike4mind/commit/3d7d6f6f7601375e40dc4d36f95a088137ecb58f) Thanks [@dea0030](https://github.com/dea0030)! - allow updating per-key rate limits without rotating

- [#894](https://github.com/Bike4Mind/bike4mind/pull/894) [`399f2c7`](https://github.com/Bike4Mind/bike4mind/commit/399f2c7c941954e0dfd5b37e010bbeaa54ea2140) Thanks [@dea0030](https://github.com/dea0030)! - record revocation metadata so revoked keys have an audit trail

- [#902](https://github.com/Bike4Mind/bike4mind/pull/902) [`1557271`](https://github.com/Bike4Mind/bike4mind/commit/15572713aeafb5eab086833ea7faedcdd8867d32) Thanks [@cgtorniado](https://github.com/cgtorniado)! - audit admin credit adjustments across both credit paths

- [#934](https://github.com/Bike4Mind/bike4mind/pull/934) [`8ca1a70`](https://github.com/Bike4Mind/bike4mind/commit/8ca1a70c2b0bfbf7bccb33620cdbff83fd77cb47) Thanks [@cgtorniado](https://github.com/cgtorniado)! - add public-lake browse & discover surface

- [#975](https://github.com/Bike4Mind/bike4mind/pull/975) [`c95fe24`](https://github.com/Bike4Mind/bike4mind/commit/c95fe2462e911310f9cbb0a7b3155dc95e1b1077) Thanks [@dea0030](https://github.com/dea0030)! - allow clearing an access gate from lake settings

- [#980](https://github.com/Bike4Mind/bike4mind/pull/980) [`c1f563e`](https://github.com/Bike4Mind/bike4mind/commit/c1f563ee248317485e4262289dec13c16e864dd7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add dormant per-lake systemPrompt model + update schema ([#843](https://github.com/Bike4Mind/bike4mind/issues/843))

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

- [#1010](https://github.com/Bike4Mind/bike4mind/pull/1010) [`6d01a12`](https://github.com/Bike4Mind/bike4mind/commit/6d01a124b85c54ac76d532773a44d42091ed7b83) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - let an owner retrieve their own gated lake

- [#1029](https://github.com/Bike4Mind/bike4mind/pull/1029) [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - keep uploaded documents in notebook context so the model can use them

- [#1030](https://github.com/Bike4Mind/bike4mind/pull/1030) [`9d1ac0a`](https://github.com/Bike4Mind/bike4mind/commit/9d1ac0aef0622d2187e1e394d0c3ea0ecdc2d6e3) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - detect and warn on elided artifact bodies

- [#1042](https://github.com/Bike4Mind/bike4mind/pull/1042) [`42b0798`](https://github.com/Bike4Mind/bike4mind/commit/42b0798e751b28190fb2757fa37d5ab345e08eae) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - clear every membership signal when a file leaves a lake

- [#597](https://github.com/Bike4Mind/bike4mind/pull/597) [`cc085b0`](https://github.com/Bike4Mind/bike4mind/commit/cc085b047884f1733b6c84958da4400da1712cd4) Thanks [@onoya](https://github.com/onoya)! - scope organization responses to the caller

- [#619](https://github.com/Bike4Mind/bike4mind/pull/619) [`97dfbd7`](https://github.com/Bike4Mind/bike4mind/commit/97dfbd74a5a9d118a83d0b47ddc886a1e15d43ae) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - retire organizationManager in favor of organizationService

- [#636](https://github.com/Bike4Mind/bike4mind/pull/636) [`836f701`](https://github.com/Bike4Mind/bike4mind/commit/836f701eaf6b9800e7499cf2e68766bf290530ba) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - retire sharingManager in favor of sharingService

- [#637](https://github.com/Bike4Mind/bike4mind/pull/637) [`61df8ce`](https://github.com/Bike4Mind/bike4mind/commit/61df8ced554f980d9e18390e694e07c0362bef1a) Thanks [@onoya](https://github.com/onoya)! - declare transitive npm deps bundled from @bike4mind/* packages

- [#643](https://github.com/Bike4Mind/bike4mind/pull/643) [`c19b591`](https://github.com/Bike4Mind/bike4mind/commit/c19b59168e6c10fff8b7c4663eaa0365a3decacf) Thanks [@StormyEmery](https://github.com/StormyEmery)! - exclude unlistable lake files from knowledge-base retrieval

- [#648](https://github.com/Bike4Mind/bike4mind/pull/648) [`bbede0c`](https://github.com/Bike4Mind/bike4mind/commit/bbede0ca75ef3f05ecbb7db8682082c0bf9a861e) Thanks [@onoya](https://github.com/onoya)! - bill tool-internal LLM calls in agent iteration billing

- [#716](https://github.com/Bike4Mind/bike4mind/pull/716) [`273a7f2`](https://github.com/Bike4Mind/bike4mind/commit/273a7f2c6e67e9913154cf7e65ab0e18a4c595b0) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from notebookCurationService

- [#732](https://github.com/Bike4Mind/bike4mind/pull/732) [`b8399b9`](https://github.com/Bike4Mind/bike4mind/commit/b8399b9f7142db63c8f8606bf9e25a927f578a3d) Thanks [@onoya](https://github.com/onoya)! - stamp and enforce a token-type claim on access/refresh tokens

- [#739](https://github.com/Bike4Mind/bike4mind/pull/739) [`c324761`](https://github.com/Bike4Mind/bike4mind/commit/c324761fd20870fea316f5da63214e7fbb07c55d) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from image generation services

- [#761](https://github.com/Bike4Mind/bike4mind/pull/761) [`04dafef`](https://github.com/Bike4Mind/bike4mind/commit/04dafefc2a2ee494fcb643c1661176f12a431c0c) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from image generation and edit tools

- [#762](https://github.com/Bike4Mind/bike4mind/pull/762) [`6b4f36e`](https://github.com/Bike4Mind/bike4mind/commit/6b4f36edfe3ff42542357eaa1a91dca90045d4dc) Thanks [@dea0030](https://github.com/dea0030)! - decouple Kontext dispatch from requiresImageInput

- [#793](https://github.com/Bike4Mind/bike4mind/pull/793) [`d083562`](https://github.com/Bike4Mind/bike4mind/commit/d08356278004a036c0c90d079b655ecb8260ba21) Thanks [@onoya](https://github.com/onoya)! - stop bundling server-only services/utils code into the CLI ([#660](https://github.com/Bike4Mind/bike4mind/issues/660))

- [#802](https://github.com/Bike4Mind/bike4mind/pull/802) [`3261fac`](https://github.com/Bike4Mind/bike4mind/commit/3261facacc4e53a356dfb4d213cb335d29a89462) Thanks [@dea0030](https://github.com/dea0030)! - anchor attribute values to their opening quote so apostrophes survive ([#795](https://github.com/Bike4Mind/bike4mind/issues/795))

- [#809](https://github.com/Bike4Mind/bike4mind/pull/809) [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8) Thanks [@poysama](https://github.com/poysama)! - remediate transitive Dependabot vulns via pnpm overrides

- [#857](https://github.com/Bike4Mind/bike4mind/pull/857) [`445b944`](https://github.com/Bike4Mind/bike4mind/commit/445b9441b3fef464ab323d00d3986c3da7ba30e0) Thanks [@onoya](https://github.com/onoya)! - count tool-schema tokens in the local input estimate

- [#926](https://github.com/Bike4Mind/bike4mind/pull/926) [`97befec`](https://github.com/Bike4Mind/bike4mind/commit/97befec9db936394ceff2131db6e72005547bf16) Thanks [@cgtorniado](https://github.com/cgtorniado)! - resolve notebook-context images and drop attachments for text-only models

- [#938](https://github.com/Bike4Mind/bike4mind/pull/938) [`3d37217`](https://github.com/Bike4Mind/bike4mind/commit/3d3721797e898732b5d597815c4fdfd0581de715) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - require org billing for embed:chat keys at the mint layer

- [#940](https://github.com/Bike4Mind/bike4mind/pull/940) [`eb23f3a`](https://github.com/Bike4Mind/bike4mind/commit/eb23f3a16f66c7758e84f6e486ae3058f9e13e93) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - org-admin-aware embed-key writes and org-billing guard

- [#943](https://github.com/Bike4Mind/bike4mind/pull/943) [`22fc094`](https://github.com/Bike4Mind/bike4mind/commit/22fc094cec6f7d210e6edfd0045033450ef0ae73) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from researchTaskService/utils

- [#944](https://github.com/Bike4Mind/bike4mind/pull/944) [`c0d8c05`](https://github.com/Bike4Mind/bike4mind/commit/c0d8c05357f774086f0b18c393d7feac5921a196) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - Zod validation at API boundaries — 930 coverage gap (b4m-infra#615)

- [#974](https://github.com/Bike4Mind/bike4mind/pull/974) [`bf8dbbd`](https://github.com/Bike4Mind/bike4mind/commit/bf8dbbd8f050608d52588b32108ce098a2a5047e) Thanks [@maconard](https://github.com/maconard)! - correct bedrock anthropic prices and bill image edits from the cost table

- [#985](https://github.com/Bike4Mind/bike4mind/pull/985) [`7e21469`](https://github.com/Bike4Mind/bike4mind/commit/7e21469de38bf7232c6f01bde47b6576bd447fac) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - unify lake scope across semantic search and chat retrieval

- [#986](https://github.com/Bike4Mind/bike4mind/pull/986) [`dd3175d`](https://github.com/Bike4Mind/bike4mind/commit/dd3175da13481cc851b3b026bc73847ddcd67331) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - report partial results when embedding models differ

- [#987](https://github.com/Bike4Mind/bike4mind/pull/987) [`51f3f35`](https://github.com/Bike4Mind/bike4mind/commit/51f3f3522f254ad095857daea891b644a5766efc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - stop workbench hydration from persisting a lost update

- [#991](https://github.com/Bike4Mind/bike4mind/pull/991) [`ec61517`](https://github.com/Bike4Mind/bike4mind/commit/ec6151734c62cb681c85866e003776040f776bed) Thanks [@ktdejesus](https://github.com/ktdejesus)! - remove pre-cutover tracker references from logs and a test title

- [#1560](https://github.com/Bike4Mind/bike4mind/pull/1560) [`9ebf19a`](https://github.com/Bike4Mind/bike4mind/commit/9ebf19ae60296f7fb6f3f8e75e47c7a8ddc37634) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - `tagService.update`'s adapter no longer asks for `Pick<ITagRepository, 'update' | ...>`. Its
  `tags.update` is now declared as the exact shape the service writes,
  `TagUpdateParams & { updatedAt: Date }`. This is a relaxation, so every adapter that satisfied the
  old type still satisfies the new one - but it is what lets an `IFileTag`-typed repository be passed
  without a cast. `IBaseRepository` declares `update` as a property-syntax function type, so
  `strictFunctionTypes` checks its parameter contravariantly and a `Partial<IBaseTag>` parameter
  rejects a `Partial<IFileTag>` one on `TagType` vs `TagType.FILE`.

  Behavioural note for anyone tracking the HTTP surface rather than the package: the caller of this
  service, `PUT/DELETE /api/files/tags/[id]`, now takes the tag id from the URL on both verbs instead
  of from the request body on PUT, and rejects a missing, empty or repeated URL id with a 400. That
  route previously answered 422 (zod) for a repeated id and 404 (Mongoose `CastError`) for an empty
  one. It lives in a private app package, so it has no changelog of its own; it is recorded here
  because the route is reachable with an API key and an external consumer could have depended on the
  old status codes.

- Updated dependencies [[`c09e844`](https://github.com/Bike4Mind/bike4mind/commit/c09e84486c087c8a108b802cf5d9d1b63ea5fa91), [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305), [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9), [`393cf48`](https://github.com/Bike4Mind/bike4mind/commit/393cf482cbf13dc77e4c26e9b8a7d395fe3353d9), [`ad5921f`](https://github.com/Bike4Mind/bike4mind/commit/ad5921f531fdd2db2fa4a2a783ebde60f2566034), [`847c3a3`](https://github.com/Bike4Mind/bike4mind/commit/847c3a359ec1ee8d6374dd3819de8f8bb6ea269d), [`6d01a12`](https://github.com/Bike4Mind/bike4mind/commit/6d01a124b85c54ac76d532773a44d42091ed7b83), [`9699565`](https://github.com/Bike4Mind/bike4mind/commit/96995652963393c86779a40386a261b4b2385cd5), [`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989), [`fc6307a`](https://github.com/Bike4Mind/bike4mind/commit/fc6307a5df18ccb7cf807ff4304914b363e4ea62), [`55cc590`](https://github.com/Bike4Mind/bike4mind/commit/55cc5901ca051b8b5d9c4de02a42c5828b18adfe), [`eaddba0`](https://github.com/Bike4Mind/bike4mind/commit/eaddba030600dc87a926f34ef781d9678e222ef9), [`9d1ac0a`](https://github.com/Bike4Mind/bike4mind/commit/9d1ac0aef0622d2187e1e394d0c3ea0ecdc2d6e3), [`bd0b213`](https://github.com/Bike4Mind/bike4mind/commit/bd0b213cf9d4aaeb57055a9fb98d49748a44a592), [`42b0798`](https://github.com/Bike4Mind/bike4mind/commit/42b0798e751b28190fb2757fa37d5ab345e08eae), [`1e3699a`](https://github.com/Bike4Mind/bike4mind/commit/1e3699a72f4d87b6ab0465fd401901544c3fed76), [`67c107a`](https://github.com/Bike4Mind/bike4mind/commit/67c107ae7e40c9f5b30875853bb12a4c016c7437), [`671bad8`](https://github.com/Bike4Mind/bike4mind/commit/671bad887ead27267709978ad340fb1bce3d2f6f), [`9b746b6`](https://github.com/Bike4Mind/bike4mind/commit/9b746b6c560ac2feb66193075c929c71953ec3d6), [`05c9e5c`](https://github.com/Bike4Mind/bike4mind/commit/05c9e5cd4393667099f0bc324599311b5eff3d6a), [`5990451`](https://github.com/Bike4Mind/bike4mind/commit/5990451279e3ee9058615051711a6e243218a587), [`d9d28d3`](https://github.com/Bike4Mind/bike4mind/commit/d9d28d3d89097ee33782dd2d631e77fd2db0f381), [`120b37c`](https://github.com/Bike4Mind/bike4mind/commit/120b37c7a6abf5be317062dae10c3996a97d76e8), [`d0627b6`](https://github.com/Bike4Mind/bike4mind/commit/d0627b6c29e019eee7e7405c5df51dd6a66ad60b), [`cdd3a09`](https://github.com/Bike4Mind/bike4mind/commit/cdd3a09854f08fee25a71a53b42b76fb64a33c7d), [`6e84c0d`](https://github.com/Bike4Mind/bike4mind/commit/6e84c0d760ca11a1175f9a8042c53eab4276a0b6), [`3e3cb08`](https://github.com/Bike4Mind/bike4mind/commit/3e3cb083adb399d3bd8923b0ef8405e5479001a5), [`a8d15d3`](https://github.com/Bike4Mind/bike4mind/commit/a8d15d3aa4f3a8a6dbc309731db1aa5dd49ef4ba), [`59088ab`](https://github.com/Bike4Mind/bike4mind/commit/59088ab8f1cd217d12110770041bb43c79840142), [`d1519d3`](https://github.com/Bike4Mind/bike4mind/commit/d1519d34a80865acd9a36c53c1ec5c098ece3f31), [`aa928d4`](https://github.com/Bike4Mind/bike4mind/commit/aa928d4401d809818ac981957ffed385d98115dd), [`c6b9eb1`](https://github.com/Bike4Mind/bike4mind/commit/c6b9eb1c0e62077e43e57ff6c78d7263c3e56dad), [`dc52359`](https://github.com/Bike4Mind/bike4mind/commit/dc5235923732a525f1b9dac2846426bb64a227ba), [`4845a87`](https://github.com/Bike4Mind/bike4mind/commit/4845a87b855e9016e52c4a9514008a22edb5260e), [`cc97fe6`](https://github.com/Bike4Mind/bike4mind/commit/cc97fe6a79940598e7f1700dc38113d597d7ebb1), [`1d0636e`](https://github.com/Bike4Mind/bike4mind/commit/1d0636e58f22028ad10cb15b2dae5a66c8e507eb), [`90717f8`](https://github.com/Bike4Mind/bike4mind/commit/90717f8a4c080738fe2ce0bddadd4fc02b6361c4), [`f5e5ae5`](https://github.com/Bike4Mind/bike4mind/commit/f5e5ae5ed64787e499c4bbf1a56875617a705305), [`1d26e34`](https://github.com/Bike4Mind/bike4mind/commit/1d26e34a64bc0e1497acf37bee3dc35d61a7f3cc), [`bf8548e`](https://github.com/Bike4Mind/bike4mind/commit/bf8548e646a33e97afc2ed229cbb676c7c6033ab), [`76d7e98`](https://github.com/Bike4Mind/bike4mind/commit/76d7e988422ddd811cd57d2c797f91dd95a729dc), [`95fbfa4`](https://github.com/Bike4Mind/bike4mind/commit/95fbfa4d70eb2e24a8981544d174a41583994fa8), [`393cf48`](https://github.com/Bike4Mind/bike4mind/commit/393cf482cbf13dc77e4c26e9b8a7d395fe3353d9), [`5ff3797`](https://github.com/Bike4Mind/bike4mind/commit/5ff3797b6b83ec20629efb24c5216288a90a84f8), [`c632544`](https://github.com/Bike4Mind/bike4mind/commit/c632544d07271bb44d124fd3dfeb9876fc6dc536), [`89f72cb`](https://github.com/Bike4Mind/bike4mind/commit/89f72cbdd9e7e93d59c01c51f7c55fe0396283c6), [`b8af6bc`](https://github.com/Bike4Mind/bike4mind/commit/b8af6bc31f67a3e13a306b34f47223dae1328948), [`cf2c553`](https://github.com/Bike4Mind/bike4mind/commit/cf2c5531ca947f6c3be6ffd6175ea94f0cc390c1), [`a08949c`](https://github.com/Bike4Mind/bike4mind/commit/a08949cb625d2d3d6f7bc2c86f3828eb20d483e4), [`fab1452`](https://github.com/Bike4Mind/bike4mind/commit/fab1452922c8564495fb9209b346c1b91f0c7aa2), [`cc085b0`](https://github.com/Bike4Mind/bike4mind/commit/cc085b047884f1733b6c84958da4400da1712cd4), [`758f406`](https://github.com/Bike4Mind/bike4mind/commit/758f406376efa5ef605f79b65f576d97854c7689), [`93c2e0e`](https://github.com/Bike4Mind/bike4mind/commit/93c2e0e5e71c246cf379caac576974c165f5a1c5), [`2a3162b`](https://github.com/Bike4Mind/bike4mind/commit/2a3162b2db07090b7fd74fb1ac628bcb2f421cf0), [`ebed878`](https://github.com/Bike4Mind/bike4mind/commit/ebed87812a188eda01788349489e33956f1de44a), [`19abb8c`](https://github.com/Bike4Mind/bike4mind/commit/19abb8c2662979fc4d0648dabfa7364ca6cdb81e), [`40a35ea`](https://github.com/Bike4Mind/bike4mind/commit/40a35ea7f4c530fdbcbc99cf9bee771762b2da96), [`b69313e`](https://github.com/Bike4Mind/bike4mind/commit/b69313ec9147a1da341e0c32f26d6af499c09fea), [`e2e2b03`](https://github.com/Bike4Mind/bike4mind/commit/e2e2b03b1c41be581801e8b6197d3341e0bf6b02), [`aa16cd8`](https://github.com/Bike4Mind/bike4mind/commit/aa16cd8e54883812cc99632ba9baf46cd124a1a3), [`4dffc64`](https://github.com/Bike4Mind/bike4mind/commit/4dffc64de320f4a59257febe89b1124fbe96e536), [`d4c3719`](https://github.com/Bike4Mind/bike4mind/commit/d4c3719a98b76093127057d7e7d5a265eebcc810), [`f29a8ef`](https://github.com/Bike4Mind/bike4mind/commit/f29a8eff394568438a6126610b557f3985dc1c93), [`c19b591`](https://github.com/Bike4Mind/bike4mind/commit/c19b59168e6c10fff8b7c4663eaa0365a3decacf), [`27096e3`](https://github.com/Bike4Mind/bike4mind/commit/27096e3d34e80a23fa40a0c9060498d3cdf27bf4), [`bbede0c`](https://github.com/Bike4Mind/bike4mind/commit/bbede0ca75ef3f05ecbb7db8682082c0bf9a861e), [`96dd741`](https://github.com/Bike4Mind/bike4mind/commit/96dd7415e5465cc1c0318ccfe0d64c9478411024), [`36b0c67`](https://github.com/Bike4Mind/bike4mind/commit/36b0c67c39b9b8b1645572202255685e2ca770e1), [`7b452e9`](https://github.com/Bike4Mind/bike4mind/commit/7b452e92621fe836eec4acf1c2bd6dff06a8f95e), [`4585043`](https://github.com/Bike4Mind/bike4mind/commit/4585043f39f4e57e052047239834fa281dc34141), [`32b419d`](https://github.com/Bike4Mind/bike4mind/commit/32b419dc6c89537b1333888db8fb72bc68b300f3), [`26257f4`](https://github.com/Bike4Mind/bike4mind/commit/26257f4992c219acd095b209a48bf914b4ccff0a), [`db74045`](https://github.com/Bike4Mind/bike4mind/commit/db74045c3c49ee75506e5fad50df81451cf2d24f), [`ad92f01`](https://github.com/Bike4Mind/bike4mind/commit/ad92f01c744b8655edf35ca90e202f8b32126df4), [`7901ec1`](https://github.com/Bike4Mind/bike4mind/commit/7901ec1e668fe2a55e1e128d2c2c5b26dcca5e12), [`43b8c8d`](https://github.com/Bike4Mind/bike4mind/commit/43b8c8d65e1743f81eedad36fa4c32d3e4685738), [`c8da52b`](https://github.com/Bike4Mind/bike4mind/commit/c8da52b42a7509f2b94c9436d2c3cb9b66c67c14), [`e60f14a`](https://github.com/Bike4Mind/bike4mind/commit/e60f14aa734c6fc41a6c59ae1fd57bb9b386aa08), [`9e4f81c`](https://github.com/Bike4Mind/bike4mind/commit/9e4f81c29451d4c186c0077ed66d28a93acf087d), [`c4d2da6`](https://github.com/Bike4Mind/bike4mind/commit/c4d2da628bcba7c7a553dd4e9a26ff04ad258bb8), [`a3ca585`](https://github.com/Bike4Mind/bike4mind/commit/a3ca585906fee85628701c6975062b6f16590106), [`ab88253`](https://github.com/Bike4Mind/bike4mind/commit/ab882537269a1ccb83d18b2e71a89f2fd32934b8), [`b8399b9`](https://github.com/Bike4Mind/bike4mind/commit/b8399b9f7142db63c8f8606bf9e25a927f578a3d), [`7b6f99b`](https://github.com/Bike4Mind/bike4mind/commit/7b6f99beb0d58e4d4382c0e8e9e90925a7f5e350), [`1332668`](https://github.com/Bike4Mind/bike4mind/commit/133266801e52d4402150e5605a994a0d8522d8fa), [`c324761`](https://github.com/Bike4Mind/bike4mind/commit/c324761fd20870fea316f5da63214e7fbb07c55d), [`5c2e209`](https://github.com/Bike4Mind/bike4mind/commit/5c2e209c36e487ed468a1c067d692b5051ba595d), [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6), [`ee4b2dc`](https://github.com/Bike4Mind/bike4mind/commit/ee4b2dcb0132ef2a3b9d978c142c67cf261287ff), [`c2f4cbc`](https://github.com/Bike4Mind/bike4mind/commit/c2f4cbc864b653c47c05c94e07495fa757331a51), [`6b4f36e`](https://github.com/Bike4Mind/bike4mind/commit/6b4f36edfe3ff42542357eaa1a91dca90045d4dc), [`c604eba`](https://github.com/Bike4Mind/bike4mind/commit/c604eba580c0ebea8b58e01bba0a3d424628b789), [`5d81e2c`](https://github.com/Bike4Mind/bike4mind/commit/5d81e2c64712792a7d65690e0f4755f4a19d2ff4), [`a948fb9`](https://github.com/Bike4Mind/bike4mind/commit/a948fb9ffe34d0e76de5a85bbb96c857f081bb6c), [`3b96393`](https://github.com/Bike4Mind/bike4mind/commit/3b96393b022660192e01ce9413bee778d10c8b03), [`886d408`](https://github.com/Bike4Mind/bike4mind/commit/886d40823384c9ff06ee84ab8da20ebbac3e8d3f), [`2e2c285`](https://github.com/Bike4Mind/bike4mind/commit/2e2c28547d92487ee89ded3129970bf27692a74b), [`de251de`](https://github.com/Bike4Mind/bike4mind/commit/de251de41162b538f2463c8be319fe739ac3ce31), [`d083562`](https://github.com/Bike4Mind/bike4mind/commit/d08356278004a036c0c90d079b655ecb8260ba21), [`9d1c73b`](https://github.com/Bike4Mind/bike4mind/commit/9d1c73b1c51bd6aa1380b3c2da27fc35e9e49ae0), [`7dd0442`](https://github.com/Bike4Mind/bike4mind/commit/7dd0442f5bf54c04019da953d2187ff557ff4e0f), [`ab05d21`](https://github.com/Bike4Mind/bike4mind/commit/ab05d2112dbb61f124ff37227b40c92b667ee1d1), [`9023927`](https://github.com/Bike4Mind/bike4mind/commit/90239272090b220c0356b2b84f525316b1dcafb9), [`3261fac`](https://github.com/Bike4Mind/bike4mind/commit/3261facacc4e53a356dfb4d213cb335d29a89462), [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8), [`a392018`](https://github.com/Bike4Mind/bike4mind/commit/a3920185ffd1a31c1f1c228b24011ea4d58926bd), [`4ca1471`](https://github.com/Bike4Mind/bike4mind/commit/4ca14711bbb459fe30969c9f58358adda37631fe), [`3d7d6f6`](https://github.com/Bike4Mind/bike4mind/commit/3d7d6f6f7601375e40dc4d36f95a088137ecb58f), [`ef8492a`](https://github.com/Bike4Mind/bike4mind/commit/ef8492afbeb06ea552665841efb547448786f1a4), [`399f2c7`](https://github.com/Bike4Mind/bike4mind/commit/399f2c7c941954e0dfd5b37e010bbeaa54ea2140), [`d52a0fe`](https://github.com/Bike4Mind/bike4mind/commit/d52a0feb494eeda57a15c956685c72dbc516577b), [`44b63f2`](https://github.com/Bike4Mind/bike4mind/commit/44b63f28de85494f5ee71203e74670bdef1ccd04), [`1557271`](https://github.com/Bike4Mind/bike4mind/commit/15572713aeafb5eab086833ea7faedcdd8867d32), [`ee85861`](https://github.com/Bike4Mind/bike4mind/commit/ee85861d2821767d0d0648a960303ba66a19bb00), [`61025c3`](https://github.com/Bike4Mind/bike4mind/commit/61025c3651db5aa06c7acd4ce292e445f05c00ed), [`8ca1a70`](https://github.com/Bike4Mind/bike4mind/commit/8ca1a70c2b0bfbf7bccb33620cdbff83fd77cb47), [`3d37217`](https://github.com/Bike4Mind/bike4mind/commit/3d3721797e898732b5d597815c4fdfd0581de715), [`eb23f3a`](https://github.com/Bike4Mind/bike4mind/commit/eb23f3a16f66c7758e84f6e486ae3058f9e13e93), [`91cdd07`](https://github.com/Bike4Mind/bike4mind/commit/91cdd07bef6e972688f64694a06c2d4b4ab23010), [`c0d8c05`](https://github.com/Bike4Mind/bike4mind/commit/c0d8c05357f774086f0b18c393d7feac5921a196), [`000c0b5`](https://github.com/Bike4Mind/bike4mind/commit/000c0b515913da4a894de023937131a355aa868a), [`5d96e19`](https://github.com/Bike4Mind/bike4mind/commit/5d96e197961cd634cc7c4ae1fdcc1878500b7545), [`b960ba8`](https://github.com/Bike4Mind/bike4mind/commit/b960ba8d6229df95f787c842eb315c3331d6ba2f), [`cc63f75`](https://github.com/Bike4Mind/bike4mind/commit/cc63f75ab8119a9a2160d906c0b789626ffcd960), [`bf8dbbd`](https://github.com/Bike4Mind/bike4mind/commit/bf8dbbd8f050608d52588b32108ce098a2a5047e), [`c95fe24`](https://github.com/Bike4Mind/bike4mind/commit/c95fe2462e911310f9cbb0a7b3155dc95e1b1077), [`beca7a0`](https://github.com/Bike4Mind/bike4mind/commit/beca7a095c9266cef2dd22169a005f5b96e44ccf), [`c1f563e`](https://github.com/Bike4Mind/bike4mind/commit/c1f563ee248317485e4262289dec13c16e864dd7), [`51f3f35`](https://github.com/Bike4Mind/bike4mind/commit/51f3f3522f254ad095857daea891b644a5766efc), [`68b36d1`](https://github.com/Bike4Mind/bike4mind/commit/68b36d1945ac9ba757f6c59b0a3e7417cb95223c), [`01ab7af`](https://github.com/Bike4Mind/bike4mind/commit/01ab7afbef983a8fe27c260c37828667122902a4), [`ec61517`](https://github.com/Bike4Mind/bike4mind/commit/ec6151734c62cb681c85866e003776040f776bed), [`0de8b32`](https://github.com/Bike4Mind/bike4mind/commit/0de8b3205b15b307b53ae45896905a29f0d9e073)]:
  - @bike4mind/llm-adapters@0.11.0
  - @bike4mind/utils@3.1.0
  - @bike4mind/common@4.0.0
  - @bike4mind/fab-pipeline@1.0.0
  - @bike4mind/db-core@0.3.0
  - @bike4mind/auth@0.7.0
  - @bike4mind/agents@0.20.0
  - @bike4mind/mcp@1.41.1

## 3.0.0

### Major Changes

- reprice credits to a uniform 1.2x markup with stochastic rounding

### Minor Changes

- record usage events for tool-settled charges

- let sub-agents opt into Lattice tools via allowedTools

- render artifacts in Agent mode at parity with chat

- disable key-gated tools in the picker with a tooltip (#52)

- per-user AI token exchange for federated Cognito apps

- validated fuzzy fallback for edit_local_file string matching

- extend insufficient-credits CTA to image/video/tool generation paths

- credit lots with expiry + soonest-to-expire consumption

- make delegate_to_agent credits and cost cache-aware

- backgroundable + pollable shell sessions for bash_execute

- background shell session UX -- live indicators + reaping

- make fun/novelty tools hidden by default in tools catalog

- log dropped delegate usage events for unresolvable models

- record operational-model and KB embedding usage

- record tool-internal operational AI usage + regression guard

- passphrase + verified-domain access gates on public share links

- add opt-in minified mode to file_read for token-economy reads

- organization API tokens billed to the org credit pool

- surface web_fetch truncation to model, UI, and telemetry

- tool support, capability detection, and lean prompt for local models

- org transaction-ledger view with filters + drill-down (M3)

- web_fetch offset continuation and llms.txt hints

- cross-path fallback for sustained Bedrock outages

- per-API-key usage breakdown on the org dashboard (M4)

### Patch Changes

- tag-less users stuck on "Loading AI models…" forever

- settle chat on provider-reported token usage

- rename GrokTool references to Bike4Mind

- remove orphaned QuestMaster artifact V1 model and service

- surface Add Credits CTA on insufficient-credits chat error

- allow SSO link into unverified pure-OAuth accounts

- replace exceljs with write-excel-file in excel_generation

- decode shell output with StringDecoder to avoid multibyte garbling

- reuse tokenizer + avoid redundant user load in usage recording

- stop storing fake passwords on provisioning paths (#360)

- allowlist the populateDecomposition tool side-effect

- collapse partial-stream final_answer repeats into one StepRow

- load MCP tools in Agent Mode so delegated subagents get real tools

- compute credit-lot expiry in UTC to remove timezone sensitivity

- resolve hardcoded fallback lakes in the single-lake access gate

- Updated dependencies:
  - @bike4mind/auth@0.6.0
  - @bike4mind/common@3.0.0
  - @bike4mind/llm-adapters@0.10.0
  - @bike4mind/agents@0.19.0
  - @bike4mind/mcp@1.41.0
  - @bike4mind/utils@3.0.0
  - @bike4mind/fab-pipeline@0.5.1
