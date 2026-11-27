# @bike4mind/sdk

## 6.3.0

### Minor Changes

- [#8602](https://github.com/Bike4Mind/bike4mind/pull/8602) [`36528fc`](https://github.com/Bike4Mind/bike4mind/commit/36528fc1f58b57e3df068623182179f189a544a4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - hold the block-end push when the user muted agent run updates

## 6.2.1

### Patch Changes

- [#8753](https://github.com/Bike4Mind/bike4mind/pull/8753) [`cce8f4c`](https://github.com/Bike4Mind/bike4mind/commit/cce8f4ce0b2912a23d561d1e12145cf03a1aef4d) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - tighten response fields for viewers of shared notebooks

## 6.2.0

### Minor Changes

- [#8723](https://github.com/Bike4Mind/bike4mind/pull/8723) [`e1dee9d`](https://github.com/Bike4Mind/bike4mind/commit/e1dee9da4be4aef95f2efacd97cc022c0b5c7273) Thanks [@onoya](https://github.com/onoya)! - sync web notebooks from a change feed instead of a full re-list

### Patch Changes

- [#8705](https://github.com/Bike4Mind/bike4mind/pull/8705) [`2461e22`](https://github.com/Bike4Mind/bike4mind/commit/2461e2267ee7583121e554393aba27126cdccd70) Thanks [@vinchi777](https://github.com/vinchi777)! - require matching API key scopes on artifact, notebook, lake and integration routes

## 6.1.0

### Minor Changes

- [#8408](https://github.com/Bike4Mind/bike4mind/pull/8408) [`6afd4ea`](https://github.com/Bike4Mind/bike4mind/commit/6afd4eab8bb90acbfeec78b4eed9058a60198bc2) Thanks [@dea0030](https://github.com/dea0030)! - report a step total on agent executions so clients can show real progress

- [#8497](https://github.com/Bike4Mind/bike4mind/pull/8497) [`8623a01`](https://github.com/Bike4Mind/bike4mind/commit/8623a0113b7909e3ce148e9396bf6d97c09ab7b4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - voice memo to drafted follow-up and reminders

- [#8537](https://github.com/Bike4Mind/bike4mind/pull/8537) [`a11c0cf`](https://github.com/Bike4Mind/bike4mind/commit/a11c0cf401247443a6376e5b79d6900a0f86a213) Thanks [@maconard](https://github.com/maconard)! - pin data files to a saved function

## 6.0.0

### Major Changes

- [#8557](https://github.com/Bike4Mind/bike4mind/pull/8557) [`862fa66`](https://github.com/Bike4Mind/bike4mind/commit/862fa66be1993684c7d6610daef38970456b04fe) Thanks [@wescarda](https://github.com/wescarda)! - remove the v4 QuestMaster chat-plan path and its questmasterplans readers

### Minor Changes

- [#8515](https://github.com/Bike4Mind/bike4mind/pull/8515) [`aac27dd`](https://github.com/Bike4Mind/bike4mind/commit/aac27ddd6b392a7464e18a1d986bb818c69788dc) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - scan a document and hand it to the assistant

- [#8521](https://github.com/Bike4Mind/bike4mind/pull/8521) [`47f5337`](https://github.com/Bike4Mind/bike4mind/commit/47f53374181e4612f0c166ca428c85ce44059c8d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - calendar-aware brief when a busy block ends

## 5.1.0

### Minor Changes

- [#7845](https://github.com/Bike4Mind/bike4mind/pull/7845) [`f28a090`](https://github.com/Bike4Mind/bike4mind/commit/f28a090645ff945d019aa62d5719b0998282538a) Thanks [@onoya](https://github.com/onoya)! - charge paid tool calls to an orchestration run budget

- [#8014](https://github.com/Bike4Mind/bike4mind/pull/8014) [`5e1ddd9`](https://github.com/Bike4Mind/bike4mind/commit/5e1ddd92ad5c2beba33bf62f78462ec80961d67d) Thanks [@jebie](https://github.com/jebie)! - share-sheet delegation to the assistant

- [#8276](https://github.com/Bike4Mind/bike4mind/pull/8276) [`3d1cd9b`](https://github.com/Bike4Mind/bike4mind/commit/3d1cd9b781fcd8ddf72ef2e3249f444bb3b367c0) Thanks [@vinchi777](https://github.com/vinchi777)! - add budgeted live orchestration evaluation

- [#8371](https://github.com/Bike4Mind/bike4mind/pull/8371) [`49327ae`](https://github.com/Bike4Mind/bike4mind/commit/49327aeddd54a337a934c6e54300422c953cc01c) Thanks [@onoya](https://github.com/onoya)! - account for credit expiry in the credits runway

- [#8380](https://github.com/Bike4Mind/bike4mind/pull/8380) [`0efae7c`](https://github.com/Bike4Mind/bike4mind/commit/0efae7cdb2551dc0ece4ffe9ea335acf42222ea0) Thanks [@maconard](https://github.com/maconard)! - public functions API with invoke, a confined scope, and stamped results

- [#8406](https://github.com/Bike4Mind/bike4mind/pull/8406) [`4625562`](https://github.com/Bike4Mind/bike4mind/commit/4625562326fb3ce70d1553ba64eefd98ee14fe91) Thanks [@onoya](https://github.com/onoya)! - let a signed-in caller choose the paying organization

- [#8436](https://github.com/Bike4Mind/bike4mind/pull/8436) [`88f0eed`](https://github.com/Bike4Mind/bike4mind/commit/88f0eed44cc701cea5b1f08e58e43616b1e922b0) Thanks [@ken-b4m](https://github.com/ken-b4m)! - undo a lake change through the public API and MCP

- [#8465](https://github.com/Bike4Mind/bike4mind/pull/8465) [`8ba6c23`](https://github.com/Bike4Mind/bike4mind/commit/8ba6c23d597ff8dfdf966418b1b1818dbe3592a3) Thanks [@maconard](https://github.com/maconard)! - asynchronous function calls for runs longer than a request can wait

## 5.0.0

### Major Changes

- [#7938](https://github.com/Bike4Mind/bike4mind/pull/7938) [`1295bcd`](https://github.com/Bike4Mind/bike4mind/commit/1295bcd011a07cec007b56a83d230c3c42d9ffce) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - act on a brief's decisions and see their live state

### Minor Changes

- [#7654](https://github.com/Bike4Mind/bike4mind/pull/7654) [`fd9de24`](https://github.com/Bike4Mind/bike4mind/commit/fd9de24313e367c7628fcf1a7e012078e9dd966a) Thanks [@vinchi777](https://github.com/vinchi777)! - add directed cross-device conversation handoff

- [#7696](https://github.com/Bike4Mind/bike4mind/pull/7696) [`e714dce`](https://github.com/Bike4Mind/bike4mind/commit/e714dce3a4a9382d31070cd3e816a3e55339dfd4) Thanks [@onoya](https://github.com/onoya)! - enforce a shared credit budget per completion run

- [#7737](https://github.com/Bike4Mind/bike4mind/pull/7737) [`bd907dd`](https://github.com/Bike4Mind/bike4mind/commit/bd907ddaf1c3e6f52038dc08886ee8b59362bba1) Thanks [@onoya](https://github.com/onoya)! - spending freeze for users, organizations and API keys

- [#7780](https://github.com/Bike4Mind/bike4mind/pull/7780) [`bc85682`](https://github.com/Bike4Mind/bike4mind/commit/bc856822c520818caa33f5e726e3abfc3cd41369) Thanks [@onoya](https://github.com/onoya)! - compose and serve assistant briefs with a brief_ready push

- [#7849](https://github.com/Bike4Mind/bike4mind/pull/7849) [`11494a0`](https://github.com/Bike4Mind/bike4mind/commit/11494a0c114a597c536351a746ae08549aa935a3) Thanks [@onoya](https://github.com/onoya)! - export Productions to MP4 with an ffmpeg render worker and multi-size export pack

- [#7862](https://github.com/Bike4Mind/bike4mind/pull/7862) [`f12e1d8`](https://github.com/Bike4Mind/bike4mind/commit/f12e1d83a1b04935da3aa7ab1bc6d6f05fbbe5bf) Thanks [@onoya](https://github.com/onoya)! - add an assistant director to Productions

- [#7880](https://github.com/Bike4Mind/bike4mind/pull/7880) [`0fe8a0c`](https://github.com/Bike4Mind/bike4mind/commit/0fe8a0c9288b97e98fe011157ac30137509c56c8) Thanks [@onoya](https://github.com/onoya)! - add the versioned image job API and deprecate the quest image routes

- [#7919](https://github.com/Bike4Mind/bike4mind/pull/7919) [`74e981f`](https://github.com/Bike4Mind/bike4mind/commit/74e981ff2c4858f75b2792dca0578228a6715bda) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - triage analyzed emails into decisions, handled and FYI items

- [#7923](https://github.com/Bike4Mind/bike4mind/pull/7923) [`4fcc398`](https://github.com/Bike4Mind/bike4mind/commit/4fcc398c95abebf74bedbf405c118ef224575995) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - scheduled brief delivery on a user-chosen time and days

- [#7950](https://github.com/Bike4Mind/bike4mind/pull/7950) [`8b06612`](https://github.com/Bike4Mind/bike4mind/commit/8b0661274bb784d7e2c7e5596b4bc0c13412cd6e) Thanks [@poysama](https://github.com/poysama)! - classify a moderated chat turn as content_blocked

- [#7971](https://github.com/Bike4Mind/bike4mind/pull/7971) [`928126a`](https://github.com/Bike4Mind/bike4mind/commit/928126a5fe89c4dc1dea15483653da673a9f2c34) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - standing instructions for briefs

- [#7995](https://github.com/Bike4Mind/bike4mind/pull/7995) [`96e21d5`](https://github.com/Bike4Mind/bike4mind/commit/96e21d52a7b7b6d751c4abd477378ad56b8aac4c) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add v1 artifact publish, republish and unpublish endpoints

- [#8064](https://github.com/Bike4Mind/bike4mind/pull/8064) [`9b8faba`](https://github.com/Bike4Mind/bike4mind/commit/9b8fabab15b9b49b9753c8c2e9485265396d3c54) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add artifacts:publish scope for the v1 publish endpoints

- [#8081](https://github.com/Bike4Mind/bike4mind/pull/8081) [`c26dfbd`](https://github.com/Bike4Mind/bike4mind/commit/c26dfbd83dfa1102d716242200b4a95c9571b148) Thanks [@ken-b4m](https://github.com/ken-b4m)! - let Spaces be a listing audience

- [#8130](https://github.com/Bike4Mind/bike4mind/pull/8130) [`7edc140`](https://github.com/Bike4Mind/bike4mind/commit/7edc1403c0eb1fea29153abbb363b88e5c646f2e) Thanks [@jebie](https://github.com/jebie)! - decisions-waiting widget and Live Activity approve/deny

- [#8157](https://github.com/Bike4Mind/bike4mind/pull/8157) [`0ae70cf`](https://github.com/Bike4Mind/bike4mind/commit/0ae70cf8ff1c75161ec412125714b7d7f6a67fd0) Thanks [@vinchi777](https://github.com/vinchi777)! - add direct versioned session lookup

- [#8180](https://github.com/Bike4Mind/bike4mind/pull/8180) [`21ce054`](https://github.com/Bike4Mind/bike4mind/commit/21ce054c9b55ebd3860ce2a7cd77ed714a4cf1b3) Thanks [@ken-b4m](https://github.com/ken-b4m)! - public research API for data lakes

- [#8183](https://github.com/Bike4Mind/bike4mind/pull/8183) [`99b91ef`](https://github.com/Bike4Mind/bike4mind/commit/99b91efae0f547803b0f48d2e941753adb1f8493) Thanks [@ken-b4m](https://github.com/ken-b4m)! - research usability follow-ups from the staging walkthrough

- [#8193](https://github.com/Bike4Mind/bike4mind/pull/8193) [`a58c365`](https://github.com/Bike4Mind/bike4mind/commit/a58c365f63d54c74bccc497917ebfd6c9f9d84b7) Thanks [@ken-b4m](https://github.com/ken-b4m)! - record structured research changes and file events in lake history

### Patch Changes

- [#8022](https://github.com/Bike4Mind/bike4mind/pull/8022) [`34ad681`](https://github.com/Bike4Mind/bike4mind/commit/34ad6819121d3c275dbc5d26779adc937f9a2a32) Thanks [@rexendy](https://github.com/rexendy)! - say why a Scene was stored outside Files

- [#8040](https://github.com/Bike4Mind/bike4mind/pull/8040) [`06710e3`](https://github.com/Bike4Mind/bike4mind/commit/06710e3ad20539e2c224618905181656081476e6) Thanks [@onoya](https://github.com/onoya)! - make every presigned upload create-only

- [#8267](https://github.com/Bike4Mind/bike4mind/pull/8267) [`933ecab`](https://github.com/Bike4Mind/bike4mind/commit/933ecab735b72d7242b6094ad33a39a2df4d853a) Thanks [@onoya](https://github.com/onoya)! - treat exhausted provider quota as an expected, clearly reported failure

## 4.0.0

### Major Changes

- [#7788](https://github.com/Bike4Mind/bike4mind/pull/7788) [`385206d`](https://github.com/Bike4Mind/bike4mind/commit/385206d6aa484dd9e7610c14bb94012b033b007e) Thanks [@vinchi777](https://github.com/vinchi777)! - enforce a durable one-quest free allowance

### Minor Changes

- [#7683](https://github.com/Bike4Mind/bike4mind/pull/7683) [`1b65299`](https://github.com/Bike4Mind/bike4mind/commit/1b65299a311a4ce5d8ee3e6036046c53b54502fb) Thanks [@onoya](https://github.com/onoya)! - speech and sound effects as generation job kinds

- [#7794](https://github.com/Bike4Mind/bike4mind/pull/7794) [`2c1140f`](https://github.com/Bike4Mind/bike4mind/commit/2c1140f958b244aa35d730888a2ce7336b3dd544) Thanks [@cgtorniado](https://github.com/cgtorniado)! - let platform API keys attribute AI requests to their own end users

- [#7796](https://github.com/Bike4Mind/bike4mind/pull/7796) [`8774f0a`](https://github.com/Bike4Mind/bike4mind/commit/8774f0a7478c0b20227aacb337386672cb12bd84) Thanks [@onoya](https://github.com/onoya)! - compose a video and a music track into one shareable clip

## 3.0.0

### Major Changes

- [#7478](https://github.com/Bike4Mind/bike4mind/pull/7478) [`2d5a2ce`](https://github.com/Bike4Mind/bike4mind/commit/2d5a2cebf549b080ceca06f13ab287d5402a4fb4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - org-level model and built-in tool policy

### Minor Changes

- [#7562](https://github.com/Bike4Mind/bike4mind/pull/7562) [`b3a724f`](https://github.com/Bike4Mind/bike4mind/commit/b3a724f7c6f7718375fa25ddfe00c1fb16d15eb4) Thanks [@onoya](https://github.com/onoya)! - publish the web search, web fetch and weather tools as v1 contracts

- [#7580](https://github.com/Bike4Mind/bike4mind/pull/7580) [`bd7f820`](https://github.com/Bike4Mind/bike4mind/commit/bd7f82035d788b7cd87c72ff31b6b4fe131ef674) Thanks [@onoya](https://github.com/onoya)! - deliver push notifications to Android devices over FCM

- [#7582](https://github.com/Bike4Mind/bike4mind/pull/7582) [`6b26028`](https://github.com/Bike4Mind/bike4mind/commit/6b2602812aafaa36e29878dbaf2c2877d402d951) Thanks [@onoya](https://github.com/onoya)! - list image models from the catalog and rank newer flagships first

- [#7650](https://github.com/Bike4Mind/bike4mind/pull/7650) [`f7de841`](https://github.com/Bike4Mind/bike4mind/commit/f7de841d5347ed1e5dda7a349dc54bca9b0ee801) Thanks [@vinchi777](https://github.com/vinchi777)! - extend client bootstrap configuration projections

- [#7671](https://github.com/Bike4Mind/bike4mind/pull/7671) [`2d7700d`](https://github.com/Bike4Mind/bike4mind/commit/2d7700d04b4e8680c5ff565866dacff33589d894) Thanks [@onoya](https://github.com/onoya)! - read a completion run's settled spend

- [#7694](https://github.com/Bike4Mind/bike4mind/pull/7694) [`c1bb5f3`](https://github.com/Bike4Mind/bike4mind/commit/c1bb5f32db8aa56006e27239ac867fcf6f3b874f) Thanks [@onoya](https://github.com/onoya)! - run the image_generation and edit_image tools as image jobs

- [#7784](https://github.com/Bike4Mind/bike4mind/pull/7784) [`376d72d`](https://github.com/Bike4Mind/bike4mind/commit/376d72d4cea3ce389ba32a942051686d79a57fd8) Thanks [@vinchi777](https://github.com/vinchi777)! - support API keyframes and draft pricing

### Patch Changes

- [#7667](https://github.com/Bike4Mind/bike4mind/pull/7667) [`2e57e2e`](https://github.com/Bike4Mind/bike4mind/commit/2e57e2ee13d2ece2b33e8977ff3cbf33ead633ea) Thanks [@onoya](https://github.com/onoya)! - make browser file uploads create-only

## 2.2.0

### Minor Changes

- [#7146](https://github.com/Bike4Mind/bike4mind/pull/7146) [`17bfadb`](https://github.com/Bike4Mind/bike4mind/commit/17bfadb5b4024f0ba61dabd24aee3ed319b5bb4e) Thanks [@erikbethke](https://github.com/erikbethke)! - mint non-admin QA test personas with a personas:mint API key scope

- [#7156](https://github.com/Bike4Mind/bike4mind/pull/7156) [`4c28bfe`](https://github.com/Bike4Mind/bike4mind/commit/4c28bfe4f44fd27300d180ba8f7e3bb649dc560f) Thanks [@onoya](https://github.com/onoya)! - issue completion runs and attribute orchestration spend to them

- [#7356](https://github.com/Bike4Mind/bike4mind/pull/7356) [`b191684`](https://github.com/Bike4Mind/bike4mind/commit/b1916849f4804d9b017aff34c6efd0e07ecc0c60) Thanks [@vinchi777](https://github.com/vinchi777)! - add project usage export and manager reads

- [#7356](https://github.com/Bike4Mind/bike4mind/pull/7356) [`b191684`](https://github.com/Bike4Mind/bike4mind/commit/b1916849f4804d9b017aff34c6efd0e07ecc0c60) Thanks [@vinchi777](https://github.com/vinchi777)! - enforce content sharing policies

- [#7411](https://github.com/Bike4Mind/bike4mind/pull/7411) [`bfc13fa`](https://github.com/Bike4Mind/bike4mind/commit/bfc13fa58b24832e578f1735075c99d3f6d690c1) Thanks [@onoya](https://github.com/onoya)! - publish model card blurb and provider label on the v1 model lists

- [#7537](https://github.com/Bike4Mind/bike4mind/pull/7537) [`aa6af34`](https://github.com/Bike4Mind/bike4mind/commit/aa6af34da65be95a353cbbecf747630c5b535ffa) Thanks [@onoya](https://github.com/onoya)! - add GET /api/v1/files/{id}/lineage

- [#7563](https://github.com/Bike4Mind/bike4mind/pull/7563) [`a75cbd5`](https://github.com/Bike4Mind/bike4mind/commit/a75cbd5c119f287ef50b3d3096f8ce26df8dbf64) Thanks [@onoya](https://github.com/onoya)! - publish agent credit transfer and create-from-context as v1 contracts

- [#7578](https://github.com/Bike4Mind/bike4mind/pull/7578) [`de83daa`](https://github.com/Bike4Mind/bike4mind/commit/de83daa13221fbc5c58af5e9093c4cf5fd436489) Thanks [@onoya](https://github.com/onoya)! - approve and deny agent pending actions from native clients

### Patch Changes

- [#7544](https://github.com/Bike4Mind/bike4mind/pull/7544) [`2ceaa6e`](https://github.com/Bike4Mind/bike4mind/commit/2ceaa6e667245f3819d501e24acb57873ab92cc4) Thanks [@onoya](https://github.com/onoya)! - carry the redeem code in the request body, not the URL

## 2.1.0

### Minor Changes

- [#6638](https://github.com/Bike4Mind/bike4mind/pull/6638) [`5967a8c`](https://github.com/Bike4Mind/bike4mind/commit/5967a8c6dc37e9b3acc7a49c3aa0155a2f52b405) Thanks [@rexendy](https://github.com/rexendy)! - publish project member, invite and system-prompt routes as v1 contracts

- [#6696](https://github.com/Bike4Mind/bike4mind/pull/6696) [`a885484`](https://github.com/Bike4Mind/bike4mind/commit/a8854848f821b2ecc9935bcc75b6be9874e98e5d) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - publish session files, search and messages as v1 contracts

- [#6862](https://github.com/Bike4Mind/bike4mind/pull/6862) [`748ea85`](https://github.com/Bike4Mind/bike4mind/commit/748ea85a8d1bd81600c3ae1a671b0ea27d350089) Thanks [@onoya](https://github.com/onoya)! - record why the chunker declined to read a file

- [#6870](https://github.com/Bike4Mind/bike4mind/pull/6870) [`b7d3341`](https://github.com/Bike4Mind/bike4mind/commit/b7d3341723c84c82958228e4d08bfca11608c62a) Thanks [@jjmarfa](https://github.com/jjmarfa)! - count the primary toward the FLUX input-image cap and document ref_image_N

- [#6893](https://github.com/Bike4Mind/bike4mind/pull/6893) [`8946448`](https://github.com/Bike4Mind/bike4mind/commit/894644869c6675b70f736b7dc2d5b5ec79015a2d) Thanks [@onoya](https://github.com/onoya)! - client version handshake with upgrade-required gate

- [#6894](https://github.com/Bike4Mind/bike4mind/pull/6894) [`8705571`](https://github.com/Bike4Mind/bike4mind/commit/870557199347df6f57bab891817d4c92ebf73568) Thanks [@onoya](https://github.com/onoya)! - contract-backed client configuration endpoint

- [#6897](https://github.com/Bike4Mind/bike4mind/pull/6897) [`d5ffa15`](https://github.com/Bike4Mind/bike4mind/commit/d5ffa15324a7ae076c80d4ae519c6854ae28723e) Thanks [@onoya](https://github.com/onoya)! - tell suspended users why and how to appeal

- [#6975](https://github.com/Bike4Mind/bike4mind/pull/6975) [`f2fd74a`](https://github.com/Bike4Mind/bike4mind/commit/f2fd74a7f248679e9f9d3fbb2305fb18422e60a6) Thanks [@ken-b4m](https://github.com/ken-b4m)! - create, update and read skills from a SKILL.md with an API key

- [#6983](https://github.com/Bike4Mind/bike4mind/pull/6983) [`a331c98`](https://github.com/Bike4Mind/bike4mind/commit/a331c985c1ba3ecad87139f2316d08de5aa89fe3) Thanks [@wescarda](https://github.com/wescarda)! - add bounding box support for BFL region edits

- [#7193](https://github.com/Bike4Mind/bike4mind/pull/7193) [`83959a6`](https://github.com/Bike4Mind/bike4mind/commit/83959a656170b44fc09e59f85edb69f888a97424) Thanks [@onoya](https://github.com/onoya)! - look up an account from its provider end-user identifier

### Patch Changes

- [#6971](https://github.com/Bike4Mind/bike4mind/pull/6971) [`c957dbe`](https://github.com/Bike4Mind/bike4mind/commit/c957dbec656f7b243081a2b3b38c6b40dddcfa33) Thanks [@ken-b4m](https://github.com/ken-b4m)! - round-trip SKILL.md model and stop false missing-file warnings

## 2.0.0

### Major Changes

- [#6637](https://github.com/Bike4Mind/bike4mind/pull/6637) [`5398063`](https://github.com/Bike4Mind/bike4mind/commit/5398063cd155b1d95722bca9de3b0d5abfeb7ded) Thanks [@onoya](https://github.com/onoya)! - unify providers and expose model discovery

- [#6746](https://github.com/Bike4Mind/bike4mind/pull/6746) [`9c44e07`](https://github.com/Bike4Mind/bike4mind/commit/9c44e076692dbe22988a51329e69dadfe9abc687) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - type the known content blocks in completions messages

## 1.7.0

### Minor Changes

- [#5621](https://github.com/Bike4Mind/bike4mind/pull/5621) [`4d955d7`](https://github.com/Bike4Mind/bike4mind/commit/4d955d7832b4305cb61a9fe68b117c2c25c94ea5) Thanks [@dea0030](https://github.com/dea0030)! - publish project file and session routes as v1 contracts

- [#6642](https://github.com/Bike4Mind/bike4mind/pull/6642) [`aa2512b`](https://github.com/Bike4Mind/bike4mind/commit/aa2512b34ff9300ef02144a84b56b17b95bfabd5) Thanks [@onoya](https://github.com/onoya)! - add the FLUX 3 Image and FLUX 3 Image Klein models

- [#6673](https://github.com/Bike4Mind/bike4mind/pull/6673) [`a802353`](https://github.com/Bike4Mind/bike4mind/commit/a8023533b19b8bcf899e2765cd8fa58164f37e74) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add v1 artifact version-create, search and types routes

- [#6682](https://github.com/Bike4Mind/bike4mind/pull/6682) [`dbf9bd6`](https://github.com/Bike4Mind/bike4mind/commit/dbf9bd66981eda46793dd6d5f6298060b94cc6cd) Thanks [@onoya](https://github.com/onoya)! - record which clients each user uses and hide the desktop promo for desktop users

## 1.6.0

### Minor Changes

- [#6138](https://github.com/Bike4Mind/bike4mind/pull/6138) [`6f5c1fb`](https://github.com/Bike4Mind/bike4mind/commit/6f5c1fbcc93ad51f40f12d0e17edc6cc65f09c28) Thanks [@maconard](https://github.com/maconard)! - share the cached prompt across chats and append tool changes

- [#6311](https://github.com/Bike4Mind/bike4mind/pull/6311) [`7584b87`](https://github.com/Bike4Mind/bike4mind/commit/7584b87589a6c9974658af8bd22deb5c6081ce32) Thanks [@maconard](https://github.com/maconard)! - chat with OpenAI-compatible model servers

- [#6325](https://github.com/Bike4Mind/bike4mind/pull/6325) [`0b07156`](https://github.com/Bike4Mind/bike4mind/commit/0b07156f05974c6a45dbf373af6dffc22ceb3058) Thanks [@erikbethke](https://github.com/erikbethke)! - post to opted-in Slack channels with a slack:post API key

- [#6394](https://github.com/Bike4Mind/bike4mind/pull/6394) [`6a288cd`](https://github.com/Bike4Mind/bike4mind/commit/6a288cd1a5544e97866cd69f0a932e7c62ecda0c) Thanks [@onoya](https://github.com/onoya)! - session quest history and credit transaction endpoints

- [#6396](https://github.com/Bike4Mind/bike4mind/pull/6396) [`0fca829`](https://github.com/Bike4Mind/bike4mind/commit/0fca8293a5d3dceb185b1c4e450a7e487f2d179f) Thanks [@onoya](https://github.com/onoya)! - device push token registry

- [#6422](https://github.com/Bike4Mind/bike4mind/pull/6422) [`f21f3e9`](https://github.com/Bike4Mind/bike4mind/commit/f21f3e9eb90774500f9311e6912ea940ef40cb2f) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - publish four file routes as v1 contracts

- [#6537](https://github.com/Bike4Mind/bike4mind/pull/6537) [`ef2d63e`](https://github.com/Bike4Mind/bike4mind/commit/ef2d63e097faf5550af8c6b331526c0e6785f74c) Thanks [@jebie](https://github.com/jebie)! - cap in-flight presigned uploads per user and reserve their bytes against quota

- [#6590](https://github.com/Bike4Mind/bike4mind/pull/6590) [`77496f1`](https://github.com/Bike4Mind/bike4mind/commit/77496f1bfe8ecb6148555056b540060881a11821) Thanks [@jarlacut](https://github.com/jarlacut)! - add an ID-token to ai-token exchange helper

- [#6604](https://github.com/Bike4Mind/bike4mind/pull/6604) [`339b66f`](https://github.com/Bike4Mind/bike4mind/commit/339b66f6f199232b75b5b8088cbec9d8b757c2c2) Thanks [@jjmarfa](https://github.com/jjmarfa)! - meter the remaining platform-key text completion routes

- [#6621](https://github.com/Bike4Mind/bike4mind/pull/6621) [`910a008`](https://github.com/Bike4Mind/bike4mind/commit/910a00879345f163e88dd216607f98fb9964a917) Thanks [@jjmarfa](https://github.com/jjmarfa)! - edit images with FLUX.2 reference inputs

### Patch Changes

- [#6109](https://github.com/Bike4Mind/bike4mind/pull/6109) [`bcd3d7d`](https://github.com/Bike4Mind/bike4mind/commit/bcd3d7d048e3b543cf807dcc09c1a033df238a28) Thanks [@dea0030](https://github.com/dea0030)! - check contract responses in production and strip undeclared fields outside it

- [#6275](https://github.com/Bike4Mind/bike4mind/pull/6275) [`70be4dc`](https://github.com/Bike4Mind/bike4mind/commit/70be4dce93edfdc12d9241678204b2ccc8ee103c) Thanks [@onoya](https://github.com/onoya)! - record cache tokens and session on completion usage rows

- [#6337](https://github.com/Bike4Mind/bike4mind/pull/6337) [`69b8c37`](https://github.com/Bike4Mind/bike4mind/commit/69b8c37e6376947f478d61af49778568e97db700) Thanks [@maconard](https://github.com/maconard)! - constrain the json_schema forced tool and honor caller reasoning

- [#6480](https://github.com/Bike4Mind/bike4mind/pull/6480) [`c959137`](https://github.com/Bike4Mind/bike4mind/commit/c95913786fbe3f42d5e2bfcd6c0185574309bb11) Thanks [@ktdejesus](https://github.com/ktdejesus)! - bill web search and web fetch per provider call

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
