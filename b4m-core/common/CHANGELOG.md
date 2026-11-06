# @bike4mind/common

## 21.0.0

### Major Changes

- [#5869](https://github.com/Bike4Mind/bike4mind/pull/5869) [`54aa9a7`](https://github.com/Bike4Mind/bike4mind/commit/54aa9a7376cc9f29c3b99fb587aab61540bc490b) Thanks [@dea0030](https://github.com/dea0030)! - Require current member user IDs as the second argument to
  `IMcpConnectionRepository.listMemberConnections(organizationId, memberUserIds, options)`.
  The optional host filter moves to the third argument. Callers must supply the current
  membership roster so connections belonging to former members stay out of admin listings.

- [#5640](https://github.com/Bike4Mind/bike4mind/pull/5640) [`b8146f3`](https://github.com/Bike4Mind/bike4mind/commit/b8146f33b24b69ee9e3762ab454e9a1b65cad880) Thanks [@jjmarfa](https://github.com/jjmarfa)! - remove the legacy What's New generation pipeline

- [#5869](https://github.com/Bike4Mind/bike4mind/pull/5869) [`54aa9a7`](https://github.com/Bike4Mind/bike4mind/commit/54aa9a7376cc9f29c3b99fb587aab61540bc490b) Thanks [@dea0030](https://github.com/dea0030)! - org admin UI for the custom MCP connector policy

### Minor Changes

- [#5295](https://github.com/Bike4Mind/bike4mind/pull/5295) [`0f38820`](https://github.com/Bike4Mind/bike4mind/commit/0f38820d54edcac762192b46712657086dbcdc1a) Thanks [@jjmarfa](https://github.com/jjmarfa)! - add current_model_details tool and drop the identity line when it is offered

- [#5446](https://github.com/Bike4Mind/bike4mind/pull/5446) [`91849a5`](https://github.com/Bike4Mind/bike4mind/commit/91849a59a4449028a8b1d293efb9c7bdfb21fd43) Thanks [@cgtorniado](https://github.com/cgtorniado)! - render multi-file react artifacts

- [#5469](https://github.com/Bike4Mind/bike4mind/pull/5469) [`a0e4dec`](https://github.com/Bike4Mind/bike4mind/commit/a0e4dec9c2f5fe2cb38b5aa6e3e11462f3df3091) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for secrets and integration credentials handlers

- [#5470](https://github.com/Bike4Mind/bike4mind/pull/5470) [`137d97b`](https://github.com/Bike4Mind/bike4mind/commit/137d97b9c219045034132df708d90f07cecc9633) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for users and credentials handlers

- [#5471](https://github.com/Bike4Mind/bike4mind/pull/5471) [`53e1863`](https://github.com/Bike4Mind/bike4mind/commit/53e1863220e36278f04b0efabe471c2a001a2273) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for signup and org access handlers

- [#5472](https://github.com/Bike4Mind/bike4mind/pull/5472) [`fcd2366`](https://github.com/Bike4Mind/bike4mind/commit/fcd23661bbfc29c4a60bfb85c2d38b28255866cc) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for security and trust and safety handlers

- [#5473](https://github.com/Bike4Mind/bike4mind/pull/5473) [`243ed22`](https://github.com/Bike4Mind/bike4mind/commit/243ed22733e81f22574fc66975e2376458fc1deb) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for email and messaging handlers

- [#5474](https://github.com/Bike4Mind/bike4mind/pull/5474) [`c1ec256`](https://github.com/Bike4Mind/bike4mind/commit/c1ec2567aef3c641a8ba5c3f33a2a0b8bc526462) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for billing and model config handlers

- [#5476](https://github.com/Bike4Mind/bike4mind/pull/5476) [`d7fe1a2`](https://github.com/Bike4Mind/bike4mind/commit/d7fe1a2e6d1f635e10e8f9c124110e5bdfc51653) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for rapid reply handlers

- [#5477](https://github.com/Bike4Mind/bike4mind/pull/5477) [`57fe9c8`](https://github.com/Bike4Mind/bike4mind/commit/57fe9c853946c4afe11307f729a701813185b48e) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for content and directory config handlers

- [#5478](https://github.com/Bike4Mind/bike4mind/pull/5478) [`bc90957`](https://github.com/Bike4Mind/bike4mind/commit/bc9095763657dfe551c011fa5454c0cc4b40f4c6) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for liveops, sre and queues handlers

- [#5479](https://github.com/Bike4Mind/bike4mind/pull/5479) [`57bcde3`](https://github.com/Bike4Mind/bike4mind/commit/57bcde35bd28aab37eaa62794ce36765d6b33bd8) Thanks [@onoya](https://github.com/onoya)! - record admin audit entries for telemetry, backfills and health handlers

- [#5498](https://github.com/Bike4Mind/bike4mind/pull/5498) [`42f4f4a`](https://github.com/Bike4Mind/bike4mind/commit/42f4f4afb5370de9cffc4fed26440ee0cd59404c) Thanks [@onoya](https://github.com/onoya)! - admin-only confidence overrides to force the confidence gate

- [#5607](https://github.com/Bike4Mind/bike4mind/pull/5607) [`ea39c25`](https://github.com/Bike4Mind/bike4mind/commit/ea39c25620ae263c44e29bcc2ebcf45ef299deec) Thanks [@cgtorniado](https://github.com/cgtorniado)! - publish multi-file react artifacts

- [#5617](https://github.com/Bike4Mind/bike4mind/pull/5617) [`22b2349`](https://github.com/Bike4Mind/bike4mind/commit/22b23498c5ea66602b8661a64fb05b8a78d6b1a1) Thanks [@vinchi777](https://github.com/vinchi777)! - show monthly credit allowance in footer

- [#5622](https://github.com/Bike4Mind/bike4mind/pull/5622) [`1e8cfff`](https://github.com/Bike4Mind/bike4mind/commit/1e8cfff9d694719a2a411685590be881180b32a3) Thanks [@onoya](https://github.com/onoya)! - add an admin-editable blocked email domain list to the signup gate

- [#5623](https://github.com/Bike4Mind/bike4mind/pull/5623) [`2ff7b2e`](https://github.com/Bike4Mind/bike4mind/commit/2ff7b2eacbc79465a9296bdba0221111e7ca6db2) Thanks [@onoya](https://github.com/onoya)! - bulk abuse response tools for banning a domain or a selection of users

- [#5632](https://github.com/Bike4Mind/bike4mind/pull/5632) [`f07bb43`](https://github.com/Bike4Mind/bike4mind/commit/f07bb43fcefe095dd26c185d822b5c1a4fe3a171) Thanks [@onoya](https://github.com/onoya)! - capture signup and login network metadata

- [#5635](https://github.com/Bike4Mind/bike4mind/pull/5635) [`1a9e18b`](https://github.com/Bike4Mind/bike4mind/commit/1a9e18b28ee2f199c16afe6fad7ea252f72e8a2c) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - save inviter at signup and add referral reward settings

- [#5652](https://github.com/Bike4Mind/bike4mind/pull/5652) [`a898007`](https://github.com/Bike4Mind/bike4mind/commit/a8980077a897e584a0da483a212e505e749cc117) Thanks [@biletskiy6](https://github.com/biletskiy6)! - show a still image on release notes without a video

- [#5667](https://github.com/Bike4Mind/bike4mind/pull/5667) [`e92f61a`](https://github.com/Bike4Mind/bike4mind/commit/e92f61a01812a1cd701eaf17efb49ec3fd345412) Thanks [@jjmarfa](https://github.com/jjmarfa)! - curate and price the FLUX.2 image models

- [#5674](https://github.com/Bike4Mind/bike4mind/pull/5674) [`3e21c08`](https://github.com/Bike4Mind/bike4mind/commit/3e21c085addeb1f7b442ef27fe6d944922db4e1e) Thanks [@jjmarfa](https://github.com/jjmarfa)! - rank daily most-active users by credits spent

- [#5690](https://github.com/Bike4Mind/bike4mind/pull/5690) [`90b879a`](https://github.com/Bike4Mind/bike4mind/commit/90b879ad96988d447cf41564ca1dcdbf261334e3) Thanks [@erikbethke](https://github.com/erikbethke)! - declare optional lane fields on analytics user-day models and index synthetic rows

- [#5694](https://github.com/Bike4Mind/bike4mind/pull/5694) [`a460dfb`](https://github.com/Bike4Mind/bike4mind/commit/a460dfbd90446166ed75175f1b292588ddbde6b6) Thanks [@onoya](https://github.com/onoya)! - add explicit user quota overrides and resolution

- [#5714](https://github.com/Bike4Mind/bike4mind/pull/5714) [`4c39123`](https://github.com/Bike4Mind/bike4mind/commit/4c391230968bcda56c6af55da4b6fa868e03e00c) Thanks [@onoya](https://github.com/onoya)! - record generation lineage and request on generated files

- [#5715](https://github.com/Bike4Mind/bike4mind/pull/5715) [`d64c463`](https://github.com/Bike4Mind/bike4mind/commit/d64c4633f6289b326ab523359586214ad9efc82d) Thanks [@onoya](https://github.com/onoya)! - declare an image capability table and validator per model

- [#5731](https://github.com/Bike4Mind/bike4mind/pull/5731) [`6b873c7`](https://github.com/Bike4Mind/bike4mind/commit/6b873c7752c0096accd8159a816aeda09d588fab) Thanks [@onoya](https://github.com/onoya)! - add signup burst detection and domain holds

- [#5736](https://github.com/Bike4Mind/bike4mind/pull/5736) [`6843651`](https://github.com/Bike4Mind/bike4mind/commit/68436514799418cb60d598aca5555bb0bf7666ed) Thanks [@maconard](https://github.com/maconard)! - add Model Hub manifest schema and fit estimator

- [#5742](https://github.com/Bike4Mind/bike4mind/pull/5742) [`1078162`](https://github.com/Bike4Mind/bike4mind/commit/1078162903f8d4575ec415bd5b785a87dec1146b) Thanks [@poysama](https://github.com/poysama)! - optional Cloudflare Turnstile challenge on email sign-in code requests

- [#5760](https://github.com/Bike4Mind/bike4mind/pull/5760) [`33efa86`](https://github.com/Bike4Mind/bike4mind/commit/33efa86f352b042f98022c656be1531ad246b0c7) Thanks [@juicewaa](https://github.com/juicewaa)! - score new-account risk from weighted signup signals

- [#5776](https://github.com/Bike4Mind/bike4mind/pull/5776) [`b514a6c`](https://github.com/Bike4Mind/bike4mind/commit/b514a6c2635d750a91d9f243c4c27d883ff4ceaa) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - allow a zero free-tier rate limit and set-balance credit adjustments

- [#5779](https://github.com/Bike4Mind/bike4mind/pull/5779) [`ca21414`](https://github.com/Bike4Mind/bike4mind/commit/ca21414ad1cb8a0176fa68429a04ad0d44a7f61a) Thanks [@jarlacut](https://github.com/jarlacut)! - lock credit enforcement on for hosted deployments

- [#5781](https://github.com/Bike4Mind/bike4mind/pull/5781) [`4dfe085`](https://github.com/Bike4Mind/bike4mind/commit/4dfe085dd929e3ac7eb4304cbf95914ea8441a19) Thanks [@choyno](https://github.com/choyno)! - tighten request quotas for API keys of new accounts

- [#5784](https://github.com/Bike4Mind/bike4mind/pull/5784) [`9602802`](https://github.com/Bike4Mind/bike4mind/commit/9602802b6673fdf1e893f6c46440fd62ebfba6c5) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - daily spend cap for free-tier accounts

- [#5786](https://github.com/Bike4Mind/bike4mind/pull/5786) [`cf89ad9`](https://github.com/Bike4Mind/bike4mind/commit/cf89ad9847ccf2631f797799eab0bf92c1192262) Thanks [@onoya](https://github.com/onoya)! - restrict free-tier accounts to an admin-set model allowlist

- [#5788](https://github.com/Bike4Mind/bike4mind/pull/5788) [`a1ab021`](https://github.com/Bike4Mind/bike4mind/commit/a1ab021251aad7ce5b03ff34f012059224174b7a) Thanks [@choyno](https://github.com/choyno)! - add a per-tier thinking visibility setting

- [#5791](https://github.com/Bike4Mind/bike4mind/pull/5791) [`92e1b83`](https://github.com/Bike4Mind/bike4mind/commit/92e1b83a4c2f6ac77b5e5955b6e98c2b2f22a81a) Thanks [@vinchi777](https://github.com/vinchi777)! - add optional signup fingerprint observations

- [#5795](https://github.com/Bike4Mind/bike4mind/pull/5795) [`0601238`](https://github.com/Bike4Mind/bike4mind/commit/0601238b67aa239377cbc65a10700daad3134422) Thanks [@onoya](https://github.com/onoya)! - cap new OTC accounts per email domain and make OTC limits admin-tunable

- [#5801](https://github.com/Bike4Mind/bike4mind/pull/5801) [`f3f40e4`](https://github.com/Bike4Mind/bike4mind/commit/f3f40e417139df795d71cdd3f73241322526f74d) Thanks [@vinchi777](https://github.com/vinchi777)! - implement staged signup grants and cumulative unlocks

- [#5809](https://github.com/Bike4Mind/bike4mind/pull/5809) [`619a9f3`](https://github.com/Bike4Mind/bike4mind/commit/619a9f3072a86f8bbf6de0c5ac05fd843d1e616c) Thanks [@choyno](https://github.com/choyno)! - compute per-user usage pattern signals

- [#5814](https://github.com/Bike4Mind/bike4mind/pull/5814) [`e930082`](https://github.com/Bike4Mind/bike4mind/commit/e930082afb1c00beb7dcb1ad981b1ace849eeebf) Thanks [@julsanchez](https://github.com/julsanchez)! - live disposable-domain intelligence for signup credit holds

- [#5819](https://github.com/Bike4Mind/bike4mind/pull/5819) [`59ceabe`](https://github.com/Bike4Mind/bike4mind/commit/59ceabe189b9d67c4e79e1919510808626e8cee1) Thanks [@onoya](https://github.com/onoya)! - limit signups per network and feed counts to the staged grant

- [#5829](https://github.com/Bike4Mind/bike4mind/pull/5829) [`cd0aece`](https://github.com/Bike4Mind/bike4mind/commit/cd0aece730c7b40d115d40fd5ea3a462047904ef) Thanks [@biletskiy6](https://github.com/biletskiy6)! - discovery modal suggesting unused gears

- [#5830](https://github.com/Bike4Mind/bike4mind/pull/5830) [`ee7a413`](https://github.com/Bike4Mind/bike4mind/commit/ee7a4136c41fcddb4a600329238c92ddd2b0ce06) Thanks [@juicewaa](https://github.com/juicewaa)! - store new-account risk scores and rescore young accounts

- [#5843](https://github.com/Bike4Mind/bike4mind/pull/5843) [`87ffad4`](https://github.com/Bike4Mind/bike4mind/commit/87ffad460ed94f5bb164e57e5207b14bd3981a74) Thanks [@onoya](https://github.com/onoya)! - route closed-signup visitors to the waitlist

- [#5871](https://github.com/Bike4Mind/bike4mind/pull/5871) [`05933eb`](https://github.com/Bike4Mind/bike4mind/commit/05933ebd54fbde1721f7642e9a28cb6a5a408b6d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - no-card unlock via aged GitHub account or verified work email

- [#5874](https://github.com/Bike4Mind/bike4mind/pull/5874) [`a31fb20`](https://github.com/Bike4Mind/bike4mind/commit/a31fb208f9ebe3af2969475d9650af3bb5491715) Thanks [@vinchi777](https://github.com/vinchi777)! - add signup anomaly review and email domain grouping

- [#5877](https://github.com/Bike4Mind/bike4mind/pull/5877) [`3c85624`](https://github.com/Bike4Mind/bike4mind/commit/3c85624f3edf0457ce96295432d8b17625a92b17) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - reward inviters on an invited friend's first answer

- [#5900](https://github.com/Bike4Mind/bike4mind/pull/5900) [`40b3c70`](https://github.com/Bike4Mind/bike4mind/commit/40b3c708079b007ed524f48f41201504b2a80b7c) Thanks [@onoya](https://github.com/onoya)! - add the delegated admin permission model and adminApi middleware

- [#5901](https://github.com/Bike4Mind/bike4mind/pull/5901) [`2724d6b`](https://github.com/Bike4Mind/bike4mind/commit/2724d6b17ccc5bb4c637f908e8e5b484b7b19303) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - add ACFP, IP reputation count, and label-forwarding rules

- [#5914](https://github.com/Bike4Mind/bike4mind/pull/5914) [`a6976cb`](https://github.com/Bike4Mind/bike4mind/commit/a6976cb4f52856e30afb19659b9a88e25189163a) Thanks [@poysama](https://github.com/poysama)! - run the Turnstile challenge before OAuth sign-in starts

- [#5919](https://github.com/Bike4Mind/bike4mind/pull/5919) [`21cf520`](https://github.com/Bike4Mind/bike4mind/commit/21cf520cbbcc8a70294a7e0106c0a7eba612cfbf) Thanks [@onoya](https://github.com/onoya)! - Activity, Sign-ins and Admin log tabs on the user profile

- [#5924](https://github.com/Bike4Mind/bike4mind/pull/5924) [`8543254`](https://github.com/Bike4Mind/bike4mind/commit/8543254f9db8da14dc16ce581fb3ca481f37f8d2) Thanks [@onoya](https://github.com/onoya)! - add Credits and API keys tabs to the user profile

- [#5925](https://github.com/Bike4Mind/bike4mind/pull/5925) [`dcc1738`](https://github.com/Bike4Mind/bike4mind/commit/dcc1738d6bb757e0de97a87a4d4baf5af1a673f3) Thanks [@julsanchez](https://github.com/julsanchez)! - serve Skill Market authoring to API keys under /api/v1 with a skills:write scope

- [#5927](https://github.com/Bike4Mind/bike4mind/pull/5927) [`661d0ec`](https://github.com/Bike4Mind/bike4mind/commit/661d0ec6f7366e70c3faf00d3a6563c6c43902f4) Thanks [@onoya](https://github.com/onoya)! - bulk user actions with Contain, dry run and undo

- [#5935](https://github.com/Bike4Mind/bike4mind/pull/5935) [`f34fcb5`](https://github.com/Bike4Mind/bike4mind/commit/f34fcb5daa8cc8e0db1e3f26ef2a8be6814f7569) Thanks [@julsanchez](https://github.com/julsanchez)! - ship a skill's scripts and references through the Skill Market

- [#5936](https://github.com/Bike4Mind/bike4mind/pull/5936) [`a3d1905`](https://github.com/Bike4Mind/bike4mind/commit/a3d19057eb8569eef3f10f23085f9ac8a0171123) Thanks [@julsanchez](https://github.com/julsanchez)! - Skill Market bundles as one Claude Code plugin

- [#5941](https://github.com/Bike4Mind/bike4mind/pull/5941) [`466f115`](https://github.com/Bike4Mind/bike4mind/commit/466f11527f486c939e5336272582daa161d8f81d) Thanks [@onoya](https://github.com/onoya)! - chart signups over time with suspected-account split

- [#5948](https://github.com/Bike4Mind/bike4mind/pull/5948) [`02c94cf`](https://github.com/Bike4Mind/bike4mind/commit/02c94cf3eb94ba6c25427ce0e657d1119f2dacb4) Thanks [@julsanchez](https://github.com/julsanchez)! - review the Skill Market queue with a skills:review API key

- [#5960](https://github.com/Bike4Mind/bike4mind/pull/5960) [`775a594`](https://github.com/Bike4Mind/bike4mind/commit/775a5948673a9b346747a11e82ddd053c578f36a) Thanks [@ken-b4m](https://github.com/ken-b4m)! - return Claude Code tools and supporting files in the v1 listing snapshot

- [#5974](https://github.com/Bike4Mind/bike4mind/pull/5974) [`79bace3`](https://github.com/Bike4Mind/bike4mind/commit/79bace3daa0069f297a11dbc178c8091bbdb2739) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - publish the agent authoring assistants as v1 contracts

- [#5993](https://github.com/Bike4Mind/bike4mind/pull/5993) [`642d0f0`](https://github.com/Bike4Mind/bike4mind/commit/642d0f0e03a41937e8d16b5a9446fe12b0cc7e28) Thanks [@vinchi777](https://github.com/vinchi777)! - harden impersonation sessions with expiry and access records

- [#6004](https://github.com/Bike4Mind/bike4mind/pull/6004) [`e768f3c`](https://github.com/Bike4Mind/bike4mind/commit/e768f3c9f6dbdb59a65ad6de6e6b2a785647d39c) Thanks [@onoya](https://github.com/onoya)! - admin-aware assistant in the admin chat (foundation)

### Patch Changes

- [#5193](https://github.com/Bike4Mind/bike4mind/pull/5193) [`d17415d`](https://github.com/Bike4Mind/bike4mind/commit/d17415d4869afdf8d0f8a430519a5ee860a32ddd) Thanks [@erikbethke](https://github.com/erikbethke)! - stop pinning the placeholder output budget and explain empty replies

- [#5253](https://github.com/Bike4Mind/bike4mind/pull/5253) [`5741560`](https://github.com/Bike4Mind/bike4mind/commit/5741560256580385e2c577ae0df83db47cb538a2) Thanks [@aflordelis](https://github.com/aflordelis)! - move the next shared server layer into the package

- [#5444](https://github.com/Bike4Mind/bike4mind/pull/5444) [`c71b53e`](https://github.com/Bike4Mind/bike4mind/commit/c71b53e3229694935b4ddd6bb662479a1dce7631) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - let overlay packages contribute API-key scopes

- [#5463](https://github.com/Bike4Mind/bike4mind/pull/5463) [`dd17bbe`](https://github.com/Bike4Mind/bike4mind/commit/dd17bbe1c5a148e550b00452944e6aef178ca809) Thanks [@vinchi777](https://github.com/vinchi777)! - reject unsupported assistant prefill

- [#5491](https://github.com/Bike4Mind/bike4mind/pull/5491) [`c36a0b3`](https://github.com/Bike4Mind/bike4mind/commit/c36a0b3022f83a8724af413c28521d6d2b203dca) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - let extension packages contribute admin settings

- [#5558](https://github.com/Bike4Mind/bike4mind/pull/5558) [`b057019`](https://github.com/Bike4Mind/bike4mind/commit/b0570190c06f5370569c182a92facd62f20de8a1) Thanks [@onoya](https://github.com/onoya)! - queue ElevenLabs calls behind shared concurrency slots

- [#5566](https://github.com/Bike4Mind/bike4mind/pull/5566) [`aee3b68`](https://github.com/Bike4Mind/bike4mind/commit/aee3b683f830087b8ca9ef272a54cd8c432ce8e6) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - lower sound-effects prompt cap to 450 chars

- [#5594](https://github.com/Bike4Mind/bike4mind/pull/5594) [`d2097fc`](https://github.com/Bike4Mind/bike4mind/commit/d2097fc17c7ee638326a4b2d34dbb56fc97a63b8) Thanks [@onoya](https://github.com/onoya)! - make the admin Moderate action block AI features

- [#5625](https://github.com/Bike4Mind/bike4mind/pull/5625) [`0ce52aa`](https://github.com/Bike4Mind/bike4mind/commit/0ce52aa9902813cc414f94b90642837602609c7e) Thanks [@onoya](https://github.com/onoya)! - gate personal API key creation behind a trust check

- [#5627](https://github.com/Bike4Mind/bike4mind/pull/5627) [`e0312a9`](https://github.com/Bike4Mind/bike4mind/commit/e0312a9165e76485b3df9ef092b0c05fcf2fece9) Thanks [@onoya](https://github.com/onoya)! - add an embedding model catalog in common

- [#5657](https://github.com/Bike4Mind/bike4mind/pull/5657) [`856f111`](https://github.com/Bike4Mind/bike4mind/commit/856f111c2a689d3d55884d8c7c354c1d2e2ae0fb) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - ask before agent mode runs a Bob site read

- [#5665](https://github.com/Bike4Mind/bike4mind/pull/5665) [`aa748ba`](https://github.com/Bike4Mind/bike4mind/commit/aa748ba08177c36d8b74064dc1e4ecfb712800d4) Thanks [@erikbethke](https://github.com/erikbethke)! - drop the per-user and per-org page-count cap

- [#5686](https://github.com/Bike4Mind/bike4mind/pull/5686) [`39675ef`](https://github.com/Bike4Mind/bike4mind/commit/39675efb1307b15900bf4757d7ec77d3600671dc) Thanks [@erikbethke](https://github.com/erikbethke)! - reserve the persona- username prefix for test accounts

- [#5687](https://github.com/Bike4Mind/bike4mind/pull/5687) [`43b7602`](https://github.com/Bike4Mind/bike4mind/commit/43b76023b13fb1bd4b9f8c346a45e9b1f0501527) Thanks [@erikbethke](https://github.com/erikbethke)! - add a per-user publish rate limit and quota-check revise and restore

- [#5689](https://github.com/Bike4Mind/bike4mind/pull/5689) [`d16988d`](https://github.com/Bike4Mind/bike4mind/commit/d16988d649b015cef203d30c265c70bbc3b57bb1) Thanks [@erikbethke](https://github.com/erikbethke)! - count archived page versions toward the storage limit

- [#5734](https://github.com/Bike4Mind/bike4mind/pull/5734) [`9a4cfb9`](https://github.com/Bike4Mind/bike4mind/commit/9a4cfb9ee905a150c32efe430e01e7df6c3ec9ed) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - return 400/403 instead of 500 for client-caused errors

- [#5738](https://github.com/Bike4Mind/bike4mind/pull/5738) [`98d31b1`](https://github.com/Bike4Mind/bike4mind/commit/98d31b1ef57a29f66bbe219d6886e2acc873d30c) Thanks [@erikbethke](https://github.com/erikbethke)! - gate user API keys on paid subscription behind an admin switch (HIGH)

- [#5740](https://github.com/Bike4Mind/bike4mind/pull/5740) [`905ac81`](https://github.com/Bike4Mind/bike4mind/commit/905ac8111cdd549fd3fb21e70449abc3ea1b98f1) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from published type declarations

- [#5746](https://github.com/Bike4Mind/bike4mind/pull/5746) [`effc6e9`](https://github.com/Bike4Mind/bike4mind/commit/effc6e96a6d194ce2ff8565147bdbf31c99d5314) Thanks [@onoya](https://github.com/onoya)! - charge personal chat overshoot in full instead of writing it off

- [#5752](https://github.com/Bike4Mind/bike4mind/pull/5752) [`4bfc517`](https://github.com/Bike4Mind/bike4mind/commit/4bfc517ba4e36a7cbb6315c5d1f296c756b2a0fa) Thanks [@onoya](https://github.com/onoya)! - meter text refinement and keep unmetered AI helpers off API keys

- [#5755](https://github.com/Bike4Mind/bike4mind/pull/5755) [`94d7c14`](https://github.com/Bike4Mind/bike4mind/commit/94d7c14cc55e69fe930d0d204595738c9a373133) Thanks [@onoya](https://github.com/onoya)! - grant signup free credits once per inbox across email aliases

- [#5783](https://github.com/Bike4Mind/bike4mind/pull/5783) [`f4f5143`](https://github.com/Bike4Mind/bike4mind/commit/f4f5143a69f64daa28121785c87aae41bb92cecf) Thanks [@choyno](https://github.com/choyno)! - debit operational usage for free-tier users

- [#5842](https://github.com/Bike4Mind/bike4mind/pull/5842) [`4ea049f`](https://github.com/Bike4Mind/bike4mind/commit/4ea049fa61816e66571b9d99a09dfea2d33a9f3d) Thanks [@onoya](https://github.com/onoya)! - add batch-first provider type, registry and conformance suite

- [#5851](https://github.com/Bike4Mind/bike4mind/pull/5851) [`45cc33d`](https://github.com/Bike4Mind/bike4mind/commit/45cc33d40e1d1931b98532accb1d5a8db9ac6748) Thanks [@ken-b4m](https://github.com/ken-b4m)! - keep the pending authenticator secret across repeat MFA setup calls

- [#5884](https://github.com/Bike4Mind/bike4mind/pull/5884) [`a1e3159`](https://github.com/Bike4Mind/bike4mind/commit/a1e315989f0607aadd3853e2409c01020113ef77) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - enforce the provider minimum output budget

- [#5885](https://github.com/Bike4Mind/bike4mind/pull/5885) [`c6a3eda`](https://github.com/Bike4Mind/bike4mind/commit/c6a3edadf1f963ef66671c352acc203927ad622a) Thanks [@maconard](https://github.com/maconard)! - detect CPU-only, AMD and Intel GPU machines in the hardware probe

- [#5889](https://github.com/Bike4Mind/bike4mind/pull/5889) [`7eb96e0`](https://github.com/Bike4Mind/bike4mind/commit/7eb96e066918d09f5201291fb7712563c88c6c61) Thanks [@maconard](https://github.com/maconard)! - size model fit compute and margin from measured Ollama loads

- [#5893](https://github.com/Bike4Mind/bike4mind/pull/5893) [`08c41f3`](https://github.com/Bike4Mind/bike4mind/commit/08c41f3a128d995e5bf481585c41bda75040491e) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - send project and prompt responses via typed schemas

- [#5904](https://github.com/Bike4Mind/bike4mind/pull/5904) [`f7d22fb`](https://github.com/Bike4Mind/bike4mind/commit/f7d22fb35ae43b8bf5bd125a2153c3f79e7ffbc8) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - record provider-side content-filter refusals as moderation hits

- [#5923](https://github.com/Bike4Mind/bike4mind/pull/5923) [`6cb814e`](https://github.com/Bike4Mind/bike4mind/commit/6cb814eead53a0f39f1dd8297da453c8cb1461b5) Thanks [@julsanchez](https://github.com/julsanchez)! - keep Claude Code allowed-tools, align feed origins, guard imports and re-publish

- [#5940](https://github.com/Bike4Mind/bike4mind/pull/5940) [`2707102`](https://github.com/Bike4Mind/bike4mind/commit/27071028499e8fd833868eebc158e5c7a32d8a34) Thanks [@jjmarfa](https://github.com/jjmarfa)! - classify reasoning output-budget exhaustion as a documented 422/502

- [#5955](https://github.com/Bike4Mind/bike4mind/pull/5955) [`a295054`](https://github.com/Bike4Mind/bike4mind/commit/a2950546d13fbf978e70ee33156e6094db9aabcd) Thanks [@ken-b4m](https://github.com/ken-b4m)! - clear open Dependabot alerts with in-major overrides and bumps

- [#5958](https://github.com/Bike4Mind/bike4mind/pull/5958) [`165fef9`](https://github.com/Bike4Mind/bike4mind/commit/165fef9c1a0fb6f9c3fada299747c725c912623a) Thanks [@maconard](https://github.com/maconard)! - cap the Auto local context at 32K on machines without a GPU

## 20.0.0

### Major Changes

- [#4794](https://github.com/Bike4Mind/bike4mind/pull/4794) [`bd5640c`](https://github.com/Bike4Mind/bike4mind/commit/bd5640c03c8f4ec923cad8c70a431c176d50fe98) Thanks [@julsanchez](https://github.com/julsanchez)! - Require durable batch settlement methods on `ITransformBatchRepository`, include each batch result's `customId`, and include per-call billing usage on `IntentDecision`. Custom repository adapters and typed completion fixtures must supply these new required members.

  Remove the retired Google Calendar integration and its setting keys from the public common contracts, and remove `creditTransactionRepository` from `NotebookCurationAdapters`; hosts now meter executive-summary completions instead of deducting a flat curation fee.

- [#5257](https://github.com/Bike4Mind/bike4mind/pull/5257) [`068b941`](https://github.com/Bike4Mind/bike4mind/commit/068b941bead19a117b6902b57d9f9a121ed4ad90) Thanks [@onoya](https://github.com/onoya)! - protect stored credentials and private data

- [#5291](https://github.com/Bike4Mind/bike4mind/pull/5291) [`06aeb90`](https://github.com/Bike4Mind/bike4mind/commit/06aeb90a4515b762709433d23c798fa742e51dd4) Thanks [@onoya](https://github.com/onoya)! - require verified identities for Slack delivery

### Minor Changes

- [#4866](https://github.com/Bike4Mind/bike4mind/pull/4866) [`0077625`](https://github.com/Bike4Mind/bike4mind/commit/0077625464f4c9a910bc7c6954a6c7c8745c1506) Thanks [@cgtorniado](https://github.com/cgtorniado)! - serve Converse-compatible Bedrock models through one generic backend

- [#5145](https://github.com/Bike4Mind/bike4mind/pull/5145) [`7676e91`](https://github.com/Bike4Mind/bike4mind/commit/7676e9134bfec4300710474ab6535539c620e47e) Thanks [@vinchi777](https://github.com/vinchi777)! - track first-run client funnel

- [#5159](https://github.com/Bike4Mind/bike4mind/pull/5159) [`e0f2069`](https://github.com/Bike4Mind/bike4mind/commit/e0f2069b4640c1323b66161ed9d6e7a5ffd61c04) Thanks [@biletskiy6](https://github.com/biletskiy6)! - show a product video in a What's New slide

- [#5162](https://github.com/Bike4Mind/bike4mind/pull/5162) [`3d73686`](https://github.com/Bike4Mind/bike4mind/commit/3d7368634829f526d919c5b09bbb704d95c04348) Thanks [@julsanchez](https://github.com/julsanchez)! - upload local skills and publish them to the Skill Market

- [#5164](https://github.com/Bike4Mind/bike4mind/pull/5164) [`edecc8d`](https://github.com/Bike4Mind/bike4mind/commit/edecc8dd12d0b7bd99123b1b64cba319bb8bcc1c) Thanks [@julsanchez](https://github.com/julsanchez)! - serve an org's Skill Market listings as a Claude Code plugin marketplace

- [#5179](https://github.com/Bike4Mind/bike4mind/pull/5179) [`1fbdb12`](https://github.com/Bike4Mind/bike4mind/commit/1fbdb12a744681100ffe89da4cb1d4898fa88022) Thanks [@ktdejesus](https://github.com/ktdejesus)! - record the price applied on each usage event

- [#5188](https://github.com/Bike4Mind/bike4mind/pull/5188) [`9d36862`](https://github.com/Bike4Mind/bike4mind/commit/9d36862f0a7d05451ad0a95403f49cb307c5936e) Thanks [@onoya](https://github.com/onoya)! - add per-user admin Activity tab

- [#5195](https://github.com/Bike4Mind/bike4mind/pull/5195) [`5ca9092`](https://github.com/Bike4Mind/bike4mind/commit/5ca9092584cdd8c1c39141f740e10bef77657458) Thanks [@biletskiy6](https://github.com/biletskiy6)! - hooks for automatic release-note videos

- [#5215](https://github.com/Bike4Mind/bike4mind/pull/5215) [`5af5151`](https://github.com/Bike4Mind/bike4mind/commit/5af515100ca0cf0f784e7e4931d8afe3710bed2b) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - require an opt-in federated:admin-status scope on the federated admin check

- [#5222](https://github.com/Bike4Mind/bike4mind/pull/5222) [`72f38ed`](https://github.com/Bike4Mind/bike4mind/commit/72f38edefbbb1425f15d542d782f4b48d15dd380) Thanks [@onoya](https://github.com/onoya)! - alert on critical admin audit entries

- [#5241](https://github.com/Bike4Mind/bike4mind/pull/5241) [`bba40de`](https://github.com/Bike4Mind/bike4mind/commit/bba40de6be35c3a4742a8063f14bc837e931255d) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - deliver generated videos to the requesting Slack thread

- [#5255](https://github.com/Bike4Mind/bike4mind/pull/5255) [`f807ef8`](https://github.com/Bike4Mind/bike4mind/commit/f807ef8e820bc1eb4f61baea2c88b0c202589023) Thanks [@onoya](https://github.com/onoya)! - add admin feature flags for the Studio rebuild

- [#5256](https://github.com/Bike4Mind/bike4mind/pull/5256) [`0e0284e`](https://github.com/Bike4Mind/bike4mind/commit/0e0284e08221bbb80caf0e317192759ca66935e5) Thanks [@onoya](https://github.com/onoya)! - record per-turn timing and retries on the quest

- [#5296](https://github.com/Bike4Mind/bike4mind/pull/5296) [`2d8a97f`](https://github.com/Bike4Mind/bike4mind/commit/2d8a97f44dffc7b2022d4bd6b09db9238f59027b) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add a registry for generic credit deduction reasons

- [#5314](https://github.com/Bike4Mind/bike4mind/pull/5314) [`95c222e`](https://github.com/Bike4Mind/bike4mind/commit/95c222e0a00b2adc0562d647008046e166cb9388) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - add bob:read and bob:run scopes for agent-held credentials

- [#5428](https://github.com/Bike4Mind/bike4mind/pull/5428) [`d0f839c`](https://github.com/Bike4Mind/bike4mind/commit/d0f839cb64f6db020c5184c038dca4a971cfed47) Thanks [@jebie](https://github.com/jebie)! - native tool search on Bedrock

- [#5431](https://github.com/Bike4Mind/bike4mind/pull/5431) [`5177854`](https://github.com/Bike4Mind/bike4mind/commit/5177854fe0cd22e9c8273d63665f924018477086) Thanks [@onoya](https://github.com/onoya)! - audit remaining admin settings writers and link credit ledger rows

- [#5434](https://github.com/Bike4Mind/bike4mind/pull/5434) [`55fbaf1`](https://github.com/Bike4Mind/bike4mind/commit/55fbaf1aa3906a8c1fbd73960aa6e3cfaa4f66c9) Thanks [@onoya](https://github.com/onoya)! - role-tagged video generation inputs

- [#5445](https://github.com/Bike4Mind/bike4mind/pull/5445) [`700400f`](https://github.com/Bike4Mind/bike4mind/commit/700400f7ad0d7358908f1b976fe22641244e8e13) Thanks [@dea0030](https://github.com/dea0030)! - show units and dollar values for credit pricing settings

- [#5457](https://github.com/Bike4Mind/bike4mind/pull/5457) [`b3badf3`](https://github.com/Bike4Mind/bike4mind/commit/b3badf3f617bff7774521211017e98c6a803824e) Thanks [@vinchi777](https://github.com/vinchi777)! - add a desktop app download page and a "Try the desktop app" prompt

- [#5459](https://github.com/Bike4Mind/bike4mind/pull/5459) [`a6c29ca`](https://github.com/Bike4Mind/bike4mind/commit/a6c29ca3570ac876e16eacf72219996ea42d5bf6) Thanks [@onoya](https://github.com/onoya)! - fold superseded models into older model groups

- [#5481](https://github.com/Bike4Mind/bike4mind/pull/5481) [`40fa1d2`](https://github.com/Bike4Mind/bike4mind/commit/40fa1d2890551fb9f2cf6933be3725652ee8e655) Thanks [@vinchi777](https://github.com/vinchi777)! - list every model-invocable skill in the agent prompt

- [#5520](https://github.com/Bike4Mind/bike4mind/pull/5520) [`b13304e`](https://github.com/Bike4Mind/bike4mind/commit/b13304e18ae26ccac766546e4495d9f0f88ef0f1) Thanks [@jjmarfa](https://github.com/jjmarfa)! - publish text refinement as a v1 contract

### Patch Changes

- [#5035](https://github.com/Bike4Mind/bike4mind/pull/5035) [`556feb1`](https://github.com/Bike4Mind/bike4mind/commit/556feb12ee8f51a8d6876317a4b95043acfc87b2) Thanks [@julsanchez](https://github.com/julsanchez)! - hold or gate credits before TTS, transcription, tools and agent runs

- [#5184](https://github.com/Bike4Mind/bike4mind/pull/5184) [`c728ebf`](https://github.com/Bike4Mind/bike4mind/commit/c728ebf806d7ec566f2bc514515b21dc358fb8de) Thanks [@ktdejesus](https://github.com/ktdejesus)! - carry per-turn context in the user message so the Claude system prompt caches

- [#5199](https://github.com/Bike4Mind/bike4mind/pull/5199) [`a23de62`](https://github.com/Bike4Mind/bike4mind/commit/a23de6218f3be2f5ae193869485b28af4a5c9f11) Thanks [@erikbethke](https://github.com/erikbethke)! - drop stale file references from sessions, system files and projects

- [#5228](https://github.com/Bike4Mind/bike4mind/pull/5228) [`b0bdfa5`](https://github.com/Bike4Mind/bike4mind/commit/b0bdfa5afa1e55a48a8b0b16d992faa4450f4b0d) Thanks [@onoya](https://github.com/onoya)! - make the shareable prompt prefix identical across users

- [#5234](https://github.com/Bike4Mind/bike4mind/pull/5234) [`ef1a26e`](https://github.com/Bike4Mind/bike4mind/commit/ef1a26edda1c8c930a0152060bda7883cf01ba7f) Thanks [@onoya](https://github.com/onoya)! - return 503 instead of 401 when API-key auth loses the database

- [#5238](https://github.com/Bike4Mind/bike4mind/pull/5238) [`be7707b`](https://github.com/Bike4Mind/bike4mind/commit/be7707b54a1ed0d84bed08c5677ee6514f2b9a42) Thanks [@jjmarfa](https://github.com/jjmarfa)! - hold review-tier skill listings for review at every visibility

- [#5246](https://github.com/Bike4Mind/bike4mind/pull/5246) [`2d768ca`](https://github.com/Bike4Mind/bike4mind/commit/2d768ca8d9220015d67a73f2e0c08b55b7bad184) Thanks [@onoya](https://github.com/onoya)! - stop a concurrent global flip or market update from landing unscanned content

- [#5252](https://github.com/Bike4Mind/bike4mind/pull/5252) [`af1c441`](https://github.com/Bike4Mind/bike4mind/commit/af1c441eff24c1648160f2515881dfb851b07baa) Thanks [@aflordelis](https://github.com/aflordelis)! - move the next-layer integration, data-lake and service files

- [#5273](https://github.com/Bike4Mind/bike4mind/pull/5273) [`fb351a8`](https://github.com/Bike4Mind/bike4mind/commit/fb351a8a4701006cbdcb58cb33c947d3d36c8a58) Thanks [@onoya](https://github.com/onoya)! - mark the admin credit ledger reliable from its production rollout

- [#5279](https://github.com/Bike4Mind/bike4mind/pull/5279) [`2661559`](https://github.com/Bike4Mind/bike4mind/commit/266155914ec7cd1c77df656c4e671d46e6e10dec) Thanks [@onoya](https://github.com/onoya)! - open Image and Productions only with Create v2 on

- [#5283](https://github.com/Bike4Mind/bike4mind/pull/5283) [`741f528`](https://github.com/Bike4Mind/bike4mind/commit/741f5287662d6d8724aac9420d0f8a46feef5d82) Thanks [@onoya](https://github.com/onoya)! - reserve quota before creating invites

- [#5429](https://github.com/Bike4Mind/bike4mind/pull/5429) [`dc66c0f`](https://github.com/Bike4Mind/bike4mind/commit/dc66c0f35aa5e8baffe57ffe16e34d1b43b36be7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - show the partial-coverage notice as one line under the answer

- [#5433](https://github.com/Bike4Mind/bike4mind/pull/5433) [`de2bc47`](https://github.com/Bike4Mind/bike4mind/commit/de2bc475eb6086648d6df902ad76ad3c38837c70) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - type admin team-member, IdP and user responses

- [#5460](https://github.com/Bike4Mind/bike4mind/pull/5460) [`0741792`](https://github.com/Bike4Mind/bike4mind/commit/074179264f77d6c72938e1d9769c906727d1b801) Thanks [@vinchi777](https://github.com/vinchi777)! - classify upstream caller errors

- [#5461](https://github.com/Bike4Mind/bike4mind/pull/5461) [`318e6a5`](https://github.com/Bike4Mind/bike4mind/commit/318e6a5f7b1ab8a512eb7fb44dee7d634ae20c75) Thanks [@vinchi777](https://github.com/vinchi777)! - reject empty effective messages

- [#5490](https://github.com/Bike4Mind/bike4mind/pull/5490) [`611de1d`](https://github.com/Bike4Mind/bike4mind/commit/611de1df6f19e4db5b221722706eb92ee8be93b7) Thanks [@onoya](https://github.com/onoya)! - treat our own stream timeouts as a slow model, not provider overload

- [#5499](https://github.com/Bike4Mind/bike4mind/pull/5499) [`74c6ac2`](https://github.com/Bike4Mind/bike4mind/commit/74c6ac23923bcf866c76efdfccd44abbb1ca66e1) Thanks [@jjmarfa](https://github.com/jjmarfa)! - document prompt_upsampling in the public image API

- [#5506](https://github.com/Bike4Mind/bike4mind/pull/5506) [`1efdda7`](https://github.com/Bike4Mind/bike4mind/commit/1efdda7f9febe72c9270bb2b9d46002cc49e7f39) Thanks [@dea0030](https://github.com/dea0030)! - edit growth and pricing keys only on their own tab

- [#5514](https://github.com/Bike4Mind/bike4mind/pull/5514) [`35b91b4`](https://github.com/Bike4Mind/bike4mind/commit/35b91b4a9dd4425015d6a1cbcf6238dbb185a0ea) Thanks [@onoya](https://github.com/onoya)! - pause the confidence gate on a low streak, not one iteration

## 19.0.0

### Major Changes

- [#4939](https://github.com/Bike4Mind/bike4mind/pull/4939) [`4eb04ce`](https://github.com/Bike4Mind/bike4mind/commit/4eb04ce7df80bc724b0ff957eab4d9bc18a62360) Thanks [@onoya](https://github.com/onoya)! - move a file's billed bytes when its lake membership changes

### Minor Changes

- [#5191](https://github.com/Bike4Mind/bike4mind/pull/5191) [`a68d013`](https://github.com/Bike4Mind/bike4mind/commit/a68d013d2a4c7a59268f3bfbb2ed9b343a0a36c0) Thanks [@jjmarfa](https://github.com/jjmarfa)! - Add the `decide` server tool to the CLI and shared tool schemas, with deployment-aware availability and permission handling.

- [#5083](https://github.com/Bike4Mind/bike4mind/pull/5083) [`20f9362`](https://github.com/Bike4Mind/bike4mind/commit/20f9362014343fde166c09acc72c3b759ddfd61d) Thanks [@onoya](https://github.com/onoya)! - close admin audit gaps for roles, deletion, impersonation, MFA and settings

- [#5154](https://github.com/Bike4Mind/bike4mind/pull/5154) [`2d33506`](https://github.com/Bike4Mind/bike4mind/commit/2d33506efd4f95460139dedb554780ac544be23c) Thanks [@julsanchez](https://github.com/julsanchez)! - export skills to Claude Code as SKILL.md and import SKILL.md into new skills

- [#5155](https://github.com/Bike4Mind/bike4mind/pull/5155) [`a6a458e`](https://github.com/Bike4Mind/bike4mind/commit/a6a458ee96a84759072f7388e77c66be8a8f9be8) Thanks [@onoya](https://github.com/onoya)! - typed response schemas for core data lake routes

- [#5189](https://github.com/Bike4Mind/bike4mind/pull/5189) [`847b65f`](https://github.com/Bike4Mind/bike4mind/commit/847b65f4347c32e825b705244902a223bbbf4d3a) Thanks [@jjmarfa](https://github.com/jjmarfa)! - show confidence-gate pauses with Proceed/Stop

### Patch Changes

- [#5173](https://github.com/Bike4Mind/bike4mind/pull/5173) [`7bc69c7`](https://github.com/Bike4Mind/bike4mind/commit/7bc69c780cf2e3def64cd650fb82412c6fa91a53) Thanks [@onoya](https://github.com/onoya)! - bill an org-billed API key's organization on agent runs and /api/ai/llm

- [#5182](https://github.com/Bike4Mind/bike4mind/pull/5182) [`a0b5f42`](https://github.com/Bike4Mind/bike4mind/commit/a0b5f429fc8e0b4bcb7968d88513ffd4c71c2d2c) Thanks [@ktdejesus](https://github.com/ktdejesus)! - keep the Claude prompt cache stable across turns in long sessions

## 18.0.0

### Major Changes

- [#5034](https://github.com/Bike4Mind/bike4mind/pull/5034) [`4e05df4`](https://github.com/Bike4Mind/bike4mind/commit/4e05df42da2be56f4b2633fad440f41d9d24e570) Thanks [@julsanchez](https://github.com/julsanchez)! - Bind voice credit holds to their payer in the session repository contract.

  Repository implementations must accept `payerId` in `openVoiceHold` and return
  `payerId: string | null` from successful `claimVoiceHold` calls. Use `null` when a
  legacy hold has no recorded payer. Pass the user funding the reserve when opening
  a hold.

  The unused `restoreVoiceHold` repository method and `VoiceHoldMarkers` export have
  been removed. Consumers must remove those references; settlement rollback belongs
  inside the transaction that claims the hold and moves credits.

### Minor Changes

- [#5127](https://github.com/Bike4Mind/bike4mind/pull/5127) [`a43e39d`](https://github.com/Bike4Mind/bike4mind/commit/a43e39da24f846df42f1c8de8631736e89bfc753) Thanks [@onoya](https://github.com/onoya)! - edit an organization's storage limit

- [#5134](https://github.com/Bike4Mind/bike4mind/pull/5134) [`d1d146c`](https://github.com/Bike4Mind/bike4mind/commit/d1d146c73a2adebe4bd3ecf54facccd7a8514e14) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - accept mid-conversation tool changes on Anthropic models

### Patch Changes

- [#5029](https://github.com/Bike4Mind/bike4mind/pull/5029) [`78b942f`](https://github.com/Bike4Mind/bike4mind/commit/78b942fdac1e4a65ebb59e9aa8467b87eee53c75) Thanks [@aflordelis](https://github.com/aflordelis)! - move the shared h0 leaves of server/utils, lib, shared, app/utils, services and config

- [#5038](https://github.com/Bike4Mind/bike4mind/pull/5038) [`9f6f66b`](https://github.com/Bike4Mind/bike4mind/commit/9f6f66b28964425db2fa7b1fecee47fcc5fc2aaa) Thanks [@julsanchez](https://github.com/julsanchez)! - bind uploads to their measured size and moderate every animation frame

- [#5062](https://github.com/Bike4Mind/bike4mind/pull/5062) [`3eeea1b`](https://github.com/Bike4Mind/bike4mind/commit/3eeea1b92b1cb3af52cdade73680c946389a9eee) Thanks [@aflordelis](https://github.com/aflordelis)! - keep a held file's stored objects through a lake purge

- [#5088](https://github.com/Bike4Mind/bike4mind/pull/5088) [`0dcbad1`](https://github.com/Bike4Mind/bike4mind/commit/0dcbad11c888e1792484de1b5cc4235c75a9661f) Thanks [@erikbethke](https://github.com/erikbethke)! - let verified partner-domain emails register on invite-only instances

- [#5129](https://github.com/Bike4Mind/bike4mind/pull/5129) [`88476d1`](https://github.com/Bike4Mind/bike4mind/commit/88476d1a5aa9fceec132d7abc452f9ba0b18ad54) Thanks [@dea0030](https://github.com/dea0030)! - point HELP_CENTER_PROMPT at Help Center entry points that exist

## 17.1.0

### Minor Changes

- [#5042](https://github.com/Bike4Mind/bike4mind/pull/5042) [`174eeda`](https://github.com/Bike4Mind/bike4mind/commit/174eedabbbcafefe4282268d902efdc6ad12e125) Thanks [@julsanchez](https://github.com/julsanchez)! - log OAuth error responses and record the client on OAuth sessions

## 17.0.0

### Major Changes

- [#4997](https://github.com/Bike4Mind/bike4mind/pull/4997) [`5598195`](https://github.com/Bike4Mind/bike4mind/commit/5598195554d31841e2a01afb4c1bb877bd315a58) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - resolve contributed per-surface session settings at read time

## 16.2.0

### Minor Changes

- [#4938](https://github.com/Bike4Mind/bike4mind/pull/4938) [`ffa4000`](https://github.com/Bike4Mind/bike4mind/commit/ffa4000fdd229f99fd8173ebc8c8bf257219773d) Thanks [@onoya](https://github.com/onoya)! - org-admin storage usage endpoint and Storage tab

- [#4951](https://github.com/Bike4Mind/bike4mind/pull/4951) [`bddc668`](https://github.com/Bike4Mind/bike4mind/commit/bddc668291070d4cc3b53a91cb207be006092ee9) Thanks [@erikbethke](https://github.com/erikbethke)! - add the custom MCP connection API, probe and tool discovery

- [#5044](https://github.com/Bike4Mind/bike4mind/pull/5044) [`a466c7f`](https://github.com/Bike4Mind/bike4mind/commit/a466c7fd0143132cade0db08a2b1039238a1d3f7) Thanks [@onoya](https://github.com/onoya)! - admit every org manager to the org write gate

- [#5052](https://github.com/Bike4Mind/bike4mind/pull/5052) [`868ff68`](https://github.com/Bike4Mind/bike4mind/commit/868ff68dc17ea92cf24292d6124d1757bdbe88a5) Thanks [@jjmarfa](https://github.com/jjmarfa)! - add gpt-5.4-mini dated snapshot to ChatModels

- [#5063](https://github.com/Bike4Mind/bike4mind/pull/5063) [`4b046c1`](https://github.com/Bike4Mind/bike4mind/commit/4b046c1a77916a76fadd7cacceb9b86f17d791c7) Thanks [@onoya](https://github.com/onoya)! - add the admin Audit Log page

- [#5092](https://github.com/Bike4Mind/bike4mind/pull/5092) [`e898c7c`](https://github.com/Bike4Mind/bike4mind/commit/e898c7cc920e1d5c3262114651e7bf24f626eab2) Thanks [@erikbethke](https://github.com/erikbethke)! - notify configured reviewers when an image incident needs review

### Patch Changes

- [#4993](https://github.com/Bike4Mind/bike4mind/pull/4993) [`af39820`](https://github.com/Bike4Mind/bike4mind/commit/af3982067de72652fcbd7cb4c2e2cee74f4d1fc4) Thanks [@onoya](https://github.com/onoya)! - number tool sources into the turn's [N] sequence so inline citations stay clickable

- [#5025](https://github.com/Bike4Mind/bike4mind/pull/5025) [`5fb3885`](https://github.com/Bike4Mind/bike4mind/commit/5fb38852c2d555a0189f02191a5cdc1d8774a57a) Thanks [@aflordelis](https://github.com/aflordelis)! - move the remaining height-0 shared files into the package

- [#5037](https://github.com/Bike4Mind/bike4mind/pull/5037) [`a467516`](https://github.com/Bike4Mind/bike4mind/commit/a467516775c4123320ca7079babce53aeec52869) Thanks [@julsanchez](https://github.com/julsanchez)! - hold and settle credits for research configs, thinking budgets and aborted turns

- [#5043](https://github.com/Bike4Mind/bike4mind/pull/5043) [`92186a1`](https://github.com/Bike4Mind/bike4mind/commit/92186a1c8172c0520779beb2c00b4be3ee1fa327) Thanks [@onoya](https://github.com/onoya)! - typed response schema for the MCP server routes

- [#5056](https://github.com/Bike4Mind/bike4mind/pull/5056) [`73c675c`](https://github.com/Bike4Mind/bike4mind/commit/73c675c64e0be1189c0aa8e4c1c59a86ab388104) Thanks [@jjmarfa](https://github.com/jjmarfa)! - bill sound effects and speech to the selected account

- [#5061](https://github.com/Bike4Mind/bike4mind/pull/5061) [`6f32290`](https://github.com/Bike4Mind/bike4mind/commit/6f322902280cea3fb7ed745e10ea49d47a186f8d) Thanks [@jjmarfa](https://github.com/jjmarfa)! - accept organization_id alias on image generation and edit bodies

- [#5085](https://github.com/Bike4Mind/bike4mind/pull/5085) [`d299e48`](https://github.com/Bike4Mind/bike4mind/commit/d299e483d13449ccf91cd3471dde95f0e83cc487) Thanks [@erikbethke](https://github.com/erikbethke)! - align model prices with provider rate cards

- [#5086](https://github.com/Bike4Mind/bike4mind/pull/5086) [`71376ea`](https://github.com/Bike4Mind/bike4mind/commit/71376ea83c4435f465b88094c47611a69ec2b5b2) Thanks [@erikbethke](https://github.com/erikbethke)! - enforce a minimum per-credit price and charge whole cents

## 16.1.0

### Minor Changes

- [#5017](https://github.com/Bike4Mind/bike4mind/pull/5017) [`e421f9a`](https://github.com/Bike4Mind/bike4mind/commit/e421f9aab9419637a5baefcddf2ffc7d9725bb0b) Thanks [@onoya](https://github.com/onoya)! - let a personal data lake connect a GitHub repository

- [#5027](https://github.com/Bike4Mind/bike4mind/pull/5027) [`2549cb9`](https://github.com/Bike4Mind/bike4mind/commit/2549cb91c4e7fb9064ed8db28bbaafc9b439bc61) Thanks [@onoya](https://github.com/onoya)! - add append-only admin audit log store and writer

### Patch Changes

- [#5006](https://github.com/Bike4Mind/bike4mind/pull/5006) [`b85ca8b`](https://github.com/Bike4Mind/bike4mind/commit/b85ca8bc9edddc0c85be7403d6c99a44b537a3d3) Thanks [@dea0030](https://github.com/dea0030)! - list the sources a reply cites before the ones it did not

- [#5019](https://github.com/Bike4Mind/bike4mind/pull/5019) [`f144377`](https://github.com/Bike4Mind/bike4mind/commit/f144377e6e845c5e7c0e6d9787c4d5172f6ea3a1) Thanks [@vinchi777](https://github.com/vinchi777)! - keep the streaming heartbeat from overwriting a user Stop

- [#5026](https://github.com/Bike4Mind/bike4mind/pull/5026) [`57b5c68`](https://github.com/Bike4Mind/bike4mind/commit/57b5c689bfcab1d87f40aed39b17cd0566694c8d) Thanks [@onoya](https://github.com/onoya)! - share the lyric line timing grammar from common

## 16.0.0

### Major Changes

- [#4937](https://github.com/Bike4Mind/bike4mind/pull/4937) [`026c8d9`](https://github.com/Bike4Mind/bike4mind/commit/026c8d963affc7b032ebe8a2e2adc2a38f5d823c) Thanks [@onoya](https://github.com/onoya)! - bill org-owned file storage to the organization

### Minor Changes

- [#4654](https://github.com/Bike4Mind/bike4mind/pull/4654) [`57d3468`](https://github.com/Bike4Mind/bike4mind/commit/57d3468c31107cd5b5e7fa819d2ad8b224f02498) Thanks [@jebie](https://github.com/jebie)! - native tool search on direct Anthropic

- [#4966](https://github.com/Bike4Mind/bike4mind/pull/4966) [`167e186`](https://github.com/Bike4Mind/bike4mind/commit/167e186fb7ee88df6a07b6e3539a0a72c92e2f0f) Thanks [@onoya](https://github.com/onoya)! - typed response schemas for quest plans, quest timeout and groups

- [#4970](https://github.com/Bike4Mind/bike4mind/pull/4970) [`077295b`](https://github.com/Bike4Mind/bike4mind/commit/077295b626863b0ecec8866d5c2abf8301fdb2f5) Thanks [@erikbethke](https://github.com/erikbethke)! - let users hide workspace surfaces they don't use

- [#4980](https://github.com/Bike4Mind/bike4mind/pull/4980) [`f33b246`](https://github.com/Bike4Mind/bike4mind/commit/f33b246c31f172ec274d965e4950856490f5c45b) Thanks [@erikbethke](https://github.com/erikbethke)! - pin message attachments to the session so they stay in context

### Patch Changes

- [#4973](https://github.com/Bike4Mind/bike4mind/pull/4973) [`c380161`](https://github.com/Bike4Mind/bike4mind/commit/c380161df1b4bda5ba5af6bf0ee692689deed661) Thanks [@erikbethke](https://github.com/erikbethke)! - keep the storage code on a share editor's quota refusal, without the owner's counts

- [#4975](https://github.com/Bike4Mind/bike4mind/pull/4975) [`a64ce8a`](https://github.com/Bike4Mind/bike4mind/commit/a64ce8afc9d05d0b988d8eb336d588614893a90d) Thanks [@erikbethke](https://github.com/erikbethke)! - narrated tool-call strip on cut-off replies and notice count

- [#4976](https://github.com/Bike4Mind/bike4mind/pull/4976) [`e774b4a`](https://github.com/Bike4Mind/bike4mind/commit/e774b4ab69877762a15cb7ac59edd082fdc93320) Thanks [@erikbethke](https://github.com/erikbethke)! - keep a disconnected OAuth connection out of the active list

- [#4977](https://github.com/Bike4Mind/bike4mind/pull/4977) [`d42b0c6`](https://github.com/Bike4Mind/bike4mind/commit/d42b0c62ef7e22ea0c63cffb66ed05402a7d9178) Thanks [@erikbethke](https://github.com/erikbethke)! - share one list of unreachable networks between the settings check and the fetch path

- [#4978](https://github.com/Bike4Mind/bike4mind/pull/4978) [`ecad515`](https://github.com/Bike4Mind/bike4mind/commit/ecad5151d524c027fe8da233fecd30b833ac3c41) Thanks [@erikbethke](https://github.com/erikbethke)! - persist and show a warning when a re-crawl keeps its previous copy for storage quota

## 15.1.1

### Patch Changes

- [#4910](https://github.com/Bike4Mind/bike4mind/pull/4910) [`0afc448`](https://github.com/Bike4Mind/bike4mind/commit/0afc4489cfd31b4dedaceecfbeb4082345917272) Thanks [@onoya](https://github.com/onoya)! - render the Confirm card for GitHub/Atlassian writes in Agent mode

- [#4957](https://github.com/Bike4Mind/bike4mind/pull/4957) [`56e8751`](https://github.com/Bike4Mind/bike4mind/commit/56e875192f26a0af5ff9aa02a5432b3c15ac2e08) Thanks [@erikbethke](https://github.com/erikbethke)! - hide tool calls a model writes out as text instead of showing them as the answer

## 15.1.0

### Minor Changes

- [#4760](https://github.com/Bike4Mind/bike4mind/pull/4760) [`63ff370`](https://github.com/Bike4Mind/bike4mind/commit/63ff37067fb8def4f7fb804eb57e7b9ef83c0560) Thanks [@onoya](https://github.com/onoya)! - add Speech and Sound effects tabs; send Files Generate Audio to Studio

- [#4936](https://github.com/Bike4Mind/bike4mind/pull/4936) [`c825dac`](https://github.com/Bike4Mind/bike4mind/commit/c825dac8ff84d66db5b5c15a310e257cea6acdd3) Thanks [@onoya](https://github.com/onoya)! - typed response schemas for org groups, chat messages and plans

### Patch Changes

- [#4895](https://github.com/Bike4Mind/bike4mind/pull/4895) [`0b84602`](https://github.com/Bike4Mind/bike4mind/commit/0b846026127703d2925a1891afc73aec4ffaa236) Thanks [@onoya](https://github.com/onoya)! - end wait=true chat turns at a deadline instead of the Lambda timeout

- [#4947](https://github.com/Bike4Mind/bike4mind/pull/4947) [`bb93dbb`](https://github.com/Bike4Mind/bike4mind/commit/bb93dbb7ae9903bf68904ef3625738cb9c0c129c) Thanks [@erikbethke](https://github.com/erikbethke)! - one Claude model id parser for tool capabilities and token estimates

- [#4949](https://github.com/Bike4Mind/bike4mind/pull/4949) [`9a2aed3`](https://github.com/Bike4Mind/bike4mind/commit/9a2aed3116a4d81b5fd36e3864fd25dc63f8f3a7) Thanks [@erikbethke](https://github.com/erikbethke)! - render agent-mode music and video cards live

## 15.0.0

### Major Changes

- [#3547](https://github.com/Bike4Mind/bike4mind/pull/3547) [`413b085`](https://github.com/Bike4Mind/bike4mind/commit/413b0859331d804d8b26fbc3d6f53c173dea9764) Thanks [@chadyuson2](https://github.com/chadyuson2)! - retire the legacy shareToken scalar ([#3523](https://github.com/Bike4Mind/bike4mind/issues/3523))

- [#4331](https://github.com/Bike4Mind/bike4mind/pull/4331) [`0cbe715`](https://github.com/Bike4Mind/bike4mind/commit/0cbe71548676fdbe7647fef37058133753b426e8) Thanks [@dea0030](https://github.com/dea0030)! - require an explicit authOrigin on ToolContext

- [#4462](https://github.com/Bike4Mind/bike4mind/pull/4462) [`3e46049`](https://github.com/Bike4Mind/bike4mind/commit/3e46049023bdb7a05e69eb6fa2fd18577dca76a5) Thanks [@onoya](https://github.com/onoya)! - save every generated asset through saveGeneratedAsset

- [#4724](https://github.com/Bike4Mind/bike4mind/pull/4724) [`6711c5f`](https://github.com/Bike4Mind/bike4mind/commit/6711c5fe5f8d9c9f1d37e5ba7739fd9a3678a13a) Thanks [@onoya](https://github.com/onoya)! - serve generated media through short-lived signed URLs

- [#4775](https://github.com/Bike4Mind/bike4mind/pull/4775) [`a786791`](https://github.com/Bike4Mind/bike4mind/commit/a786791da684d73d4bf6ccccbb5713af175c3509) Thanks [@onoya](https://github.com/onoya)! - honour a cancel before the provider call and refuse it once a song is rendering

### Minor Changes

- [#4177](https://github.com/Bike4Mind/bike4mind/pull/4177) [`2684a62`](https://github.com/Bike4Mind/bike4mind/commit/2684a6225aca69a1d9cc1e522dc63b5dbcedee5d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - Export the API-key rate-limit header names and descriptions (`API_KEY_RATE_LIMIT_HEADERS`, `API_KEY_RATE_LIMIT_HEADER_NAMES`, `ApiKeyRateLimitHeader`) as the single source for the limiter and the API docs.

- [#3945](https://github.com/Bike4Mind/bike4mind/pull/3945) [`7da670f`](https://github.com/Bike4Mind/bike4mind/commit/7da670f8868e9cf0f30ddf97b6bcd799c0cc0992) Thanks [@vinchi777](https://github.com/vinchi777)! - add an Access lost state for a GitHub lake

- [#4140](https://github.com/Bike4Mind/bike4mind/pull/4140) [`8b0b9ad`](https://github.com/Bike4Mind/bike4mind/commit/8b0b9add76f3d5a9737f448164349fe4dd1de927) Thanks [@onoya](https://github.com/onoya)! - add multi-provider Decisions API

- [#4146](https://github.com/Bike4Mind/bike4mind/pull/4146) [`ddd3792`](https://github.com/Bike4Mind/bike4mind/commit/ddd37926424c5748eb85b549c4265c95d6193cb3) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 project update and delete endpoints

- [#4164](https://github.com/Bike4Mind/bike4mind/pull/4164) [`d553e0d`](https://github.com/Bike4Mind/bike4mind/commit/d553e0d6e290d89abe8d5f375d463fbf9ff077d9) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 file list, update and delete endpoints

- [#4165](https://github.com/Bike4Mind/bike4mind/pull/4165) [`9e8e683`](https://github.com/Bike4Mind/bike4mind/commit/9e8e683270d93003dd254b8908cc878d40b1b6db) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 agents API (list, create, get, update, delete)

- [#4187](https://github.com/Bike4Mind/bike4mind/pull/4187) [`8ad3249`](https://github.com/Bike4Mind/bike4mind/commit/8ad32497393db0a4a0d01b419ca398a276d46b11) Thanks [@vinchi777](https://github.com/vinchi777)! - emit a toolStarted frame when a tool call opens

- [#4192](https://github.com/Bike4Mind/bike4mind/pull/4192) [`e9b4d0a`](https://github.com/Bike4Mind/bike4mind/commit/e9b4d0a15a5f0048f72cc6f543b59e41f2ec0422) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 artifacts, transcriptions and quest files endpoints

- [#4214](https://github.com/Bike4Mind/bike4mind/pull/4214) [`d2535a6`](https://github.com/Bike4Mind/bike4mind/commit/d2535a668e73dea53c6002250e33d0dd7a10a12e) Thanks [@erikbethke](https://github.com/erikbethke)! - overlay-declared workspace copy grants and sidebar nav items

- [#4217](https://github.com/Bike4Mind/bike4mind/pull/4217) [`4014ce0`](https://github.com/Bike4Mind/bike4mind/commit/4014ce096c58cac673bcb0eebcd152a7848074ea) Thanks [@onoya](https://github.com/onoya)! - expose video_generation to agent mode with a per-run clip cap

- [#4243](https://github.com/Bike4Mind/bike4mind/pull/4243) [`6857653`](https://github.com/Bike4Mind/bike4mind/commit/6857653b24a6476d14e9efaad819b9ae1792a968) Thanks [@erikbethke](https://github.com/erikbethke)! - visible balance, per-answer cost and new-user welcome

- [#4248](https://github.com/Bike4Mind/bike4mind/pull/4248) [`d645fac`](https://github.com/Bike4Mind/bike4mind/commit/d645fac844755c997e702bf95fe11faa1716cffd) Thanks [@erikbethke](https://github.com/erikbethke)! - add admin-configurable Recommended group

- [#4250](https://github.com/Bike4Mind/bike4mind/pull/4250) [`a543c77`](https://github.com/Bike4Mind/bike4mind/commit/a543c77991e50229e34b0dbe4cc6e2b90687c95b) Thanks [@erikbethke](https://github.com/erikbethke)! - funnel instrumentation floor

- [#4251](https://github.com/Bike4Mind/bike4mind/pull/4251) [`382f8f6`](https://github.com/Bike4Mind/bike4mind/commit/382f8f60b701d4b93046bd7ff1be6ad7a25a60fc) Thanks [@erikbethke](https://github.com/erikbethke)! - growth and pricing settings in one place

- [#4277](https://github.com/Bike4Mind/bike4mind/pull/4277) [`36ba5dd`](https://github.com/Bike4Mind/bike4mind/commit/36ba5dd550bdff2d69e677100843c5a248d38553) Thanks [@onoya](https://github.com/onoya)! - honour reasoningEffort on Claude for the completions API

- [#4385](https://github.com/Bike4Mind/bike4mind/pull/4385) [`ac59e6e`](https://github.com/Bike4Mind/bike4mind/commit/ac59e6ebdb34b6fb3679ccc927ac3cbbebc02b11) Thanks [@erikbethke](https://github.com/erikbethke)! - add Claude Haiku 5.5

- [#4392](https://github.com/Bike4Mind/bike4mind/pull/4392) [`3faee39`](https://github.com/Bike4Mind/bike4mind/commit/3faee396882e23c6957fb45163620d1bd7c91932) Thanks [@wescarda](https://github.com/wescarda)! - register PerplexityApiKey in SettingKeySchema

- [#4406](https://github.com/Bike4Mind/bike4mind/pull/4406) [`00e7a26`](https://github.com/Bike4Mind/bike4mind/commit/00e7a261cdf3f296bbe22e5f6be68bc5f91d9e45) Thanks [@onoya](https://github.com/onoya)! - make inline [N] citation markers clickable

- [#4422](https://github.com/Bike4Mind/bike4mind/pull/4422) [`a2f9d5f`](https://github.com/Bike4Mind/bike4mind/commit/a2f9d5fbda2485e4d00ee772a75d4df4e56a5c00) Thanks [@onoya](https://github.com/onoya)! - raise the hardware per-run spend cap ceiling to $100k

- [#4424](https://github.com/Bike4Mind/bike4mind/pull/4424) [`1744af0`](https://github.com/Bike4Mind/bike4mind/commit/1744af05c88e0b5ee9e83f501f6880af3ce2a229) Thanks [@vinchi777](https://github.com/vinchi777)! - add Quick/Standard/Deep presets to the lake research config

- [#4437](https://github.com/Bike4Mind/bike4mind/pull/4437) [`5b096c7`](https://github.com/Bike4Mind/bike4mind/commit/5b096c7f0db1014e2c924091202046b8d027088e) Thanks [@onoya](https://github.com/onoya)! - music model catalog, request validation and cost estimate

- [#4480](https://github.com/Bike4Mind/bike4mind/pull/4480) [`1f97700`](https://github.com/Bike4Mind/bike4mind/commit/1f97700b02f82f4f83f7fa57b5b6233aec76f597) Thanks [@onoya](https://github.com/onoya)! - add the Lyria adapter with recorded fixtures

- [#4491](https://github.com/Bike4Mind/bike4mind/pull/4491) [`18d0d5f`](https://github.com/Bike4Mind/bike4mind/commit/18d0d5fe99dfe3256a72144d7a1924ceec545e21) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - add Bedrock Guardrails fallback for keyless users

- [#4493](https://github.com/Bike4Mind/bike4mind/pull/4493) [`231e762`](https://github.com/Bike4Mind/bike4mind/commit/231e7622bbf54023a8cd635bc4aa5cb3796520b3) Thanks [@onoya](https://github.com/onoya)! - add the music job kind to the generation engine

- [#4495](https://github.com/Bike4Mind/bike4mind/pull/4495) [`b907917`](https://github.com/Bike4Mind/bike4mind/commit/b9079176ad40a5f54052e3e8b35a0251f31f7ba5) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - add NCMEC CyberTipline reporting path for CSAM detection

- [#4503](https://github.com/Bike4Mind/bike4mind/pull/4503) [`9e21e87`](https://github.com/Bike4Mind/bike4mind/commit/9e21e8716531d60e0bdb00d3c91b43c16ca6c14f) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - tag signups with the OAuth client that sent them

- [#4546](https://github.com/Bike4Mind/bike4mind/pull/4546) [`d0e3bf4`](https://github.com/Bike4Mind/bike4mind/commit/d0e3bf4458d179006a2859cfeceb6a4805b27397) Thanks [@onoya](https://github.com/onoya)! - route the self-view user endpoints through the typed respond() boundary

- [#4549](https://github.com/Bike4Mind/bike4mind/pull/4549) [`a71e697`](https://github.com/Bike4Mind/bike4mind/commit/a71e6975fcdf1ab8a0b64f3e1a8437483c7c941e) Thanks [@onoya](https://github.com/onoya)! - show Drive and GitHub files that were not ingested, with names and reasons

- [#4550](https://github.com/Bike4Mind/bike4mind/pull/4550) [`329f0db`](https://github.com/Bike4Mind/bike4mind/commit/329f0db7315cc330976a08b892b099117cdb2d9f) Thanks [@onoya](https://github.com/onoya)! - add the TypeSafe Jev decisions adapter

- [#4552](https://github.com/Bike4Mind/bike4mind/pull/4552) [`4622d0f`](https://github.com/Bike4Mind/bike4mind/commit/4622d0fbf4ecb1298c8ca5769387cc2e533299f6) Thanks [@onoya](https://github.com/onoya)! - add the ElevenLabs adapter with recorded fixtures

- [#4602](https://github.com/Bike4Mind/bike4mind/pull/4602) [`9656d79`](https://github.com/Bike4Mind/bike4mind/commit/9656d7988332702d1c31040a31e0dc24db20d585) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add stable errorCode and byte counts to quota refusals

- [#4608](https://github.com/Bike4Mind/bike4mind/pull/4608) [`76dc400`](https://github.com/Bike4Mind/bike4mind/commit/76dc4002c6e409fc8c69b67bbce9f11182fc35b4) Thanks [@vinchi777](https://github.com/vinchi777)! - expose reasoning behaviour on GET /api/v1/models

- [#4611](https://github.com/Bike4Mind/bike4mind/pull/4611) [`8c93e44`](https://github.com/Bike4Mind/bike4mind/commit/8c93e442a61d092b35e9ede1cb02c0a64c989a1b) Thanks [@onoya](https://github.com/onoya)! - play audio and video in Files with generation details and a generated filter

- [#4612](https://github.com/Bike4Mind/bike4mind/pull/4612) [`c8030a2`](https://github.com/Bike4Mind/bike4mind/commit/c8030a231a8227b656f316ff9265ad08a8f7b24a) Thanks [@onoya](https://github.com/onoya)! - retire connector rows whose data lake no longer exists

- [#4633](https://github.com/Bike4Mind/bike4mind/pull/4633) [`3c26baa`](https://github.com/Bike4Mind/bike4mind/commit/3c26baa783477b0a1fa9dbe24269160faffd00f6) Thanks [@aflordelis](https://github.com/aflordelis)! - show storageLimit in decimal MB to match enforcement

- [#4636](https://github.com/Bike4Mind/bike4mind/pull/4636) [`d82d8b3`](https://github.com/Bike4Mind/bike4mind/commit/d82d8b309fcf73291434ad6d1add189bc84ea03e) Thanks [@jebie](https://github.com/jebie)! - advertise native tool search support on GET /api/v1/models

- [#4652](https://github.com/Bike4Mind/bike4mind/pull/4652) [`dd37361`](https://github.com/Bike4Mind/bike4mind/commit/dd373618fa3206de0954958b7cf795b388179d6c) Thanks [@onoya](https://github.com/onoya)! - let a programmatic launch carry per-send system context

- [#4666](https://github.com/Bike4Mind/bike4mind/pull/4666) [`a3dceab`](https://github.com/Bike4Mind/bike4mind/commit/a3dceabbca09029e112a2fcb2839602a19b41965) Thanks [@onoya](https://github.com/onoya)! - add an offline tool-calling scorecard

- [#4670](https://github.com/Bike4Mind/bike4mind/pull/4670) [`70eb763`](https://github.com/Bike4Mind/bike4mind/commit/70eb7633ee731cce9f4a41667cccd0e37bd87419) Thanks [@vinchi777](https://github.com/vinchi777)! - add the Electron desktop client

- [#4671](https://github.com/Bike4Mind/bike4mind/pull/4671) [`e522492`](https://github.com/Bike4Mind/bike4mind/commit/e5224921043739026e3a234e9dd29e6d5f8ee7b5) Thanks [@julsanchez](https://github.com/julsanchez)! - add the Skill Market (publish, safety scan, review, import, rate)

- [#4676](https://github.com/Bike4Mind/bike4mind/pull/4676) [`9052a9d`](https://github.com/Bike4Mind/bike4mind/commit/9052a9d5ddcbfad02b978dc4218e4b26c530f281) Thanks [@onoya](https://github.com/onoya)! - add the public music generation API

- [#4687](https://github.com/Bike4Mind/bike4mind/pull/4687) [`6f26e26`](https://github.com/Bike4Mind/bike4mind/commit/6f26e2637ae06aa215ee79bc4dd0f507bb8e1d57) Thanks [@onoya](https://github.com/onoya)! - run the music_generation tool as a background job

- [#4689](https://github.com/Bike4Mind/bike4mind/pull/4689) [`c295a57`](https://github.com/Bike4Mind/bike4mind/commit/c295a57cd01737da22ab10ce4992b9338e0cdbe8) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - record CyberTips filed by hand on the NCMEC web form

- [#4728](https://github.com/Bike4Mind/bike4mind/pull/4728) [`c6ea6e2`](https://github.com/Bike4Mind/bike4mind/commit/c6ea6e2155fc40aff4c1d3e67868e79dd0adadd9) Thanks [@onoya](https://github.com/onoya)! - cap songs per agent-mode run

- [#4729](https://github.com/Bike4Mind/bike4mind/pull/4729) [`e841be1`](https://github.com/Bike4Mind/bike4mind/commit/e841be14c6840bd30f86ff8e618ddf4d0427f532) Thanks [@onoya](https://github.com/onoya)! - deprecate the sync /api/ai/music route

- [#4752](https://github.com/Bike4Mind/bike4mind/pull/4752) [`719ca2d`](https://github.com/Bike4Mind/bike4mind/commit/719ca2ddd52c66e966f904772b4c4c58615254ab) Thanks [@poysama](https://github.com/poysama)! - add scoped daily Desktop usage export

- [#4754](https://github.com/Bike4Mind/bike4mind/pull/4754) [`ea9e434`](https://github.com/Bike4Mind/bike4mind/commit/ea9e4343899a55057f36211e87f5ceed2aad8332) Thanks [@ktdejesus](https://github.com/ktdejesus)! - attribute B4M Desktop usage and count it in DAU

- [#4757](https://github.com/Bike4Mind/bike4mind/pull/4757) [`8ed9273`](https://github.com/Bike4Mind/bike4mind/commit/8ed9273aeac5bf47dddeb0145725b03c34231046) Thanks [@vinchi777](https://github.com/vinchi777)! - scheduled storage reconciliation with drift alert

- [#4758](https://github.com/Bike4Mind/bike4mind/pull/4758) [`819632e`](https://github.com/Bike4Mind/bike4mind/commit/819632e71b29e5dab434d2e8a021c8970982dc6c) Thanks [@vinchi777](https://github.com/vinchi777)! - storage usage breakdown per source and per lake

- [#4767](https://github.com/Bike4Mind/bike4mind/pull/4767) [`0722e63`](https://github.com/Bike4Mind/bike4mind/commit/0722e630193fedaf627e3465404c8a1d121cd62f) Thanks [@poysama](https://github.com/poysama)! - let an ai:generate key create a bare session

- [#4768](https://github.com/Bike4Mind/bike4mind/pull/4768) [`0d96e9e`](https://github.com/Bike4Mind/bike4mind/commit/0d96e9e68a8082930b44ddf7153523f77532efb8) Thanks [@onoya](https://github.com/onoya)! - add publish_artifact tool to the B4M MCP server

- [#4806](https://github.com/Bike4Mind/bike4mind/pull/4806) [`06e97d6`](https://github.com/Bike4Mind/bike4mind/commit/06e97d645237a84108a5a9dc9a1218905ce612ee) Thanks [@erikbethke](https://github.com/erikbethke)! - add integrations gallery page

- [#4819](https://github.com/Bike4Mind/bike4mind/pull/4819) [`c6990f9`](https://github.com/Bike4Mind/bike4mind/commit/c6990f9de2dba3e7523c15c82c3986ea3e72f2c9) Thanks [@erikbethke](https://github.com/erikbethke)! - resolve team-plan seats for plan, tier and rate limits

- [#4857](https://github.com/Bike4Mind/bike4mind/pull/4857) [`aa5f140`](https://github.com/Bike4Mind/bike4mind/commit/aa5f140b3dab34eb8d90e521b64b5e26bff80979) Thanks [@onoya](https://github.com/onoya)! - apply user tags and a subscription from partner signup rules

- [#4859](https://github.com/Bike4Mind/bike4mind/pull/4859) [`fac6156`](https://github.com/Bike4Mind/bike4mind/commit/fac61563ba10990bf9650fcb8852b564c3fe2c1b) Thanks [@erikbethke](https://github.com/erikbethke)! - add the custom MCP connection models and settings

- [#4860](https://github.com/Bike4Mind/bike4mind/pull/4860) [`8250a7f`](https://github.com/Bike4Mind/bike4mind/commit/8250a7f6249a237e039934db15a54b895e88f7a8) Thanks [@onoya](https://github.com/onoya)! - persist the owning org on FabFile and add an org storage counter

- [#4863](https://github.com/Bike4Mind/bike4mind/pull/4863) [`0bab465`](https://github.com/Bike4Mind/bike4mind/commit/0bab4656ac106d0513dc34a53e789ae03bd76430) Thanks [@vinchi777](https://github.com/vinchi777)! - report reasoning tokens in the completions usage event

- [#4868](https://github.com/Bike4Mind/bike4mind/pull/4868) [`42b55a9`](https://github.com/Bike4Mind/bike4mind/commit/42b55a94920cb0d47a26007e9230bb05ff84b974) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - deny contributed tools per workspace surface at read time

### Patch Changes

- [#4147](https://github.com/Bike4Mind/bike4mind/pull/4147) [`270d5c2`](https://github.com/Bike4Mind/bike4mind/commit/270d5c2275d56b79fc9b4591682479cded1de442) Thanks [@vinchi777](https://github.com/vinchi777)! - make TTS and transcribe credit pre-flight cost- and enforcement-aware

- [#4177](https://github.com/Bike4Mind/bike4mind/pull/4177) [`2684a62`](https://github.com/Bike4Mind/bike4mind/commit/2684a6225aca69a1d9cc1e522dc63b5dbcedee5d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - derive in-app API reference rate-limit facts from one source

- [#4196](https://github.com/Bike4Mind/bike4mind/pull/4196) [`f927f61`](https://github.com/Bike4Mind/bike4mind/commit/f927f61ab02c5f46406bd628ef39470bdeca447b) Thanks [@jjmarfa](https://github.com/jjmarfa)! - cache confirmed-empty tool fetches so zero-tool servers stop refetching

- [#4219](https://github.com/Bike4Mind/bike4mind/pull/4219) [`c6be81b`](https://github.com/Bike4Mind/bike4mind/commit/c6be81b06904f920d8deec900dc241daaffdd6bb) Thanks [@poysama](https://github.com/poysama)! - configure organization feedback summary model

- [#4265](https://github.com/Bike4Mind/bike4mind/pull/4265) [`92970d1`](https://github.com/Bike4Mind/bike4mind/commit/92970d15401e0a7103b88a6caa65eba0b4085de7) Thanks [@erikbethke](https://github.com/erikbethke)! - don't return invitee emails resolved from user ids

- [#4312](https://github.com/Bike4Mind/bike4mind/pull/4312) [`921a039`](https://github.com/Bike4Mind/bike4mind/commit/921a039c1ec872eebeda409961a5c5cc2d2de5ac) Thanks [@erikbethke](https://github.com/erikbethke)! - publish per-model credit pricing and fix the in-app price table ([#4284](https://github.com/Bike4Mind/bike4mind/issues/4284))

- [#4317](https://github.com/Bike4Mind/bike4mind/pull/4317) [`0d068f3`](https://github.com/Bike4Mind/bike4mind/commit/0d068f356e3849a0b9dc180e9659b8e17bf2bc87) Thanks [@erikbethke](https://github.com/erikbethke)! - stop forcing tool_choice on Claude models that reject it

- [#4332](https://github.com/Bike4Mind/bike4mind/pull/4332) [`c1bcd94`](https://github.com/Bike4Mind/bike4mind/commit/c1bcd94a299e94300692291912384cba02810900) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - show Team roster controls only to members the API allows

- [#4366](https://github.com/Bike4Mind/bike4mind/pull/4366) [`022470b`](https://github.com/Bike4Mind/bike4mind/commit/022470bd2471f0eddf60bd37bee0aca80028bbfd) Thanks [@onoya](https://github.com/onoya)! - park a Drive lake in needs_reconnect when its folder is gone

- [#4369](https://github.com/Bike4Mind/bike4mind/pull/4369) [`d0c1e57`](https://github.com/Bike4Mind/bike4mind/commit/d0c1e5742deb81aaa000b7ea2074e0ce1cc1913c) Thanks [@erikbethke](https://github.com/erikbethke)! - trace the credit purchase funnel end to end

- [#4373](https://github.com/Bike4Mind/bike4mind/pull/4373) [`489980e`](https://github.com/Bike4Mind/bike4mind/commit/489980ed4b181a26b5a0086c23d1a2b663270d32) Thanks [@erikbethke](https://github.com/erikbethke)! - reply line breaks, web search offer, attach menu, phone title, cost split

- [#4380](https://github.com/Bike4Mind/bike4mind/pull/4380) [`0692ff4`](https://github.com/Bike4Mind/bike4mind/commit/0692ff4250fceba00a2f6d3f33835f5bee8281fa) Thanks [@erikbethke](https://github.com/erikbethke)! - settle stale voice credit holds with a scheduled sweep

- [#4388](https://github.com/Bike4Mind/bike4mind/pull/4388) [`1916e8a`](https://github.com/Bike4Mind/bike4mind/commit/1916e8ace1df142ec718e381859d57bfa4243245) Thanks [@erikbethke](https://github.com/erikbethke)! - bill every realtime voice response once and keep the hold open

- [#4405](https://github.com/Bike4Mind/bike4mind/pull/4405) [`49ca156`](https://github.com/Bike4Mind/bike4mind/commit/49ca156c7b613e6bba234e2e3b57a1387a602ee9) Thanks [@aflordelis](https://github.com/aflordelis)! - move data-lake cleanup and Drive purge queue handlers into apps/workers

- [#4414](https://github.com/Bike4Mind/bike4mind/pull/4414) [`d075a46`](https://github.com/Bike4Mind/bike4mind/commit/d075a46d5310069e45521a88928ec9ac710b325e) Thanks [@jarlacut](https://github.com/jarlacut)! - return real HTTP status for pre-stream completion failures

- [#4428](https://github.com/Bike4Mind/bike4mind/pull/4428) [`ea17e18`](https://github.com/Bike4Mind/bike4mind/commit/ea17e18fb5e554819ba014eb5bc957681d00caca) Thanks [@onoya](https://github.com/onoya)! - keep interpolated identifiers inside their REST path segment

- [#4429](https://github.com/Bike4Mind/bike4mind/pull/4429) [`863d5c8`](https://github.com/Bike4Mind/bike4mind/commit/863d5c8eb7ee78087acfee25baf526757a973e89) Thanks [@onoya](https://github.com/onoya)! - stop computing a sync bcrypt hash on key create and rotate

- [#4433](https://github.com/Bike4Mind/bike4mind/pull/4433) [`b75bf86`](https://github.com/Bike4Mind/bike4mind/commit/b75bf8688dc5b39b215c85e9674e9c436591eafd) Thanks [@erikbethke](https://github.com/erikbethke)! - bill voice holds on connected time only

- [#4435](https://github.com/Bike4Mind/bike4mind/pull/4435) [`bd39517`](https://github.com/Bike4Mind/bike4mind/commit/bd39517ba937413731087d9b86b6c515bd75af97) Thanks [@onoya](https://github.com/onoya)! - generic GenerationProvider and shared job public layer

- [#4454](https://github.com/Bike4Mind/bike4mind/pull/4454) [`860624a`](https://github.com/Bike4Mind/bike4mind/commit/860624ac3e6284d64aefbea9915363dd98378e78) Thanks [@erikbethke](https://github.com/erikbethke)! - only let the realtime close frame settle realtime holds

- [#4471](https://github.com/Bike4Mind/bike4mind/pull/4471) [`ad3098e`](https://github.com/Bike4Mind/bike4mind/commit/ad3098eb31c97cd100a2fbcb06ccffff6229c333) Thanks [@onoya](https://github.com/onoya)! - grant free credits and stamp verified email on OAuth signup

- [#4518](https://github.com/Bike4Mind/bike4mind/pull/4518) [`d9dfddf`](https://github.com/Bike4Mind/bike4mind/commit/d9dfddfa6cfff9dc63857e641b37af5963de3b35) Thanks [@jarlacut](https://github.com/jarlacut)! - return unknown_model for unrecognised completion model ids

- [#4547](https://github.com/Bike4Mind/bike4mind/pull/4547) [`4eab687`](https://github.com/Bike4Mind/bike4mind/commit/4eab6879269b3e2d471786455def74043eda60b6) Thanks [@aflordelis](https://github.com/aflordelis)! - move the agent executor handler family into apps/workers

- [#4555](https://github.com/Bike4Mind/bike4mind/pull/4555) [`1f030e3`](https://github.com/Bike4Mind/bike4mind/commit/1f030e3cf5e27b2d9fb32479bc9e426c16a600c2) Thanks [@julsanchez](https://github.com/julsanchez)! - refund only bytes that were actually charged

- [#4557](https://github.com/Bike4Mind/bike4mind/pull/4557) [`86bba4a`](https://github.com/Bike4Mind/bike4mind/commit/86bba4a26562a43a06e28951b7b38d9e5867d4c0) Thanks [@julsanchez](https://github.com/julsanchez)! - charge a content rewrite only the size delta

- [#4586](https://github.com/Bike4Mind/bike4mind/pull/4586) [`7c9f77a`](https://github.com/Bike4Mind/bike4mind/commit/7c9f77a2e344b1c743894931785195de54e11cc1) Thanks [@erikbethke](https://github.com/erikbethke)! - reopening Publish & Share on a shared answer acts on the live link

- [#4590](https://github.com/Bike4Mind/bike4mind/pull/4590) [`32923a0`](https://github.com/Bike4Mind/bike4mind/commit/32923a0af533f65121be2f29b928bfdef4417549) Thanks [@erikbethke](https://github.com/erikbethke)! - bill video generations to the account selected in the switcher

- [#4599](https://github.com/Bike4Mind/bike4mind/pull/4599) [`37a8844`](https://github.com/Bike4Mind/bike4mind/commit/37a8844e98868251b1725987d427f8810c86faeb) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - rate-limit WS JWT completions at the cli cap

- [#4600](https://github.com/Bike4Mind/bike4mind/pull/4600) [`e77dac6`](https://github.com/Bike4Mind/bike4mind/commit/e77dac6f4bf07e81694a139e0deb96c9bde74cf7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - report ops DAU from an uncapped distinct-user count

- [#4607](https://github.com/Bike4Mind/bike4mind/pull/4607) [`2bee04d`](https://github.com/Bike4Mind/bike4mind/commit/2bee04dbfae7582290d8e774efd28a8c10e57c96) Thanks [@jjmarfa](https://github.com/jjmarfa)! - debit research judge spend against the lake owner's credits

- [#4615](https://github.com/Bike4Mind/bike4mind/pull/4615) [`aca73ca`](https://github.com/Bike4Mind/bike4mind/commit/aca73ca6908301a25aca1457c18a15b21ddd2185) Thanks [@onoya](https://github.com/onoya)! - list only the decision models the caller can use

- [#4620](https://github.com/Bike4Mind/bike4mind/pull/4620) [`0e24dce`](https://github.com/Bike4Mind/bike4mind/commit/0e24dcef3f637cd8d10f2d5495f1ee3062aaffbd) Thanks [@jarlacut](https://github.com/jarlacut)! - stop listing models plain text calls cannot serve

- [#4634](https://github.com/Bike4Mind/bike4mind/pull/4634) [`34b28a5`](https://github.com/Bike4Mind/bike4mind/commit/34b28a5cc08bafe6c0083f325672a9d0a8087d1b) Thanks [@onoya](https://github.com/onoya)! - remove a generated asset's stored copies when its file is deleted

- [#4640](https://github.com/Bike4Mind/bike4mind/pull/4640) [`596a26c`](https://github.com/Bike4Mind/bike4mind/commit/596a26c579c1bfb76f2689d57ff2d47afddb86a0) Thanks [@onoya](https://github.com/onoya)! - require recent verification for account security changes

- [#4645](https://github.com/Bike4Mind/bike4mind/pull/4645) [`c317966`](https://github.com/Bike4Mind/bike4mind/commit/c317966ac743b47b873b47b0148201ff0523b53a) Thanks [@aflordelis](https://github.com/aflordelis)! - move the standalone Lambda handlers into apps/workers

- [#4650](https://github.com/Bike4Mind/bike4mind/pull/4650) [`bc0da01`](https://github.com/Bike4Mind/bike4mind/commit/bc0da019b191b6e8f942bf144666d1819629b1b1) Thanks [@onoya](https://github.com/onoya)! - keep email changes and usernames consistent

- [#4661](https://github.com/Bike4Mind/bike4mind/pull/4661) [`feed5af`](https://github.com/Bike4Mind/bike4mind/commit/feed5af8ba445f23f90f68df4755642c30b8adaa) Thanks [@onoya](https://github.com/onoya)! - tie websocket connections to the session that opened them

- [#4674](https://github.com/Bike4Mind/bike4mind/pull/4674) [`2db94ea`](https://github.com/Bike4Mind/bike4mind/commit/2db94ea1a1fca4dcf10b7e780560cf16613a1cdd) Thanks [@julsanchez](https://github.com/julsanchez)! - price each provider request on its own long-context tier

- [#4677](https://github.com/Bike4Mind/bike4mind/pull/4677) [`6575b54`](https://github.com/Bike4Mind/bike4mind/commit/6575b5417f35708bd2e73cc7c46a5f865fee191c) Thanks [@onoya](https://github.com/onoya)! - gate subagent and DAG-node tool calls on the parent's permission lists

- [#4678](https://github.com/Bike4Mind/bike4mind/pull/4678) [`eecffd3`](https://github.com/Bike4Mind/bike4mind/commit/eecffd346cbef79e0a633352b6212657ad6d2d8d) Thanks [@onoya](https://github.com/onoya)! - run workflow steps as the Slack-attested user

- [#4683](https://github.com/Bike4Mind/bike4mind/pull/4683) [`8bb7ec1`](https://github.com/Bike4Mind/bike4mind/commit/8bb7ec15c012844e019f709b43abdb51ccc6da8d) Thanks [@julsanchez](https://github.com/julsanchez)! - bill Gemini and xAI cached tokens and price each request on its own tier

- [#4685](https://github.com/Bike4Mind/bike4mind/pull/4685) [`9615cd3`](https://github.com/Bike4Mind/bike4mind/commit/9615cd38e8b27e4a3a1da37dbf4ca31c95d5f463) Thanks [@onoya](https://github.com/onoya)! - confirm only allowlisted write tools against the values the card shows

- [#4686](https://github.com/Bike4Mind/bike4mind/pull/4686) [`ac39448`](https://github.com/Bike4Mind/bike4mind/commit/ac39448c2386d772dcdaf5680ca5ff7c2576812d) Thanks [@onoya](https://github.com/onoya)! - bind attachment deletes to the listed attachment

- [#4690](https://github.com/Bike4Mind/bike4mind/pull/4690) [`e7aa767`](https://github.com/Bike4Mind/bike4mind/commit/e7aa767ae676f4a8377ec189e13fe1cfe0d4706d) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - delete the stored bytes of an unscannable-format upload on owner delete

- [#4697](https://github.com/Bike4Mind/bike4mind/pull/4697) [`3e4e742`](https://github.com/Bike4Mind/bike4mind/commit/3e4e7427a1e15330cc85ec0c83486cc7638ef3f5) Thanks [@julsanchez](https://github.com/julsanchez)! - bill the streamed output of a stopped or aborted Claude call

- [#4720](https://github.com/Bike4Mind/bike4mind/pull/4720) [`2226e00`](https://github.com/Bike4Mind/bike4mind/commit/2226e00973fc2ec077a21149bd76b21551cb694c) Thanks [@onoya](https://github.com/onoya)! - bill image tool calls on delivery, not at start

- [#4735](https://github.com/Bike4Mind/bike4mind/pull/4735) [`d6275be`](https://github.com/Bike4Mind/bike4mind/commit/d6275bed435ad13e10d49f2aecd626a95740c2ea) Thanks [@onoya](https://github.com/onoya)! - isolate workflow-step runs from the runner's notebook and integrations

- [#4737](https://github.com/Bike4Mind/bike4mind/pull/4737) [`04d2d8c`](https://github.com/Bike4Mind/bike4mind/commit/04d2d8c05738cff64119d4fdbaf8b480f93a18a1) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - record a hand-filed CyberTip over a false_positive verdict

- [#4747](https://github.com/Bike4Mind/bike4mind/pull/4747) [`fcb16fc`](https://github.com/Bike4Mind/bike4mind/commit/fcb16fcb24b971f64a4f01e7cafd3f52415fb732) Thanks [@jarlacut](https://github.com/jarlacut)! - stop model discovery from un-retiring deprecated models

- [#4771](https://github.com/Bike4Mind/bike4mind/pull/4771) [`2f4069a`](https://github.com/Bike4Mind/bike4mind/commit/2f4069a8a45d1e73d11000c138cc28a7de8b01b9) Thanks [@onoya](https://github.com/onoya)! - derive new-page slugs from a hash of the artifact id

- [#4774](https://github.com/Bike4Mind/bike4mind/pull/4774) [`268235b`](https://github.com/Bike4Mind/bike4mind/commit/268235b2a7ab08d9f6e166eedc6019d6b1d07e23) Thanks [@onoya](https://github.com/onoya)! - bill v1 media generations to the API key's billing organization

- [#4789](https://github.com/Bike4Mind/bike4mind/pull/4789) [`34d23d0`](https://github.com/Bike4Mind/bike4mind/commit/34d23d0c1dd22dc5df8f8867c9cd751c2069c0ac) Thanks [@onoya](https://github.com/onoya)! - validate ElevenLabs output format and harden the credit hold paths

- [#4814](https://github.com/Bike4Mind/bike4mind/pull/4814) [`487348b`](https://github.com/Bike4Mind/bike4mind/commit/487348b72280f132767073d1580d8235c6eae201) Thanks [@jarlacut](https://github.com/jarlacut)! - tell users when a retired model is switched to its successor

- [#4817](https://github.com/Bike4Mind/bike4mind/pull/4817) [`2532430`](https://github.com/Bike4Mind/bike4mind/commit/2532430b003c3d7734c0b45c4eac31bc7680ef4e) Thanks [@erikbethke](https://github.com/erikbethke)! - label a redirected reply with the model that answered

- [#4821](https://github.com/Bike4Mind/bike4mind/pull/4821) [`769a1c8`](https://github.com/Bike4Mind/bike4mind/commit/769a1c8d6fa0557d77a46bdd3de2534ea458f3b9) Thanks [@maconard](https://github.com/maconard)! - make an existing chat search the data lake picked for it

- [#4847](https://github.com/Bike4Mind/bike4mind/pull/4847) [`8ef244f`](https://github.com/Bike4Mind/bike4mind/commit/8ef244f7cc9a4e9f010422b66a17257fc3af3b30) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - show GitHub repo folders in the lake tree and keep them across re-syncs

- [#4849](https://github.com/Bike4Mind/bike4mind/pull/4849) [`20e307a`](https://github.com/Bike4Mind/bike4mind/commit/20e307a05c7a394ba3a2c51fc4a9455c7cee56b1) Thanks [@maconard](https://github.com/maconard)! - stop a too-high relevance threshold from emptying answers without notice

- [#4850](https://github.com/Bike4Mind/bike4mind/pull/4850) [`5d97d15`](https://github.com/Bike4Mind/bike4mind/commit/5d97d154517899ae09aabd9048ba63061efe3cc9) Thanks [@maconard](https://github.com/maconard)! - fail an upload when its embedding key is missing instead of using a different model

- [#4853](https://github.com/Bike4Mind/bike4mind/pull/4853) [`6df4968`](https://github.com/Bike4Mind/bike4mind/commit/6df4968d983f2e3c21ca16bc015cb69fae77b3af) Thanks [@maconard](https://github.com/maconard)! - keep forced retrieval on attachment turns when a lake is chosen

- [#4856](https://github.com/Bike4Mind/bike4mind/pull/4856) [`197e1df`](https://github.com/Bike4Mind/bike4mind/commit/197e1df99af23886e08fd87e30a12be086f6acb1) Thanks [@maconard](https://github.com/maconard)! - report files whose passage rebuild has not committed yet

- [#4869](https://github.com/Bike4Mind/bike4mind/pull/4869) [`8e28dd8`](https://github.com/Bike4Mind/bike4mind/commit/8e28dd83047b4d7274fa6fd84cfdd6d0271a9763) Thanks [@chadyuson2](https://github.com/chadyuson2)! - only call it a delivery failure when a channel actually failed

- [#4877](https://github.com/Bike4Mind/bike4mind/pull/4877) [`7546222`](https://github.com/Bike4Mind/bike4mind/commit/7546222b382d7cfa8a4357785a02ed1ae95dc171) Thanks [@onoya](https://github.com/onoya)! - reject replayed TOTP codes and make the MFA lockout race-safe

- [#4886](https://github.com/Bike4Mind/bike4mind/pull/4886) [`e497e42`](https://github.com/Bike4Mind/bike4mind/commit/e497e423b78cd68a4737b243dc22755357012e58) Thanks [@chadyuson2](https://github.com/chadyuson2)! - a failed channel is only a failure if nothing else got through

## 14.0.0

### Major Changes

- [#3968](https://github.com/Bike4Mind/bike4mind/pull/3968) [`342a68a`](https://github.com/Bike4Mind/bike4mind/commit/342a68aa84d32e921432728dd90c72641da010a1) Thanks [@onoya](https://github.com/onoya)! - replace the Sora video endpoint with multi-provider video generations

### Minor Changes

- [#4057](https://github.com/Bike4Mind/bike4mind/pull/4057) [`1b5ac9d`](https://github.com/Bike4Mind/bike4mind/commit/1b5ac9d8b5c5ca3dbeb5c23c60263d98d329a034) Thanks [@jarlacut](https://github.com/jarlacut)! - The auth mfaService drops `recordFailedAttempt` and `shouldResetFailedAttempts`, and `clearFailedAttempts` now takes the MFA config. Common adds shared MFA lockout constants.

- [#3916](https://github.com/Bike4Mind/bike4mind/pull/3916) [`f0877e3`](https://github.com/Bike4Mind/bike4mind/commit/f0877e3893a2ad53d9ead07c8395792f1cb9cc80) Thanks [@onoya](https://github.com/onoya)! - show github lake sync progress, skipped counts and an ask-about-repo action

- [#3922](https://github.com/Bike4Mind/bike4mind/pull/3922) [`6358d6c`](https://github.com/Bike4Mind/bike4mind/commit/6358d6c21c8e34a493d1bd7e734317eb157a8114) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - create a GitHub lake and start its connect in one call

- [#3923](https://github.com/Bike4Mind/bike4mind/pull/3923) [`745dfea`](https://github.com/Bike4Mind/bike4mind/commit/745dfea4c0fdd093150fa546dd78e1510500ccb5) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - offer the lake's own source in the finish-connect banner

- [#3983](https://github.com/Bike4Mind/bike4mind/pull/3983) [`50c8fa5`](https://github.com/Bike4Mind/bike4mind/commit/50c8fa5d7cb961deee0f3b14ae11234b3cd2644d) Thanks [@onoya](https://github.com/onoya)! - add the Video Studio at /studio/video

- [#4003](https://github.com/Bike4Mind/bike4mind/pull/4003) [`6fa1181`](https://github.com/Bike4Mind/bike4mind/commit/6fa1181e7078c4e36a33e45d560fce7926e5fcc1) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reconcile GitHub lakes on a schedule when push webhooks are missed

- [#4006](https://github.com/Bike4Mind/bike4mind/pull/4006) [`2b0f761`](https://github.com/Bike4Mind/bike4mind/commit/2b0f7618a7cfb26689ebeceb6e236ec783cceacb) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - compose customer-facing notes from each prod release

- [#4015](https://github.com/Bike4Mind/bike4mind/pull/4015) [`c9b6ce6`](https://github.com/Bike4Mind/bike4mind/commit/c9b6ce651dd88dbe666a253e439fce71435d10ea) Thanks [@vinchi777](https://github.com/vinchi777)! - support passkeys (WebAuthn) as an MFA method

- [#4029](https://github.com/Bike4Mind/bike4mind/pull/4029) [`48ccf11`](https://github.com/Bike4Mind/bike4mind/commit/48ccf11ff9a536cf7c9fb7d3057ad3a3a23ea93c) Thanks [@onoya](https://github.com/onoya)! - add GET /api/v1/sessions to the generated public API docs

- [#4030](https://github.com/Bike4Mind/bike4mind/pull/4030) [`85a6b07`](https://github.com/Bike4Mind/bike4mind/commit/85a6b07d0665e66ed8714c9113ea3774ff049368) Thanks [@vinchi777](https://github.com/vinchi777)! - add Bedrock inference profile ids

- [#4033](https://github.com/Bike4Mind/bike4mind/pull/4033) [`5a067b0`](https://github.com/Bike4Mind/bike4mind/commit/5a067b09f79dc65f6f02d12b18280bf26b2f2268) Thanks [@onoya](https://github.com/onoya)! - let the chat agent generate videos with a live job card

- [#4038](https://github.com/Bike4Mind/bike4mind/pull/4038) [`2784aea`](https://github.com/Bike4Mind/bike4mind/commit/2784aea964ef1ba610407d28e94bfef2c92198e4) Thanks [@vinchi777](https://github.com/vinchi777)! - identified SSO-passthrough embed mode with per-user memory

- [#4039](https://github.com/Bike4Mind/bike4mind/pull/4039) [`766aef9`](https://github.com/Bike4Mind/bike4mind/commit/766aef961bc8b721247f51a53b8f1f8ecb052aa3) Thanks [@jjmarfa](https://github.com/jjmarfa)! - return datalake_tag from GET /api/v1/data-lakes

- [#4068](https://github.com/Bike4Mind/bike4mind/pull/4068) [`45eca4d`](https://github.com/Bike4Mind/bike4mind/commit/45eca4db5004ec39ba8cc8b5d39461b87d009c4a) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - public What's New feed and admin tab

- [#4126](https://github.com/Bike4Mind/bike4mind/pull/4126) [`ac71151`](https://github.com/Bike4Mind/bike4mind/commit/ac71151caf575311863f5367e55e5fa73d38b432) Thanks [@juicewaa](https://github.com/juicewaa)! - register per-family Problem/Solvers views for navigate_view

### Patch Changes

- [#4136](https://github.com/Bike4Mind/bike4mind/pull/4136) [`ccb4d30`](https://github.com/Bike4Mind/bike4mind/commit/ccb4d30ee6e2b6d7371b3b99774153ec8988b702) Thanks [@onoya](https://github.com/onoya)! - drop confirm_pending_action from the external tool side-effects registry

- [#3874](https://github.com/Bike4Mind/bike4mind/pull/3874) [`52cccac`](https://github.com/Bike4Mind/bike4mind/commit/52cccac190a8b81c973978038cf9f14400aeceb2) Thanks [@aflordelis](https://github.com/aflordelis)! - publish GET/DELETE /api/sessions/{id} as contracts

- [#3880](https://github.com/Bike4Mind/bike4mind/pull/3880) [`979b44d`](https://github.com/Bike4Mind/bike4mind/commit/979b44d71823c0b82a4c1f922b3eabbe1013b824) Thanks [@julsanchez](https://github.com/julsanchez)! - resolve API-key principals to the key name in config history

- [#3892](https://github.com/Bike4Mind/bike4mind/pull/3892) [`dfb0427`](https://github.com/Bike4Mind/bike4mind/commit/dfb042798fb6c92f16859980d00c14affcbdefa2) Thanks [@aflordelis](https://github.com/aflordelis)! - show distinct file counts on inner tag-tree rows

- [#3908](https://github.com/Bike4Mind/bike4mind/pull/3908) [`e76712e`](https://github.com/Bike4Mind/bike4mind/commit/e76712e59e04b64fb113f8c140b933fe81f8ced5) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - include administered orgs in account-wide excluded count

- [#3926](https://github.com/Bike4Mind/bike4mind/pull/3926) [`fa6cad8`](https://github.com/Bike4Mind/bike4mind/commit/fa6cad8adffaec711268808c1d37e2adc2a2af6e) Thanks [@onoya](https://github.com/onoya)! - scan held artifact spans in one pass and drop the raw mermaid promotion

- [#3933](https://github.com/Bike4Mind/bike4mind/pull/3933) [`d3156bf`](https://github.com/Bike4Mind/bike4mind/commit/d3156bf2127fbd01ea28fc50bb4360f60dee0dce) Thanks [@dea0030](https://github.com/dea0030)! - attribute API-key route usage by caller client and key owner

- [#3935](https://github.com/Bike4Mind/bike4mind/pull/3935) [`14b6798`](https://github.com/Bike4Mind/bike4mind/commit/14b6798f6ac2eb43e485242db67f34fd4682b369) Thanks [@julsanchez](https://github.com/julsanchez)! - group the lake picker by a stable effective-owner key

- [#3948](https://github.com/Bike4Mind/bike4mind/pull/3948) [`dbb9b9a`](https://github.com/Bike4Mind/bike4mind/commit/dbb9b9a32b6b8c41e74d4fce0fd733bd195ea0d0) Thanks [@vinchi777](https://github.com/vinchi777)! - enforce notebook import storage quota across imports

- [#3950](https://github.com/Bike4Mind/bike4mind/pull/3950) [`7063e18`](https://github.com/Bike4Mind/bike4mind/commit/7063e180b2ea5c405304e5eef56c208bd6ad74c9) Thanks [@vinchi777](https://github.com/vinchi777)! - show tool-generated audio and images in the File Browser

- [#3956](https://github.com/Bike4Mind/bike4mind/pull/3956) [`5ac32cf`](https://github.com/Bike4Mind/bike4mind/commit/5ac32cff321399a50eb3520ef2f2c2e9f5627fbe) Thanks [@vinchi777](https://github.com/vinchi777)! - keep clientFirstTokenTime when the pipeline saves the whole quest

- [#3957](https://github.com/Bike4Mind/bike4mind/pull/3957) [`380dd56`](https://github.com/Bike4Mind/bike4mind/commit/380dd5669d9b25734410a83e5ef9240cb2baa8af) Thanks [@vinchi777](https://github.com/vinchi777)! - record refusal UsageEvents so the Spend refusal rate is populated

- [#3963](https://github.com/Bike4Mind/bike4mind/pull/3963) [`b39a54f`](https://github.com/Bike4Mind/bike4mind/commit/b39a54f19f4c35c44014a07fa0b9f34db1b2985b) Thanks [@onoya](https://github.com/onoya)! - serialize lake writes up to their external step against a grant revoke

- [#3967](https://github.com/Bike4Mind/bike4mind/pull/3967) [`56d4363`](https://github.com/Bike4Mind/bike4mind/commit/56d43635e2e4302cebdf4a2e6b691177be434ae5) Thanks [@jjmarfa](https://github.com/jjmarfa)! - populate first-token timing so slow-first-token anomalies fire

- [#3971](https://github.com/Bike4Mind/bike4mind/pull/3971) [`d9bf1a1`](https://github.com/Bike4Mind/bike4mind/commit/d9bf1a13f467f8807a7972cc76b7fbbf0a0b9b03) Thanks [@julsanchez](https://github.com/julsanchez)! - pick a free tag prefix when recreating a deleted lake

- [#3986](https://github.com/Bike4Mind/bike4mind/pull/3986) [`5907b66`](https://github.com/Bike4Mind/bike4mind/commit/5907b66551679d755253a0e546d917f9dd4b90f6) Thanks [@dea0030](https://github.com/dea0030)! - resolve lifecycle actions by lake id only

- [#3991](https://github.com/Bike4Mind/bike4mind/pull/3991) [`89c5938`](https://github.com/Bike4Mind/bike4mind/commit/89c5938df001ef300d0221852b69ce2b9d2862fe) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - trust adapter price literals in model promotion

- [#4004](https://github.com/Bike4Mind/bike4mind/pull/4004) [`190c592`](https://github.com/Bike4Mind/bike4mind/commit/190c59227a558b03f9993f8582fcce8e646b2da9) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - make per-user key cap atomic via insert-then-recount

- [#4005](https://github.com/Bike4Mind/bike4mind/pull/4005) [`128c504`](https://github.com/Bike4Mind/bike4mind/commit/128c504ae50a80d29daa85613bba438c7acf0c2f) Thanks [@vinchi777](https://github.com/vinchi777)! - price cached context at the cache-read rate when reserving CLI credits

- [#4017](https://github.com/Bike4Mind/bike4mind/pull/4017) [`fcec8c8`](https://github.com/Bike4Mind/bike4mind/commit/fcec8c8980df42d032df92b597519fd8b796a243) Thanks [@onoya](https://github.com/onoya)! - strip choices blocks from every reply slot and separate joined slots

- [#4037](https://github.com/Bike4Mind/bike4mind/pull/4037) [`2142ebf`](https://github.com/Bike4Mind/bike4mind/commit/2142ebfdaeccde9177e7d9e5a301f4137790ea22) Thanks [@julsanchez](https://github.com/julsanchez)! - reach Bedrock on self-host through dedicated credentials

- [#4040](https://github.com/Bike4Mind/bike4mind/pull/4040) [`1154408`](https://github.com/Bike4Mind/bike4mind/commit/1154408ea4686c9a330efac69b5e69007defa122) Thanks [@vinchi777](https://github.com/vinchi777)! - honor a declared 403 in defineLambdaRoute auth failures

- [#4066](https://github.com/Bike4Mind/bike4mind/pull/4066) [`c5ce159`](https://github.com/Bike4Mind/bike4mind/commit/c5ce15963ab2d6bba555f653e331095ac7ec3275) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - pass request client to checkRateLimit on WS route

- [#4069](https://github.com/Bike4Mind/bike4mind/pull/4069) [`5ef61d6`](https://github.com/Bike4Mind/bike4mind/commit/5ef61d652da7feecd8259e8f8fbcc720ca86811d) Thanks [@onoya](https://github.com/onoya)! - enforce API-key scopes on projects and agents routes

- [#4071](https://github.com/Bike4Mind/bike4mind/pull/4071) [`c44d38d`](https://github.com/Bike4Mind/bike4mind/commit/c44d38d290bd775e08f65d3a6544c2b6a0121207) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - one shared Bedrock region-prefix helper

- [#4128](https://github.com/Bike4Mind/bike4mind/pull/4128) [`54d7dd6`](https://github.com/Bike4Mind/bike4mind/commit/54d7dd6081da91698e0f3ca5fdc8b30680e775a3) Thanks [@juicewaa](https://github.com/juicewaa)! - echo sessionId on reconnect_result and drop client correlation queue

- Updated dependencies [[`0838962`](https://github.com/Bike4Mind/bike4mind/commit/0838962cc87930266d8b4918c081b3dc4bade3eb)]:
  - @bike4mind/hearth@0.3.1

## 13.1.0

### Minor Changes

- [#3899](https://github.com/Bike4Mind/bike4mind/pull/3899) [`254ae9f`](https://github.com/Bike4Mind/bike4mind/commit/254ae9ff0702b92b3a41d620d5a020c9c026afb6) Thanks [@onoya](https://github.com/onoya)! - add the generation job engine and video job foundation

- [#3903](https://github.com/Bike4Mind/bike4mind/pull/3903) [`45d7c5e`](https://github.com/Bike4Mind/bike4mind/commit/45d7c5e86ce91cbffcbf1efe3bf606593af5deac) Thanks [@onoya](https://github.com/onoya)! - publish an API contract for GET /api/v1/models

### Patch Changes

- [#3876](https://github.com/Bike4Mind/bike4mind/pull/3876) [`9bbfd8c`](https://github.com/Bike4Mind/bike4mind/commit/9bbfd8c1d6f66da7e433bcf233d4e2a6c37637c7) Thanks [@julsanchez](https://github.com/julsanchez)! - stop resolving deleted lakes by slug and preview the real slug

- [#3894](https://github.com/Bike4Mind/bike4mind/pull/3894) [`ea66cbb`](https://github.com/Bike4Mind/bike4mind/commit/ea66cbb0257bb8264c5c6e60a8a9209e9f24da9a) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - validate API keys with a SHA-256 digest instead of bcrypt

## 13.0.0

### Major Changes

- [#3884](https://github.com/Bike4Mind/bike4mind/pull/3884) [`31d4623`](https://github.com/Bike4Mind/bike4mind/commit/31d46236619fd7e0c2be3f3bc4d34ee69314e682) Thanks [@onoya](https://github.com/onoya)! - deliver all generated audio through one shared module, by URL when oversized

### Minor Changes

- [#3766](https://github.com/Bike4Mind/bike4mind/pull/3766) [`99033fe`](https://github.com/Bike4Mind/bike4mind/commit/99033fe34169925190d1cad36aa45c5c7fc956a4) Thanks [@onoya](https://github.com/onoya)! - expose per-model image capabilities (sizes, limits, supported params)

- [#3863](https://github.com/Bike4Mind/bike4mind/pull/3863) [`9bd1edf`](https://github.com/Bike4Mind/bike4mind/commit/9bd1edf146cbf8e6b43d413ff94b5f5f4740f311) Thanks [@onoya](https://github.com/onoya)! - show which image models support transparent backgrounds

- [#3864](https://github.com/Bike4Mind/bike4mind/pull/3864) [`88587cc`](https://github.com/Bike4Mind/bike4mind/commit/88587cc0acdfc7ca0658c8d0c92b8c6852cd79d1) Thanks [@onoya](https://github.com/onoya)! - let API callers opt out of the continuation prompt rewrite

- [#3866](https://github.com/Bike4Mind/bike4mind/pull/3866) [`23bd5c7`](https://github.com/Bike4Mind/bike4mind/commit/23bd5c7680423502c5033bb83f6988d9916e76c6) Thanks [@onoya](https://github.com/onoya)! - manage and show monthly member credit budgets

- [#3879](https://github.com/Bike4Mind/bike4mind/pull/3879) [`a728e8c`](https://github.com/Bike4Mind/bike4mind/commit/a728e8c8a459c177cce15a978dd0418a6085129e) Thanks [@onoya](https://github.com/onoya)! - scope voice v2 routes and publish them as v1 contracts

- [#3881](https://github.com/Bike4Mind/bike4mind/pull/3881) [`3942bbc`](https://github.com/Bike4Mind/bike4mind/commit/3942bbc9dbceb5356ae18f016fe8c0684f43ffef) Thanks [@onoya](https://github.com/onoya)! - filter platform endpoint traffic by source and owner type

### Patch Changes

- [#3841](https://github.com/Bike4Mind/bike4mind/pull/3841) [`4c46065`](https://github.com/Bike4Mind/bike4mind/commit/4c46065b22954e0f8e6afdec0e497e741de92a2d) Thanks [@jarlacut](https://github.com/jarlacut)! - show each lake's uncategorized files inside its own folder

- [#3858](https://github.com/Bike4Mind/bike4mind/pull/3858) [`ad14801`](https://github.com/Bike4Mind/bike4mind/commit/ad14801acd6de3230b2dc9819586f402ae047cb4) Thanks [@juicewaa](https://github.com/juicewaa)! - derive quest reply text from replies[] on poll and wait bodies

- [#3868](https://github.com/Bike4Mind/bike4mind/pull/3868) [`04d895f`](https://github.com/Bike4Mind/bike4mind/commit/04d895f7bf3053326bb8d0871ebefb389fe37dec) Thanks [@jjmarfa](https://github.com/jjmarfa)! - measure the per-lake budget bar against embedding spend only

- [#3882](https://github.com/Bike4Mind/bike4mind/pull/3882) [`c8ac9ba`](https://github.com/Bike4Mind/bike4mind/commit/c8ac9ba4856dfc472f2e55d80b7013c28429f0eb) Thanks [@onoya](https://github.com/onoya)! - re-enqueue generation callbacks stuck in dispatched state

- [#3891](https://github.com/Bike4Mind/bike4mind/pull/3891) [`c4d2bd4`](https://github.com/Bike4Mind/bike4mind/commit/c4d2bd49a6bc6bccec224924e899f89de9dca269) Thanks [@aflordelis](https://github.com/aflordelis)! - move comms and ops queue handlers into apps/workers

## 12.2.0

### Minor Changes

- [#3656](https://github.com/Bike4Mind/bike4mind/pull/3656) [`9c03692`](https://github.com/Bike4Mind/bike4mind/commit/9c03692a2b4bf06e81cfa3c9d73813d9ffa8e7bd) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - flag lakes chat retrieval cannot search in the picker and scope strip

- [#3700](https://github.com/Bike4Mind/bike4mind/pull/3700) [`db87b77`](https://github.com/Bike4Mind/bike4mind/commit/db87b7730203867c4e2f94a8900b51de804e8c90) Thanks [@onoya](https://github.com/onoya)! - let a personal data lake connect a Google Drive folder

- [#3713](https://github.com/Bike4Mind/bike4mind/pull/3713) [`8ada8ca`](https://github.com/Bike4Mind/bike4mind/commit/8ada8cae802a64ef92a635044e68539a51507965) Thanks [@erikbethke](https://github.com/erikbethke)! - clone, fork or move a notebook into another workspace

- [#3714](https://github.com/Bike4Mind/bike4mind/pull/3714) [`993d00e`](https://github.com/Bike4Mind/bike4mind/commit/993d00e916ce3f7b0b682544b3457b3a261095af) Thanks [@erikbethke](https://github.com/erikbethke)! - record session origin and generated image count

- [#3716](https://github.com/Bike4Mind/bike4mind/pull/3716) [`4401e08`](https://github.com/Bike4Mind/bike4mind/commit/4401e08ac6947ae1d61c06b89fb39b742e79dd03) Thanks [@erikbethke](https://github.com/erikbethke)! - hedge web_search with a backup provider

- [#3717](https://github.com/Bike4Mind/bike4mind/pull/3717) [`974f6a9`](https://github.com/Bike4Mind/bike4mind/commit/974f6a98798bd50b954802730c91886fc023307f) Thanks [@erikbethke](https://github.com/erikbethke)! - run SearXNG as an internal web-search backend

- [#3718](https://github.com/Bike4Mind/bike4mind/pull/3718) [`d1e2a5d`](https://github.com/Bike4Mind/bike4mind/commit/d1e2a5d22d42dc7dead35a2f53ca29e22d711994) Thanks [@erikbethke](https://github.com/erikbethke)! - render a reply's next-step choices as numbered buttons

- [#3723](https://github.com/Bike4Mind/bike4mind/pull/3723) [`082ac10`](https://github.com/Bike4Mind/bike4mind/commit/082ac107adf29fefe2ba7764f5deb659823c42da) Thanks [@onoya](https://github.com/onoya)! - authorize-first GitHub connect with a repository picker

- [#3765](https://github.com/Bike4Mind/bike4mind/pull/3765) [`31f1493`](https://github.com/Bike4Mind/bike4mind/commit/31f1493086206e85ec1615a29b7a4556dd8305ec) Thanks [@onoya](https://github.com/onoya)! - add GET /api/v1/credits for ai:* balance pre-flight

- [#3811](https://github.com/Bike4Mind/bike4mind/pull/3811) [`377bea9`](https://github.com/Bike4Mind/bike4mind/commit/377bea9855a55de1140f6bbea9b815893d42bb6e) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - notify previous owner when API key changes hands on rotation

- [#3843](https://github.com/Bike4Mind/bike4mind/pull/3843) [`2c3ed54`](https://github.com/Bike4Mind/bike4mind/commit/2c3ed543d7d596805a352a0e93a1cbe124d09d9d) Thanks [@onoya](https://github.com/onoya)! - add MCP text to speech tool

- [#3845](https://github.com/Bike4Mind/bike4mind/pull/3845) [`dfeb6d7`](https://github.com/Bike4Mind/bike4mind/commit/dfeb6d74c81e8e652932f3e5732979622479d345) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add Return to ranking for superseded files

- [#3851](https://github.com/Bike4Mind/bike4mind/pull/3851) [`07d3d0d`](https://github.com/Bike4Mind/bike4mind/commit/07d3d0dabe5d7b79575aa5da18838d2c313c63bb) Thanks [@vinchi777](https://github.com/vinchi777)! - accept the b4m-desktop client in the device flow

- [#3852](https://github.com/Bike4Mind/bike4mind/pull/3852) [`d0ac85c`](https://github.com/Bike4Mind/bike4mind/commit/d0ac85c3192529cc8b679856627031e7560a0ef9) Thanks [@vinchi777](https://github.com/vinchi777)! - forward a reasoningEffort option to the LLM adapter

- [#3862](https://github.com/Bike4Mind/bike4mind/pull/3862) [`51ac5f4`](https://github.com/Bike4Mind/bike4mind/commit/51ac5f4cf502ea00f4401c3b81158363d42f0705) Thanks [@onoya](https://github.com/onoya)! - make the per-member credit cap a monthly budget with per-member overrides

### Patch Changes

- [#3412](https://github.com/Bike4Mind/bike4mind/pull/3412) [`ac9be44`](https://github.com/Bike4Mind/bike4mind/commit/ac9be444b5961a25499f322645701ca4d2a37d35) Thanks [@vinchi777](https://github.com/vinchi777)! - persist and expose model fallback info

- [#3532](https://github.com/Bike4Mind/bike4mind/pull/3532) [`f38dd70`](https://github.com/Bike4Mind/bike4mind/commit/f38dd70dd37d2b80d47a131562cc8dcfdc907021) Thanks [@jjmarfa](https://github.com/jjmarfa)! - stop counting expired keys against the per-user API key cap

- [#3710](https://github.com/Bike4Mind/bike4mind/pull/3710) [`d4bb5f0`](https://github.com/Bike4Mind/bike4mind/commit/d4bb5f051b13778c2e24e7234d07e03068623532) Thanks [@erikbethke](https://github.com/erikbethke)! - harden web_search resilience and diagnosis accuracy

- [#3720](https://github.com/Bike4Mind/bike4mind/pull/3720) [`3bd6a36`](https://github.com/Bike4Mind/bike4mind/commit/3bd6a368a8db2f5a0a9a22099b389c4f521a025c) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - count administered-org lakes in excluded-lake count

- [#3732](https://github.com/Bike4Mind/bike4mind/pull/3732) [`ebc8be5`](https://github.com/Bike4Mind/bike4mind/commit/ebc8be501a76a99b10edc9814800e209b077443b) Thanks [@dea0030](https://github.com/dea0030)! - correct History upload and review rows

- [#3734](https://github.com/Bike4Mind/bike4mind/pull/3734) [`8eaa7fa`](https://github.com/Bike4Mind/bike4mind/commit/8eaa7fa134f16a2d1f3fb008b77fb21c0aa4e206) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - name a tool timeout in Answer Diagnosis

- [#3737](https://github.com/Bike4Mind/bike4mind/pull/3737) [`a7144cc`](https://github.com/Bike4Mind/bike4mind/commit/a7144ccda6473317b1af3f70b822b4bed19204f0) Thanks [@onoya](https://github.com/onoya)! - queue the GitHub disconnect purge off the request path

- [#3739](https://github.com/Bike4Mind/bike4mind/pull/3739) [`155d3b5`](https://github.com/Bike4Mind/bike4mind/commit/155d3b599fc9ec7728b73f09f13c058eb40f923f) Thanks [@onoya](https://github.com/onoya)! - build the data-lake AccessContext in one place

- [#3740](https://github.com/Bike4Mind/bike4mind/pull/3740) [`0fd958e`](https://github.com/Bike4Mind/bike4mind/commit/0fd958ead53f3440f0536b049c72167376a16cad) Thanks [@dea0030](https://github.com/dea0030)! - give federated exchange keys their own per-user cap pool

- [#3751](https://github.com/Bike4Mind/bike4mind/pull/3751) [`ba37763`](https://github.com/Bike4Mind/bike4mind/commit/ba377630cc53b56ed23917287751ea7a19f6b0ef) Thanks [@onoya](https://github.com/onoya)! - accept seed on image edit requests

- [#3756](https://github.com/Bike4Mind/bike4mind/pull/3756) [`5f85ce9`](https://github.com/Bike4Mind/bike4mind/commit/5f85ce912fba2a42616f23d4fcf180e75db857a7) Thanks [@vinchi777](https://github.com/vinchi777)! - detach notebook attachments whose file no longer exists

- [#3759](https://github.com/Bike4Mind/bike4mind/pull/3759) [`abe503f`](https://github.com/Bike4Mind/bike4mind/commit/abe503f570c91fbf1cbaa0d0e37c5c6b357ded40) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - make data lake write tools work in agent runs and use the picker-attached agent

- [#3779](https://github.com/Bike4Mind/bike4mind/pull/3779) [`0e0d518`](https://github.com/Bike4Mind/bike4mind/commit/0e0d518938fbd8c17edfa8d227e27759a70bea39) Thanks [@erikbethke](https://github.com/erikbethke)! - keep reply choices from drifting out of later turns

- [#3780](https://github.com/Bike4Mind/bike4mind/pull/3780) [`67c3be6`](https://github.com/Bike4Mind/bike4mind/commit/67c3be68863b2e2d38961a48ec7d2b2cbc908d91) Thanks [@erikbethke](https://github.com/erikbethke)! - load Python artifact packages from imports via Pyodide

- [#3835](https://github.com/Bike4Mind/bike4mind/pull/3835) [`83fb75f`](https://github.com/Bike4Mind/bike4mind/commit/83fb75feff292c71203c2f22a7ae8795635eb25f) Thanks [@poysama](https://github.com/poysama)! - retain and recover permanent lake cleanup

- [#3837](https://github.com/Bike4Mind/bike4mind/pull/3837) [`9d7b298`](https://github.com/Bike4Mind/bike4mind/commit/9d7b298a2b71380b1f3202f50b230e5ef33ac4e9) Thanks [@jjmarfa](https://github.com/jjmarfa)! - isolate API-key chat sessions from the user's open notebook

- [#3838](https://github.com/Bike4Mind/bike4mind/pull/3838) [`f921f5d`](https://github.com/Bike4Mind/bike4mind/commit/f921f5d3ebe17c93a34ce981d8cedf5a9702b27f) Thanks [@jjmarfa](https://github.com/jjmarfa)! - stop absence retiring Bedrock inference-profile ids

- [#3840](https://github.com/Bike4Mind/bike4mind/pull/3840) [`623d55d`](https://github.com/Bike4Mind/bike4mind/commit/623d55dd1aed920f84ee7480c3ba7f6b38b63149) Thanks [@jjmarfa](https://github.com/jjmarfa)! - send selected workbench agents on the new-session LLM turn

- [#3861](https://github.com/Bike4Mind/bike4mind/pull/3861) [`c854733`](https://github.com/Bike4Mind/bike4mind/commit/c854733c09bae678de0ffa4b22658ffed391b9d1) Thanks [@onoya](https://github.com/onoya)! - reject reference images the selected model cannot use

- [#3878](https://github.com/Bike4Mind/bike4mind/pull/3878) [`b96f722`](https://github.com/Bike4Mind/bike4mind/commit/b96f7222812a1f638a96e02fff84d6215069f856) Thanks [@onoya](https://github.com/onoya)! - centralize contract example ids

## 12.1.0

### Minor Changes

- [#3410](https://github.com/Bike4Mind/bike4mind/pull/3410) [`ede9899`](https://github.com/Bike4Mind/bike4mind/commit/ede9899b6ec98aeb9f7936eaa6bd99624ce1b6d6) Thanks [@onoya](https://github.com/onoya)! - add metadata-only documentDate backfill script

- [#3488](https://github.com/Bike4Mind/bike4mind/pull/3488) [`9d369fd`](https://github.com/Bike4Mind/bike4mind/commit/9d369fd0083bbddfd4a87ae05c7ace87c945f1a5) Thanks [@chadyuson2](https://github.com/chadyuson2)! - list, add and revoke-by-id on the share-token route

- [#3491](https://github.com/Bike4Mind/bike4mind/pull/3491) [`fd7ef89`](https://github.com/Bike4Mind/bike4mind/commit/fd7ef89592e6228fd7df9a5bbdd7e750d2249e6b) Thanks [@vinchi777](https://github.com/vinchi777)! - let add-on packages publish contracts for the routes they mount

- [#3503](https://github.com/Bike4Mind/bike4mind/pull/3503) [`a92d5d3`](https://github.com/Bike4Mind/bike4mind/commit/a92d5d31c493960010cdf1abe03333450c7dd6b0) Thanks [@aflordelis](https://github.com/aflordelis)! - show the judge model on an in-flight research run card

- [#3509](https://github.com/Bike4Mind/bike4mind/pull/3509) [`60845e1`](https://github.com/Bike4Mind/bike4mind/commit/60845e1ee2b6605fe8a2e05fa4b8431360c07dd0) Thanks [@onoya](https://github.com/onoya)! - publish the data lake API in the public contract

- [#3489](https://github.com/Bike4Mind/bike4mind/pull/3489) [`0a36217`](https://github.com/Bike4Mind/bike4mind/commit/0a362178b0ad60b07877666862ac98815ed5af54) Thanks [@julsanchez](https://github.com/julsanchez)! - Add required `removeMember` to `IOrganizationRepository` and `recordReferrals` to `IUserRepository`, a typed `RepositoryUpdateOptions<T>` for `IBaseRepository.update` and `updateMany`, and the exported `RepositoryPatch<T>` / `RepositoryUpdate<T>` types so `update` accepts dotted leaf paths (`'visual.portraitUrl'`). `updateMany` now honours the reserved `unset` option.

### Patch Changes

- [#3385](https://github.com/Bike4Mind/bike4mind/pull/3385) [`0aa75f9`](https://github.com/Bike4Mind/bike4mind/commit/0aa75f9b925474b221817fb70fd7f4222f69c4e8) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - purge ingested files on Google Drive disconnect

- [#3387](https://github.com/Bike4Mind/bike4mind/pull/3387) [`5f21257`](https://github.com/Bike4Mind/bike4mind/commit/5f21257e89df2bdb9ed84b37ec157a98220dc678) Thanks [@dea0030](https://github.com/dea0030)! - give the attachment door its own draft-inclusive lake scope

- [#3391](https://github.com/Bike4Mind/bike4mind/pull/3391) [`420acfd`](https://github.com/Bike4Mind/bike4mind/commit/420acfd544dd1c4825ccf3e6730906609e8d5f56) Thanks [@dea0030](https://github.com/dea0030)! - define generate-image and edit-image with API contracts

- [#3394](https://github.com/Bike4Mind/bike4mind/pull/3394) [`fb13127`](https://github.com/Bike4Mind/bike4mind/commit/fb13127fa17159715f2465edc13aa79ba9fbb371) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - scan artifact tags, titles and tool-output results in linear time

- [#3482](https://github.com/Bike4Mind/bike4mind/pull/3482) [`35e91bf`](https://github.com/Bike4Mind/bike4mind/commit/35e91bf9d09751fea6d066d20273a23bf2c596e4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - move lattice intent scanners into @bike4mind/common

- [#3486](https://github.com/Bike4Mind/bike4mind/pull/3486) [`870a2e5`](https://github.com/Bike4Mind/bike4mind/commit/870a2e53453e8c62afe271d4cccd147eb70a6ca9) Thanks [@julsanchez](https://github.com/julsanchez)! - stop API-key writers from reverting a revoke or spend increment

- [#3492](https://github.com/Bike4Mind/bike4mind/pull/3492) [`ada05e5`](https://github.com/Bike4Mind/bike4mind/commit/ada05e5375c6ece452390fd894b7ba5ee8ca7eca) Thanks [@vinchi777](https://github.com/vinchi777)! - mark a killed turn's recovered quest unfinished and bound web_search in the Lambda

- [#3493](https://github.com/Bike4Mind/bike4mind/pull/3493) [`9358808`](https://github.com/Bike4Mind/bike4mind/commit/9358808b851943c909443297d9cbd820c6b5abdf) Thanks [@onoya](https://github.com/onoya)! - pick forced-retrieval candidates by relevance, not file name

- [#3502](https://github.com/Bike4Mind/bike4mind/pull/3502) [`5d94e2b`](https://github.com/Bike4Mind/bike4mind/commit/5d94e2b2eea151c86fe4c697bd7e39feda74dfec) Thanks [@julsanchez](https://github.com/julsanchez)! - re-check sharee write access at write time for projects, quest plans, artifacts and sessions

- [#3512](https://github.com/Bike4Mind/bike4mind/pull/3512) [`cd64e03`](https://github.com/Bike4Mind/bike4mind/commit/cd64e03790355e26c51079385cd09797514d066e) Thanks [@onoya](https://github.com/onoya)! - let a lake's system prompt reach readers on sessions scoped to it

## 12.0.0

### Major Changes

- [#3098](https://github.com/Bike4Mind/bike4mind/pull/3098) [`a97d7b0`](https://github.com/Bike4Mind/bike4mind/commit/a97d7b07e980c2c74ec8d6a895483cf98786a0a5) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - show when access excluded lakes from a turn

- [#3108](https://github.com/Bike4Mind/bike4mind/pull/3108) [`a9ad19f`](https://github.com/Bike4Mind/bike4mind/commit/a9ad19f2eb4367773fb9fb97697477f6a00f1a76) Thanks [@juicewaa](https://github.com/juicewaa)! - carry summaryTrigger through clone, fork and snip

- [#3113](https://github.com/Bike4Mind/bike4mind/pull/3113) [`8472dd6`](https://github.com/Bike4Mind/bike4mind/commit/8472dd6719f154c8d393a1f0ec36210b5a2d9a84) Thanks [@onoya](https://github.com/onoya)! - stop rendering ingestion time as the document date

- [#3163](https://github.com/Bike4Mind/bike4mind/pull/3163) [`74b798c`](https://github.com/Bike4Mind/bike4mind/commit/74b798c9f2e9e7b0a86a10afa2640714926bb878) Thanks [@jarlacut](https://github.com/jarlacut)! - declare a lake origin and refuse unattended ingest into curated lakes

- [#3219](https://github.com/Bike4Mind/bike4mind/pull/3219) [`a31113d`](https://github.com/Bike4Mind/bike4mind/commit/a31113d843a081d1cef3175f95c39134ebd16fd5) Thanks [@jjmarfa](https://github.com/jjmarfa)! - make ownership transfer a pending offer

- [#3449](https://github.com/Bike4Mind/bike4mind/pull/3449) [`4bea648`](https://github.com/Bike4Mind/bike4mind/commit/4bea648addc68d3c254eff55edf187db08a9f5d2) Thanks [@onoya](https://github.com/onoya)! - scheduled research runs, paused while the review queue is full

### Minor Changes

- [#3071](https://github.com/Bike4Mind/bike4mind/pull/3071) [`fcc343b`](https://github.com/Bike4Mind/bike4mind/commit/fcc343bb3c2c6d5ffa8cba42f60dd024b2e1c2d4) Thanks [@choyno](https://github.com/choyno)! - record a durable membership change log for file add/remove

- [#3115](https://github.com/Bike4Mind/bike4mind/pull/3115) [`b34fd8c`](https://github.com/Bike4Mind/bike4mind/commit/b34fd8cecce82f4159a3cd4b44a3528d8760b3a9) Thanks [@onoya](https://github.com/onoya)! - mark disagreeing sources on the citation chips

- [#3134](https://github.com/Bike4Mind/bike4mind/pull/3134) [`e4b4032`](https://github.com/Bike4Mind/bike4mind/commit/e4b40325c25d79379755d074379f4f6de2a47d64) Thanks [@onoya](https://github.com/onoya)! - add a model-driven contradiction detection pass

- [#3140](https://github.com/Bike4Mind/bike4mind/pull/3140) [`eb67058`](https://github.com/Bike4Mind/bike4mind/commit/eb670588d2b95ae9bd03440638decb3107aa6495) Thanks [@vinchi777](https://github.com/vinchi777)! - persist finding resolution decisions across detector reruns

- [#3147](https://github.com/Bike4Mind/bike4mind/pull/3147) [`d4faf36`](https://github.com/Bike4Mind/bike4mind/commit/d4faf36852e6beb2834d60541a8fe21471664647) Thanks [@vinchi777](https://github.com/vinchi777)! - show images inline in reply for visual queries

- [#3148](https://github.com/Bike4Mind/bike4mind/pull/3148) [`baae0c8`](https://github.com/Bike4Mind/bike4mind/commit/baae0c8c658f31a98fbfce09aea2a83a16d87889) Thanks [@vinchi777](https://github.com/vinchi777)! - side-by-side finding review view

- [#3152](https://github.com/Bike4Mind/bike4mind/pull/3152) [`f80d464`](https://github.com/Bike4Mind/bike4mind/commit/f80d4642733eefccd6b273e7b8596035eb733b3d) Thanks [@vinchi777](https://github.com/vinchi777)! - scan inconsistencies on a schedule and persist findings as rows

- [#3153](https://github.com/Bike4Mind/bike4mind/pull/3153) [`9d995b5`](https://github.com/Bike4Mind/bike4mind/commit/9d995b5cb90c47453dc003629788314fc3c2661e) Thanks [@vinchi777](https://github.com/vinchi777)! - add curator merge, supersede and retag actions

- [#3191](https://github.com/Bike4Mind/bike4mind/pull/3191) [`f2f49db`](https://github.com/Bike4Mind/bike4mind/commit/f2f49dbfdda2b223c0c9bfd983f003d5637b3016) Thanks [@onoya](https://github.com/onoya)! - persist a curator's finding resolution as a lake belief

- [#3195](https://github.com/Bike4Mind/bike4mind/pull/3195) [`bef318c`](https://github.com/Bike4Mind/bike4mind/commit/bef318c78b56e34ab5c4b8f79a876a0d77f73479) Thanks [@onoya](https://github.com/onoya)! - capture real document vintage at ingest

- [#3213](https://github.com/Bike4Mind/bike4mind/pull/3213) [`46b4494`](https://github.com/Bike4Mind/bike4mind/commit/46b4494b60d5f961bca266304e119d08aa5f97ff) Thanks [@choyno](https://github.com/choyno)! - diff a lake's membership between two instants

- [#3221](https://github.com/Bike4Mind/bike4mind/pull/3221) [`0cc7540`](https://github.com/Bike4Mind/bike4mind/commit/0cc7540adeb1661e10cb24c57e716e6416932773) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add Claude Opus 5.5 (claude-opus-5-5) to ChatModels

- [#3244](https://github.com/Bike4Mind/bike4mind/pull/3244) [`250695d`](https://github.com/Bike4Mind/bike4mind/commit/250695d7f282ddfef87f2259d50cf9e706e328a8) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - show the stored tag breakdown on the org feedback summary

- [#3263](https://github.com/Bike4Mind/bike4mind/pull/3263) [`e5e3914`](https://github.com/Bike4Mind/bike4mind/commit/e5e391430b35b19b630dfea134a1915e3914f7d9) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add queryParams to EndpointContract

- [#3264](https://github.com/Bike4Mind/bike4mind/pull/3264) [`77a8559`](https://github.com/Bike4Mind/bike4mind/commit/77a85598922c4a09b28d68581260074ae64fe5bf) Thanks [@vinchi777](https://github.com/vinchi777)! - render an inline map for location-based search results

- [#3352](https://github.com/Bike4Mind/bike4mind/pull/3352) [`e8f6e3c`](https://github.com/Bike4Mind/bike4mind/commit/e8f6e3c3b41bbacf7f05f3029cbe35066e64b61e) Thanks [@chadyuson2](https://github.com/chadyuson2)! - store share links as an array, mirrored from the scalar

- [#3393](https://github.com/Bike4Mind/bike4mind/pull/3393) [`dd940f7`](https://github.com/Bike4Mind/bike4mind/commit/dd940f709ea10a20393cdaeb6f5a1b35b5d942b6) Thanks [@onoya](https://github.com/onoya)! - connect one GitHub repository to a data lake, read-only

### Patch Changes

- [#3000](https://github.com/Bike4Mind/bike4mind/pull/3000) [`1a1ade0`](https://github.com/Bike4Mind/bike4mind/commit/1a1ade073fd08cd23a93f28fe7c452390934a59e) Thanks [@dea0030](https://github.com/dea0030)! - attribute the tool_usage ledger row to the model that charged

- [#3095](https://github.com/Bike4Mind/bike4mind/pull/3095) [`57aa4cd`](https://github.com/Bike4Mind/bike4mind/commit/57aa4cdfa2cfdf8da565d06b97286a2b49343787) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - reconcile the org report and the personal rollup on one window

- [#3103](https://github.com/Bike4Mind/bike4mind/pull/3103) [`8da8172`](https://github.com/Bike4Mind/bike4mind/commit/8da8172b5e2b75f39aa9c1889f1c9a89f0a50173) Thanks [@dea0030](https://github.com/dea0030)! - render an omitted GPT-Image quality at the tier it bills

- [#3104](https://github.com/Bike4Mind/bike4mind/pull/3104) [`4f6bb28`](https://github.com/Bike4Mind/bike4mind/commit/4f6bb2897af5ba0301f118b99617bd13aa2f6716) Thanks [@vinchi777](https://github.com/vinchi777)! - gate approval-required tool calls before execution

- [#3111](https://github.com/Bike4Mind/bike4mind/pull/3111) [`312210a`](https://github.com/Bike4Mind/bike4mind/commit/312210a847ea3748a4b0f7a0e99b7d2fdc41aa2b) Thanks [@juicewaa](https://github.com/juicewaa)! - render public embed replies instead of empty text

- [#3125](https://github.com/Bike4Mind/bike4mind/pull/3125) [`1eaa5dc`](https://github.com/Bike4Mind/bike4mind/commit/1eaa5dc4a71a91911d0fb30def5de46d1a710150) Thanks [@vinchi777](https://github.com/vinchi777)! - preserve streamed text across a reopened thinking block

- [#3127](https://github.com/Bike4Mind/bike4mind/pull/3127) [`b5943fc`](https://github.com/Bike4Mind/bike4mind/commit/b5943fc377b3563359211bc64d242d27c455f23b) Thanks [@aflordelis](https://github.com/aflordelis)! - resolve the agentless tool union server-side

- [#3144](https://github.com/Bike4Mind/bike4mind/pull/3144) [`1e68664`](https://github.com/Bike4Mind/bike4mind/commit/1e6866430e93902f0e1dfa64aa138dedfcaa753b) Thanks [@poysama](https://github.com/poysama)! - await handlers before completing schedules

- [#3158](https://github.com/Bike4Mind/bike4mind/pull/3158) [`1b3627b`](https://github.com/Bike4Mind/bike4mind/commit/1b3627b78929c6ce18de724b07d8822133287a29) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - allowlist the slackSettings self-view rebuild

- [#3190](https://github.com/Bike4Mind/bike4mind/pull/3190) [`ab64edb`](https://github.com/Bike4Mind/bike4mind/commit/ab64edbbaa475b44fb7400a0b5e3fee16ad6f985) Thanks [@dea0030](https://github.com/dea0030)! - scope the edit-image mask lookup to the caller

- [#3217](https://github.com/Bike4Mind/bike4mind/pull/3217) [`32573fe`](https://github.com/Bike4Mind/bike4mind/commit/32573fef42d5e35e2b7569c567d96752a3cab0fe) Thanks [@vinchi777](https://github.com/vinchi777)! - attribute retrieval volume to the surface that ran

- [#3235](https://github.com/Bike4Mind/bike4mind/pull/3235) [`d12a958`](https://github.com/Bike4Mind/bike4mind/commit/d12a958bf4d933dbb90368ae70df81e8dc48e2a1) Thanks [@dea0030](https://github.com/dea0030)! - measure each dall-e tier against its own size list

- [#3245](https://github.com/Bike4Mind/bike4mind/pull/3245) [`1124e9a`](https://github.com/Bike4Mind/bike4mind/commit/1124e9a02c6826f985231e083047db14a4376db4) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - sync data lake storage counters on lifecycle sweeps

- [#3248](https://github.com/Bike4Mind/bike4mind/pull/3248) [`4dd4a83`](https://github.com/Bike4Mind/bike4mind/commit/4dd4a83b3e289a22758eeb263f4bf5f86f81e9e6) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - only extract tool artifacts from the tools that emit them

- [#3301](https://github.com/Bike4Mind/bike4mind/pull/3301) [`69b0b27`](https://github.com/Bike4Mind/bike4mind/commit/69b0b276012b7086ff0638888b95bc45a8f999de) Thanks [@dea0030](https://github.com/dea0030)! - show readable categories on source chips, not raw lake tag paths

- [#3303](https://github.com/Bike4Mind/bike4mind/pull/3303) [`387a876`](https://github.com/Bike4Mind/bike4mind/commit/387a8768355b571a62899cc823f2a8880c92d6e8) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - delete stored objects on whole-lake purge

- [#3312](https://github.com/Bike4Mind/bike4mind/pull/3312) [`428335f`](https://github.com/Bike4Mind/bike4mind/commit/428335fd995d74ed26e1d9bbab1a6a84e27342a9) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - correct required/nullable for coerced query params

- [#3329](https://github.com/Bike4Mind/bike4mind/pull/3329) [`d1f749e`](https://github.com/Bike4Mind/bike4mind/commit/d1f749e671f825f1631f7cb7081272a0cb6bdd90) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - stop artifact cards from rendering twice

- [#3330](https://github.com/Bike4Mind/bike4mind/pull/3330) [`d256617`](https://github.com/Bike4Mind/bike4mind/commit/d256617f418ae03e4db2459a8ef1a878098d11a8) Thanks [@julsanchez](https://github.com/julsanchez)! - re-check share permission and not-deleted at write time for sharee session writes

- [#3334](https://github.com/Bike4Mind/bike4mind/pull/3334) [`5fe5e01`](https://github.com/Bike4Mind/bike4mind/commit/5fe5e018dec86925650e1d1e06c307974593974e) Thanks [@onoya](https://github.com/onoya)! - order and label research judge models, validate levers, confirm delete

- [#3335](https://github.com/Bike4Mind/bike4mind/pull/3335) [`9c3d451`](https://github.com/Bike4Mind/bike4mind/commit/9c3d4516e3bbbe26c44887e9159420efa63bee20) Thanks [@vinchi777](https://github.com/vinchi777)! - fix proposal review copy, rationale, excerpts, and declined restore

- [#3365](https://github.com/Bike4Mind/bike4mind/pull/3365) [`a0f807c`](https://github.com/Bike4Mind/bike4mind/commit/a0f807ca795552fb2dfd2546774cf0911a313adf) Thanks [@erikbethke](https://github.com/erikbethke)! - render mermaid charts whose labels contain line breaks

- [#3397](https://github.com/Bike4Mind/bike4mind/pull/3397) [`7759faa`](https://github.com/Bike4Mind/bike4mind/commit/7759faaff96fc87926a604a1ff16e80506583a62) Thanks [@vinchi777](https://github.com/vinchi777)! - return 502/504 on source fetch timeouts and strip page chrome from titles

- [#3401](https://github.com/Bike4Mind/bike4mind/pull/3401) [`be2db69`](https://github.com/Bike4Mind/bike4mind/commit/be2db69ef7fba5d85121c016e140f77b64bb79c0) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - record research runs and reviews in history and spend

- [#3404](https://github.com/Bike4Mind/bike4mind/pull/3404) [`8da8278`](https://github.com/Bike4Mind/bike4mind/commit/8da8278053702e80311b3104b13a0689d6da4f10) Thanks [@onoya](https://github.com/onoya)! - report research judge failures honestly and disable profile-only Bedrock ids

## 11.0.0

### Major Changes

- [#3073](https://github.com/Bike4Mind/bike4mind/pull/3073) [`3f5f10f`](https://github.com/Bike4Mind/bike4mind/commit/3f5f10f92fa61cc3155dbd669608b3cc539c5c40) Thanks [@choyno](https://github.com/choyno)! - replace implicit draft-lake activation with explicit promote and demote

### Minor Changes

- [#2990](https://github.com/Bike4Mind/bike4mind/pull/2990) [`0b5b296`](https://github.com/Bike4Mind/bike4mind/commit/0b5b29675bd15a076e3a4cc721ef9bb5d657b54b) Thanks [@ken-b4m](https://github.com/ken-b4m)! - migrate the corpus to text-embedding-3-small, repair blank embedding labels, and refit the retrieval floors

- [#3015](https://github.com/Bike4Mind/bike4mind/pull/3015) [`38e6673`](https://github.com/Bike4Mind/bike4mind/commit/38e667337bd28b5b61dc7a1b635b9a25e6ee0df1) Thanks [@vinchi777](https://github.com/vinchi777)! - publish public GET /api/v1/me for tier, balance and entitlements

- [#3066](https://github.com/Bike4Mind/bike4mind/pull/3066) [`1295822`](https://github.com/Bike4Mind/bike4mind/commit/129582275b2f94d06a2009583a4a52519f74a3c7) Thanks [@dea0030](https://github.com/dea0030)! - accept up to 4 gpt-image reference images

- [#3072](https://github.com/Bike4Mind/bike4mind/pull/3072) [`044d447`](https://github.com/Bike4Mind/bike4mind/commit/044d447eeb24b1b1af3e532663c6486d49257ec3) Thanks [@onoya](https://github.com/onoya)! - give detected corpus problems a durable, triageable identity

- [#3074](https://github.com/Bike4Mind/bike4mind/pull/3074) [`0485840`](https://github.com/Bike4Mind/bike4mind/commit/0485840d81f1bbc2a2925099d57c1cf832b6ad4a) Thanks [@onoya](https://github.com/onoya)! - deep-link citations to the cited passage

- [#3076](https://github.com/Bike4Mind/bike4mind/pull/3076) [`db3408d`](https://github.com/Bike4Mind/bike4mind/commit/db3408dbcf750db35d815f74a435c2daa27ed3a0) Thanks [@jjmarfa](https://github.com/jjmarfa)! - give lake retrieval its own token bucket

- [#3081](https://github.com/Bike4Mind/bike4mind/pull/3081) [`8039f4c`](https://github.com/Bike4Mind/bike4mind/commit/8039f4cabc06a1d8fa07121e41736f2206e61a71) Thanks [@aflordelis](https://github.com/aflordelis)! - bound auto-tagging retries and price the credit pre-flight on notebooks that can be tagged

- [#3094](https://github.com/Bike4Mind/bike4mind/pull/3094) [`3720b09`](https://github.com/Bike4Mind/bike4mind/commit/3720b099adcc38f5e1d2592819088c15f7b41ce8) Thanks [@onoya](https://github.com/onoya)! - multi-select the data lakes a chat grounds on

### Patch Changes

- [#2827](https://github.com/Bike4Mind/bike4mind/pull/2827) [`254337c`](https://github.com/Bike4Mind/bike4mind/commit/254337c91edeefc41333a60559a15673411bea01) Thanks [@onoya](https://github.com/onoya)! - linearize the super-linear content parsers

- [#2848](https://github.com/Bike4Mind/bike4mind/pull/2848) [`c6c35c3`](https://github.com/Bike4Mind/bike4mind/commit/c6c35c3ac15cf06526b4503bf4a18cef7a929b30) Thanks [@choyno](https://github.com/choyno)! - surface the credit-exhaustion classifier and emit type on both chat surfaces

- [#2895](https://github.com/Bike4Mind/bike4mind/pull/2895) [`311f5cd`](https://github.com/Bike4Mind/bike4mind/commit/311f5cd69a083a3a0afc4c1a81602950086b8c83) Thanks [@aflordelis](https://github.com/aflordelis)! - consolidate OpenAI image size validation

- [#3016](https://github.com/Bike4Mind/bike4mind/pull/3016) [`27173c2`](https://github.com/Bike4Mind/bike4mind/commit/27173c2de2852fcd8f6f0b04a8b5f9281ae0016e) Thanks [@vinchi777](https://github.com/vinchi777)! - distinguish a derived output cap from a declared one

- [#3019](https://github.com/Bike4Mind/bike4mind/pull/3019) [`6481767`](https://github.com/Bike4Mind/bike4mind/commit/6481767f9507cf6f440f7e941c986762ef3079f0) Thanks [@vinchi777](https://github.com/vinchi777)! - mark degenerate-loop turns so they are not billed as clean successes

- [#3023](https://github.com/Bike4Mind/bike4mind/pull/3023) [`f96ee0a`](https://github.com/Bike4Mind/bike4mind/commit/f96ee0a3490e75881b69c4617dd3cca60bf120f9) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - let org members create and cancel org invites

- [#3025](https://github.com/Bike4Mind/bike4mind/pull/3025) [`886d895`](https://github.com/Bike4Mind/bike4mind/commit/886d8952c29b81a907fcf1455b0eb19ebd1313e1) Thanks [@aflordelis](https://github.com/aflordelis)! - persist summaryTrigger and align its enum with the values code produces

- [#3077](https://github.com/Bike4Mind/bike4mind/pull/3077) [`a27d416`](https://github.com/Bike4Mind/bike4mind/commit/a27d4169b82c17089b0a8c54106babe51dc66367) Thanks [@choyno](https://github.com/choyno)! - scheduled lake health sweep with fair per-run cap

- [#3087](https://github.com/Bike4Mind/bike4mind/pull/3087) [`919b705`](https://github.com/Bike4Mind/bike4mind/commit/919b7051c1ce4ae7552f93a7592e76a9727b2d0e) Thanks [@vinchi777](https://github.com/vinchi777)! - repoint What's New generation at the current repository

- [#3091](https://github.com/Bike4Mind/bike4mind/pull/3091) [`280ef10`](https://github.com/Bike4Mind/bike4mind/commit/280ef104977de1c415c5dabca67c6866887d6d27) Thanks [@vinchi777](https://github.com/vinchi777)! - stamp spider bulk summarizations with a distinct trigger

- [#3092](https://github.com/Bike4Mind/bike4mind/pull/3092) [`0192e3f`](https://github.com/Bike4Mind/bike4mind/commit/0192e3f70714d04a4f65f346a15145a581c80e26) Thanks [@vinchi777](https://github.com/vinchi777)! - honor configured Image Size for BFL Pro models

## 10.1.0

### Minor Changes

- [#2949](https://github.com/Bike4Mind/bike4mind/pull/2949) [`8e31cbf`](https://github.com/Bike4Mind/bike4mind/commit/8e31cbfad875f80f372f16032f487cde1e624ce1) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add an org-level feedback analysis report

### Patch Changes

- [#2977](https://github.com/Bike4Mind/bike4mind/pull/2977) [`4ce553e`](https://github.com/Bike4Mind/bike4mind/commit/4ce553ebc6d706aef224317811c004f64a8df5f3) Thanks [@dea0030](https://github.com/dea0030)! - bill 'auto' GPT-Image quality at the ceiling tier

- [#2981](https://github.com/Bike4Mind/bike4mind/pull/2981) [`3593192`](https://github.com/Bike4Mind/bike4mind/commit/3593192f407f6a1a337824d2d2b1d5e9d9065a8e) Thanks [@onoya](https://github.com/onoya)! - let tool narrowing reach MCP tools

- [#2991](https://github.com/Bike4Mind/bike4mind/pull/2991) [`f687f87`](https://github.com/Bike4Mind/bike4mind/commit/f687f87600e726f00d1a480d12b8e72bbe3f9691) Thanks [@dea0030](https://github.com/dea0030)! - bill edit-image for the one image it renders, not the requested n

- [#3022](https://github.com/Bike4Mind/bike4mind/pull/3022) [`34443c6`](https://github.com/Bike4Mind/bike4mind/commit/34443c6911e1e96197c2f1d6306fc3ebabde5153) Thanks [@onoya](https://github.com/onoya)! - follow effective ownership for lake memory shredding

## 10.0.0

### Major Changes

- [#2930](https://github.com/Bike4Mind/bike4mind/pull/2930) [`f3f76c2`](https://github.com/Bike4Mind/bike4mind/commit/f3f76c21ef2e882fad72db3f0f36c8c5e8113065) Thanks [@jarlacut](https://github.com/jarlacut)! - gate the remaining FabFile ingest doors

### Patch Changes

- [#2988](https://github.com/Bike4Mind/bike4mind/pull/2988) [`b8bd20d`](https://github.com/Bike4Mind/bike4mind/commit/b8bd20d40a1551f6b999cb84745a677984144916) Thanks [@ken-b4m](https://github.com/ken-b4m)! - pin memento embedding space and refit the 3-small floor

## 9.0.0

### Major Changes

- [#2932](https://github.com/Bike4Mind/bike4mind/pull/2932) [`4717962`](https://github.com/Bike4Mind/bike4mind/commit/4717962ddba858b806befe85578d29ac59c41e2f) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - owner-gate lake access widening and replace the invite bearer secret

### Minor Changes

- [#2916](https://github.com/Bike4Mind/bike4mind/pull/2916) [`1f4cf3e`](https://github.com/Bike4Mind/bike4mind/commit/1f4cf3e673a53ab86e7710e20a1bf031751aaf8f) Thanks [@onoya](https://github.com/onoya)! - lock the lake-reachability clause set and close two capture-harness gaps

- [#2921](https://github.com/Bike4Mind/bike4mind/pull/2921) [`c29a80d`](https://github.com/Bike4Mind/bike4mind/commit/c29a80d73048693e57572b20ba281185f795e5b6) Thanks [@vinchi777](https://github.com/vinchi777)! - pass background and output_format through for gpt-image

- [#2947](https://github.com/Bike4Mind/bike4mind/pull/2947) [`2c9221c`](https://github.com/Bike4Mind/bike4mind/commit/2c9221c0fca6903ff823b064627bb2100c696697) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add a personal, owner-scoped feedback rollup

### Patch Changes

- [#2389](https://github.com/Bike4Mind/bike4mind/pull/2389) [`9f936cd`](https://github.com/Bike4Mind/bike4mind/commit/9f936cd95670f4e4a254e457ccd5156da26e8242) Thanks [@julsanchez](https://github.com/julsanchez)! - confine dedicated-flow API keys to the routes that name their scope

- [#2866](https://github.com/Bike4Mind/bike4mind/pull/2866) [`a5dddf3`](https://github.com/Bike4Mind/bike4mind/commit/a5dddf329c18fb52da5c0b69ecb164c22cd006b6) Thanks [@vinchi777](https://github.com/vinchi777)! - document the chat quest error classifier

- [#2908](https://github.com/Bike4Mind/bike4mind/pull/2908) [`17daf4c`](https://github.com/Bike4Mind/bike4mind/commit/17daf4cfae91f1b83887ce05816446c5d4834ea3) Thanks [@aflordelis](https://github.com/aflordelis)! - declare taggedAt on the Session schema so it persists

- [#2917](https://github.com/Bike4Mind/bike4mind/pull/2917) [`8edb070`](https://github.com/Bike4Mind/bike4mind/commit/8edb070c37947550d9f1fcc2b06eda15069e93a4) Thanks [@onoya](https://github.com/onoya)! - route human-written help feedback into Feedback

- [#2920](https://github.com/Bike4Mind/bike4mind/pull/2920) [`abfce42`](https://github.com/Bike4Mind/bike4mind/commit/abfce420f22de9373d1104d88d3648b5281ac9c1) Thanks [@vinchi777](https://github.com/vinchi777)! - normalize multimodal content across providers

- [#2950](https://github.com/Bike4Mind/bike4mind/pull/2950) [`8c3870b`](https://github.com/Bike4Mind/bike4mind/commit/8c3870b58e57fa98f97672ea8c2dbedd4d4348a3) Thanks [@vinchi777](https://github.com/vinchi777)! - spend the search budget fairly across a session's lakes

- [#2951](https://github.com/Bike4Mind/bike4mind/pull/2951) [`d0ad77c`](https://github.com/Bike4Mind/bike4mind/commit/d0ad77cecbdace4bb0bdeb109aa754f76f1ee9f1) Thanks [@onoya](https://github.com/onoya)! - resolve every creator-provenance access arm through effective ownership

- [#2953](https://github.com/Bike4Mind/bike4mind/pull/2953) [`a09600c`](https://github.com/Bike4Mind/bike4mind/commit/a09600c89f6366a45990afa6cb45c789ba672c4d) Thanks [@vinchi777](https://github.com/vinchi777)! - gate forced retrieval on the turn's own score spread

## 8.0.0

### Major Changes

- [#2663](https://github.com/Bike4Mind/bike4mind/pull/2663) [`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - cascade revocations, cap re-shares, and gate the invite lifecycle

- [#2663](https://github.com/Bike4Mind/bike4mind/pull/2663) [`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - Second tranche of the sharing authorization cluster. A grant now means only what it says, and an
  entity that derives grants cleans them up when it goes away.

  Re-sharing is capped and gated at the invite door. An invite can no longer carry a permission its
  minter does not hold, so a sharee with `share` alone cannot mint `update`/`delete` and redeem the link on their own
  account; `@bike4mind/common` exports `heldPermissions` and `grantablePermissions` for that check.
  The cap uses the latter, which treats `share` as conveying `read`: minting an invite already
  requires share authority, and a collaborator granted share alone still has to be able to pass on
  the read that share implies. Flipping `isGlobalRead`/
  `isGlobalWrite` publishes a document to the whole instance, so it moves from the update predicate
  to the share predicate. Project invite listing moves to the share predicate too, since it exposes
  link-invite ids and pending invitees' email addresses. Accepting a session invite propagates a
  grant to an attached file only when the inviter holds share on that file, capped at what they hold;
  invites gain an optional `inviterId` to make that check possible, and a legacy invite without one
  falls back to propagating only to the session owner's own files.

  Revocation and deletion now cascade. The project-scoped revoke filter removed every entry carrying
  the target `projectId` rather than only the target user's, so one member leaving stripped every
  co-member's access. Deleting a project strips the grants it left on its files and sessions.
  Revoking a session share also removes the file grants acceptance materialized. Deleting a session
  hard-deletes only the owner's own files; an attached file owned by someone else loses the derived
  grant instead of being destroyed.

  A shared entry now records the grant's source, for sessions as well as projects. `pushShareable`
  keyed `users[]` on `userId` alone,
  so a file reached through two projects collapsed into one entry tagged with whichever project
  wrote last, while `revoke` filters on that tag: revoking via the earlier project matched nothing
  and returned the document as if it had succeeded, leaving access live, and revoking via the later
  one tore out the other project's grant as well. Entries are keyed on `(userId, projectId, sessionId)`,
  so each project's grant, each session's, and any direct share are separate rows, and a scoped revoke that matches no row now
  raises `NotFoundError` instead of reporting a success that removed nothing. No first-party caller passes a
  `projectId` except `revokeFromProject`'s own cascade, which swallows `NotFoundError` by design, but
  the `revokeSharing` route accepts one in its body - so a client that supplies a `projectId` matching
  none of the target's rows now gets a 404 instead of the broad revoke it probably meant. That is the
  fail-closed direction, and it is the point: the old behaviour reported success and removed nothing.
  Rows written before
  this change carry only the last project's tag; a scoped revoke against an earlier project hits the
  new not-found path, and revoking without a `projectId` still clears every row the user holds. A
  user may now legitimately hold several rows on one document, so the client-side permission helpers
  in `apps/client/app/utils/userPermission.ts` union across them instead of reading the first match,
  matching the `$elemMatch` predicates and `heldPermissions` server-side.

  The db-core CASL ability was missing `Project` from its shared user/group permission arm while the
  HTTP copy carried it, so a project shared with a user was unreachable through every caller that
  builds an ability from `@bike4mind/database` rather than `@server/auth/ability` (the quest,
  slack-quest, image-edit, image-generation and video-generation queue handlers). Both copies now
  grant the same resource set, and a structural test reads the two files and fails if they drift.

  An invite now records whether it names anybody. Project and Organization invites carry raw user
  ids (the add-members modals send `recipients: [userId]`), and `findAllByEmailsOrUsernames` queries
  email and username only, so their `recipients.pending` always persisted as `[]`. Every gate keyed
  on `pending.length` therefore fell open for exactly those two types: any authenticated caller
  holding the invite id could read its contents, and could accept it and join the project or
  organization with grants on every file and session inside. `createInvite` resolves id-shaped
  recipients through `findByIds` (a new requirement on its `users` adapter, alongside the
  `findAllByEmailsOrUsernames` and `findById` it already took), refuses to mint an invite whose
  recipients all fail to resolve, and persists an `isLinkOnly` flag; `canViewInvite` and the accept-time recipient gate key on that flag
  via `isLinkOnlyInvite` (`@bike4mind/common`) rather than on an empty `pending`. Invites minted
  before the flag fall back to inferring it, and only for FabFile and Session, whose recipients always
  did resolve to emails - so a legacy Project or Organization invite fails closed at both gates and
  has to be re-sent. A side effect worth knowing: organization seat accounting counts pending
  recipients, so it was undercounting and now holds.

  A session's knowledge propagation now tags the grants it mints, and both cascades key on that tag.
  `IUserShare` gains an optional `sessionId`, the counterpart to `projectId` for the other entity that
  derives grants, and `pushShareable` keys on all three. Untagged, a propagated file grant merged into
  any direct share of the same file to the same user - so unsharing the session deleted the merged row
  whole and destroyed a grant a third party had made. Reaching that row through the session also
  skipped the owner-or-self check a direct `revokeSharing` on the file would have applied, since the
  cascade writes `file.users` itself. Keying on the tag fixes both: a direct share is its own row and
  is never touched, and a tagged row can only have been written by an accept that already required the
  inviter to hold share on the file, so the tag _is_ the authorization. That retires the previous
  gate, which asked whether the SESSION OWNER could still share the file while the mint had asked
  about the INVITER - not the same principal whenever a sharee minted the invite, which stranded those
  grants un-revokable through the very path that created them.

  Grants written before the tag existed are untagged and so are not reachable from either cascade.
  This is under-revocation, and it is the safe direction to fail - the alternative is the third-party
  destruction above - but it is not costless, and the honest statement of the residue is narrower than
  "revoke it on the file instead". Where the session owner does not own the file, they have no
  surface at all: an unscoped revoke on the file is owner-or-self, so only the file's owner or the
  grant holder can clear it, and neither of them is the person who wanted the access gone. No backfill closes this from
  code alone: an untagged row is indistinguishable from the direct share this change exists to
  protect, so tagging it re-creates the bug and adding a second tagged row leaves the untagged one
  live. Reconstructing provenance from accepted-invite history does not substitute, because a grant
  outlives the invite that created it and can predate the address it would be keyed on; a gate on the
  session owner holding `share` authorizes the wrong principal, since the mint reads the inviter. It is
  not a regression either - before this change neither cascade existed at all, so those rows were
  already unreachable from this surface. The gap shrinks as legacy grants are revoked on the file. Closing
  the rest is tracked as its own follow-up, `sharing: owner-facing surface to list and clear untagged
grant rows`, which is a UI plus a scoped revoke endpoint rather than a backfill that guesses at
  provenance.

  Deleting a session cascades before it tombstones. The tombstone came first while the per-file grant
  rewrite came second, and `softDeletePlugin` puts `deletedAt: null` on every `findOne` - so a failure
  mid-cascade left the session unreachable on a retry with the remaining grants live and nothing left
  to clear them. The cascade now runs first, and both live entry points - `DELETE /api/sessions/[id]` and the bulk
  route - wrap each call in a transaction, so a concurrency conflict partway through rolls back rather
  than leaving some files rewritten and some not; that matches the `revokeSharing` route, which
  already wrapped the sibling cascade. The bulk route wraps per session rather than around its loop,
  because it is best-effort: one session failing must not roll back the ones already deleted.

  What that cascade touches, precisely: rows tagged with this session, on the union of files uploaded
  into it and files named in `knowledgeIds` (neither set contains the other), for every grantee rather
  than only the deleter, skipping files the deleter owns because those are deleted moments later and a
  guarded write on them can abort the delete for nothing. That delete is `deleteManyInIds`, the
  soft-delete plugin's tombstone path rather than a hard delete, so the skipped rows survive on the
  tombstoned document; no read path reaches them, since every FabFile aggregate filters `deletedAt`
  and none projects `users`, and the one `includeDeleted` read that returns `users[]` is admin-only. Its reach is bounded by `knowledgeIds` as of the call, which is
  client-writable, so a sharee holding update on the session can detach a file first and keep the
  grant; closing that needs a `users.sessionId` sweep across a high-cardinality collection and is not
  paid here. Both new whole-document grant writes, here and in the session knowledge-file cascade,
  take `updateGuarded` rather than `update`, joining the optimistic-concurrency convention the revoke
  path already uses. Mint paths still use a plain `update`; guarding those remains a separate change.

  Deleting a project revokes the owner's own derived grants. `addFiles`/`addSessions` mint the project
  owner a `projectId`-scoped read+update grant on content a MEMBER contributes, but the owner is never
  in `project.users`, so the per-member cascade never reached those and they outlived the only surface
  that could revoke them. Making that pass reachable meant taking a hidden mutation out of
  `revokeFromProject`: it pruned the caller's live `project.fileIds`/`sessionIds` as it went, so by the
  time the owner pass ran, the member-owned documents carrying the owner's grants had already been
  removed from the list it reads. It now returns the pruned ids and leaves the caller's document alone.
  `leaveProject` and the project arm of `revoke` assign the return; `deleteProject` drops it, so a
  tombstoned project still records what it held for restore and audit to read.

  The legacy link-only inference reads all three recipient buckets, and is permanent: rows minted
  before `isLinkOnly` existed never gain the flag, so the fork stays until none are left. Its safety
  also depends on `remaining`, which is documented at the predicate rather than left implied. Accepting and declining both move
  an address out of `pending`, so unioning only `pending` and `accepted` made a pre-flag invite whose
  named recipients had all declined infer as a share link - opening the view gate to any authenticated
  caller and letting anyone redeem it. `refused` is unioned too.

  An invite of a type that is not shareable by link can no longer be minted with no recipients. Only
  FabFile and Session are: for Project and Organization an empty list would otherwise persist
  `isLinkOnly: true` and be redeemable by anyone holding the id, and for Group it persisted
  `isLinkOnly: false` against an empty `pending`, which both the view gate and the accept gate then
  refuse - a row that minted successfully and nobody could ever redeem. The refusal is expressed
  against the same predicate that sets the flag, so the two cannot drift apart. `InviteType.Tool` has
  no arm in `createInvite`'s switch and still fails earlier, on `Document not found`. A Group invite
  naming only recipients that fail to resolve is refused too, matching the Project/Organization arm
  that already did: it persisted a row both gates then refuse, while telling the sharer it worked.

  The CASL share arm is now one exported function, `applySharedShareableRules`, called by both ability
  builders instead of being hand-copied. Each caller still passes its own resource list, because CASL
  matches subjects by constructor and a shared list would close over db-core's models; list drift is
  what the structural test compares, and body drift is no longer possible. `findAllAccessibleByIds`
  declares the `Pick<IUserDocument, 'id' | 'groups'>` it actually consumes, which removes two casts at
  the `createProject` call site. Its sibling `findAllUpdateAccessByIds` still takes a full
  `IUserDocument` and is unchanged here.
  `GET /api/invites/[id]` screens the id shape before `findById` and answers a malformed id with the
  same 404 as a missing or unauthorized one, so the status never tells a caller which ids exist.
  The `backfill-invite-inviter-id` migration backfills `Invite.inviterId` from the username every
  invite already persists, which is the closing move for the legacy propagation fallback in
  `accept.ts`. It scans on an `_id` cursor rather than loading the whole matching set at once, since
  invites are one of the higher-cardinality collections. Because `username` is mutable and the only
  reader of `inviterId` is an authorization gate, the backfill is narrowed twice: to Session invites,
  the only type that gate runs for, and to resolutions where the account still OWNS the target
  session. Not merely holds a grant on it: minting a Session invite is owner-only, so a sharee can
  never be the inviter, and admitting grant holders would readmit the squatter case the narrowing
  exists to exclude. A rename-then-reuse resolves to exactly one account, so the
  ambiguity guard never fires on it; anything uncorroborated stays on the conservative fallback, which
  is strictly safer than attributing the invite to the wrong person. `SkillShareDialog`, the surface that actually
  flips `isGlobalRead`/`isGlobalWrite`, reports the server's reason instead of a fixed string, so a
  holder refused by the predicate this change moves can tell that apart from a network failure.

  Cancelling one named recipient by email clamps `remaining` to the addresses still pending instead of
  decrementing it. The two gates that let anyone holding an invite id read and redeem it treat an
  invite naming nobody as a share link, and on a row minted before `isLinkOnly` existed that is
  inferred from the recipient buckets - so `remaining` reaching zero is what stops a cancelled named
  invite becoming a live link. A decrement only matched the address count while `remaining` started
  equal to it, and `available` in the create body is taken at face value, so a row naming one person
  with five slots kept four of them after that person was cancelled.

  `POST /api/projects` no longer turns a typed service error into a 500. `createProject` raises
  `BadRequestError` when a supplied file or notebook does not resolve through the caller's access
  predicate, which the client hits whenever a pick is revoked between select and submit; the route's
  catch rewrapped every non-duplicate-key error as `InternalServerError`, so that 400 reached the
  client as a 500. `GET /api/[type]/[id]` now strips co-recipients' addresses from the response, the
  last invitee-facing route that was returning the whole recipient list to one named recipient.

  Invite redemption enforces `expiresAt` on both accept and refuse. Declining now affects only the
  decliner's own slot: one recipient declining used to zero the invite for every other recipient, and
  any holder of a link id could do the same. Whole-invite revocation requires the same authority
  `cancelInviteById` enforces. `GET /api/invites/[id]` and `GET /api/[type]/[id]` no longer return an
  invite's contents to any authenticated caller holding the id; a caller who fails the gate gets 404,
  not 403, so the response does not confirm the id exists.

  Ids supplied by the caller are resolved before they are persisted. Project creation and
  `addSessions` write only the ids that resolved through the caller's access predicate, so a project
  can no longer carry a file or notebook the creator cannot reach. The favorites list intersects
  against currently-held access rather than trusting the stored row, so a notebook stops appearing
  once its share is revoked.

  Breaking, in `@bike4mind/services`: `createProject` takes the acting user (`Pick<IUserDocument,
'id' | 'groups'>`) instead of a bare user id, and requires `fabFiles` and `sessions` adapters;
  `refuseWholeInvite` takes a full `IUserDocument` and the adapters `authorizeByInviteType` needs;
  `deleteProject` requires `sessions`, `fabFiles` and `users` adapters to run its cascade;
  `revokeFromProject` returns `{ fileIds, sessionIds }` and no longer writes them back onto the
  `project` it was handed, so a caller that relied on the mutation must assign the return itself. In
  `@bike4mind/common`, `IUserShare` gains an optional `sessionId`, and any code that reads `users[]`
  must treat a row carrying it as distinct from an untagged row for the same user.

### Minor Changes

- [#2853](https://github.com/Bike4Mind/bike4mind/pull/2853) [`7bd1432`](https://github.com/Bike4Mind/bike4mind/commit/7bd143228cbc2b9be3434ad8d795c2ae76623241) Thanks [@onoya](https://github.com/onoya)! - correct and retry

### Patch Changes

- [#2719](https://github.com/Bike4Mind/bike4mind/pull/2719) [`718232a`](https://github.com/Bike4Mind/bike4mind/commit/718232ac8b73f441d39cbf74041f3a06316a7248) Thanks [@vinchi777](https://github.com/vinchi777)! - gate self-host OpenSearch retrieval on confirmed index residency

- [#2788](https://github.com/Bike4Mind/bike4mind/pull/2788) [`c619705`](https://github.com/Bike4Mind/bike4mind/commit/c619705a92c6cbbb614b893caee446ae868beab2) Thanks [@onoya](https://github.com/onoya)! - stop a vectorize resume from splitting a file across two embedding spaces

- [#2862](https://github.com/Bike4Mind/bike4mind/pull/2862) [`b9bc64a`](https://github.com/Bike4Mind/bike4mind/commit/b9bc64a4291420be50017fb34c1dc80f92e64c89) Thanks [@onoya](https://github.com/onoya)! - report a declared scope rung the caller's scope cannot key

- [#2875](https://github.com/Bike4Mind/bike4mind/pull/2875) [`d6cd7dd`](https://github.com/Bike4Mind/bike4mind/commit/d6cd7dddabe0428fee52db8fc33d045461ae4c79) Thanks [@dea0030](https://github.com/dea0030)! - constrain promptMeta.model.type at the completion write path

- [#2888](https://github.com/Bike4Mind/bike4mind/pull/2888) [`5d79949`](https://github.com/Bike4Mind/bike4mind/commit/5d7994926622a7af9d6aa38d8e547e014d3838ac) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - surface the sources a discovery run skipped

- [#2894](https://github.com/Bike4Mind/bike4mind/pull/2894) [`d086ed5`](https://github.com/Bike4Mind/bike4mind/commit/d086ed5f0049fea32dd03034fe8f084c600b5bd7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - treat a cleared numeric admin field as unset, not zero

- [#2904](https://github.com/Bike4Mind/bike4mind/pull/2904) [`b91b853`](https://github.com/Bike4Mind/bike4mind/commit/b91b853a865f8f1cf5ab417ade6fac88184886c2) Thanks [@vinchi777](https://github.com/vinchi777)! - stop gating read-only tools in agent mode, and make session approvals stick

- [#2909](https://github.com/Bike4Mind/bike4mind/pull/2909) [`91a73c9`](https://github.com/Bike4Mind/bike4mind/commit/91a73c9b9494408f126d267e859f9a9629e6e126) Thanks [@vinchi777](https://github.com/vinchi777)! - type the completions SSE error classifier and emit it mid-stream

- [#2913](https://github.com/Bike4Mind/bike4mind/pull/2913) [`13e0733`](https://github.com/Bike4Mind/bike4mind/commit/13e0733c9faf196143a79225d4bcd74623f36dee) Thanks [@vinchi777](https://github.com/vinchi777)! - honor the artifact opt-out on the chat persistence path

## 7.5.0

### Minor Changes

- [#2720](https://github.com/Bike4Mind/bike4mind/pull/2720) [`40f31bd`](https://github.com/Bike4Mind/bike4mind/commit/40f31bd9c9f63e6a2db9d5569222145c84fa46a0) Thanks [@vinchi777](https://github.com/vinchi777)! - add a /feedback slash command for session-level reports

### Patch Changes

- [#2797](https://github.com/Bike4Mind/bike4mind/pull/2797) [`bf76770`](https://github.com/Bike4Mind/bike4mind/commit/bf7677008efbd820c9d235e1cbad8a7797fbd4b4) Thanks [@juicewaa](https://github.com/juicewaa)! - let non-admin routes own the 404 for a malformed resource id

## 7.4.0

### Minor Changes

- [#2819](https://github.com/Bike4Mind/bike4mind/pull/2819) [`6f662d8`](https://github.com/Bike4Mind/bike4mind/commit/6f662d81308d53bb430665ed048607da97c4e9ef) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - send a per-visit session id, and count anonymous visits

### Patch Changes

- [#2782](https://github.com/Bike4Mind/bike4mind/pull/2782) [`7a214d5`](https://github.com/Bike4Mind/bike4mind/commit/7a214d5aa0fb5aa65302f887a3fac356ab3dc8ca) Thanks [@onoya](https://github.com/onoya)! - end a departing member's lake access, and pass on lakes they created

- [#2833](https://github.com/Bike4Mind/bike4mind/pull/2833) [`46ea8e1`](https://github.com/Bike4Mind/bike4mind/commit/46ea8e1efc42e992ebc0a19c4542f65d2665832c) Thanks [@onoya](https://github.com/onoya)! - bound oversized structured inputs before allocation and decode

- [#2842](https://github.com/Bike4Mind/bike4mind/pull/2842) [`068e14f`](https://github.com/Bike4Mind/bike4mind/commit/068e14f2ab9e45cb7e7cecbae8a49fca1ce85dc6) Thanks [@choyno](https://github.com/choyno)! - validate requiredUserTag as a single matchable tag

- [#2844](https://github.com/Bike4Mind/bike4mind/pull/2844) [`fa08028`](https://github.com/Bike4Mind/bike4mind/commit/fa08028c91136b4f051a45bc4976a7714677f845) Thanks [@choyno](https://github.com/choyno)! - surface lake status on computeLakeHealth so a non-active lake cannot read healthy

- [#2861](https://github.com/Bike4Mind/bike4mind/pull/2861) [`0a4253e`](https://github.com/Bike4Mind/bike4mind/commit/0a4253e4f31492b6fea19976a469ffd5e79f4af9) Thanks [@vinchi777](https://github.com/vinchi777)! - report lake lifecycle status in lake health

- [#2865](https://github.com/Bike4Mind/bike4mind/pull/2865) [`6ce4b99`](https://github.com/Bike4Mind/bike4mind/commit/6ce4b99b9ab5d4fe8142647a9b3dcef6f0c8ebfd) Thanks [@vinchi777](https://github.com/vinchi777)! - stop a failing cluster starving the rescue sweep

## 7.3.0

### Minor Changes

- [#2812](https://github.com/Bike4Mind/bike4mind/pull/2812) [`fee546f`](https://github.com/Bike4Mind/bike4mind/commit/fee546f162297fbd3cf5acdb41b71906bdabab46) Thanks [@maconard](https://github.com/maconard)! - restore DeepSeek V4 Pro

### Patch Changes

- [#2783](https://github.com/Bike4Mind/bike4mind/pull/2783) [`5e1eee0`](https://github.com/Bike4Mind/bike4mind/commit/5e1eee08f765b93a1c30160c03858e7c5e9fd798) Thanks [@onoya](https://github.com/onoya)! - verify membership and roster authority at every use site

- [#2828](https://github.com/Bike4Mind/bike4mind/pull/2828) [`2922d00`](https://github.com/Bike4Mind/bike4mind/commit/2922d0061d5ee3673da2a3b9bd88f11b7005e5db) Thanks [@onoya](https://github.com/onoya)! - let a caller rung only raise the search serve budget

- [#2832](https://github.com/Bike4Mind/bike4mind/pull/2832) [`afba631`](https://github.com/Bike4Mind/bike4mind/commit/afba6315105929e9b39672a2d0d23caad7f8e4aa) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - merge or drop near-empty chunks from SmartChunker

## 7.2.2

### Patch Changes

- [#2765](https://github.com/Bike4Mind/bike4mind/pull/2765) [`2298140`](https://github.com/Bike4Mind/bike4mind/commit/229814036a13097cae1cd3ccc19d052d4d6c17f9) Thanks [@onoya](https://github.com/onoya)! - resolve search budgets on the caller scope in the semantic-search route

## 7.2.1

### Patch Changes

- [#2796](https://github.com/Bike4Mind/bike4mind/pull/2796) [`8ef2c17`](https://github.com/Bike4Mind/bike4mind/commit/8ef2c17f7b54b0df8c3809f17a62544784e65029) Thanks [@onoya](https://github.com/onoya)! - derive the scoped-retrieval Lake-rung guard from the reads' own key lists

## 7.2.0

### Minor Changes

- [#2738](https://github.com/Bike4Mind/bike4mind/pull/2738) [`a756c37`](https://github.com/Bike4Mind/bike4mind/commit/a756c379f89401a9cfefc41735df4610dd5da0ce) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - add an overwatch:read scope for agent-held credentials

- [#2762](https://github.com/Bike4Mind/bike4mind/pull/2762) [`adc900a`](https://github.com/Bike4Mind/bike4mind/commit/adc900ab152e00d3324bc228ac73c98a5cb5e2ef) Thanks [@maconard](https://github.com/maconard)! - add DeepSeek as a first-party provider and close Moonshot gaps

- [#2773](https://github.com/Bike4Mind/bike4mind/pull/2773) [`b660460`](https://github.com/Bike4Mind/bike4mind/commit/b6604604904ae62ab4c6745ec4e2335e05706e68) Thanks [@vinchi777](https://github.com/vinchi777)! - record which lake prompts the owner/curator grant arm admitted

### Patch Changes

- [#2513](https://github.com/Bike4Mind/bike4mind/pull/2513) [`b5c25db`](https://github.com/Bike4Mind/bike4mind/commit/b5c25db2ff248dd7491f7c263ae69cd1aaf23eca) Thanks [@julsanchez](https://github.com/julsanchez)! - verify session ownership before acting on session-scoped routes

- [#2682](https://github.com/Bike4Mind/bike4mind/pull/2682) [`f6407e2`](https://github.com/Bike4Mind/bike4mind/commit/f6407e27d91175446e28246e1234d4c0a409c694) Thanks [@onoya](https://github.com/onoya)! - fall back to a keyless Bedrock embedder when no provider credential resolves

- [#2758](https://github.com/Bike4Mind/bike4mind/pull/2758) [`0a931d2`](https://github.com/Bike4Mind/bike4mind/commit/0a931d25ddbfc35963f82f1bb6ea26b89a10f39e) Thanks [@onoya](https://github.com/onoya)! - resolve cosine relevance floors per embedding space

- [#2759](https://github.com/Bike4Mind/bike4mind/pull/2759) [`671c753`](https://github.com/Bike4Mind/bike4mind/commit/671c753fc81d65561729f591bc7038e4c605126c) Thanks [@onoya](https://github.com/onoya)! - report unmeasured lake members as unmeasured, and disclose the corpus-scope gap

- [#2775](https://github.com/Bike4Mind/bike4mind/pull/2775) [`36fae3b`](https://github.com/Bike4Mind/bike4mind/commit/36fae3b0e2a448442c65b83735de0406ed233370) Thanks [@vinchi777](https://github.com/vinchi777)! - record the resolved lake scope at the retrieval seed site

## 7.1.1

### Patch Changes

- [#2723](https://github.com/Bike4Mind/bike4mind/pull/2723) [`7958ee1`](https://github.com/Bike4Mind/bike4mind/commit/7958ee13d277295ed9877a24686aa266265a727f) Thanks [@vinchi777](https://github.com/vinchi777)! - harden the embedding-comparison harness before the credentialed run

## 7.1.0

### Minor Changes

- [#2465](https://github.com/Bike4Mind/bike4mind/pull/2465) [`576f59f`](https://github.com/Bike4Mind/bike4mind/commit/576f59f9cb237c473c2793e72cd33e1648f12327) Thanks [@onoya](https://github.com/onoya)! - per-document search cap + rescue sweep metrics ([#1422](https://github.com/Bike4Mind/bike4mind/issues/1422))

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

- [#2459](https://github.com/Bike4Mind/bike4mind/pull/2459) [`872164a`](https://github.com/Bike4Mind/bike4mind/commit/872164aef40a5fc24673a0c0a6ced35c97be36e2) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - Content mutations now resolve through the update-level share predicate rather than the read-level
  one, so a `read` grant on a notebook, file or project authorizes viewing it and nothing more.
  Affected paths: `updateFabFile` and `toggleTags` (file bytes, metadata and tags),
  `addSystemPrompts`, `addFiles` and `removeSystemPrompts` (project content), the chat-completion
  entry point (which appends to the notebook it runs against), and
  `PUT /api/sessions/[id]/chat/[messageId]`. A sharee who previously edited shared content while
  holding only `read` now needs `update`; project-derived grants already carry `[read, update]` and
  are unaffected.

  `IShareableStaticMethods` gains a required `findAllUpdateAccessByIds`, the batch counterpart to
  `findUpdateAccessById`, implemented by `ShareableDocumentRepository` - an out-of-tree implementer
  of that interface must add it. `@bike4mind/common` also exports `canUpdateShareable`, an
  update-level predicate for the call sites that already hold the document and so cannot re-resolve
  it through the repository.

  `DELETE /api/files` no longer hard-deletes files owned by other users that happen to be shared in
  with a delete grant: those lose the caller's grant instead, and only the caller's own files (and
  their stored bytes) are destroyed.

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

- [#2656](https://github.com/Bike4Mind/bike4mind/pull/2656) [`466e5a9`](https://github.com/Bike4Mind/bike4mind/commit/466e5a9b2ed4276f8886faec3aea42ff8484434b) Thanks [@julsanchez](https://github.com/julsanchez)! - expose ConcurrencyConflictError, isConcurrencyConflictError, and the opt-in IBaseRepository.updateGuarded from @bike4mind/common

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

- [#2081](https://github.com/Bike4Mind/bike4mind/pull/2081) [`214d076`](https://github.com/Bike4Mind/bike4mind/commit/214d076194b7b5792af4011b29a9d071c7b7a35e) Thanks [@biletskiy6](https://github.com/biletskiy6)! - make delegation denials durable across continuations and dispatched children

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

- [#2458](https://github.com/Bike4Mind/bike4mind/pull/2458) [`b8c6d29`](https://github.com/Bike4Mind/bike4mind/commit/b8c6d290a814bdf7e9cc04eb2c90c970d53976df) Thanks [@jjmarfa](https://github.com/jjmarfa)! - flag cross-document retrieval conflicts for the model

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
