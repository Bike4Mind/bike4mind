# @bike4mind/services

## 23.0.0

### Major Changes

- [#6149](https://github.com/Bike4Mind/bike4mind/pull/6149) [`112b6fa`](https://github.com/Bike4Mind/bike4mind/commit/112b6fa278b7b52f8321c6d57c8aeac4a2d7a6da) Thanks [@onoya](https://github.com/onoya)! - enforce free-tier admission for media models

### Minor Changes

- [#5839](https://github.com/Bike4Mind/bike4mind/pull/5839) [`c869f6e`](https://github.com/Bike4Mind/bike4mind/commit/c869f6e8d037d346711c37bc4a5dec6ccd0280ac) Thanks [@jarlacut](https://github.com/jarlacut)! - per-user throttle tier and signup bot checks

- [#5973](https://github.com/Bike4Mind/bike4mind/pull/5973) [`a0cd9c7`](https://github.com/Bike4Mind/bike4mind/commit/a0cd9c748d9dd3ae7ff7d875a4d5ae3fc3eadc28) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - reward inviters for a friend's subscription payments

- [#5985](https://github.com/Bike4Mind/bike4mind/pull/5985) [`35539ab`](https://github.com/Bike4Mind/bike4mind/commit/35539ab4f28537ddc2146789d676f6397ef33285) Thanks [@juicewaa](https://github.com/juicewaa)! - review pending signup risk scores with approve and suspend actions

- [#6002](https://github.com/Bike4Mind/bike4mind/pull/6002) [`eec7321`](https://github.com/Bike4Mind/bike4mind/commit/eec7321e4b43d4c0c42cac756026fe4fee610434) Thanks [@onoya](https://github.com/onoya)! - ledger model/source/date filters, request id and spend breakdowns on Credits tab

- [#6048](https://github.com/Bike4Mind/bike4mind/pull/6048) [`dce62a1`](https://github.com/Bike4Mind/bike4mind/commit/dce62a181758f060544760a5da57455e4fbf92d3) Thanks [@onoya](https://github.com/onoya)! - admin assistant user investigation tools

- [#6119](https://github.com/Bike4Mind/bike4mind/pull/6119) [`15cd6c9`](https://github.com/Bike4Mind/bike4mind/commit/15cd6c974b90469425abc7cab1489d8d2ceffb4d) Thanks [@cgtorniado](https://github.com/cgtorniado)! - link and manage organization membership on the user profile

- [#6132](https://github.com/Bike4Mind/bike4mind/pull/6132) [`3b75162`](https://github.com/Bike4Mind/bike4mind/commit/3b751623da18daed9a24b73d644f1b1626d69564) Thanks [@maconard](https://github.com/maconard)! - send chat tool changes as appended messages instead of rewriting the cached prompt

- [#6138](https://github.com/Bike4Mind/bike4mind/pull/6138) [`6f5c1fb`](https://github.com/Bike4Mind/bike4mind/commit/6f5c1fbcc93ad51f40f12d0e17edc6cc65f09c28) Thanks [@maconard](https://github.com/maconard)! - share the cached prompt across chats and append tool changes

- [#6153](https://github.com/Bike4Mind/bike4mind/pull/6153) [`0840e93`](https://github.com/Bike4Mind/bike4mind/commit/0840e93c2c4cbf85cad6639f0a48148e71ee6d36) Thanks [@onoya](https://github.com/onoya)! - complete signup grant risk observations

- [#6157](https://github.com/Bike4Mind/bike4mind/pull/6157) [`d1975be`](https://github.com/Bike4Mind/bike4mind/commit/d1975be5dad2165854d7918f1c45fc333653f566) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - cap free signup grants with a daily budget, release held grants from admin, and unlock the rest as an activity drip

- [#6157](https://github.com/Bike4Mind/bike4mind/pull/6157) [`d1975be`](https://github.com/Bike4Mind/bike4mind/commit/d1975be5dad2165854d7918f1c45fc333653f566) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add an admin held-grants tab with bulk release, undo and a next-day release cron

- [#6168](https://github.com/Bike4Mind/bike4mind/pull/6168) [`7e7d754`](https://github.com/Bike4Mind/bike4mind/commit/7e7d754c30f4e48de34497d8d6a8800e0ef0ea3c) Thanks [@jarlacut](https://github.com/jarlacut)! - gate outbound actions on account trust and restriction state

- [#6185](https://github.com/Bike4Mind/bike4mind/pull/6185) [`56a4de6`](https://github.com/Bike4Mind/bike4mind/commit/56a4de6b0f63a3f0ff12ae069b34b6e9f0e2fc87) Thanks [@onoya](https://github.com/onoya)! - stamp the funding source on usage events and report cost by signup cohort

- [#6199](https://github.com/Bike4Mind/bike4mind/pull/6199) [`147e089`](https://github.com/Bike4Mind/bike4mind/commit/147e089c6456166a38faaeb0d9a936c2c6723f0d) Thanks [@onoya](https://github.com/onoya)! - hold AI access pending signup review

- [#6222](https://github.com/Bike4Mind/bike4mind/pull/6222) [`fdb4208`](https://github.com/Bike4Mind/bike4mind/commit/fdb42085c50439ab35a52cbe965d67a5a8a5f6eb) Thanks [@onoya](https://github.com/onoya)! - build shadow-only behavioral evidence for account assessments

- [#6245](https://github.com/Bike4Mind/bike4mind/pull/6245) [`5e4007b`](https://github.com/Bike4Mind/bike4mind/commit/5e4007b20639f3c056fb5829429a93dc724a0f29) Thanks [@onoya](https://github.com/onoya)! - roll credit usage into 5-minute spend buckets

- [#6263](https://github.com/Bike4Mind/bike4mind/pull/6263) [`547efb0`](https://github.com/Bike4Mind/bike4mind/commit/547efb00622fe6d1e3a22175100991fc4ebb20b7) Thanks [@juicewaa](https://github.com/juicewaa)! - queue held signup grants for risk review and pay them on approve

- [#6279](https://github.com/Bike4Mind/bike4mind/pull/6279) [`689ca3f`](https://github.com/Bike4Mind/bike4mind/commit/689ca3f4caebb642fa6c56ca49045aeb22ad4849) Thanks [@poysama](https://github.com/poysama)! - alarm on young-account LLM spend and credit overdraft

- [#6284](https://github.com/Bike4Mind/bike4mind/pull/6284) [`a78b173`](https://github.com/Bike4Mind/bike4mind/commit/a78b1735f1118858a7c3fcbb00124a233bcc7b33) Thanks [@onoya](https://github.com/onoya)! - cap hourly and daily spend for new accounts

- [#6291](https://github.com/Bike4Mind/bike4mind/pull/6291) [`af9872c`](https://github.com/Bike4Mind/bike4mind/commit/af9872cec18f8821b9c9623c413f8d8ec5aa569f) Thanks [@ken-b4m](https://github.com/ken-b4m)! - let a contributed workspace answer a turn before the model runs

- [#6296](https://github.com/Bike4Mind/bike4mind/pull/6296) [`02b81e3`](https://github.com/Bike4Mind/bike4mind/commit/02b81e3d498f21710dc6255b9aff128ce97ec680) Thanks [@poysama](https://github.com/poysama)! - poll provider usage reports hourly and page on unusual spend

- [#6311](https://github.com/Bike4Mind/bike4mind/pull/6311) [`7584b87`](https://github.com/Bike4Mind/bike4mind/commit/7584b87589a6c9974658af8bd22deb5c6081ce32) Thanks [@maconard](https://github.com/maconard)! - chat with OpenAI-compatible model servers

- [#6314](https://github.com/Bike4Mind/bike4mind/pull/6314) [`522cb54`](https://github.com/Bike4Mind/bike4mind/commit/522cb5480805b15c5f4692dcd6436fa7661f674f) Thanks [@poysama](https://github.com/poysama)! - list the top accounts on young-account spend alarms

### Patch Changes

- [#5971](https://github.com/Bike4Mind/bike4mind/pull/5971) [`5de606f`](https://github.com/Bike4Mind/bike4mind/commit/5de606f9c1a74b537067a8b50e7ab38c1ac5c355) Thanks [@jarlacut](https://github.com/jarlacut)! - remove any from published declarations

- [#5988](https://github.com/Bike4Mind/bike4mind/pull/5988) [`687ef6e`](https://github.com/Bike4Mind/bike4mind/commit/687ef6ed16b9e2e41d63ef0d257e74f81bce0ae4) Thanks [@onoya](https://github.com/onoya)! - keep DeepSeek tool-call history valid on parallel calls and fallback

- [#6007](https://github.com/Bike4Mind/bike4mind/pull/6007) [`0af0cf3`](https://github.com/Bike4Mind/bike4mind/commit/0af0cf3901ddefdf21edd05350c748b11630d4a2) Thanks [@biletskiy6](https://github.com/biletskiy6)! - drop stranded file references after project and session revokes too

- [#6009](https://github.com/Bike4Mind/bike4mind/pull/6009) [`bf9b60e`](https://github.com/Bike4Mind/bike4mind/commit/bf9b60e92c4c585d207d5e55a6d6f112fc5a194b) Thanks [@jebie](https://github.com/jebie)! - abort timed-out configurations and bill their actual usage

- [#6069](https://github.com/Bike4Mind/bike4mind/pull/6069) [`a0d1b7a`](https://github.com/Bike4Mind/bike4mind/commit/a0d1b7aedd1417b3fa90347cdc86ce5dba5abb84) Thanks [@onoya](https://github.com/onoya)! - analytics exclusions match real data and drop staff accounts

- [#6070](https://github.com/Bike4Mind/bike4mind/pull/6070) [`b1b617c`](https://github.com/Bike4Mind/bike4mind/commit/b1b617c8c26dea55800ccc39703ab23123516d52) Thanks [@onoya](https://github.com/onoya)! - count the whole week in the weekly activity report

- [#6105](https://github.com/Bike4Mind/bike4mind/pull/6105) [`6987a2e`](https://github.com/Bike4Mind/bike4mind/commit/6987a2e7b57bd137c6da8414a864286ff6f8484a) Thanks [@choyno](https://github.com/choyno)! - escape user text in Slack messages

- [#6110](https://github.com/Bike4Mind/bike4mind/pull/6110) [`86ab0eb`](https://github.com/Bike4Mind/bike4mind/commit/86ab0ebdabcb683f5264b8e04cd92e9653d3b95b) Thanks [@jarlacut](https://github.com/jarlacut)! - bound model ids with one shared ModelIdSchema

- [#6122](https://github.com/Bike4Mind/bike4mind/pull/6122) [`f2ee365`](https://github.com/Bike4Mind/bike4mind/commit/f2ee3659e675375b4145d4f00e7ea6da491f60b3) Thanks [@maconard](https://github.com/maconard)! - price Claude cache reads at their published rates

- [#6131](https://github.com/Bike4Mind/bike4mind/pull/6131) [`11cc576`](https://github.com/Bike4Mind/bike4mind/commit/11cc576b692a93e0864395cd165fba30a34385dd) Thanks [@onoya](https://github.com/onoya)! - treat the free-tier daily cap as a terminal credit refusal

- [#6141](https://github.com/Bike4Mind/bike4mind/pull/6141) [`5d649a5`](https://github.com/Bike4Mind/bike4mind/commit/5d649a57b5fb4884f5b2d3dd28ce20b1d476e440) Thanks [@rexendy](https://github.com/rexendy)! - tie signup domain grants to the one grant per inbox

- [#6145](https://github.com/Bike4Mind/bike4mind/pull/6145) [`7c48465`](https://github.com/Bike4Mind/bike4mind/commit/7c484657f096e410e8cffbcb76b5aa42b8a2ea2e) Thanks [@choyno](https://github.com/choyno)! - apply the email sign-up checks to OAuth sign-ups

- [#6150](https://github.com/Bike4Mind/bike4mind/pull/6150) [`a6605d0`](https://github.com/Bike4Mind/bike4mind/commit/a6605d019fb86e3ad8355bfe86d9fd08a4a4afa0) Thanks [@dea0030](https://github.com/dea0030)! - record the reason on restrict, verification, key trust, message and suspend

- [#6161](https://github.com/Bike4Mind/bike4mind/pull/6161) [`644285c`](https://github.com/Bike4Mind/bike4mind/commit/644285c3a153a5558a6d0434a43b5624ed644592) Thanks [@onoya](https://github.com/onoya)! - stop the Default API Model from bypassing the free-tier model gate

- [#6182](https://github.com/Bike4Mind/bike4mind/pull/6182) [`c06f320`](https://github.com/Bike4Mind/bike4mind/commit/c06f320a9b4b12330fecca2f3e48b3e02428a0d2) Thanks [@biletskiy6](https://github.com/biletskiy6)! - show pasted and attached files as thumbnail previews

- [#6189](https://github.com/Bike4Mind/bike4mind/pull/6189) [`c496003`](https://github.com/Bike4Mind/bike4mind/commit/c496003fad830944432bcc4d1494e3af78b30d85) Thanks [@poysama](https://github.com/poysama)! - size the keepalive ceiling by max_tokens and skip the same-model retry while generating

- [#6210](https://github.com/Bike4Mind/bike4mind/pull/6210) [`d61e8c5`](https://github.com/Bike4Mind/bike4mind/commit/d61e8c5ace0fcb8b2607267f338ee9d6e9973c1d) Thanks [@choyno](https://github.com/choyno)! - record usage events for worker subagents and memento evaluation

- [#6211](https://github.com/Bike4Mind/bike4mind/pull/6211) [`a62447d`](https://github.com/Bike4Mind/bike4mind/commit/a62447dc61e7180a3da45474b14785e2c69c7e21) Thanks [@choyno](https://github.com/choyno)! - record usage for timed-out stream attempts

- [#6213](https://github.com/Bike4Mind/bike4mind/pull/6213) [`70b2544`](https://github.com/Bike4Mind/bike4mind/commit/70b2544b9bb5725e5fe9a44dbd57aeb4b816d29c) Thanks [@jarlacut](https://github.com/jarlacut)! - scope request log context per request

- [#6215](https://github.com/Bike4Mind/bike4mind/pull/6215) [`088b7a4`](https://github.com/Bike4Mind/bike4mind/commit/088b7a47582804d5d07bb09324974bdc94bf0ef8) Thanks [@dea0030](https://github.com/dea0030)! - stop listing OpenAI aliases next to their dated snapshots

- [#6216](https://github.com/Bike4Mind/bike4mind/pull/6216) [`46950e9`](https://github.com/Bike4Mind/bike4mind/commit/46950e9a7ee5eae9c63543ddcf9ce6d5146a87c1) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - send reasoning_effort for catalog-only OpenAI models

- [#6217](https://github.com/Bike4Mind/bike4mind/pull/6217) [`168c09f`](https://github.com/Bike4Mind/bike4mind/commit/168c09fc93d93ee8ba09aa37ea558929a325b3f7) Thanks [@choyno](https://github.com/choyno)! - update share entries atomically

- [#6221](https://github.com/Bike4Mind/bike4mind/pull/6221) [`aa541ee`](https://github.com/Bike4Mind/bike4mind/commit/aa541ee08caacfab809423457dbd9153d530688e) Thanks [@choyno](https://github.com/choyno)! - persist only changed quest fields

- [#6235](https://github.com/Bike4Mind/bike4mind/pull/6235) [`b7d33af`](https://github.com/Bike4Mind/bike4mind/commit/b7d33af9bb9178fb5775462ced28ed83cd49cea4) Thanks [@onoya](https://github.com/onoya)! - return free-tier model refusals from media tools as results logged at warn

- [#6254](https://github.com/Bike4Mind/bike4mind/pull/6254) [`416cc52`](https://github.com/Bike4Mind/bike4mind/commit/416cc521e4d83bce0ba39a7014f88ad15ac2632a) Thanks [@onoya](https://github.com/onoya)! - return free-tier refusals from video and music job tools as results logged at warn

- [#6265](https://github.com/Bike4Mind/bike4mind/pull/6265) [`a553f02`](https://github.com/Bike4Mind/bike4mind/commit/a553f02a205729a895729fca53b73eec73acf80d) Thanks [@onoya](https://github.com/onoya)! - log a chat paid-plan model refusal at warn

- [#6266](https://github.com/Bike4Mind/bike4mind/pull/6266) [`531b1dc`](https://github.com/Bike4Mind/bike4mind/commit/531b1dc4fd3c9fa912eafcc9113655c1289f777e) Thanks [@onoya](https://github.com/onoya)! - log a transient SerpAPI image or place lookup failure at warn

- [#6270](https://github.com/Bike4Mind/bike4mind/pull/6270) [`9d40abc`](https://github.com/Bike4Mind/bike4mind/commit/9d40abcabd58873bcb04dde171fa38d7d1cf5843) Thanks [@onoya](https://github.com/onoya)! - require a description on every generic_add credit grant

- [#6275](https://github.com/Bike4Mind/bike4mind/pull/6275) [`70be4dc`](https://github.com/Bike4Mind/bike4mind/commit/70be4dce93edfdc12d9241678204b2ccc8ee103c) Thanks [@onoya](https://github.com/onoya)! - record cache tokens and session on completion usage rows

- [#6276](https://github.com/Bike4Mind/bike4mind/pull/6276) [`fa1cf69`](https://github.com/Bike4Mind/bike4mind/commit/fa1cf690fc118fa469fed0f6e504d0ebccf3843f) Thanks [@onoya](https://github.com/onoya)! - cap completion rounds at the remaining balance

- [#6281](https://github.com/Bike4Mind/bike4mind/pull/6281) [`1934750`](https://github.com/Bike4Mind/bike4mind/commit/193475077c0a59e5dc560c007e15c0ca082f3833) Thanks [@onoya](https://github.com/onoya)! - hold signup unlock bonus until the unlocking payment settles

- [#6285](https://github.com/Bike4Mind/bike4mind/pull/6285) [`98a0b4e`](https://github.com/Bike4Mind/bike4mind/commit/98a0b4eeda09ec51588249f37e6f4793338853ac) Thanks [@onoya](https://github.com/onoya)! - refuse credit spend for suspended and dispute-pending users

- [#6295](https://github.com/Bike4Mind/bike4mind/pull/6295) [`d70cdb7`](https://github.com/Bike4Mind/bike4mind/commit/d70cdb7ba8bc2433c9c385ef1bd38ecce119b938) Thanks [@onoya](https://github.com/onoya)! - floor completion settlement debits atomically

- [#6299](https://github.com/Bike4Mind/bike4mind/pull/6299) [`ffbb946`](https://github.com/Bike4Mind/bike4mind/commit/ffbb94632da65989c6c9e0bba6ac2b145579afee) Thanks [@onoya](https://github.com/onoya)! - fall back off a provider whose spend limit is reached

- [#6300](https://github.com/Bike4Mind/bike4mind/pull/6300) [`8717566`](https://github.com/Bike4Mind/bike4mind/commit/87175667a1997bcc4ec7d95201c348e6f817d7cb) Thanks [@onoya](https://github.com/onoya)! - answer a refused fetch target with a 400 and one generic message

- [#6309](https://github.com/Bike4Mind/bike4mind/pull/6309) [`2c1559d`](https://github.com/Bike4Mind/bike4mind/commit/2c1559d9b8ea252813738eebd71d28fd97d71eb5) Thanks [@onoya](https://github.com/onoya)! - refuse a bundled MCP server missing its startup credential before invoking it

- Updated dependencies [[`db4a697`](https://github.com/Bike4Mind/bike4mind/commit/db4a697a7f89126756ea3f356b11eb78fe867a44), [`42b2ece`](https://github.com/Bike4Mind/bike4mind/commit/42b2ece2a105f58d11c9cf46f2f0f3472fb8c983), [`c869f6e`](https://github.com/Bike4Mind/bike4mind/commit/c869f6e8d037d346711c37bc4a5dec6ccd0280ac), [`6f04636`](https://github.com/Bike4Mind/bike4mind/commit/6f0463622a3d1ad6a8a66f4a643b5e7a22ed5b1d), [`b1a2a74`](https://github.com/Bike4Mind/bike4mind/commit/b1a2a74217996585835f9d9180f88506cec34913), [`630bf8f`](https://github.com/Bike4Mind/bike4mind/commit/630bf8f19d08321065c8c1d8f5f9b47c8d907540), [`5de606f`](https://github.com/Bike4Mind/bike4mind/commit/5de606f9c1a74b537067a8b50e7ab38c1ac5c355), [`a0cd9c7`](https://github.com/Bike4Mind/bike4mind/commit/a0cd9c748d9dd3ae7ff7d875a4d5ae3fc3eadc28), [`35539ab`](https://github.com/Bike4Mind/bike4mind/commit/35539ab4f28537ddc2146789d676f6397ef33285), [`0ac9f6f`](https://github.com/Bike4Mind/bike4mind/commit/0ac9f6fcbf0b17f7df94663be4f7fce3f7afcfbb), [`687ef6e`](https://github.com/Bike4Mind/bike4mind/commit/687ef6ed16b9e2e41d63ef0d257e74f81bce0ae4), [`dad1d84`](https://github.com/Bike4Mind/bike4mind/commit/dad1d84533f648b526cf01f7f861c1c80dd79f72), [`10ae0d3`](https://github.com/Bike4Mind/bike4mind/commit/10ae0d3ff691032bb8dc1ed7bb9c60a5881a3be3), [`b1b617c`](https://github.com/Bike4Mind/bike4mind/commit/b1b617c8c26dea55800ccc39703ab23123516d52), [`0d99c48`](https://github.com/Bike4Mind/bike4mind/commit/0d99c4879a345e8b97e7e2465a3f5e8f0c744dde), [`b944221`](https://github.com/Bike4Mind/bike4mind/commit/b94422194e8882c9b762b5986c2381442eae5639), [`1109d4a`](https://github.com/Bike4Mind/bike4mind/commit/1109d4a325228bc9ced79dcb5264f662aca3b015), [`6987a2e`](https://github.com/Bike4Mind/bike4mind/commit/6987a2e7b57bd137c6da8414a864286ff6f8484a), [`bcd3d7d`](https://github.com/Bike4Mind/bike4mind/commit/bcd3d7d048e3b543cf807dcc09c1a033df238a28), [`86ab0eb`](https://github.com/Bike4Mind/bike4mind/commit/86ab0ebdabcb683f5264b8e04cd92e9653d3b95b), [`7cf653b`](https://github.com/Bike4Mind/bike4mind/commit/7cf653b8f453f743d23631d149694dacf9a44325), [`15cd6c9`](https://github.com/Bike4Mind/bike4mind/commit/15cd6c974b90469425abc7cab1489d8d2ceffb4d), [`f2ee365`](https://github.com/Bike4Mind/bike4mind/commit/f2ee3659e675375b4145d4f00e7ea6da491f60b3), [`69ec262`](https://github.com/Bike4Mind/bike4mind/commit/69ec262ea93a4b353310d3ee3e889c3db5762291), [`148b77b`](https://github.com/Bike4Mind/bike4mind/commit/148b77bfe2d6836ec0315c21e9a068467f08cfda), [`b96cddd`](https://github.com/Bike4Mind/bike4mind/commit/b96cddd563c64289bbecaaff39b5292da1c23654), [`c7e704d`](https://github.com/Bike4Mind/bike4mind/commit/c7e704d0ba58c45b0890afb5b05f1825796d5899), [`11cc576`](https://github.com/Bike4Mind/bike4mind/commit/11cc576b692a93e0864395cd165fba30a34385dd), [`3b75162`](https://github.com/Bike4Mind/bike4mind/commit/3b751623da18daed9a24b73d644f1b1626d69564), [`8d43fec`](https://github.com/Bike4Mind/bike4mind/commit/8d43fec67f0130877b9410fb51e76a9f2020db07), [`6f5c1fb`](https://github.com/Bike4Mind/bike4mind/commit/6f5c1fbcc93ad51f40f12d0e17edc6cc65f09c28), [`2a41c70`](https://github.com/Bike4Mind/bike4mind/commit/2a41c70a11c5dfce58deea671d8933ce47be79f2), [`112b6fa`](https://github.com/Bike4Mind/bike4mind/commit/112b6fa278b7b52f8321c6d57c8aeac4a2d7a6da), [`a6605d0`](https://github.com/Bike4Mind/bike4mind/commit/a6605d019fb86e3ad8355bfe86d9fd08a4a4afa0), [`065ac56`](https://github.com/Bike4Mind/bike4mind/commit/065ac565d2371b4ab09d750fe6a1b65a6ade9f16), [`0840e93`](https://github.com/Bike4Mind/bike4mind/commit/0840e93c2c4cbf85cad6639f0a48148e71ee6d36), [`fdad4c9`](https://github.com/Bike4Mind/bike4mind/commit/fdad4c97e1fa82ba33c2c181b52e257568ff834e), [`d1975be`](https://github.com/Bike4Mind/bike4mind/commit/d1975be5dad2165854d7918f1c45fc333653f566), [`d1975be`](https://github.com/Bike4Mind/bike4mind/commit/d1975be5dad2165854d7918f1c45fc333653f566), [`644285c`](https://github.com/Bike4Mind/bike4mind/commit/644285c3a153a5558a6d0434a43b5624ed644592), [`33c6589`](https://github.com/Bike4Mind/bike4mind/commit/33c65899bf8871fd7dd1fa3e90be3c4d6e0de528), [`7e7d754`](https://github.com/Bike4Mind/bike4mind/commit/7e7d754c30f4e48de34497d8d6a8800e0ef0ea3c), [`c368db9`](https://github.com/Bike4Mind/bike4mind/commit/c368db9cabb7d74200af6967776570a9c31c72bf), [`56a4de6`](https://github.com/Bike4Mind/bike4mind/commit/56a4de6b0f63a3f0ff12ae069b34b6e9f0e2fc87), [`4d7cb24`](https://github.com/Bike4Mind/bike4mind/commit/4d7cb24efa957396f561c6350bf0e6d423b02979), [`c496003`](https://github.com/Bike4Mind/bike4mind/commit/c496003fad830944432bcc4d1494e3af78b30d85), [`147e089`](https://github.com/Bike4Mind/bike4mind/commit/147e089c6456166a38faaeb0d9a936c2c6723f0d), [`ef87ede`](https://github.com/Bike4Mind/bike4mind/commit/ef87edeeacbc7e91bfa15194167d333da60440a1), [`6971506`](https://github.com/Bike4Mind/bike4mind/commit/6971506f556903a308b27b9475e3a4f53b6e70a0), [`a62447d`](https://github.com/Bike4Mind/bike4mind/commit/a62447dc61e7180a3da45474b14785e2c69c7e21), [`70b2544`](https://github.com/Bike4Mind/bike4mind/commit/70b2544b9bb5725e5fe9a44dbd57aeb4b816d29c), [`e31e75b`](https://github.com/Bike4Mind/bike4mind/commit/e31e75bf7cf0e5bbbaf714b6a4917561c6c269f4), [`088b7a4`](https://github.com/Bike4Mind/bike4mind/commit/088b7a47582804d5d07bb09324974bdc94bf0ef8), [`46950e9`](https://github.com/Bike4Mind/bike4mind/commit/46950e9a7ee5eae9c63543ddcf9ce6d5146a87c1), [`168c09f`](https://github.com/Bike4Mind/bike4mind/commit/168c09fc93d93ee8ba09aa37ea558929a325b3f7), [`fdb4208`](https://github.com/Bike4Mind/bike4mind/commit/fdb42085c50439ab35a52cbe965d67a5a8a5f6eb), [`a567161`](https://github.com/Bike4Mind/bike4mind/commit/a567161d6a962bcf665a38a3fce416f5e9117356), [`5e4007b`](https://github.com/Bike4Mind/bike4mind/commit/5e4007b20639f3c056fb5829429a93dc724a0f29), [`50b8eb6`](https://github.com/Bike4Mind/bike4mind/commit/50b8eb669080685cd3d31c030135947e440617ef), [`cf0f94d`](https://github.com/Bike4Mind/bike4mind/commit/cf0f94d71206db34a55d455d35d26cfee3067458), [`547efb0`](https://github.com/Bike4Mind/bike4mind/commit/547efb00622fe6d1e3a22175100991fc4ebb20b7), [`cc86fba`](https://github.com/Bike4Mind/bike4mind/commit/cc86fba4df7e0a8b28349df75569deb953ef5850), [`021a257`](https://github.com/Bike4Mind/bike4mind/commit/021a25713274ee61d6d897968266589f00a099d2), [`70be4dc`](https://github.com/Bike4Mind/bike4mind/commit/70be4dce93edfdc12d9241678204b2ccc8ee103c), [`fa1cf69`](https://github.com/Bike4Mind/bike4mind/commit/fa1cf690fc118fa469fed0f6e504d0ebccf3843f), [`a6e7df7`](https://github.com/Bike4Mind/bike4mind/commit/a6e7df77e71a8f141536a57dc6955faa07a65925), [`1934750`](https://github.com/Bike4Mind/bike4mind/commit/193475077c0a59e5dc560c007e15c0ca082f3833), [`d522dd6`](https://github.com/Bike4Mind/bike4mind/commit/d522dd642dbbcd344e6028c4f17d26ac74f55da3), [`a78b173`](https://github.com/Bike4Mind/bike4mind/commit/a78b1735f1118858a7c3fcbb00124a233bcc7b33), [`98a0b4e`](https://github.com/Bike4Mind/bike4mind/commit/98a0b4eeda09ec51588249f37e6f4793338853ac), [`467cc42`](https://github.com/Bike4Mind/bike4mind/commit/467cc425e2cbff7cc39d5e25d8831616bda8239a), [`ad4b777`](https://github.com/Bike4Mind/bike4mind/commit/ad4b777082dddd6c5a612b46fcfa7526d55b0173), [`af9872c`](https://github.com/Bike4Mind/bike4mind/commit/af9872cec18f8821b9c9623c413f8d8ec5aa569f), [`d70cdb7`](https://github.com/Bike4Mind/bike4mind/commit/d70cdb7ba8bc2433c9c385ef1bd38ecce119b938), [`99c0690`](https://github.com/Bike4Mind/bike4mind/commit/99c0690b283eeb106f7ca7423b6ee481d8a50afd), [`ffbb946`](https://github.com/Bike4Mind/bike4mind/commit/ffbb94632da65989c6c9e0bba6ac2b145579afee), [`78ba603`](https://github.com/Bike4Mind/bike4mind/commit/78ba6039a5e50f2d6b732c2cd8bf406102f6936b), [`2c1559d`](https://github.com/Bike4Mind/bike4mind/commit/2c1559d9b8ea252813738eebd71d28fd97d71eb5), [`7584b87`](https://github.com/Bike4Mind/bike4mind/commit/7584b87589a6c9974658af8bd22deb5c6081ce32)]:
  - @bike4mind/common@22.0.0
  - @bike4mind/agents@1.5.0
  - @bike4mind/llm-adapters@2.2.0
  - @bike4mind/utils@10.0.0
  - @bike4mind/fab-pipeline@2.2.1
  - @bike4mind/mcp@2.1.12
  - @bike4mind/observability@1.0.2
  - @bike4mind/auth@1.2.1
  - @bike4mind/db-core@0.8.12

## 22.0.0

### Major Changes

- [#5757](https://github.com/Bike4Mind/bike4mind/pull/5757) [`0591563`](https://github.com/Bike4Mind/bike4mind/commit/0591563a5f8b594f0a2778016dfca6bd79bcf56a) Thanks [@onoya](https://github.com/onoya)! - reserve image generation and edit credits before rendering

- [#5992](https://github.com/Bike4Mind/bike4mind/pull/5992) [`8eaf1f6`](https://github.com/Bike4Mind/bike4mind/commit/8eaf1f66e0eaa538f376cbdf1d13b893a9912b59) Thanks [@vinchi777](https://github.com/vinchi777)! - add versioned internal user notes and audited tags

### Minor Changes

- [#5271](https://github.com/Bike4Mind/bike4mind/pull/5271) [`aa80549`](https://github.com/Bike4Mind/bike4mind/commit/aa8054946833fbe7b083f239c7d073d74d48d871) Thanks [@poysama](https://github.com/poysama)! - let the shared provider keys authenticate through workload identity federation on AWS

- [#5295](https://github.com/Bike4Mind/bike4mind/pull/5295) [`0f38820`](https://github.com/Bike4Mind/bike4mind/commit/0f38820d54edcac762192b46712657086dbcdc1a) Thanks [@jjmarfa](https://github.com/jjmarfa)! - add current_model_details tool and drop the identity line when it is offered

- [#5427](https://github.com/Bike4Mind/bike4mind/pull/5427) [`634f63c`](https://github.com/Bike4Mind/bike4mind/commit/634f63c6f05c132264aa40f813b2cd10943997d8) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - offer video generation on in-app voice calls

- [#5446](https://github.com/Bike4Mind/bike4mind/pull/5446) [`91849a5`](https://github.com/Bike4Mind/bike4mind/commit/91849a59a4449028a8b1d293efb9c7bdfb21fd43) Thanks [@cgtorniado](https://github.com/cgtorniado)! - render multi-file react artifacts

- [#5573](https://github.com/Bike4Mind/bike4mind/pull/5573) [`cf8826b`](https://github.com/Bike4Mind/bike4mind/commit/cf8826b3dc9b3b26968c112877a7f08a76ffa648) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - alarm when most large-lake forced retrieval turns are cut by name

- [#5622](https://github.com/Bike4Mind/bike4mind/pull/5622) [`1e8cfff`](https://github.com/Bike4Mind/bike4mind/commit/1e8cfff9d694719a2a411685590be881180b32a3) Thanks [@onoya](https://github.com/onoya)! - add an admin-editable blocked email domain list to the signup gate

- [#5623](https://github.com/Bike4Mind/bike4mind/pull/5623) [`2ff7b2e`](https://github.com/Bike4Mind/bike4mind/commit/2ff7b2eacbc79465a9296bdba0221111e7ca6db2) Thanks [@onoya](https://github.com/onoya)! - bulk abuse response tools for banning a domain or a selection of users

- [#5635](https://github.com/Bike4Mind/bike4mind/pull/5635) [`1a9e18b`](https://github.com/Bike4Mind/bike4mind/commit/1a9e18b28ee2f199c16afe6fad7ea252f72e8a2c) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - save inviter at signup and add referral reward settings

- [#5667](https://github.com/Bike4Mind/bike4mind/pull/5667) [`e92f61a`](https://github.com/Bike4Mind/bike4mind/commit/e92f61a01812a1cd701eaf17efb49ec3fd345412) Thanks [@jjmarfa](https://github.com/jjmarfa)! - curate and price the FLUX.2 image models

- [#5674](https://github.com/Bike4Mind/bike4mind/pull/5674) [`3e21c08`](https://github.com/Bike4Mind/bike4mind/commit/3e21c085addeb1f7b442ef27fe6d944922db4e1e) Thanks [@jjmarfa](https://github.com/jjmarfa)! - rank daily most-active users by credits spent

- [#5694](https://github.com/Bike4Mind/bike4mind/pull/5694) [`a460dfb`](https://github.com/Bike4Mind/bike4mind/commit/a460dfbd90446166ed75175f1b292588ddbde6b6) Thanks [@onoya](https://github.com/onoya)! - add explicit user quota overrides and resolution

- [#5714](https://github.com/Bike4Mind/bike4mind/pull/5714) [`4c39123`](https://github.com/Bike4Mind/bike4mind/commit/4c391230968bcda56c6af55da4b6fa868e03e00c) Thanks [@onoya](https://github.com/onoya)! - record generation lineage and request on generated files

- [#5731](https://github.com/Bike4Mind/bike4mind/pull/5731) [`6b873c7`](https://github.com/Bike4Mind/bike4mind/commit/6b873c7752c0096accd8159a816aeda09d588fab) Thanks [@onoya](https://github.com/onoya)! - add signup burst detection and domain holds

- [#5737](https://github.com/Bike4Mind/bike4mind/pull/5737) [`fba41dd`](https://github.com/Bike4Mind/bike4mind/commit/fba41dd44d857b9278489033b46c3d30fcb71d3f) Thanks [@poysama](https://github.com/poysama)! - add burst, edge-signal, young-account spend and LLM spend alerts

- [#5760](https://github.com/Bike4Mind/bike4mind/pull/5760) [`33efa86`](https://github.com/Bike4Mind/bike4mind/commit/33efa86f352b042f98022c656be1531ad246b0c7) Thanks [@juicewaa](https://github.com/juicewaa)! - score new-account risk from weighted signup signals

- [#5776](https://github.com/Bike4Mind/bike4mind/pull/5776) [`b514a6c`](https://github.com/Bike4Mind/bike4mind/commit/b514a6c2635d750a91d9f243c4c27d883ff4ceaa) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - allow a zero free-tier rate limit and set-balance credit adjustments

- [#5779](https://github.com/Bike4Mind/bike4mind/pull/5779) [`ca21414`](https://github.com/Bike4Mind/bike4mind/commit/ca21414ad1cb8a0176fa68429a04ad0d44a7f61a) Thanks [@jarlacut](https://github.com/jarlacut)! - lock credit enforcement on for hosted deployments

- [#5781](https://github.com/Bike4Mind/bike4mind/pull/5781) [`4dfe085`](https://github.com/Bike4Mind/bike4mind/commit/4dfe085dd929e3ac7eb4304cbf95914ea8441a19) Thanks [@choyno](https://github.com/choyno)! - tighten request quotas for API keys of new accounts

- [#5786](https://github.com/Bike4Mind/bike4mind/pull/5786) [`cf89ad9`](https://github.com/Bike4Mind/bike4mind/commit/cf89ad9847ccf2631f797799eab0bf92c1192262) Thanks [@onoya](https://github.com/onoya)! - restrict free-tier accounts to an admin-set model allowlist

- [#5788](https://github.com/Bike4Mind/bike4mind/pull/5788) [`a1ab021`](https://github.com/Bike4Mind/bike4mind/commit/a1ab021251aad7ce5b03ff34f012059224174b7a) Thanks [@choyno](https://github.com/choyno)! - add a per-tier thinking visibility setting

- [#5795](https://github.com/Bike4Mind/bike4mind/pull/5795) [`0601238`](https://github.com/Bike4Mind/bike4mind/commit/0601238b67aa239377cbc65a10700daad3134422) Thanks [@onoya](https://github.com/onoya)! - cap new OTC accounts per email domain and make OTC limits admin-tunable

- [#5801](https://github.com/Bike4Mind/bike4mind/pull/5801) [`f3f40e4`](https://github.com/Bike4Mind/bike4mind/commit/f3f40e417139df795d71cdd3f73241322526f74d) Thanks [@vinchi777](https://github.com/vinchi777)! - implement staged signup grants and cumulative unlocks

- [#5803](https://github.com/Bike4Mind/bike4mind/pull/5803) [`233bdf1`](https://github.com/Bike4Mind/bike4mind/commit/233bdf15425ccbf10d8adaaf5844121112c0cb0d) Thanks [@vinchi777](https://github.com/vinchi777)! - add configurable signup assessment foundation

- [#5806](https://github.com/Bike4Mind/bike4mind/pull/5806) [`a35949b`](https://github.com/Bike4Mind/bike4mind/commit/a35949bd058497959b5ca2de55c4148573a96fef) Thanks [@choyno](https://github.com/choyno)! - group signups by shared email domain infrastructure

- [#5809](https://github.com/Bike4Mind/bike4mind/pull/5809) [`619a9f3`](https://github.com/Bike4Mind/bike4mind/commit/619a9f3072a86f8bbf6de0c5ac05fd843d1e616c) Thanks [@choyno](https://github.com/choyno)! - compute per-user usage pattern signals

- [#5814](https://github.com/Bike4Mind/bike4mind/pull/5814) [`e930082`](https://github.com/Bike4Mind/bike4mind/commit/e930082afb1c00beb7dcb1ad981b1ace849eeebf) Thanks [@julsanchez](https://github.com/julsanchez)! - live disposable-domain intelligence for signup credit holds

- [#5819](https://github.com/Bike4Mind/bike4mind/pull/5819) [`59ceabe`](https://github.com/Bike4Mind/bike4mind/commit/59ceabe189b9d67c4e79e1919510808626e8cee1) Thanks [@onoya](https://github.com/onoya)! - limit signups per network and feed counts to the staged grant

- [#5830](https://github.com/Bike4Mind/bike4mind/pull/5830) [`ee7a413`](https://github.com/Bike4Mind/bike4mind/commit/ee7a4136c41fcddb4a600329238c92ddd2b0ce06) Thanks [@juicewaa](https://github.com/juicewaa)! - store new-account risk scores and rescore young accounts

- [#5871](https://github.com/Bike4Mind/bike4mind/pull/5871) [`05933eb`](https://github.com/Bike4Mind/bike4mind/commit/05933ebd54fbde1721f7642e9a28cb6a5a408b6d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - no-card unlock via aged GitHub account or verified work email

- [#5924](https://github.com/Bike4Mind/bike4mind/pull/5924) [`8543254`](https://github.com/Bike4Mind/bike4mind/commit/8543254f9db8da14dc16ce581fb3ca481f37f8d2) Thanks [@onoya](https://github.com/onoya)! - add Credits and API keys tabs to the user profile

- [#5974](https://github.com/Bike4Mind/bike4mind/pull/5974) [`79bace3`](https://github.com/Bike4Mind/bike4mind/commit/79bace3daa0069f297a11dbc178c8091bbdb2739) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - publish the agent authoring assistants as v1 contracts

- [#5993](https://github.com/Bike4Mind/bike4mind/pull/5993) [`642d0f0`](https://github.com/Bike4Mind/bike4mind/commit/642d0f0e03a41937e8d16b5a9446fe12b0cc7e28) Thanks [@vinchi777](https://github.com/vinchi777)! - harden impersonation sessions with expiry and access records

- [#6004](https://github.com/Bike4Mind/bike4mind/pull/6004) [`e768f3c`](https://github.com/Bike4Mind/bike4mind/commit/e768f3c9f6dbdb59a65ad6de6e6b2a785647d39c) Thanks [@onoya](https://github.com/onoya)! - admin-aware assistant in the admin chat (foundation)

### Patch Changes

- [#5193](https://github.com/Bike4Mind/bike4mind/pull/5193) [`d17415d`](https://github.com/Bike4Mind/bike4mind/commit/d17415d4869afdf8d0f8a430519a5ee860a32ddd) Thanks [@erikbethke](https://github.com/erikbethke)! - stop pinning the placeholder output budget and explain empty replies

- [#5253](https://github.com/Bike4Mind/bike4mind/pull/5253) [`5741560`](https://github.com/Bike4Mind/bike4mind/commit/5741560256580385e2c577ae0df83db47cb538a2) Thanks [@aflordelis](https://github.com/aflordelis)! - move the next shared server layer into the package

- [#5444](https://github.com/Bike4Mind/bike4mind/pull/5444) [`c71b53e`](https://github.com/Bike4Mind/bike4mind/commit/c71b53e3229694935b4ddd6bb662479a1dce7631) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - let overlay packages contribute API-key scopes

- [#5463](https://github.com/Bike4Mind/bike4mind/pull/5463) [`dd17bbe`](https://github.com/Bike4Mind/bike4mind/commit/dd17bbe1c5a148e550b00452944e6aef178ca809) Thanks [@vinchi777](https://github.com/vinchi777)! - reject unsupported assistant prefill

- [#5494](https://github.com/Bike4Mind/bike4mind/pull/5494) [`34fa1ca`](https://github.com/Bike4Mind/bike4mind/commit/34fa1ca62863acfd56d51fce782d759fb83841ac) Thanks [@cgtorniado](https://github.com/cgtorniado)! - recover image quests stuck on running

- [#5557](https://github.com/Bike4Mind/bike4mind/pull/5557) [`fcc0027`](https://github.com/Bike4Mind/bike4mind/commit/fcc002788898d441b19b61281da62817dcad4629) Thanks [@dea0030](https://github.com/dea0030)! - reject a tag rename longer than the lake tag-name cap

- [#5558](https://github.com/Bike4Mind/bike4mind/pull/5558) [`b057019`](https://github.com/Bike4Mind/bike4mind/commit/b0570190c06f5370569c182a92facd62f20de8a1) Thanks [@onoya](https://github.com/onoya)! - queue ElevenLabs calls behind shared concurrency slots

- [#5559](https://github.com/Bike4Mind/bike4mind/pull/5559) [`c668716`](https://github.com/Bike4Mind/bike4mind/commit/c668716920ee4cd0147bf9711cb3235844cc13b7) Thanks [@choyno](https://github.com/choyno)! - tighten sandbox path defaults and host git invocation

- [#5563](https://github.com/Bike4Mind/bike4mind/pull/5563) [`07f0e60`](https://github.com/Bike4Mind/bike4mind/commit/07f0e60afb4b7933bc9fbcfd341c58f42de8b206) Thanks [@choyno](https://github.com/choyno)! - require the admin scope for admin access via API keys

- [#5564](https://github.com/Bike4Mind/bike4mind/pull/5564) [`d7fdf44`](https://github.com/Bike4Mind/bike4mind/commit/d7fdf44f94b13fa1ed07f29437b318d4bd7b87d4) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - set profile photo only after the upload reaches storage

- [#5566](https://github.com/Bike4Mind/bike4mind/pull/5566) [`aee3b68`](https://github.com/Bike4Mind/bike4mind/commit/aee3b683f830087b8ca9ef272a54cd8c432ce8e6) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - lower sound-effects prompt cap to 450 chars

- [#5594](https://github.com/Bike4Mind/bike4mind/pull/5594) [`d2097fc`](https://github.com/Bike4Mind/bike4mind/commit/d2097fc17c7ee638326a4b2d34dbb56fc97a63b8) Thanks [@onoya](https://github.com/onoya)! - make the admin Moderate action block AI features

- [#5625](https://github.com/Bike4Mind/bike4mind/pull/5625) [`0ce52aa`](https://github.com/Bike4Mind/bike4mind/commit/0ce52aa9902813cc414f94b90642837602609c7e) Thanks [@onoya](https://github.com/onoya)! - gate personal API key creation behind a trust check

- [#5636](https://github.com/Bike4Mind/bike4mind/pull/5636) [`ed76824`](https://github.com/Bike4Mind/bike4mind/commit/ed76824f16f56edb9c0ea6e81f0849951bdafd37) Thanks [@jjmarfa](https://github.com/jjmarfa)! - refuse non-text models in executeCompletion

- [#5686](https://github.com/Bike4Mind/bike4mind/pull/5686) [`39675ef`](https://github.com/Bike4Mind/bike4mind/commit/39675efb1307b15900bf4757d7ec77d3600671dc) Thanks [@erikbethke](https://github.com/erikbethke)! - reserve the persona- username prefix for test accounts

- [#5695](https://github.com/Bike4Mind/bike4mind/pull/5695) [`f78e236`](https://github.com/Bike4Mind/bike4mind/commit/f78e236873a72b8b09eb517010795431a9a7f0dc) Thanks [@onoya](https://github.com/onoya)! - guard aggregator dates and monitor pinned models

- [#5734](https://github.com/Bike4Mind/bike4mind/pull/5734) [`9a4cfb9`](https://github.com/Bike4Mind/bike4mind/commit/9a4cfb9ee905a150c32efe430e01e7df6c3ec9ed) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - return 400/403 instead of 500 for client-caused errors

- [#5735](https://github.com/Bike4Mind/bike4mind/pull/5735) [`a29bc83`](https://github.com/Bike4Mind/bike4mind/commit/a29bc837d8df0542594f5499ff3726fff5312ec5) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - retry stalled empty Bedrock streams, ignore aborts

- [#5738](https://github.com/Bike4Mind/bike4mind/pull/5738) [`98d31b1`](https://github.com/Bike4Mind/bike4mind/commit/98d31b1ef57a29f66bbe219d6886e2acc873d30c) Thanks [@erikbethke](https://github.com/erikbethke)! - gate user API keys on paid subscription behind an admin switch (HIGH)

- [#5744](https://github.com/Bike4Mind/bike4mind/pull/5744) [`93dbe04`](https://github.com/Bike4Mind/bike4mind/commit/93dbe0416c43629a391cb1d09c1c61aa04403f04) Thanks [@onoya](https://github.com/onoya)! - log expected provider failures at warn and surface Gemini block reasons

- [#5745](https://github.com/Bike4Mind/bike4mind/pull/5745) [`6b9fe49`](https://github.com/Bike4Mind/bike4mind/commit/6b9fe4983497e10973f6b5cafc7ab63261a56746) Thanks [@onoya](https://github.com/onoya)! - stop downloading S3 objects to validate cached signed URLs

- [#5746](https://github.com/Bike4Mind/bike4mind/pull/5746) [`effc6e9`](https://github.com/Bike4Mind/bike4mind/commit/effc6e96a6d194ce2ff8565147bdbf31c99d5314) Thanks [@onoya](https://github.com/onoya)! - charge personal chat overshoot in full instead of writing it off

- [#5755](https://github.com/Bike4Mind/bike4mind/pull/5755) [`94d7c14`](https://github.com/Bike4Mind/bike4mind/commit/94d7c14cc55e69fe930d0d204595738c9a373133) Thanks [@onoya](https://github.com/onoya)! - grant signup free credits once per inbox across email aliases

- [#5763](https://github.com/Bike4Mind/bike4mind/pull/5763) [`1a85a91`](https://github.com/Bike4Mind/bike4mind/commit/1a85a91d9169b615b54533833fe2a14d5426e233) Thanks [@vinchi777](https://github.com/vinchi777)! - redeem invites during email code signup

- [#5778](https://github.com/Bike4Mind/bike4mind/pull/5778) [`ef98111`](https://github.com/Bike4Mind/bike4mind/commit/ef981110feb53520b2c24c4b94c5f0115a5a1231) Thanks [@onoya](https://github.com/onoya)! - clamp cached signed URL expiry to the signing credentials

- [#5783](https://github.com/Bike4Mind/bike4mind/pull/5783) [`f4f5143`](https://github.com/Bike4Mind/bike4mind/commit/f4f5143a69f64daa28121785c87aae41bb92cecf) Thanks [@choyno](https://github.com/choyno)! - debit operational usage for free-tier users

- [#5800](https://github.com/Bike4Mind/bike4mind/pull/5800) [`0348ea6`](https://github.com/Bike4Mind/bike4mind/commit/0348ea6ab02c5fe8dc7f6549416cf47f1dc644ce) Thanks [@choyno](https://github.com/choyno)! - lapse members' data-lake access when an organization is deleted

- [#5821](https://github.com/Bike4Mind/bike4mind/pull/5821) [`94487a4`](https://github.com/Bike4Mind/bike4mind/commit/94487a476972e6d61d4e759118a400e5c5296b31) Thanks [@jjmarfa](https://github.com/jjmarfa)! - report or keep lake files embedded within the index lag at the candidate cap

- [#5834](https://github.com/Bike4Mind/bike4mind/pull/5834) [`3441a3d`](https://github.com/Bike4Mind/bike4mind/commit/3441a3d92969ae4217eff8c0dac5b41a2e164073) Thanks [@jjmarfa](https://github.com/jjmarfa)! - build Content-Disposition with the shared helper so non-ASCII filenames upload

- [#5904](https://github.com/Bike4Mind/bike4mind/pull/5904) [`f7d22fb`](https://github.com/Bike4Mind/bike4mind/commit/f7d22fb35ae43b8bf5bd125a2153c3f79e7ffbc8) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - record provider-side content-filter refusals as moderation hits

- [#5940](https://github.com/Bike4Mind/bike4mind/pull/5940) [`2707102`](https://github.com/Bike4Mind/bike4mind/commit/27071028499e8fd833868eebc158e5c7a32d8a34) Thanks [@jjmarfa](https://github.com/jjmarfa)! - classify reasoning output-budget exhaustion as a documented 422/502

- [#5955](https://github.com/Bike4Mind/bike4mind/pull/5955) [`a295054`](https://github.com/Bike4Mind/bike4mind/commit/a2950546d13fbf978e70ee33156e6094db9aabcd) Thanks [@ken-b4m](https://github.com/ken-b4m)! - clear open Dependabot alerts with in-major overrides and bumps

- [#6001](https://github.com/Bike4Mind/bike4mind/pull/6001) [`144b32b`](https://github.com/Bike4Mind/bike4mind/commit/144b32bf6732c105073778e4b572d3ad77717a80) Thanks [@biletskiy6](https://github.com/biletskiy6)! - drop a revoked file from the former recipient's system files and sessions

- [#6010](https://github.com/Bike4Mind/bike4mind/pull/6010) [`0cfe42e`](https://github.com/Bike4Mind/bike4mind/commit/0cfe42ec9eccaf198c042e2e0c01116dca9c366b) Thanks [@biletskiy6](https://github.com/biletskiy6)! - revoke the owner's grant on a departing member's files and notebooks

- [#6074](https://github.com/Bike4Mind/bike4mind/pull/6074) [`be31cb6`](https://github.com/Bike4Mind/bike4mind/commit/be31cb636173debf4646a25802af9529c7a388bf) Thanks [@vinchi777](https://github.com/vinchi777)! - retire the shut-down Veo 3.1 Fast preview model

- Updated dependencies [[`4814e56`](https://github.com/Bike4Mind/bike4mind/commit/4814e56abc60ceecb18ec19875ffacd57c8f0e09), [`4814e56`](https://github.com/Bike4Mind/bike4mind/commit/4814e56abc60ceecb18ec19875ffacd57c8f0e09), [`54aa9a7`](https://github.com/Bike4Mind/bike4mind/commit/54aa9a7376cc9f29c3b99fb587aab61540bc490b), [`d17415d`](https://github.com/Bike4Mind/bike4mind/commit/d17415d4869afdf8d0f8a430519a5ee860a32ddd), [`5741560`](https://github.com/Bike4Mind/bike4mind/commit/5741560256580385e2c577ae0df83db47cb538a2), [`aa80549`](https://github.com/Bike4Mind/bike4mind/commit/aa8054946833fbe7b083f239c7d073d74d48d871), [`0f38820`](https://github.com/Bike4Mind/bike4mind/commit/0f38820d54edcac762192b46712657086dbcdc1a), [`c71b53e`](https://github.com/Bike4Mind/bike4mind/commit/c71b53e3229694935b4ddd6bb662479a1dce7631), [`91849a5`](https://github.com/Bike4Mind/bike4mind/commit/91849a59a4449028a8b1d293efb9c7bdfb21fd43), [`dd17bbe`](https://github.com/Bike4Mind/bike4mind/commit/dd17bbe1c5a148e550b00452944e6aef178ca809), [`4814e56`](https://github.com/Bike4Mind/bike4mind/commit/4814e56abc60ceecb18ec19875ffacd57c8f0e09), [`a0e4dec`](https://github.com/Bike4Mind/bike4mind/commit/a0e4dec9c2f5fe2cb38b5aa6e3e11462f3df3091), [`137d97b`](https://github.com/Bike4Mind/bike4mind/commit/137d97b9c219045034132df708d90f07cecc9633), [`53e1863`](https://github.com/Bike4Mind/bike4mind/commit/53e1863220e36278f04b0efabe471c2a001a2273), [`fcd2366`](https://github.com/Bike4Mind/bike4mind/commit/fcd23661bbfc29c4a60bfb85c2d38b28255866cc), [`243ed22`](https://github.com/Bike4Mind/bike4mind/commit/243ed22733e81f22574fc66975e2376458fc1deb), [`c1ec256`](https://github.com/Bike4Mind/bike4mind/commit/c1ec2567aef3c641a8ba5c3f33a2a0b8bc526462), [`d7fe1a2`](https://github.com/Bike4Mind/bike4mind/commit/d7fe1a2e6d1f635e10e8f9c124110e5bdfc51653), [`57fe9c8`](https://github.com/Bike4Mind/bike4mind/commit/57fe9c853946c4afe11307f729a701813185b48e), [`bc90957`](https://github.com/Bike4Mind/bike4mind/commit/bc9095763657dfe551c011fa5454c0cc4b40f4c6), [`57bcde3`](https://github.com/Bike4Mind/bike4mind/commit/57bcde35bd28aab37eaa62794ce36765d6b33bd8), [`c36a0b3`](https://github.com/Bike4Mind/bike4mind/commit/c36a0b3022f83a8724af413c28521d6d2b203dca), [`42f4f4a`](https://github.com/Bike4Mind/bike4mind/commit/42f4f4afb5370de9cffc4fed26440ee0cd59404c), [`84c15bc`](https://github.com/Bike4Mind/bike4mind/commit/84c15bc59fa124eac1c80350e0a101b6c6e85572), [`b057019`](https://github.com/Bike4Mind/bike4mind/commit/b0570190c06f5370569c182a92facd62f20de8a1), [`aee3b68`](https://github.com/Bike4Mind/bike4mind/commit/aee3b683f830087b8ca9ef272a54cd8c432ce8e6), [`f97cf1e`](https://github.com/Bike4Mind/bike4mind/commit/f97cf1ee441ce790b331804a6dc10149683f4dc6), [`d2097fc`](https://github.com/Bike4Mind/bike4mind/commit/d2097fc17c7ee638326a4b2d34dbb56fc97a63b8), [`ea39c25`](https://github.com/Bike4Mind/bike4mind/commit/ea39c25620ae263c44e29bcc2ebcf45ef299deec), [`22b2349`](https://github.com/Bike4Mind/bike4mind/commit/22b23498c5ea66602b8661a64fb05b8a78d6b1a1), [`1e8cfff`](https://github.com/Bike4Mind/bike4mind/commit/1e8cfff9d694719a2a411685590be881180b32a3), [`2ff7b2e`](https://github.com/Bike4Mind/bike4mind/commit/2ff7b2eacbc79465a9296bdba0221111e7ca6db2), [`0ce52aa`](https://github.com/Bike4Mind/bike4mind/commit/0ce52aa9902813cc414f94b90642837602609c7e), [`e0312a9`](https://github.com/Bike4Mind/bike4mind/commit/e0312a9165e76485b3df9ef092b0c05fcf2fece9), [`f07bb43`](https://github.com/Bike4Mind/bike4mind/commit/f07bb43fcefe095dd26c185d822b5c1a4fe3a171), [`1a9e18b`](https://github.com/Bike4Mind/bike4mind/commit/1a9e18b28ee2f199c16afe6fad7ea252f72e8a2c), [`ba301bc`](https://github.com/Bike4Mind/bike4mind/commit/ba301bc0756fd38fce9b0e946a35db371894cd53), [`b8146f3`](https://github.com/Bike4Mind/bike4mind/commit/b8146f33b24b69ee9e3762ab454e9a1b65cad880), [`d9cad9f`](https://github.com/Bike4Mind/bike4mind/commit/d9cad9f03bc507a89819c088e7cfc018f2891403), [`49c0fa5`](https://github.com/Bike4Mind/bike4mind/commit/49c0fa56e8d0f735adc540fe5d7f533b41e534de), [`cc8fc1d`](https://github.com/Bike4Mind/bike4mind/commit/cc8fc1dbc1a9f4528cc78c3a7d73caa9bf9454f3), [`a898007`](https://github.com/Bike4Mind/bike4mind/commit/a8980077a897e584a0da483a212e505e749cc117), [`856f111`](https://github.com/Bike4Mind/bike4mind/commit/856f111c2a689d3d55884d8c7c354c1d2e2ae0fb), [`aa748ba`](https://github.com/Bike4Mind/bike4mind/commit/aa748ba08177c36d8b74064dc1e4ecfb712800d4), [`e92f61a`](https://github.com/Bike4Mind/bike4mind/commit/e92f61a01812a1cd701eaf17efb49ec3fd345412), [`906bf96`](https://github.com/Bike4Mind/bike4mind/commit/906bf96005592c4a384f777729dae4737d08db1f), [`3e21c08`](https://github.com/Bike4Mind/bike4mind/commit/3e21c085addeb1f7b442ef27fe6d944922db4e1e), [`39675ef`](https://github.com/Bike4Mind/bike4mind/commit/39675efb1307b15900bf4757d7ec77d3600671dc), [`43b7602`](https://github.com/Bike4Mind/bike4mind/commit/43b76023b13fb1bd4b9f8c346a45e9b1f0501527), [`d16988d`](https://github.com/Bike4Mind/bike4mind/commit/d16988d649b015cef203d30c265c70bbc3b57bb1), [`90b879a`](https://github.com/Bike4Mind/bike4mind/commit/90b879ad96988d447cf41564ca1dcdbf261334e3), [`a460dfb`](https://github.com/Bike4Mind/bike4mind/commit/a460dfbd90446166ed75175f1b292588ddbde6b6), [`f78e236`](https://github.com/Bike4Mind/bike4mind/commit/f78e236873a72b8b09eb517010795431a9a7f0dc), [`4c39123`](https://github.com/Bike4Mind/bike4mind/commit/4c391230968bcda56c6af55da4b6fa868e03e00c), [`d64c463`](https://github.com/Bike4Mind/bike4mind/commit/d64c4633f6289b326ab523359586214ad9efc82d), [`a7e45b5`](https://github.com/Bike4Mind/bike4mind/commit/a7e45b5a3c298b80f5f8d4c3b0e2d4b3a8e80e17), [`c564001`](https://github.com/Bike4Mind/bike4mind/commit/c56400175e574856356e18644f92089aa77d6820), [`6b873c7`](https://github.com/Bike4Mind/bike4mind/commit/6b873c7752c0096accd8159a816aeda09d588fab), [`3311b21`](https://github.com/Bike4Mind/bike4mind/commit/3311b2127dffb1785803962144d5bfd1367092c4), [`9a4cfb9`](https://github.com/Bike4Mind/bike4mind/commit/9a4cfb9ee905a150c32efe430e01e7df6c3ec9ed), [`a29bc83`](https://github.com/Bike4Mind/bike4mind/commit/a29bc837d8df0542594f5499ff3726fff5312ec5), [`6843651`](https://github.com/Bike4Mind/bike4mind/commit/68436514799418cb60d598aca5555bb0bf7666ed), [`98d31b1`](https://github.com/Bike4Mind/bike4mind/commit/98d31b1ef57a29f66bbe219d6886e2acc873d30c), [`905ac81`](https://github.com/Bike4Mind/bike4mind/commit/905ac8111cdd549fd3fb21e70449abc3ea1b98f1), [`1078162`](https://github.com/Bike4Mind/bike4mind/commit/1078162903f8d4575ec415bd5b785a87dec1146b), [`93dbe04`](https://github.com/Bike4Mind/bike4mind/commit/93dbe0416c43629a391cb1d09c1c61aa04403f04), [`effc6e9`](https://github.com/Bike4Mind/bike4mind/commit/effc6e96a6d194ce2ff8565147bdbf31c99d5314), [`4bfc517`](https://github.com/Bike4Mind/bike4mind/commit/4bfc517ba4e36a7cbb6315c5d1f296c756b2a0fa), [`94d7c14`](https://github.com/Bike4Mind/bike4mind/commit/94d7c14cc55e69fe930d0d204595738c9a373133), [`33efa86`](https://github.com/Bike4Mind/bike4mind/commit/33efa86f352b042f98022c656be1531ad246b0c7), [`b514a6c`](https://github.com/Bike4Mind/bike4mind/commit/b514a6c2635d750a91d9f243c4c27d883ff4ceaa), [`ef98111`](https://github.com/Bike4Mind/bike4mind/commit/ef981110feb53520b2c24c4b94c5f0115a5a1231), [`ca21414`](https://github.com/Bike4Mind/bike4mind/commit/ca21414ad1cb8a0176fa68429a04ad0d44a7f61a), [`4dfe085`](https://github.com/Bike4Mind/bike4mind/commit/4dfe085dd929e3ac7eb4304cbf95914ea8441a19), [`f4f5143`](https://github.com/Bike4Mind/bike4mind/commit/f4f5143a69f64daa28121785c87aae41bb92cecf), [`9602802`](https://github.com/Bike4Mind/bike4mind/commit/9602802b6673fdf1e893f6c46440fd62ebfba6c5), [`cf89ad9`](https://github.com/Bike4Mind/bike4mind/commit/cf89ad9847ccf2631f797799eab0bf92c1192262), [`a1ab021`](https://github.com/Bike4Mind/bike4mind/commit/a1ab021251aad7ce5b03ff34f012059224174b7a), [`92e1b83`](https://github.com/Bike4Mind/bike4mind/commit/92e1b83a4c2f6ac77b5e5955b6e98c2b2f22a81a), [`0601238`](https://github.com/Bike4Mind/bike4mind/commit/0601238b67aa239377cbc65a10700daad3134422), [`f3f40e4`](https://github.com/Bike4Mind/bike4mind/commit/f3f40e417139df795d71cdd3f73241322526f74d), [`619a9f3`](https://github.com/Bike4Mind/bike4mind/commit/619a9f3072a86f8bbf6de0c5ac05fd843d1e616c), [`e930082`](https://github.com/Bike4Mind/bike4mind/commit/e930082afb1c00beb7dcb1ad981b1ace849eeebf), [`59ceabe`](https://github.com/Bike4Mind/bike4mind/commit/59ceabe189b9d67c4e79e1919510808626e8cee1), [`cd0aece`](https://github.com/Bike4Mind/bike4mind/commit/cd0aece730c7b40d115d40fd5ea3a462047904ef), [`ee7a413`](https://github.com/Bike4Mind/bike4mind/commit/ee7a4136c41fcddb4a600329238c92ddd2b0ce06), [`deaedfe`](https://github.com/Bike4Mind/bike4mind/commit/deaedfee39d989e92506a49c9321a794495a6300), [`4ea049f`](https://github.com/Bike4Mind/bike4mind/commit/4ea049fa61816e66571b9d99a09dfea2d33a9f3d), [`87ffad4`](https://github.com/Bike4Mind/bike4mind/commit/87ffad460ed94f5bb164e57e5207b14bd3981a74), [`45cc33d`](https://github.com/Bike4Mind/bike4mind/commit/45cc33d40e1d1931b98532accb1d5a8db9ac6748), [`54aa9a7`](https://github.com/Bike4Mind/bike4mind/commit/54aa9a7376cc9f29c3b99fb587aab61540bc490b), [`05933eb`](https://github.com/Bike4Mind/bike4mind/commit/05933ebd54fbde1721f7642e9a28cb6a5a408b6d), [`a31fb20`](https://github.com/Bike4Mind/bike4mind/commit/a31fb208f9ebe3af2969475d9650af3bb5491715), [`b13e5c9`](https://github.com/Bike4Mind/bike4mind/commit/b13e5c9910a417a9a6fc67e0a6dcfb578edfa343), [`3c85624`](https://github.com/Bike4Mind/bike4mind/commit/3c85624f3edf0457ce96295432d8b17625a92b17), [`7461ef5`](https://github.com/Bike4Mind/bike4mind/commit/7461ef5ebac9784370371b9602af454912cb327f), [`a1e3159`](https://github.com/Bike4Mind/bike4mind/commit/a1e315989f0607aadd3853e2409c01020113ef77), [`c6a3eda`](https://github.com/Bike4Mind/bike4mind/commit/c6a3edadf1f963ef66671c352acc203927ad622a), [`7eb96e0`](https://github.com/Bike4Mind/bike4mind/commit/7eb96e066918d09f5201291fb7712563c88c6c61), [`08c41f3`](https://github.com/Bike4Mind/bike4mind/commit/08c41f3a128d995e5bf481585c41bda75040491e), [`40b3c70`](https://github.com/Bike4Mind/bike4mind/commit/40b3c708079b007ed524f48f41201504b2a80b7c), [`2724d6b`](https://github.com/Bike4Mind/bike4mind/commit/2724d6b17ccc5bb4c637f908e8e5b484b7b19303), [`f7d22fb`](https://github.com/Bike4Mind/bike4mind/commit/f7d22fb35ae43b8bf5bd125a2153c3f79e7ffbc8), [`a6976cb`](https://github.com/Bike4Mind/bike4mind/commit/a6976cb4f52856e30afb19659b9a88e25189163a), [`0196148`](https://github.com/Bike4Mind/bike4mind/commit/01961486e75cce4a2b90ba4bf6a8666f04dd22b3), [`21cf520`](https://github.com/Bike4Mind/bike4mind/commit/21cf520cbbcc8a70294a7e0106c0a7eba612cfbf), [`6cb814e`](https://github.com/Bike4Mind/bike4mind/commit/6cb814eead53a0f39f1dd8297da453c8cb1461b5), [`8543254`](https://github.com/Bike4Mind/bike4mind/commit/8543254f9db8da14dc16ce581fb3ca481f37f8d2), [`dcc1738`](https://github.com/Bike4Mind/bike4mind/commit/dcc1738d6bb757e0de97a87a4d4baf5af1a673f3), [`661d0ec`](https://github.com/Bike4Mind/bike4mind/commit/661d0ec6f7366e70c3faf00d3a6563c6c43902f4), [`f34fcb5`](https://github.com/Bike4Mind/bike4mind/commit/f34fcb5daa8cc8e0db1e3f26ef2a8be6814f7569), [`a3d1905`](https://github.com/Bike4Mind/bike4mind/commit/a3d19057eb8569eef3f10f23085f9ac8a0171123), [`ddf55c9`](https://github.com/Bike4Mind/bike4mind/commit/ddf55c9eda3a107ead0732f1eebe4427bf52f3cc), [`2707102`](https://github.com/Bike4Mind/bike4mind/commit/27071028499e8fd833868eebc158e5c7a32d8a34), [`466f115`](https://github.com/Bike4Mind/bike4mind/commit/466f11527f486c939e5336272582daa161d8f81d), [`02c94cf`](https://github.com/Bike4Mind/bike4mind/commit/02c94cf3eb94ba6c25427ce0e657d1119f2dacb4), [`a295054`](https://github.com/Bike4Mind/bike4mind/commit/a2950546d13fbf978e70ee33156e6094db9aabcd), [`165fef9`](https://github.com/Bike4Mind/bike4mind/commit/165fef9c1a0fb6f9c3fada299747c725c912623a), [`775a594`](https://github.com/Bike4Mind/bike4mind/commit/775a5948673a9b346747a11e82ddd053c578f36a), [`019696f`](https://github.com/Bike4Mind/bike4mind/commit/019696fc70140cf0f2a215a4c05865db91eb308d), [`79bace3`](https://github.com/Bike4Mind/bike4mind/commit/79bace3daa0069f297a11dbc178c8091bbdb2739), [`642d0f0`](https://github.com/Bike4Mind/bike4mind/commit/642d0f0e03a41937e8d16b5a9446fe12b0cc7e28), [`f423f9d`](https://github.com/Bike4Mind/bike4mind/commit/f423f9d657a5cb0365b4f9761c828444151e092c), [`e768f3c`](https://github.com/Bike4Mind/bike4mind/commit/e768f3c9f6dbdb59a65ad6de6e6b2a785647d39c), [`be31cb6`](https://github.com/Bike4Mind/bike4mind/commit/be31cb636173debf4646a25802af9529c7a388bf)]:
  - @bike4mind/agents@1.4.0
  - @bike4mind/common@21.0.0
  - @bike4mind/llm-adapters@2.1.0
  - @bike4mind/auth@1.2.0
  - @bike4mind/utils@9.1.0
  - @bike4mind/fab-pipeline@2.2.0
  - @bike4mind/mcp@2.1.11
  - @bike4mind/observability@1.0.1
  - @bike4mind/db-core@0.8.11

## 21.0.0

### Major Changes

- [#4794](https://github.com/Bike4Mind/bike4mind/pull/4794) [`bd5640c`](https://github.com/Bike4Mind/bike4mind/commit/bd5640c03c8f4ec923cad8c70a431c176d50fe98) Thanks [@julsanchez](https://github.com/julsanchez)! - Require durable batch settlement methods on `ITransformBatchRepository`, include each batch result's `customId`, and include per-call billing usage on `IntentDecision`. Custom repository adapters and typed completion fixtures must supply these new required members.

  Remove the retired Google Calendar integration and its setting keys from the public common contracts, and remove `creditTransactionRepository` from `NotebookCurationAdapters`; hosts now meter executive-summary completions instead of deducting a flat curation fee.

- [#5257](https://github.com/Bike4Mind/bike4mind/pull/5257) [`068b941`](https://github.com/Bike4Mind/bike4mind/commit/068b941bead19a117b6902b57d9f9a121ed4ad90) Thanks [@onoya](https://github.com/onoya)! - protect stored credentials and private data

- [#5291](https://github.com/Bike4Mind/bike4mind/pull/5291) [`06aeb90`](https://github.com/Bike4Mind/bike4mind/commit/06aeb90a4515b762709433d23c798fa742e51dd4) Thanks [@onoya](https://github.com/onoya)! - require verified identities for Slack delivery

### Minor Changes

- [#5149](https://github.com/Bike4Mind/bike4mind/pull/5149) [`e4e0043`](https://github.com/Bike4Mind/bike4mind/commit/e4e0043705b98f1f0560205c4dc985648acbd201) Thanks [@vinchi777](https://github.com/vinchi777)! - explain balance and offer affordable models

- [#5179](https://github.com/Bike4Mind/bike4mind/pull/5179) [`1fbdb12`](https://github.com/Bike4Mind/bike4mind/commit/1fbdb12a744681100ffe89da4cb1d4898fa88022) Thanks [@ktdejesus](https://github.com/ktdejesus)! - record the price applied on each usage event

- [#5188](https://github.com/Bike4Mind/bike4mind/pull/5188) [`9d36862`](https://github.com/Bike4Mind/bike4mind/commit/9d36862f0a7d05451ad0a95403f49cb307c5936e) Thanks [@onoya](https://github.com/onoya)! - add per-user admin Activity tab

- [#5222](https://github.com/Bike4Mind/bike4mind/pull/5222) [`72f38ed`](https://github.com/Bike4Mind/bike4mind/commit/72f38edefbbb1425f15d542d782f4b48d15dd380) Thanks [@onoya](https://github.com/onoya)! - alert on critical admin audit entries

- [#5241](https://github.com/Bike4Mind/bike4mind/pull/5241) [`bba40de`](https://github.com/Bike4Mind/bike4mind/commit/bba40de6be35c3a4742a8063f14bc837e931255d) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - deliver generated videos to the requesting Slack thread

- [#5256](https://github.com/Bike4Mind/bike4mind/pull/5256) [`0e0284e`](https://github.com/Bike4Mind/bike4mind/commit/0e0284e08221bbb80caf0e317192759ca66935e5) Thanks [@onoya](https://github.com/onoya)! - record per-turn timing and retries on the quest

- [#5296](https://github.com/Bike4Mind/bike4mind/pull/5296) [`2d8a97f`](https://github.com/Bike4Mind/bike4mind/commit/2d8a97f44dffc7b2022d4bd6b09db9238f59027b) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add a registry for generic credit deduction reasons

- [#5428](https://github.com/Bike4Mind/bike4mind/pull/5428) [`d0f839c`](https://github.com/Bike4Mind/bike4mind/commit/d0f839cb64f6db020c5184c038dca4a971cfed47) Thanks [@jebie](https://github.com/jebie)! - native tool search on Bedrock

- [#5431](https://github.com/Bike4Mind/bike4mind/pull/5431) [`5177854`](https://github.com/Bike4Mind/bike4mind/commit/5177854fe0cd22e9c8273d63665f924018477086) Thanks [@onoya](https://github.com/onoya)! - audit remaining admin settings writers and link credit ledger rows

- [#5434](https://github.com/Bike4Mind/bike4mind/pull/5434) [`55fbaf1`](https://github.com/Bike4Mind/bike4mind/commit/55fbaf1aa3906a8c1fbd73960aa6e3cfaa4f66c9) Thanks [@onoya](https://github.com/onoya)! - role-tagged video generation inputs

- [#5436](https://github.com/Bike4Mind/bike4mind/pull/5436) [`f34e5e4`](https://github.com/Bike4Mind/bike4mind/commit/f34e5e428a3807366c97cc8a3fff31f54285eb6d) Thanks [@dea0030](https://github.com/dea0030)! - show the image model and its credit price before generating

- [#5457](https://github.com/Bike4Mind/bike4mind/pull/5457) [`b3badf3`](https://github.com/Bike4Mind/bike4mind/commit/b3badf3f617bff7774521211017e98c6a803824e) Thanks [@vinchi777](https://github.com/vinchi777)! - add a desktop app download page and a "Try the desktop app" prompt

### Patch Changes

- [#5240](https://github.com/Bike4Mind/bike4mind/pull/5240) [`06b1887`](https://github.com/Bike4Mind/bike4mind/commit/06b1887b08c3fc4544168b6421e5aacfd1509627) Thanks [@jarlacut](https://github.com/jarlacut)! - return retryable 503 when Ollama or local image listing fails

- [#5035](https://github.com/Bike4Mind/bike4mind/pull/5035) [`556feb1`](https://github.com/Bike4Mind/bike4mind/commit/556feb12ee8f51a8d6876317a4b95043acfc87b2) Thanks [@julsanchez](https://github.com/julsanchez)! - hold or gate credits before TTS, transcription, tools and agent runs

- [#5184](https://github.com/Bike4Mind/bike4mind/pull/5184) [`c728ebf`](https://github.com/Bike4Mind/bike4mind/commit/c728ebf806d7ec566f2bc514515b21dc358fb8de) Thanks [@ktdejesus](https://github.com/ktdejesus)! - carry per-turn context in the user message so the Claude system prompt caches

- [#5199](https://github.com/Bike4Mind/bike4mind/pull/5199) [`a23de62`](https://github.com/Bike4Mind/bike4mind/commit/a23de6218f3be2f5ae193869485b28af4a5c9f11) Thanks [@erikbethke](https://github.com/erikbethke)! - drop stale file references from sessions, system files and projects

- [#5218](https://github.com/Bike4Mind/bike4mind/pull/5218) [`6fd5509`](https://github.com/Bike4Mind/bike4mind/commit/6fd55098bd7f47ac6d574c74102fc0f0863497bc) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - skip prompts stopped before any reply in chat history

- [#5228](https://github.com/Bike4Mind/bike4mind/pull/5228) [`b0bdfa5`](https://github.com/Bike4Mind/bike4mind/commit/b0bdfa5afa1e55a48a8b0b16d992faa4450f4b0d) Thanks [@onoya](https://github.com/onoya)! - make the shareable prompt prefix identical across users

- [#5230](https://github.com/Bike4Mind/bike4mind/pull/5230) [`3aded30`](https://github.com/Bike4Mind/bike4mind/commit/3aded306b15804c470de95509ac29fbc03216d9e) Thanks [@jjmarfa](https://github.com/jjmarfa)! - cancel the streaming status throttle before terminal writes

- [#5232](https://github.com/Bike4Mind/bike4mind/pull/5232) [`fc4e1b2`](https://github.com/Bike4Mind/bike4mind/commit/fc4e1b242046e1dc327ba6387b942fa0f37c3f26) Thanks [@onoya](https://github.com/onoya)! - give adaptive Claude the thinking idle timeout

- [#5233](https://github.com/Bike4Mind/bike4mind/pull/5233) [`aeff516`](https://github.com/Bike4Mind/bike4mind/commit/aeff5161a0e4b05bfe77afa49ec4912ddf7be9d3) Thanks [@onoya](https://github.com/onoya)! - await wrapper metric emits before Lambda handlers return

- [#5248](https://github.com/Bike4Mind/bike4mind/pull/5248) [`14340d8`](https://github.com/Bike4Mind/bike4mind/commit/14340d8d1656fe318521e4784adc0b980be58dbf) Thanks [@jjmarfa](https://github.com/jjmarfa)! - read billing and access flags fresh from the settings store

- [#5252](https://github.com/Bike4Mind/bike4mind/pull/5252) [`af1c441`](https://github.com/Bike4Mind/bike4mind/commit/af1c441eff24c1648160f2515881dfb851b07baa) Thanks [@aflordelis](https://github.com/aflordelis)! - move the next-layer integration, data-lake and service files

- [#5259](https://github.com/Bike4Mind/bike4mind/pull/5259) [`f8395e9`](https://github.com/Bike4Mind/bike4mind/commit/f8395e91970859d3930c17b7849503b4789735b5) Thanks [@onoya](https://github.com/onoya)! - carry user timezone into async chat turns

- [#5276](https://github.com/Bike4Mind/bike4mind/pull/5276) [`7a76d27`](https://github.com/Bike4Mind/bike4mind/commit/7a76d278ddb1ff2e524f5b7b6b5f9e5e6d4934da) Thanks [@jarlacut](https://github.com/jarlacut)! - keep provider-owned deprecation state across runs where the provider is absent

- [#5283](https://github.com/Bike4Mind/bike4mind/pull/5283) [`741f528`](https://github.com/Bike4Mind/bike4mind/commit/741f5287662d6d8724aac9420d0f8a46feef5d82) Thanks [@onoya](https://github.com/onoya)! - reserve quota before creating invites

- [#5287](https://github.com/Bike4Mind/bike4mind/pull/5287) [`2372df8`](https://github.com/Bike4Mind/bike4mind/commit/2372df8527c3a8e7f39be9b1a088c6ab4b879434) Thanks [@juicewaa](https://github.com/juicewaa)! - tell the model web search is unavailable when the hedge degrades

- [#5292](https://github.com/Bike4Mind/bike4mind/pull/5292) [`f40e60d`](https://github.com/Bike4Mind/bike4mind/commit/f40e60df07845d53ba1bc49be1066f6602200938) Thanks [@jjmarfa](https://github.com/jjmarfa)! - name the model by its friendly name in the identity line

- [#5429](https://github.com/Bike4Mind/bike4mind/pull/5429) [`dc66c0f`](https://github.com/Bike4Mind/bike4mind/commit/dc66c0f35aa5e8baffe57ffe16e34d1b43b36be7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - show the partial-coverage notice as one line under the answer

- [#5432](https://github.com/Bike4Mind/bike4mind/pull/5432) [`fbede64`](https://github.com/Bike4Mind/bike4mind/commit/fbede6464d5489cbaecb178c6689230ffbb60bcf) Thanks [@onoya](https://github.com/onoya)! - keep the lake vector index warm so forced retrieval stops cutting by name

- [#5461](https://github.com/Bike4Mind/bike4mind/pull/5461) [`318e6a5`](https://github.com/Bike4Mind/bike4mind/commit/318e6a5f7b1ab8a512eb7fb44dee7d634ae20c75) Thanks [@vinchi777](https://github.com/vinchi777)! - reject empty effective messages

- [#5490](https://github.com/Bike4Mind/bike4mind/pull/5490) [`611de1d`](https://github.com/Bike4Mind/bike4mind/commit/611de1df6f19e4db5b221722706eb92ee8be93b7) Thanks [@onoya](https://github.com/onoya)! - treat our own stream timeouts as a slow model, not provider overload

- [#5496](https://github.com/Bike4Mind/bike4mind/pull/5496) [`155c4df`](https://github.com/Bike4Mind/bike4mind/commit/155c4df543ac53022a741adb5cd2baabc7ea0080) Thanks [@onoya](https://github.com/onoya)! - let each tool score its own result for the confidence gate

- [#5499](https://github.com/Bike4Mind/bike4mind/pull/5499) [`74c6ac2`](https://github.com/Bike4Mind/bike4mind/commit/74c6ac23923bcf866c76efdfccd44abbb1ca66e1) Thanks [@jjmarfa](https://github.com/jjmarfa)! - document prompt_upsampling in the public image API

- [#5522](https://github.com/Bike4Mind/bike4mind/pull/5522) [`b28886d`](https://github.com/Bike4Mind/bike4mind/commit/b28886de7218c28dafb4ed57ed7f940421309765) Thanks [@onoya](https://github.com/onoya)! - import MUI icons and lodash per module so vitest skips the barrels

- Updated dependencies [[`06b1887`](https://github.com/Bike4Mind/bike4mind/commit/06b1887b08c3fc4544168b6421e5aacfd1509627), [`bd5640c`](https://github.com/Bike4Mind/bike4mind/commit/bd5640c03c8f4ec923cad8c70a431c176d50fe98), [`bd5640c`](https://github.com/Bike4Mind/bike4mind/commit/bd5640c03c8f4ec923cad8c70a431c176d50fe98), [`0077625`](https://github.com/Bike4Mind/bike4mind/commit/0077625464f4c9a910bc7c6954a6c7c8745c1506), [`556feb1`](https://github.com/Bike4Mind/bike4mind/commit/556feb12ee8f51a8d6876317a4b95043acfc87b2), [`7676e91`](https://github.com/Bike4Mind/bike4mind/commit/7676e9134bfec4300710474ab6535539c620e47e), [`e4e0043`](https://github.com/Bike4Mind/bike4mind/commit/e4e0043705b98f1f0560205c4dc985648acbd201), [`e0f2069`](https://github.com/Bike4Mind/bike4mind/commit/e0f2069b4640c1323b66161ed9d6e7a5ffd61c04), [`3d73686`](https://github.com/Bike4Mind/bike4mind/commit/3d7368634829f526d919c5b09bbb704d95c04348), [`edecc8d`](https://github.com/Bike4Mind/bike4mind/commit/edecc8dd12d0b7bd99123b1b64cba319bb8bcc1c), [`1fbdb12`](https://github.com/Bike4Mind/bike4mind/commit/1fbdb12a744681100ffe89da4cb1d4898fa88022), [`c728ebf`](https://github.com/Bike4Mind/bike4mind/commit/c728ebf806d7ec566f2bc514515b21dc358fb8de), [`9d36862`](https://github.com/Bike4Mind/bike4mind/commit/9d36862f0a7d05451ad0a95403f49cb307c5936e), [`5ca9092`](https://github.com/Bike4Mind/bike4mind/commit/5ca9092584cdd8c1c39141f740e10bef77657458), [`a23de62`](https://github.com/Bike4Mind/bike4mind/commit/a23de6218f3be2f5ae193869485b28af4a5c9f11), [`8541a8e`](https://github.com/Bike4Mind/bike4mind/commit/8541a8e776eacefc3f241e15060493355333cf92), [`5af5151`](https://github.com/Bike4Mind/bike4mind/commit/5af515100ca0cf0f784e7e4931d8afe3710bed2b), [`6fd5509`](https://github.com/Bike4Mind/bike4mind/commit/6fd55098bd7f47ac6d574c74102fc0f0863497bc), [`72f38ed`](https://github.com/Bike4Mind/bike4mind/commit/72f38edefbbb1425f15d542d782f4b48d15dd380), [`b0bdfa5`](https://github.com/Bike4Mind/bike4mind/commit/b0bdfa5afa1e55a48a8b0b16d992faa4450f4b0d), [`fc4e1b2`](https://github.com/Bike4Mind/bike4mind/commit/fc4e1b242046e1dc327ba6387b942fa0f37c3f26), [`ef1a26e`](https://github.com/Bike4Mind/bike4mind/commit/ef1a26edda1c8c930a0152060bda7883cf01ba7f), [`be7707b`](https://github.com/Bike4Mind/bike4mind/commit/be7707b54a1ed0d84bed08c5677ee6514f2b9a42), [`bba40de`](https://github.com/Bike4Mind/bike4mind/commit/bba40de6be35c3a4742a8063f14bc837e931255d), [`2d768ca`](https://github.com/Bike4Mind/bike4mind/commit/2d768ca8d9220015d67a73f2e0c08b55b7bad184), [`14340d8`](https://github.com/Bike4Mind/bike4mind/commit/14340d8d1656fe318521e4784adc0b980be58dbf), [`af1c441`](https://github.com/Bike4Mind/bike4mind/commit/af1c441eff24c1648160f2515881dfb851b07baa), [`f807ef8`](https://github.com/Bike4Mind/bike4mind/commit/f807ef8e820bc1eb4f61baea2c88b0c202589023), [`0e0284e`](https://github.com/Bike4Mind/bike4mind/commit/0e0284e08221bbb80caf0e317192759ca66935e5), [`068b941`](https://github.com/Bike4Mind/bike4mind/commit/068b941bead19a117b6902b57d9f9a121ed4ad90), [`fb351a8`](https://github.com/Bike4Mind/bike4mind/commit/fb351a8a4701006cbdcb58cb33c947d3d36c8a58), [`81ec1bb`](https://github.com/Bike4Mind/bike4mind/commit/81ec1bbd63bff400b3502f24b345ac92e9e30eaa), [`2661559`](https://github.com/Bike4Mind/bike4mind/commit/266155914ec7cd1c77df656c4e671d46e6e10dec), [`741f528`](https://github.com/Bike4Mind/bike4mind/commit/741f5287662d6d8724aac9420d0f8a46feef5d82), [`5d9605b`](https://github.com/Bike4Mind/bike4mind/commit/5d9605b198a1794a1217a4c973dd6b0ea664d45a), [`06aeb90`](https://github.com/Bike4Mind/bike4mind/commit/06aeb90a4515b762709433d23c798fa742e51dd4), [`f40e60d`](https://github.com/Bike4Mind/bike4mind/commit/f40e60df07845d53ba1bc49be1066f6602200938), [`2d8a97f`](https://github.com/Bike4Mind/bike4mind/commit/2d8a97f44dffc7b2022d4bd6b09db9238f59027b), [`95c222e`](https://github.com/Bike4Mind/bike4mind/commit/95c222e0a00b2adc0562d647008046e166cb9388), [`d0f839c`](https://github.com/Bike4Mind/bike4mind/commit/d0f839cb64f6db020c5184c038dca4a971cfed47), [`dc66c0f`](https://github.com/Bike4Mind/bike4mind/commit/dc66c0f35aa5e8baffe57ffe16e34d1b43b36be7), [`ba24fb7`](https://github.com/Bike4Mind/bike4mind/commit/ba24fb71a1c8ef55208cd4799f380883d76329db), [`5177854`](https://github.com/Bike4Mind/bike4mind/commit/5177854fe0cd22e9c8273d63665f924018477086), [`fbede64`](https://github.com/Bike4Mind/bike4mind/commit/fbede6464d5489cbaecb178c6689230ffbb60bcf), [`de2bc47`](https://github.com/Bike4Mind/bike4mind/commit/de2bc475eb6086648d6df902ad76ad3c38837c70), [`55fbaf1`](https://github.com/Bike4Mind/bike4mind/commit/55fbaf1aa3906a8c1fbd73960aa6e3cfaa4f66c9), [`700400f`](https://github.com/Bike4Mind/bike4mind/commit/700400f7ad0d7358908f1b976fe22641244e8e13), [`98517a3`](https://github.com/Bike4Mind/bike4mind/commit/98517a345b3697574c9c33f07318b75c170deee5), [`b3badf3`](https://github.com/Bike4Mind/bike4mind/commit/b3badf3f617bff7774521211017e98c6a803824e), [`a6c29ca`](https://github.com/Bike4Mind/bike4mind/commit/a6c29ca3570ac876e16eacf72219996ea42d5bf6), [`0741792`](https://github.com/Bike4Mind/bike4mind/commit/074179264f77d6c72938e1d9769c906727d1b801), [`318e6a5`](https://github.com/Bike4Mind/bike4mind/commit/318e6a5f7b1ab8a512eb7fb44dee7d634ae20c75), [`40fa1d2`](https://github.com/Bike4Mind/bike4mind/commit/40fa1d2890551fb9f2cf6933be3725652ee8e655), [`611de1d`](https://github.com/Bike4Mind/bike4mind/commit/611de1df6f19e4db5b221722706eb92ee8be93b7), [`155c4df`](https://github.com/Bike4Mind/bike4mind/commit/155c4df543ac53022a741adb5cd2baabc7ea0080), [`74c6ac2`](https://github.com/Bike4Mind/bike4mind/commit/74c6ac23923bcf866c76efdfccd44abbb1ca66e1), [`1efdda7`](https://github.com/Bike4Mind/bike4mind/commit/1efdda7f9febe72c9270bb2b9d46002cc49e7f39), [`35b91b4`](https://github.com/Bike4Mind/bike4mind/commit/35b91b4a9dd4425015d6a1cbcf6238dbb185a0ea), [`b13304e`](https://github.com/Bike4Mind/bike4mind/commit/b13304e18ae26ccac766546e4495d9f0f88ef0f1)]:
  - @bike4mind/llm-adapters@2.0.0
  - @bike4mind/common@20.0.0
  - @bike4mind/agents@1.3.0
  - @bike4mind/utils@9.0.0
  - @bike4mind/db-core@0.8.10
  - @bike4mind/observability@1.0.0
  - @bike4mind/fab-pipeline@2.1.10
  - @bike4mind/auth@1.1.10
  - @bike4mind/mcp@2.1.10

## 20.0.0

### Major Changes

- [#4939](https://github.com/Bike4Mind/bike4mind/pull/4939) [`4eb04ce`](https://github.com/Bike4Mind/bike4mind/commit/4eb04ce7df80bc724b0ff957eab4d9bc18a62360) Thanks [@onoya](https://github.com/onoya)! - move a file's billed bytes when its lake membership changes

- [#5045](https://github.com/Bike4Mind/bike4mind/pull/5045) [`c060285`](https://github.com/Bike4Mind/bike4mind/commit/c060285611b6d4abdafb701fa8c0010afb1be30c) Thanks [@onoya](https://github.com/onoya)! - retire the single org managerId in favor of the Managers list

### Minor Changes

- [#5083](https://github.com/Bike4Mind/bike4mind/pull/5083) [`20f9362`](https://github.com/Bike4Mind/bike4mind/commit/20f9362014343fde166c09acc72c3b759ddfd61d) Thanks [@onoya](https://github.com/onoya)! - close admin audit gaps for roles, deletion, impersonation, MFA and settings

- [#5191](https://github.com/Bike4Mind/bike4mind/pull/5191) [`a68d013`](https://github.com/Bike4Mind/bike4mind/commit/a68d013d2a4c7a59268f3bfbb2ed9b343a0a36c0) Thanks [@jjmarfa](https://github.com/jjmarfa)! - add a decide tool for agent loops and the CLI

### Patch Changes

- [#5069](https://github.com/Bike4Mind/bike4mind/pull/5069) [`fe5147e`](https://github.com/Bike4Mind/bike4mind/commit/fe5147e64e18b78e9d28198f3d94bbae546ad963) Thanks [@jarlacut](https://github.com/jarlacut)! - apply Bedrock lifecycle to served inference-profile ids

- [#5112](https://github.com/Bike4Mind/bike4mind/pull/5112) [`a3f3802`](https://github.com/Bike4Mind/bike4mind/commit/a3f3802a916aa37c354deeba9ad5cde19c20fff3) Thanks [@onoya](https://github.com/onoya)! - make session-reuse revocations triageable, alarm on bursts only

- [#5175](https://github.com/Bike4Mind/bike4mind/pull/5175) [`6edd9d0`](https://github.com/Bike4Mind/bike4mind/commit/6edd9d0def28d3689f2d974cd968c911f8873536) Thanks [@jjmarfa](https://github.com/jjmarfa)! - completed history import shows 0/N items

- [#5182](https://github.com/Bike4Mind/bike4mind/pull/5182) [`a0b5f42`](https://github.com/Bike4Mind/bike4mind/commit/a0b5f429fc8e0b4bcb7968d88513ffd4c71c2d2c) Thanks [@ktdejesus](https://github.com/ktdejesus)! - keep the Claude prompt cache stable across turns in long sessions

- [#5185](https://github.com/Bike4Mind/bike4mind/pull/5185) [`c90d3c5`](https://github.com/Bike4Mind/bike4mind/commit/c90d3c59eeab038d8e84b6bba0a655c64b28ee5b) Thanks [@jjmarfa](https://github.com/jjmarfa)! - avoid 'Gathering data sources' status on source-free prompts

- Updated dependencies [[`a68d013`](https://github.com/Bike4Mind/bike4mind/commit/a68d013d2a4c7a59268f3bfbb2ed9b343a0a36c0), [`4eb04ce`](https://github.com/Bike4Mind/bike4mind/commit/4eb04ce7df80bc724b0ff957eab4d9bc18a62360), [`fe5147e`](https://github.com/Bike4Mind/bike4mind/commit/fe5147e64e18b78e9d28198f3d94bbae546ad963), [`20f9362`](https://github.com/Bike4Mind/bike4mind/commit/20f9362014343fde166c09acc72c3b759ddfd61d), [`2d33506`](https://github.com/Bike4Mind/bike4mind/commit/2d33506efd4f95460139dedb554780ac544be23c), [`a6a458e`](https://github.com/Bike4Mind/bike4mind/commit/a6a458ee96a84759072f7388e77c66be8a8f9be8), [`7bc69c7`](https://github.com/Bike4Mind/bike4mind/commit/7bc69c780cf2e3def64cd650fb82412c6fa91a53), [`a0b5f42`](https://github.com/Bike4Mind/bike4mind/commit/a0b5f429fc8e0b4bcb7968d88513ffd4c71c2d2c), [`847b65f`](https://github.com/Bike4Mind/bike4mind/commit/847b65f4347c32e825b705244902a223bbbf4d3a)]:
  - @bike4mind/common@19.0.0
  - @bike4mind/llm-adapters@1.5.1
  - @bike4mind/utils@8.1.4
  - @bike4mind/agents@1.2.9
  - @bike4mind/auth@1.1.9
  - @bike4mind/db-core@0.8.9
  - @bike4mind/fab-pipeline@2.1.9
  - @bike4mind/mcp@2.1.9

## 19.2.0

### Minor Changes

- [#5127](https://github.com/Bike4Mind/bike4mind/pull/5127) [`a43e39d`](https://github.com/Bike4Mind/bike4mind/commit/a43e39da24f846df42f1c8de8631736e89bfc753) Thanks [@onoya](https://github.com/onoya)! - edit an organization's storage limit

- [#5134](https://github.com/Bike4Mind/bike4mind/pull/5134) [`d1d146c`](https://github.com/Bike4Mind/bike4mind/commit/d1d146c73a2adebe4bd3ecf54facccd7a8514e14) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - accept mid-conversation tool changes on Anthropic models

### Patch Changes

- [#5029](https://github.com/Bike4Mind/bike4mind/pull/5029) [`78b942f`](https://github.com/Bike4Mind/bike4mind/commit/78b942fdac1e4a65ebb59e9aa8467b87eee53c75) Thanks [@aflordelis](https://github.com/aflordelis)! - move the shared h0 leaves of server/utils, lib, shared, app/utils, services and config

- [#5034](https://github.com/Bike4Mind/bike4mind/pull/5034) [`4e05df4`](https://github.com/Bike4Mind/bike4mind/commit/4e05df42da2be56f4b2633fad440f41d9d24e570) Thanks [@julsanchez](https://github.com/julsanchez)! - bound voice holds by server time and floor voice debits

- [#5038](https://github.com/Bike4Mind/bike4mind/pull/5038) [`9f6f66b`](https://github.com/Bike4Mind/bike4mind/commit/9f6f66b28964425db2fa7b1fecee47fcc5fc2aaa) Thanks [@julsanchez](https://github.com/julsanchez)! - bind uploads to their measured size and moderate every animation frame

- [#5062](https://github.com/Bike4Mind/bike4mind/pull/5062) [`3eeea1b`](https://github.com/Bike4Mind/bike4mind/commit/3eeea1b92b1cb3af52cdade73680c946389a9eee) Thanks [@aflordelis](https://github.com/aflordelis)! - keep a held file's stored objects through a lake purge

- [#5088](https://github.com/Bike4Mind/bike4mind/pull/5088) [`0dcbad1`](https://github.com/Bike4Mind/bike4mind/commit/0dcbad11c888e1792484de1b5cc4235c75a9661f) Thanks [@erikbethke](https://github.com/erikbethke)! - let verified partner-domain emails register on invite-only instances

- [#5118](https://github.com/Bike4Mind/bike4mind/pull/5118) [`ac0b050`](https://github.com/Bike4Mind/bike4mind/commit/ac0b050304bf47fd8e62833de7b52be004b0fc19) Thanks [@onoya](https://github.com/onoya)! - stop content-policy blocks from paging the error-alert channel

- [#5147](https://github.com/Bike4Mind/bike4mind/pull/5147) [`e6cf558`](https://github.com/Bike4Mind/bike4mind/commit/e6cf558f5be37f0d2bef61ee278eaf2f82321133) Thanks [@ktdejesus](https://github.com/ktdejesus)! - enable Claude prompt caching on the CLI, Desktop and v1 completions path

- [#5151](https://github.com/Bike4Mind/bike4mind/pull/5151) [`a60a44b`](https://github.com/Bike4Mind/bike4mind/commit/a60a44b8b1e8e62d2178a45451c5dfc760675349) Thanks [@ktdejesus](https://github.com/ktdejesus)! - default adaptive-thinking Claude models to medium effort on the CLI path

- [#5174](https://github.com/Bike4Mind/bike4mind/pull/5174) [`9acd1df`](https://github.com/Bike4Mind/bike4mind/commit/9acd1df001f711b28be3667f742773f6186291e4) Thanks [@ktdejesus](https://github.com/ktdejesus)! - settle non-chat usage stochastically instead of rounding up

- Updated dependencies [[`cf07686`](https://github.com/Bike4Mind/bike4mind/commit/cf0768653624d972a13256138132cb45ac183b8e), [`0ff8025`](https://github.com/Bike4Mind/bike4mind/commit/0ff80253dc13b74255b32727c873ed915764372f), [`78b942f`](https://github.com/Bike4Mind/bike4mind/commit/78b942fdac1e4a65ebb59e9aa8467b87eee53c75), [`9f6f66b`](https://github.com/Bike4Mind/bike4mind/commit/9f6f66b28964425db2fa7b1fecee47fcc5fc2aaa), [`3eeea1b`](https://github.com/Bike4Mind/bike4mind/commit/3eeea1b92b1cb3af52cdade73680c946389a9eee), [`0dcbad1`](https://github.com/Bike4Mind/bike4mind/commit/0dcbad11c888e1792484de1b5cc4235c75a9661f), [`ac0b050`](https://github.com/Bike4Mind/bike4mind/commit/ac0b050304bf47fd8e62833de7b52be004b0fc19), [`a43e39d`](https://github.com/Bike4Mind/bike4mind/commit/a43e39da24f846df42f1c8de8631736e89bfc753), [`88476d1`](https://github.com/Bike4Mind/bike4mind/commit/88476d1a5aa9fceec132d7abc452f9ba0b18ad54), [`d1d146c`](https://github.com/Bike4Mind/bike4mind/commit/d1d146c73a2adebe4bd3ecf54facccd7a8514e14), [`acf5d1e`](https://github.com/Bike4Mind/bike4mind/commit/acf5d1e06542b3b28748b8fcaae825eb9aa299dc), [`a60a44b`](https://github.com/Bike4Mind/bike4mind/commit/a60a44b8b1e8e62d2178a45451c5dfc760675349), [`4e05df4`](https://github.com/Bike4Mind/bike4mind/commit/4e05df42da2be56f4b2633fad440f41d9d24e570)]:
  - @bike4mind/llm-adapters@1.5.0
  - @bike4mind/utils@8.1.3
  - @bike4mind/common@18.0.0
  - @bike4mind/fab-pipeline@2.1.8
  - @bike4mind/agents@1.2.8
  - @bike4mind/auth@1.1.8
  - @bike4mind/db-core@0.8.8
  - @bike4mind/mcp@2.1.8

## 19.1.0

### Minor Changes

- [#5042](https://github.com/Bike4Mind/bike4mind/pull/5042) [`174eeda`](https://github.com/Bike4Mind/bike4mind/commit/174eedabbbcafefe4282268d902efdc6ad12e125) Thanks [@julsanchez](https://github.com/julsanchez)! - log OAuth error responses and record the client on OAuth sessions

### Patch Changes

- Updated dependencies [[`174eeda`](https://github.com/Bike4Mind/bike4mind/commit/174eedabbbcafefe4282268d902efdc6ad12e125)]:
  - @bike4mind/common@17.1.0
  - @bike4mind/agents@1.2.7
  - @bike4mind/auth@1.1.7
  - @bike4mind/db-core@0.8.7
  - @bike4mind/fab-pipeline@2.1.7
  - @bike4mind/llm-adapters@1.4.1
  - @bike4mind/mcp@2.1.7
  - @bike4mind/utils@8.1.2

## 19.0.0

### Major Changes

- [#4997](https://github.com/Bike4Mind/bike4mind/pull/4997) [`5598195`](https://github.com/Bike4Mind/bike4mind/commit/5598195554d31841e2a01afb4c1bb877bd315a58) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - resolve contributed per-surface session settings at read time

### Patch Changes

- Updated dependencies [[`5598195`](https://github.com/Bike4Mind/bike4mind/commit/5598195554d31841e2a01afb4c1bb877bd315a58), [`ee518f5`](https://github.com/Bike4Mind/bike4mind/commit/ee518f5a07404395871bb0824b2038c842f51167)]:
  - @bike4mind/common@17.0.0
  - @bike4mind/llm-adapters@1.4.0
  - @bike4mind/agents@1.2.6
  - @bike4mind/auth@1.1.6
  - @bike4mind/db-core@0.8.6
  - @bike4mind/fab-pipeline@2.1.6
  - @bike4mind/mcp@2.1.6
  - @bike4mind/utils@8.1.1

## 18.2.0

### Minor Changes

- [#4938](https://github.com/Bike4Mind/bike4mind/pull/4938) [`ffa4000`](https://github.com/Bike4Mind/bike4mind/commit/ffa4000fdd229f99fd8173ebc8c8bf257219773d) Thanks [@onoya](https://github.com/onoya)! - org-admin storage usage endpoint and Storage tab

- [#4951](https://github.com/Bike4Mind/bike4mind/pull/4951) [`bddc668`](https://github.com/Bike4Mind/bike4mind/commit/bddc668291070d4cc3b53a91cb207be006092ee9) Thanks [@erikbethke](https://github.com/erikbethke)! - add the custom MCP connection API, probe and tool discovery

- [#5044](https://github.com/Bike4Mind/bike4mind/pull/5044) [`a466c7f`](https://github.com/Bike4Mind/bike4mind/commit/a466c7fd0143132cade0db08a2b1039238a1d3f7) Thanks [@onoya](https://github.com/onoya)! - admit every org manager to the org write gate

- [#5092](https://github.com/Bike4Mind/bike4mind/pull/5092) [`e898c7c`](https://github.com/Bike4Mind/bike4mind/commit/e898c7cc920e1d5c3262114651e7bf24f626eab2) Thanks [@erikbethke](https://github.com/erikbethke)! - notify configured reviewers when an image incident needs review

### Patch Changes

- [#4993](https://github.com/Bike4Mind/bike4mind/pull/4993) [`af39820`](https://github.com/Bike4Mind/bike4mind/commit/af3982067de72652fcbd7cb4c2e2cee74f4d1fc4) Thanks [@onoya](https://github.com/onoya)! - number tool sources into the turn's [N] sequence so inline citations stay clickable

- [#4994](https://github.com/Bike4Mind/bike4mind/pull/4994) [`763153a`](https://github.com/Bike4Mind/bike4mind/commit/763153a0732e992e074b25c7d002f4c2af443b24) Thanks [@onoya](https://github.com/onoya)! - ask the model to rephrase once when the provider blocks a song prompt

- [#5018](https://github.com/Bike4Mind/bike4mind/pull/5018) [`e3f2c4e`](https://github.com/Bike4Mind/bike4mind/commit/e3f2c4ee60e4c08c77b066941f4c077892486867) Thanks [@vinchi777](https://github.com/vinchi777)! - sweep credit holds that are never settled or refunded

- [#5025](https://github.com/Bike4Mind/bike4mind/pull/5025) [`5fb3885`](https://github.com/Bike4Mind/bike4mind/commit/5fb38852c2d555a0189f02191a5cdc1d8774a57a) Thanks [@aflordelis](https://github.com/aflordelis)! - move the remaining height-0 shared files into the package

- [#5037](https://github.com/Bike4Mind/bike4mind/pull/5037) [`a467516`](https://github.com/Bike4Mind/bike4mind/commit/a467516775c4123320ca7079babce53aeec52869) Thanks [@julsanchez](https://github.com/julsanchez)! - hold and settle credits for research configs, thinking budgets and aborted turns

- [#5040](https://github.com/Bike4Mind/bike4mind/pull/5040) [`0e98eee`](https://github.com/Bike4Mind/bike4mind/commit/0e98eee40237b240efbc0738585577a35179bacb) Thanks [@onoya](https://github.com/onoya)! - run adaptive Claude at low effort for simple queries

- [#5056](https://github.com/Bike4Mind/bike4mind/pull/5056) [`73c675c`](https://github.com/Bike4Mind/bike4mind/commit/73c675c64e0be1189c0aa8e4c1c59a86ab388104) Thanks [@jjmarfa](https://github.com/jjmarfa)! - bill sound effects and speech to the selected account

- [#5057](https://github.com/Bike4Mind/bike4mind/pull/5057) [`8b32da9`](https://github.com/Bike4Mind/bike4mind/commit/8b32da9f4bea124592f83fc3a007df164139bc70) Thanks [@vinchi777](https://github.com/vinchi777)! - turn Ollama thinking off explicitly when the toggle is off

- [#5061](https://github.com/Bike4Mind/bike4mind/pull/5061) [`6f32290`](https://github.com/Bike4Mind/bike4mind/commit/6f322902280cea3fb7ed745e10ea49d47a186f8d) Thanks [@jjmarfa](https://github.com/jjmarfa)! - accept organization_id alias on image generation and edit bodies

- [#5068](https://github.com/Bike4Mind/bike4mind/pull/5068) [`a8d5467`](https://github.com/Bike4Mind/bike4mind/commit/a8d5467b1d065f94ff4e8aa80398e671c6e179da) Thanks [@onoya](https://github.com/onoya)! - return 422 instead of 500 for a site the scraper refuses

- [#5085](https://github.com/Bike4Mind/bike4mind/pull/5085) [`d299e48`](https://github.com/Bike4Mind/bike4mind/commit/d299e483d13449ccf91cd3471dde95f0e83cc487) Thanks [@erikbethke](https://github.com/erikbethke)! - align model prices with provider rate cards

- Updated dependencies [[`ffa4000`](https://github.com/Bike4Mind/bike4mind/commit/ffa4000fdd229f99fd8173ebc8c8bf257219773d), [`bddc668`](https://github.com/Bike4Mind/bike4mind/commit/bddc668291070d4cc3b53a91cb207be006092ee9), [`af39820`](https://github.com/Bike4Mind/bike4mind/commit/af3982067de72652fcbd7cb4c2e2cee74f4d1fc4), [`5fb3885`](https://github.com/Bike4Mind/bike4mind/commit/5fb38852c2d555a0189f02191a5cdc1d8774a57a), [`a467516`](https://github.com/Bike4Mind/bike4mind/commit/a467516775c4123320ca7079babce53aeec52869), [`0e98eee`](https://github.com/Bike4Mind/bike4mind/commit/0e98eee40237b240efbc0738585577a35179bacb), [`92186a1`](https://github.com/Bike4Mind/bike4mind/commit/92186a1c8172c0520779beb2c00b4be3ee1fa327), [`a466c7f`](https://github.com/Bike4Mind/bike4mind/commit/a466c7fd0143132cade0db08a2b1039238a1d3f7), [`868ff68`](https://github.com/Bike4Mind/bike4mind/commit/868ff68dc17ea92cf24292d6124d1757bdbe88a5), [`73c675c`](https://github.com/Bike4Mind/bike4mind/commit/73c675c64e0be1189c0aa8e4c1c59a86ab388104), [`8b32da9`](https://github.com/Bike4Mind/bike4mind/commit/8b32da9f4bea124592f83fc3a007df164139bc70), [`6f32290`](https://github.com/Bike4Mind/bike4mind/commit/6f322902280cea3fb7ed745e10ea49d47a186f8d), [`4b046c1`](https://github.com/Bike4Mind/bike4mind/commit/4b046c1a77916a76fadd7cacceb9b86f17d791c7), [`c4792db`](https://github.com/Bike4Mind/bike4mind/commit/c4792db25539db71ca079fa91e6e2054626b7846), [`a1550b5`](https://github.com/Bike4Mind/bike4mind/commit/a1550b5b1db0ce1fa75d3a818f52cd224a458195), [`d299e48`](https://github.com/Bike4Mind/bike4mind/commit/d299e483d13449ccf91cd3471dde95f0e83cc487), [`71376ea`](https://github.com/Bike4Mind/bike4mind/commit/71376ea83c4435f465b88094c47611a69ec2b5b2), [`e898c7c`](https://github.com/Bike4Mind/bike4mind/commit/e898c7cc920e1d5c3262114651e7bf24f626eab2), [`9da32d2`](https://github.com/Bike4Mind/bike4mind/commit/9da32d26f2a53fd0371c6a27c265ff000358619b)]:
  - @bike4mind/common@16.2.0
  - @bike4mind/utils@8.1.0
  - @bike4mind/llm-adapters@1.3.0
  - @bike4mind/agents@1.2.5
  - @bike4mind/auth@1.1.5
  - @bike4mind/db-core@0.8.5
  - @bike4mind/fab-pipeline@2.1.5
  - @bike4mind/mcp@2.1.5

## 18.1.0

### Minor Changes

- [#4748](https://github.com/Bike4Mind/bike4mind/pull/4748) [`b45a2df`](https://github.com/Bike4Mind/bike4mind/commit/b45a2df434429731ec156d60fce971b3b3987913) Thanks [@poysama](https://github.com/poysama)! - reintegrate the public docs site with CI/CD deploy

- [#5017](https://github.com/Bike4Mind/bike4mind/pull/5017) [`e421f9a`](https://github.com/Bike4Mind/bike4mind/commit/e421f9aab9419637a5baefcddf2ffc7d9725bb0b) Thanks [@onoya](https://github.com/onoya)! - let a personal data lake connect a GitHub repository

- [#5027](https://github.com/Bike4Mind/bike4mind/pull/5027) [`2549cb9`](https://github.com/Bike4Mind/bike4mind/commit/2549cb91c4e7fb9064ed8db28bbaafc9b439bc61) Thanks [@onoya](https://github.com/onoya)! - add append-only admin audit log store and writer

### Patch Changes

- [#5006](https://github.com/Bike4Mind/bike4mind/pull/5006) [`b85ca8b`](https://github.com/Bike4Mind/bike4mind/commit/b85ca8bc9edddc0c85be7403d6c99a44b537a3d3) Thanks [@dea0030](https://github.com/dea0030)! - list the sources a reply cites before the ones it did not

- [#5019](https://github.com/Bike4Mind/bike4mind/pull/5019) [`f144377`](https://github.com/Bike4Mind/bike4mind/commit/f144377e6e845c5e7c0e6d9787c4d5172f6ea3a1) Thanks [@vinchi777](https://github.com/vinchi777)! - keep the streaming heartbeat from overwriting a user Stop

- Updated dependencies [[`b85ca8b`](https://github.com/Bike4Mind/bike4mind/commit/b85ca8bc9edddc0c85be7403d6c99a44b537a3d3), [`e421f9a`](https://github.com/Bike4Mind/bike4mind/commit/e421f9aab9419637a5baefcddf2ffc7d9725bb0b), [`f144377`](https://github.com/Bike4Mind/bike4mind/commit/f144377e6e845c5e7c0e6d9787c4d5172f6ea3a1), [`57b5c68`](https://github.com/Bike4Mind/bike4mind/commit/57b5c689bfcab1d87f40aed39b17cd0566694c8d), [`2549cb9`](https://github.com/Bike4Mind/bike4mind/commit/2549cb91c4e7fb9064ed8db28bbaafc9b439bc61)]:
  - @bike4mind/common@16.1.0
  - @bike4mind/utils@8.0.1
  - @bike4mind/agents@1.2.4
  - @bike4mind/auth@1.1.4
  - @bike4mind/db-core@0.8.4
  - @bike4mind/fab-pipeline@2.1.4
  - @bike4mind/llm-adapters@1.2.1
  - @bike4mind/mcp@2.1.4

## 18.0.0

### Major Changes

- [#4937](https://github.com/Bike4Mind/bike4mind/pull/4937) [`026c8d9`](https://github.com/Bike4Mind/bike4mind/commit/026c8d963affc7b032ebe8a2e2adc2a38f5d823c) Thanks [@onoya](https://github.com/onoya)! - bill org-owned file storage to the organization

### Minor Changes

- [#4654](https://github.com/Bike4Mind/bike4mind/pull/4654) [`57d3468`](https://github.com/Bike4Mind/bike4mind/commit/57d3468c31107cd5b5e7fa819d2ad8b224f02498) Thanks [@jebie](https://github.com/jebie)! - native tool search on direct Anthropic

- [#4970](https://github.com/Bike4Mind/bike4mind/pull/4970) [`077295b`](https://github.com/Bike4Mind/bike4mind/commit/077295b626863b0ecec8866d5c2abf8301fdb2f5) Thanks [@erikbethke](https://github.com/erikbethke)! - let users hide workspace surfaces they don't use

### Patch Changes

- [#4764](https://github.com/Bike4Mind/bike4mind/pull/4764) [`5ea1b6b`](https://github.com/Bike4Mind/bike4mind/commit/5ea1b6b9dfa604c2f869860febdfd83f7c6bf837) Thanks [@onoya](https://github.com/onoya)! - list only the caller's own speech and sound-effect generations

- [#4973](https://github.com/Bike4Mind/bike4mind/pull/4973) [`c380161`](https://github.com/Bike4Mind/bike4mind/commit/c380161df1b4bda5ba5af6bf0ee692689deed661) Thanks [@erikbethke](https://github.com/erikbethke)! - keep the storage code on a share editor's quota refusal, without the owner's counts

- [#4975](https://github.com/Bike4Mind/bike4mind/pull/4975) [`a64ce8a`](https://github.com/Bike4Mind/bike4mind/commit/a64ce8afc9d05d0b988d8eb336d588614893a90d) Thanks [@erikbethke](https://github.com/erikbethke)! - narrated tool-call strip on cut-off replies and notice count

- [#4978](https://github.com/Bike4Mind/bike4mind/pull/4978) [`ecad515`](https://github.com/Bike4Mind/bike4mind/commit/ecad5151d524c027fe8da233fecd30b833ac3c41) Thanks [@erikbethke](https://github.com/erikbethke)! - persist and show a warning when a re-crawl keeps its previous copy for storage quota

- [#4988](https://github.com/Bike4Mind/bike4mind/pull/4988) [`e3663a6`](https://github.com/Bike4Mind/bike4mind/commit/e3663a6252e51a7ef27e90be92e28d785d85964e) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - count tool schemas in the credit reservation

- [#4989](https://github.com/Bike4Mind/bike4mind/pull/4989) [`6a2291f`](https://github.com/Bike4Mind/bike4mind/commit/6a2291f29592aff2a57f1d48b88d105b90d10a7b) Thanks [@onoya](https://github.com/onoya)! - derive tool policy from per-tool descriptors in a tool gateway

- [#4991](https://github.com/Bike4Mind/bike4mind/pull/4991) [`06f2578`](https://github.com/Bike4Mind/bike4mind/commit/06f2578e3753ee70ad8df59b3b3ed16fd6c754a1) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - extract the CLI tool search into b4m-core/agents

- [#5005](https://github.com/Bike4Mind/bike4mind/pull/5005) [`b5d867e`](https://github.com/Bike4Mind/bike4mind/commit/b5d867e9db4783f5100564f60f122e1fdc252d69) Thanks [@onoya](https://github.com/onoya)! - hide personal prompts from API keys on the by-id read

- Updated dependencies [[`57d3468`](https://github.com/Bike4Mind/bike4mind/commit/57d3468c31107cd5b5e7fa819d2ad8b224f02498), [`026c8d9`](https://github.com/Bike4Mind/bike4mind/commit/026c8d963affc7b032ebe8a2e2adc2a38f5d823c), [`167e186`](https://github.com/Bike4Mind/bike4mind/commit/167e186fb7ee88df6a07b6e3539a0a72c92e2f0f), [`077295b`](https://github.com/Bike4Mind/bike4mind/commit/077295b626863b0ecec8866d5c2abf8301fdb2f5), [`c380161`](https://github.com/Bike4Mind/bike4mind/commit/c380161df1b4bda5ba5af6bf0ee692689deed661), [`a64ce8a`](https://github.com/Bike4Mind/bike4mind/commit/a64ce8afc9d05d0b988d8eb336d588614893a90d), [`e774b4a`](https://github.com/Bike4Mind/bike4mind/commit/e774b4ab69877762a15cb7ac59edd082fdc93320), [`d42b0c6`](https://github.com/Bike4Mind/bike4mind/commit/d42b0c62ef7e22ea0c63cffb66ed05402a7d9178), [`ecad515`](https://github.com/Bike4Mind/bike4mind/commit/ecad5151d524c027fe8da233fecd30b833ac3c41), [`f33b246`](https://github.com/Bike4Mind/bike4mind/commit/f33b246c31f172ec274d965e4950856490f5c45b), [`d83ce3a`](https://github.com/Bike4Mind/bike4mind/commit/d83ce3a92238e271112af4a0546886ccdcfa27a6), [`06f2578`](https://github.com/Bike4Mind/bike4mind/commit/06f2578e3753ee70ad8df59b3b3ed16fd6c754a1), [`9921022`](https://github.com/Bike4Mind/bike4mind/commit/9921022be285f866f81fe6c4a5b552595880ec50)]:
  - @bike4mind/common@16.0.0
  - @bike4mind/llm-adapters@1.2.0
  - @bike4mind/utils@8.0.0
  - @bike4mind/fab-pipeline@2.1.3
  - @bike4mind/agents@1.2.3
  - @bike4mind/auth@1.1.3
  - @bike4mind/db-core@0.8.3
  - @bike4mind/mcp@2.1.3

## 17.1.1

### Patch Changes

- [#4957](https://github.com/Bike4Mind/bike4mind/pull/4957) [`56e8751`](https://github.com/Bike4Mind/bike4mind/commit/56e875192f26a0af5ff9aa02a5432b3c15ac2e08) Thanks [@erikbethke](https://github.com/erikbethke)! - hide tool calls a model writes out as text instead of showing them as the answer

- [#4964](https://github.com/Bike4Mind/bike4mind/pull/4964) [`135d47a`](https://github.com/Bike4Mind/bike4mind/commit/135d47aeaa17b6ec4b2782417a0003335e00295e) Thanks [@erikbethke](https://github.com/erikbethke)! - resolve retired pinned models for subagent child executions

- Updated dependencies [[`0afc448`](https://github.com/Bike4Mind/bike4mind/commit/0afc4489cfd31b4dedaceecfbeb4082345917272), [`56e8751`](https://github.com/Bike4Mind/bike4mind/commit/56e875192f26a0af5ff9aa02a5432b3c15ac2e08)]:
  - @bike4mind/common@15.1.1
  - @bike4mind/agents@1.2.2
  - @bike4mind/auth@1.1.2
  - @bike4mind/db-core@0.8.2
  - @bike4mind/fab-pipeline@2.1.2
  - @bike4mind/llm-adapters@1.1.2
  - @bike4mind/mcp@2.1.2
  - @bike4mind/utils@7.1.2

## 17.1.0

### Minor Changes

- [#4760](https://github.com/Bike4Mind/bike4mind/pull/4760) [`63ff370`](https://github.com/Bike4Mind/bike4mind/commit/63ff37067fb8def4f7fb804eb57e7b9ef83c0560) Thanks [@onoya](https://github.com/onoya)! - add Speech and Sound effects tabs; send Files Generate Audio to Studio

### Patch Changes

- [#4895](https://github.com/Bike4Mind/bike4mind/pull/4895) [`0b84602`](https://github.com/Bike4Mind/bike4mind/commit/0b846026127703d2925a1891afc73aec4ffaa236) Thanks [@onoya](https://github.com/onoya)! - end wait=true chat turns at a deadline instead of the Lambda timeout

- [#4943](https://github.com/Bike4Mind/bike4mind/pull/4943) [`6e4bc6b`](https://github.com/Bike4Mind/bike4mind/commit/6e4bc6bd447207a95d0df6863188b818e6bd4dc0) Thanks [@erikbethke](https://github.com/erikbethke)! - fix org-owned research tasks failing to save their report

- [#4945](https://github.com/Bike4Mind/bike4mind/pull/4945) [`a029c26`](https://github.com/Bike4Mind/bike4mind/commit/a029c26fa8bd25b6344dfe64525929bd73cb2bb5) Thanks [@erikbethke](https://github.com/erikbethke)! - persist fileSize only through the content-rewrite commit

- [#4948](https://github.com/Bike4Mind/bike4mind/pull/4948) [`3d47de8`](https://github.com/Bike4Mind/bike4mind/commit/3d47de8e4defa3b78dc14162d5da97423090ab8d) Thanks [@erikbethke](https://github.com/erikbethke)! - list forced-retrieval candidates per lake

- Updated dependencies [[`63ff370`](https://github.com/Bike4Mind/bike4mind/commit/63ff37067fb8def4f7fb804eb57e7b9ef83c0560), [`0b84602`](https://github.com/Bike4Mind/bike4mind/commit/0b846026127703d2925a1891afc73aec4ffaa236), [`f18e199`](https://github.com/Bike4Mind/bike4mind/commit/f18e1994dc83bf650b504e604b35f44bb477baff), [`c825dac`](https://github.com/Bike4Mind/bike4mind/commit/c825dac8ff84d66db5b5c15a310e257cea6acdd3), [`58951e2`](https://github.com/Bike4Mind/bike4mind/commit/58951e2cb07b8bf0adaac6133e66f5f41060b033), [`bb93dbb`](https://github.com/Bike4Mind/bike4mind/commit/bb93dbb7ae9903bf68904ef3625738cb9c0c129c), [`9a2aed3`](https://github.com/Bike4Mind/bike4mind/commit/9a2aed3116a4d81b5fd36e3864fd25dc63f8f3a7)]:
  - @bike4mind/common@15.1.0
  - @bike4mind/auth@1.1.1
  - @bike4mind/agents@1.2.1
  - @bike4mind/db-core@0.8.1
  - @bike4mind/fab-pipeline@2.1.1
  - @bike4mind/llm-adapters@1.1.1
  - @bike4mind/mcp@2.1.1
  - @bike4mind/utils@7.1.1

## 17.0.0

### Major Changes

- [#4331](https://github.com/Bike4Mind/bike4mind/pull/4331) [`0cbe715`](https://github.com/Bike4Mind/bike4mind/commit/0cbe71548676fdbe7647fef37058133753b426e8) Thanks [@dea0030](https://github.com/dea0030)! - require an explicit authOrigin on ToolContext

- [#4462](https://github.com/Bike4Mind/bike4mind/pull/4462) [`3e46049`](https://github.com/Bike4Mind/bike4mind/commit/3e46049023bdb7a05e69eb6fa2fd18577dca76a5) Thanks [@onoya](https://github.com/onoya)! - save every generated asset through saveGeneratedAsset

- [#4487](https://github.com/Bike4Mind/bike4mind/pull/4487) [`2b056ec`](https://github.com/Bike4Mind/bike4mind/commit/2b056ec18dbde6a0582caf51d7f5ae5ce0115d48) Thanks [@erikbethke](https://github.com/erikbethke)! - validate references inside artifact create

- [#4724](https://github.com/Bike4Mind/bike4mind/pull/4724) [`6711c5f`](https://github.com/Bike4Mind/bike4mind/commit/6711c5fe5f8d9c9f1d37e5ba7739fd9a3678a13a) Thanks [@onoya](https://github.com/onoya)! - serve generated media through short-lived signed URLs

- [#4775](https://github.com/Bike4Mind/bike4mind/pull/4775) [`a786791`](https://github.com/Bike4Mind/bike4mind/commit/a786791da684d73d4bf6ccccbb5713af175c3509) Thanks [@onoya](https://github.com/onoya)! - honour a cancel before the provider call and refuse it once a song is rendering

### Minor Changes

- [#3959](https://github.com/Bike4Mind/bike4mind/pull/3959) [`eac5fbd`](https://github.com/Bike4Mind/bike4mind/commit/eac5fbd9b24ecf3c3ad3aa103180717e441965da) Thanks [@vinchi777](https://github.com/vinchi777)! - source-first Create wizard step with a GitHub panel

- [#4140](https://github.com/Bike4Mind/bike4mind/pull/4140) [`8b0b9ad`](https://github.com/Bike4Mind/bike4mind/commit/8b0b9add76f3d5a9737f448164349fe4dd1de927) Thanks [@onoya](https://github.com/onoya)! - add multi-provider Decisions API

- [#4143](https://github.com/Bike4Mind/bike4mind/pull/4143) [`d5363b4`](https://github.com/Bike4Mind/bike4mind/commit/d5363b44894705f5a5e945437ff6d7bd235204ad) Thanks [@julsanchez](https://github.com/julsanchez)! - price gpt-image input images and raise the reference-image cap to 15

- [#4146](https://github.com/Bike4Mind/bike4mind/pull/4146) [`ddd3792`](https://github.com/Bike4Mind/bike4mind/commit/ddd37926424c5748eb85b549c4265c95d6193cb3) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 project update and delete endpoints

- [#4164](https://github.com/Bike4Mind/bike4mind/pull/4164) [`d553e0d`](https://github.com/Bike4Mind/bike4mind/commit/d553e0d6e290d89abe8d5f375d463fbf9ff077d9) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 file list, update and delete endpoints

- [#4192](https://github.com/Bike4Mind/bike4mind/pull/4192) [`e9b4d0a`](https://github.com/Bike4Mind/bike4mind/commit/e9b4d0a15a5f0048f72cc6f543b59e41f2ec0422) Thanks [@julsanchez](https://github.com/julsanchez)! - add public v1 artifacts, transcriptions and quest files endpoints

- [#4214](https://github.com/Bike4Mind/bike4mind/pull/4214) [`d2535a6`](https://github.com/Bike4Mind/bike4mind/commit/d2535a668e73dea53c6002250e33d0dd7a10a12e) Thanks [@erikbethke](https://github.com/erikbethke)! - overlay-declared workspace copy grants and sidebar nav items

- [#4217](https://github.com/Bike4Mind/bike4mind/pull/4217) [`4014ce0`](https://github.com/Bike4Mind/bike4mind/commit/4014ce096c58cac673bcb0eebcd152a7848074ea) Thanks [@onoya](https://github.com/onoya)! - expose video_generation to agent mode with a per-run clip cap

- [#4243](https://github.com/Bike4Mind/bike4mind/pull/4243) [`6857653`](https://github.com/Bike4Mind/bike4mind/commit/6857653b24a6476d14e9efaad819b9ae1792a968) Thanks [@erikbethke](https://github.com/erikbethke)! - visible balance, per-answer cost and new-user welcome

- [#4251](https://github.com/Bike4Mind/bike4mind/pull/4251) [`382f8f6`](https://github.com/Bike4Mind/bike4mind/commit/382f8f60b701d4b93046bd7ff1be6ad7a25a60fc) Thanks [@erikbethke](https://github.com/erikbethke)! - growth and pricing settings in one place

- [#4277](https://github.com/Bike4Mind/bike4mind/pull/4277) [`36ba5dd`](https://github.com/Bike4Mind/bike4mind/commit/36ba5dd550bdff2d69e677100843c5a248d38553) Thanks [@onoya](https://github.com/onoya)! - honour reasoningEffort on Claude for the completions API

- [#4406](https://github.com/Bike4Mind/bike4mind/pull/4406) [`00e7a26`](https://github.com/Bike4Mind/bike4mind/commit/00e7a261cdf3f296bbe22e5f6be68bc5f91d9e45) Thanks [@onoya](https://github.com/onoya)! - make inline [N] citation markers clickable

- [#4491](https://github.com/Bike4Mind/bike4mind/pull/4491) [`18d0d5f`](https://github.com/Bike4Mind/bike4mind/commit/18d0d5fe99dfe3256a72144d7a1924ceec545e21) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - add Bedrock Guardrails fallback for keyless users

- [#4493](https://github.com/Bike4Mind/bike4mind/pull/4493) [`231e762`](https://github.com/Bike4Mind/bike4mind/commit/231e7622bbf54023a8cd635bc4aa5cb3796520b3) Thanks [@onoya](https://github.com/onoya)! - add the music job kind to the generation engine

- [#4495](https://github.com/Bike4Mind/bike4mind/pull/4495) [`b907917`](https://github.com/Bike4Mind/bike4mind/commit/b9079176ad40a5f54052e3e8b35a0251f31f7ba5) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - add NCMEC CyberTipline reporting path for CSAM detection

- [#4503](https://github.com/Bike4Mind/bike4mind/pull/4503) [`9e21e87`](https://github.com/Bike4Mind/bike4mind/commit/9e21e8716531d60e0bdb00d3c91b43c16ca6c14f) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - tag signups with the OAuth client that sent them

- [#4549](https://github.com/Bike4Mind/bike4mind/pull/4549) [`a71e697`](https://github.com/Bike4Mind/bike4mind/commit/a71e6975fcdf1ab8a0b64f3e1a8437483c7c941e) Thanks [@onoya](https://github.com/onoya)! - show Drive and GitHub files that were not ingested, with names and reasons

- [#4562](https://github.com/Bike4Mind/bike4mind/pull/4562) [`4422a54`](https://github.com/Bike4Mind/bike4mind/commit/4422a542e14c9a2e3872d2cba72f747382d214c3) Thanks [@aflordelis](https://github.com/aflordelis)! - unify artifact detection across chat and agent replies

- [#4602](https://github.com/Bike4Mind/bike4mind/pull/4602) [`9656d79`](https://github.com/Bike4Mind/bike4mind/commit/9656d7988332702d1c31040a31e0dc24db20d585) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add stable errorCode and byte counts to quota refusals

- [#4611](https://github.com/Bike4Mind/bike4mind/pull/4611) [`8c93e44`](https://github.com/Bike4Mind/bike4mind/commit/8c93e442a61d092b35e9ede1cb02c0a64c989a1b) Thanks [@onoya](https://github.com/onoya)! - play audio and video in Files with generation details and a generated filter

- [#4621](https://github.com/Bike4Mind/bike4mind/pull/4621) [`cb26e0c`](https://github.com/Bike4Mind/bike4mind/commit/cb26e0c7980d68738308556742bbc6038a8f7379) Thanks [@onoya](https://github.com/onoya)! - persist generated and edited images

- [#4666](https://github.com/Bike4Mind/bike4mind/pull/4666) [`a3dceab`](https://github.com/Bike4Mind/bike4mind/commit/a3dceabbca09029e112a2fcb2839602a19b41965) Thanks [@onoya](https://github.com/onoya)! - add an offline tool-calling scorecard

- [#4670](https://github.com/Bike4Mind/bike4mind/pull/4670) [`70eb763`](https://github.com/Bike4Mind/bike4mind/commit/70eb7633ee731cce9f4a41667cccd0e37bd87419) Thanks [@vinchi777](https://github.com/vinchi777)! - add the Electron desktop client

- [#4671](https://github.com/Bike4Mind/bike4mind/pull/4671) [`e522492`](https://github.com/Bike4Mind/bike4mind/commit/e5224921043739026e3a234e9dd29e6d5f8ee7b5) Thanks [@julsanchez](https://github.com/julsanchez)! - add the Skill Market (publish, safety scan, review, import, rate)

- [#4676](https://github.com/Bike4Mind/bike4mind/pull/4676) [`9052a9d`](https://github.com/Bike4Mind/bike4mind/commit/9052a9d5ddcbfad02b978dc4218e4b26c530f281) Thanks [@onoya](https://github.com/onoya)! - add the public music generation API

- [#4687](https://github.com/Bike4Mind/bike4mind/pull/4687) [`6f26e26`](https://github.com/Bike4Mind/bike4mind/commit/6f26e2637ae06aa215ee79bc4dd0f507bb8e1d57) Thanks [@onoya](https://github.com/onoya)! - run the music_generation tool as a background job

- [#4728](https://github.com/Bike4Mind/bike4mind/pull/4728) [`c6ea6e2`](https://github.com/Bike4Mind/bike4mind/commit/c6ea6e2155fc40aff4c1d3e67868e79dd0adadd9) Thanks [@onoya](https://github.com/onoya)! - cap songs per agent-mode run

- [#4754](https://github.com/Bike4Mind/bike4mind/pull/4754) [`ea9e434`](https://github.com/Bike4Mind/bike4mind/commit/ea9e4343899a55057f36211e87f5ceed2aad8332) Thanks [@ktdejesus](https://github.com/ktdejesus)! - attribute B4M Desktop usage and count it in DAU

- [#4757](https://github.com/Bike4Mind/bike4mind/pull/4757) [`8ed9273`](https://github.com/Bike4Mind/bike4mind/commit/8ed9273aeac5bf47dddeb0145725b03c34231046) Thanks [@vinchi777](https://github.com/vinchi777)! - scheduled storage reconciliation with drift alert

- [#4758](https://github.com/Bike4Mind/bike4mind/pull/4758) [`819632e`](https://github.com/Bike4Mind/bike4mind/commit/819632e71b29e5dab434d2e8a021c8970982dc6c) Thanks [@vinchi777](https://github.com/vinchi777)! - storage usage breakdown per source and per lake

- [#4819](https://github.com/Bike4Mind/bike4mind/pull/4819) [`c6990f9`](https://github.com/Bike4Mind/bike4mind/commit/c6990f9de2dba3e7523c15c82c3986ea3e72f2c9) Thanks [@erikbethke](https://github.com/erikbethke)! - resolve team-plan seats for plan, tier and rate limits

- [#4857](https://github.com/Bike4Mind/bike4mind/pull/4857) [`aa5f140`](https://github.com/Bike4Mind/bike4mind/commit/aa5f140b3dab34eb8d90e521b64b5e26bff80979) Thanks [@onoya](https://github.com/onoya)! - apply user tags and a subscription from partner signup rules

- [#4859](https://github.com/Bike4Mind/bike4mind/pull/4859) [`fac6156`](https://github.com/Bike4Mind/bike4mind/commit/fac61563ba10990bf9650fcb8852b564c3fe2c1b) Thanks [@erikbethke](https://github.com/erikbethke)! - add the custom MCP connection models and settings

- [#4860](https://github.com/Bike4Mind/bike4mind/pull/4860) [`8250a7f`](https://github.com/Bike4Mind/bike4mind/commit/8250a7f6249a237e039934db15a54b895e88f7a8) Thanks [@onoya](https://github.com/onoya)! - persist the owning org on FabFile and add an org storage counter

- [#4863](https://github.com/Bike4Mind/bike4mind/pull/4863) [`0bab465`](https://github.com/Bike4Mind/bike4mind/commit/0bab4656ac106d0513dc34a53e789ae03bd76430) Thanks [@vinchi777](https://github.com/vinchi777)! - report reasoning tokens in the completions usage event

- [#4868](https://github.com/Bike4Mind/bike4mind/pull/4868) [`42b55a9`](https://github.com/Bike4Mind/bike4mind/commit/42b55a94920cb0d47a26007e9230bb05ff84b974) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - deny contributed tools per workspace surface at read time

### Patch Changes

- [#4658](https://github.com/Bike4Mind/bike4mind/pull/4658) [`fa7243d`](https://github.com/Bike4Mind/bike4mind/commit/fa7243d9ae31f8a454920a6780c4a9866d85626b) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - Let notebook sharees with share access create invites. Accepting a notebook, file, or project invite minted by someone other than the owner now re-checks that person's current access: the invite is refused if they no longer hold share, and capped to what they still hold.

- [#4089](https://github.com/Bike4Mind/bike4mind/pull/4089) [`ff80be4`](https://github.com/Bike4Mind/bike4mind/commit/ff80be417aceb09e5e10657f4d3b019621174a12) Thanks [@julsanchez](https://github.com/julsanchez)! - honor an explicit 75% forced-retrieval absolute floor

- [#4172](https://github.com/Bike4Mind/bike4mind/pull/4172) [`64135d1`](https://github.com/Bike4Mind/bike4mind/commit/64135d100a82bee95541f1a9c4ca4d9057aaa37f) Thanks [@onoya](https://github.com/onoya)! - persist attached fabFileIds with an add-only write

- [#4189](https://github.com/Bike4Mind/bike4mind/pull/4189) [`8d879f2`](https://github.com/Bike4Mind/bike4mind/commit/8d879f25b3277e410269a5a254c3ab533d2a684c) Thanks [@jarlacut](https://github.com/jarlacut)! - repair published declarations and check them in CI

- [#4193](https://github.com/Bike4Mind/bike4mind/pull/4193) [`41faa56`](https://github.com/Bike4Mind/bike4mind/commit/41faa565989c3007d37d986825c6c6cd854a2da4) Thanks [@poysama](https://github.com/poysama)! - run atomic daily credit-lot expiry

- [#4196](https://github.com/Bike4Mind/bike4mind/pull/4196) [`f927f61`](https://github.com/Bike4Mind/bike4mind/commit/f927f61ab02c5f46406bd628ef39470bdeca447b) Thanks [@jjmarfa](https://github.com/jjmarfa)! - cache confirmed-empty tool fetches so zero-tool servers stop refetching

- [#4206](https://github.com/Bike4Mind/bike4mind/pull/4206) [`6329fa6`](https://github.com/Bike4Mind/bike4mind/commit/6329fa625bbb7ce72e79bd5baf9ff70cd9676f67) Thanks [@onoya](https://github.com/onoya)! - route more MCP writes through the confirmation gate

- [#4252](https://github.com/Bike4Mind/bike4mind/pull/4252) [`05eb512`](https://github.com/Bike4Mind/bike4mind/commit/05eb512cb5a00544cfad0f6aa8cabd43fff27c15) Thanks [@poysama](https://github.com/poysama)! - sign browser-reachable file downloads

- [#4265](https://github.com/Bike4Mind/bike4mind/pull/4265) [`92970d1`](https://github.com/Bike4Mind/bike4mind/commit/92970d15401e0a7103b88a6caa65eba0b4085de7) Thanks [@erikbethke](https://github.com/erikbethke)! - don't return invitee emails resolved from user ids

- [#4268](https://github.com/Bike4Mind/bike4mind/pull/4268) [`9911721`](https://github.com/Bike4Mind/bike4mind/commit/991172108b69e28d0a65a81a01ee3745b58957e1) Thanks [@erikbethke](https://github.com/erikbethke)! - working key test snippet, scoped key options, JSON 404s and one settled credit event

- [#4269](https://github.com/Bike4Mind/bike4mind/pull/4269) [`f945526`](https://github.com/Bike4Mind/bike4mind/commit/f945526ebd22bbb192e13e01800a15c1fc8685fd) Thanks [@erikbethke](https://github.com/erikbethke)! - findable invites, invite by email and clearer member and share flows

- [#4276](https://github.com/Bike4Mind/bike4mind/pull/4276) [`b142d79`](https://github.com/Bike4Mind/bike4mind/commit/b142d79a0d726cbaa25ff77fa3e1d7884b0033c5) Thanks [@poysama](https://github.com/poysama)! - sign browser URLs in file collections

- [#4317](https://github.com/Bike4Mind/bike4mind/pull/4317) [`0d068f3`](https://github.com/Bike4Mind/bike4mind/commit/0d068f356e3849a0b9dc180e9659b8e17bf2bc87) Thanks [@erikbethke](https://github.com/erikbethke)! - stop forcing tool_choice on Claude models that reject it

- [#4332](https://github.com/Bike4Mind/bike4mind/pull/4332) [`c1bcd94`](https://github.com/Bike4Mind/bike4mind/commit/c1bcd94a299e94300692291912384cba02810900) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - show Team roster controls only to members the API allows

- [#4372](https://github.com/Bike4Mind/bike4mind/pull/4372) [`57a3bdb`](https://github.com/Bike4Mind/bike4mind/commit/57a3bdb8e9ae0004ce01d384dfcd2fcd827c1e33) Thanks [@erikbethke](https://github.com/erikbethke)! - one picker row per model, keyboard-selectable cards, catalog-only Gemini ids

- [#4374](https://github.com/Bike4Mind/bike4mind/pull/4374) [`9e6cef4`](https://github.com/Bike4Mind/bike4mind/commit/9e6cef404f479351e5f3edfd48071f739fa08ff4) Thanks [@erikbethke](https://github.com/erikbethke)! - enforce one-time-code limits per email and bound shared-IP use

- [#4380](https://github.com/Bike4Mind/bike4mind/pull/4380) [`0692ff4`](https://github.com/Bike4Mind/bike4mind/commit/0692ff4250fceba00a2f6d3f33835f5bee8281fa) Thanks [@erikbethke](https://github.com/erikbethke)! - settle stale voice credit holds with a scheduled sweep

- [#4388](https://github.com/Bike4Mind/bike4mind/pull/4388) [`1916e8a`](https://github.com/Bike4Mind/bike4mind/commit/1916e8ace1df142ec718e381859d57bfa4243245) Thanks [@erikbethke](https://github.com/erikbethke)! - bill every realtime voice response once and keep the hold open

- [#4414](https://github.com/Bike4Mind/bike4mind/pull/4414) [`d075a46`](https://github.com/Bike4Mind/bike4mind/commit/d075a46d5310069e45521a88928ec9ac710b325e) Thanks [@jarlacut](https://github.com/jarlacut)! - return real HTTP status for pre-stream completion failures

- [#4417](https://github.com/Bike4Mind/bike4mind/pull/4417) [`e63e96a`](https://github.com/Bike4Mind/bike4mind/commit/e63e96a848a928ada60a34cd2fbf9e26f0d7aff2) Thanks [@juicewaa](https://github.com/juicewaa)! - log the outgoing search request on every provider attempt

- [#4429](https://github.com/Bike4Mind/bike4mind/pull/4429) [`863d5c8`](https://github.com/Bike4Mind/bike4mind/commit/863d5c8eb7ee78087acfee25baf526757a973e89) Thanks [@onoya](https://github.com/onoya)! - stop computing a sync bcrypt hash on key create and rotate

- [#4433](https://github.com/Bike4Mind/bike4mind/pull/4433) [`b75bf86`](https://github.com/Bike4Mind/bike4mind/commit/b75bf8688dc5b39b215c85e9674e9c436591eafd) Thanks [@erikbethke](https://github.com/erikbethke)! - bill voice holds on connected time only

- [#4435](https://github.com/Bike4Mind/bike4mind/pull/4435) [`bd39517`](https://github.com/Bike4Mind/bike4mind/commit/bd39517ba937413731087d9b86b6c515bd75af97) Thanks [@onoya](https://github.com/onoya)! - generic GenerationProvider and shared job public layer

- [#4468](https://github.com/Bike4Mind/bike4mind/pull/4468) [`ea11a77`](https://github.com/Bike4Mind/bike4mind/commit/ea11a77afdfdaebca30a173ceaa0b46fb1a6b450) Thanks [@erikbethke](https://github.com/erikbethke)! - keep pending sign-in code state server-side

- [#4471](https://github.com/Bike4Mind/bike4mind/pull/4471) [`ad3098e`](https://github.com/Bike4Mind/bike4mind/commit/ad3098eb31c97cd100a2fbcb06ccffff6229c333) Thanks [@onoya](https://github.com/onoya)! - grant free credits and stamp verified email on OAuth signup

- [#4474](https://github.com/Bike4Mind/bike4mind/pull/4474) [`ed24bf7`](https://github.com/Bike4Mind/bike4mind/commit/ed24bf7cc5e68aafa89efe5913c4b84dea9316ce) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - stop masked edits losing the race with mask moderation

- [#4483](https://github.com/Bike4Mind/bike4mind/pull/4483) [`6474c58`](https://github.com/Bike4Mind/bike4mind/commit/6474c58cb0afeb4fab6851c4f9c949038fae15de) Thanks [@erikbethke](https://github.com/erikbethke)! - structural pool boundary and max lifetime for exchange keys

- [#4518](https://github.com/Bike4Mind/bike4mind/pull/4518) [`d9dfddf`](https://github.com/Bike4Mind/bike4mind/commit/d9dfddfa6cfff9dc63857e641b37af5963de3b35) Thanks [@jarlacut](https://github.com/jarlacut)! - return unknown_model for unrecognised completion model ids

- [#4547](https://github.com/Bike4Mind/bike4mind/pull/4547) [`4eab687`](https://github.com/Bike4Mind/bike4mind/commit/4eab6879269b3e2d471786455def74043eda60b6) Thanks [@aflordelis](https://github.com/aflordelis)! - move the agent executor handler family into apps/workers

- [#4551](https://github.com/Bike4Mind/bike4mind/pull/4551) [`ea2caf5`](https://github.com/Bike4Mind/bike4mind/commit/ea2caf53c168d521730177e39314228613e10b18) Thanks [@julsanchez](https://github.com/julsanchez)! - don't refund soft-deleted files again on connection purge

- [#4555](https://github.com/Bike4Mind/bike4mind/pull/4555) [`1f030e3`](https://github.com/Bike4Mind/bike4mind/commit/1f030e3cf5e27b2d9fb32479bc9e426c16a600c2) Thanks [@julsanchez](https://github.com/julsanchez)! - refund only bytes that were actually charged

- [#4557](https://github.com/Bike4Mind/bike4mind/pull/4557) [`86bba4a`](https://github.com/Bike4Mind/bike4mind/commit/86bba4a26562a43a06e28951b7b38d9e5867d4c0) Thanks [@julsanchez](https://github.com/julsanchez)! - charge a content rewrite only the size delta

- [#4565](https://github.com/Bike4Mind/bike4mind/pull/4565) [`1b9a028`](https://github.com/Bike4Mind/bike4mind/commit/1b9a028a2464ddb7969c46be3dc8a60430fb5330) Thanks [@erikbethke](https://github.com/erikbethke)! - move notification email helpers to a shared module

- [#4600](https://github.com/Bike4Mind/bike4mind/pull/4600) [`e77dac6`](https://github.com/Bike4Mind/bike4mind/commit/e77dac6f4bf07e81694a139e0deb96c9bde74cf7) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - report ops DAU from an uncapped distinct-user count

- [#4607](https://github.com/Bike4Mind/bike4mind/pull/4607) [`2bee04d`](https://github.com/Bike4Mind/bike4mind/commit/2bee04dbfae7582290d8e774efd28a8c10e57c96) Thanks [@jjmarfa](https://github.com/jjmarfa)! - debit research judge spend against the lake owner's credits

- [#4634](https://github.com/Bike4Mind/bike4mind/pull/4634) [`34b28a5`](https://github.com/Bike4Mind/bike4mind/commit/34b28a5cc08bafe6c0083f325672a9d0a8087d1b) Thanks [@onoya](https://github.com/onoya)! - remove a generated asset's stored copies when its file is deleted

- [#4640](https://github.com/Bike4Mind/bike4mind/pull/4640) [`596a26c`](https://github.com/Bike4Mind/bike4mind/commit/596a26c579c1bfb76f2689d57ff2d47afddb86a0) Thanks [@onoya](https://github.com/onoya)! - require recent verification for account security changes

- [#4645](https://github.com/Bike4Mind/bike4mind/pull/4645) [`c317966`](https://github.com/Bike4Mind/bike4mind/commit/c317966ac743b47b873b47b0148201ff0523b53a) Thanks [@aflordelis](https://github.com/aflordelis)! - move the standalone Lambda handlers into apps/workers

- [#4650](https://github.com/Bike4Mind/bike4mind/pull/4650) [`bc0da01`](https://github.com/Bike4Mind/bike4mind/commit/bc0da019b191b6e8f942bf144666d1819629b1b1) Thanks [@onoya](https://github.com/onoya)! - keep email changes and usernames consistent

- [#4661](https://github.com/Bike4Mind/bike4mind/pull/4661) [`feed5af`](https://github.com/Bike4Mind/bike4mind/commit/feed5af8ba445f23f90f68df4755642c30b8adaa) Thanks [@onoya](https://github.com/onoya)! - tie websocket connections to the session that opened them

- [#4674](https://github.com/Bike4Mind/bike4mind/pull/4674) [`2db94ea`](https://github.com/Bike4Mind/bike4mind/commit/2db94ea1a1fca4dcf10b7e780560cf16613a1cdd) Thanks [@julsanchez](https://github.com/julsanchez)! - price each provider request on its own long-context tier

- [#4677](https://github.com/Bike4Mind/bike4mind/pull/4677) [`6575b54`](https://github.com/Bike4Mind/bike4mind/commit/6575b5417f35708bd2e73cc7c46a5f865fee191c) Thanks [@onoya](https://github.com/onoya)! - gate subagent and DAG-node tool calls on the parent's permission lists

- [#4679](https://github.com/Bike4Mind/bike4mind/pull/4679) [`7b55415`](https://github.com/Bike4Mind/bike4mind/commit/7b55415e6fa513b53cb3756cb06ab99ac6d63b35) Thanks [@julsanchez](https://github.com/julsanchez)! - price agent iterations and subagent runs per request

- [#4681](https://github.com/Bike4Mind/bike4mind/pull/4681) [`fcf293f`](https://github.com/Bike4Mind/bike4mind/commit/fcf293f40b6e2d649269a3e2eb83708b0db2a5cd) Thanks [@onoya](https://github.com/onoya)! - reject inbound mail whose From address SES did not authenticate

- [#4683](https://github.com/Bike4Mind/bike4mind/pull/4683) [`8bb7ec1`](https://github.com/Bike4Mind/bike4mind/commit/8bb7ec15c012844e019f709b43abdb51ccc6da8d) Thanks [@julsanchez](https://github.com/julsanchez)! - bill Gemini and xAI cached tokens and price each request on its own tier

- [#4685](https://github.com/Bike4Mind/bike4mind/pull/4685) [`9615cd3`](https://github.com/Bike4Mind/bike4mind/commit/9615cd38e8b27e4a3a1da37dbf4ca31c95d5f463) Thanks [@onoya](https://github.com/onoya)! - confirm only allowlisted write tools against the values the card shows

- [#4686](https://github.com/Bike4Mind/bike4mind/pull/4686) [`ac39448`](https://github.com/Bike4Mind/bike4mind/commit/ac39448c2386d772dcdaf5680ca5ff7c2576812d) Thanks [@onoya](https://github.com/onoya)! - bind attachment deletes to the listed attachment

- [#4690](https://github.com/Bike4Mind/bike4mind/pull/4690) [`e7aa767`](https://github.com/Bike4Mind/bike4mind/commit/e7aa767ae676f4a8377ec189e13fe1cfe0d4706d) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - delete the stored bytes of an unscannable-format upload on owner delete

- [#4692](https://github.com/Bike4Mind/bike4mind/pull/4692) [`4dbe9e7`](https://github.com/Bike4Mind/bike4mind/commit/4dbe9e7fa39224cdb49c9a6aa41dcd4e71bc808d) Thanks [@onoya](https://github.com/onoya)! - apply the partner domain grant when a login verifies an existing account

- [#4697](https://github.com/Bike4Mind/bike4mind/pull/4697) [`3e4e742`](https://github.com/Bike4Mind/bike4mind/commit/3e4e7427a1e15330cc85ec0c83486cc7638ef3f5) Thanks [@julsanchez](https://github.com/julsanchez)! - bill the streamed output of a stopped or aborted Claude call

- [#4705](https://github.com/Bike4Mind/bike4mind/pull/4705) [`abe12eb`](https://github.com/Bike4Mind/bike4mind/commit/abe12ebe0f3ef3f6ff3f1e9badedcac156cece48) Thanks [@onoya](https://github.com/onoya)! - start the CLI faster by skipping the update wait and heavy imports

- [#4716](https://github.com/Bike4Mind/bike4mind/pull/4716) [`d8018c3`](https://github.com/Bike4Mind/bike4mind/commit/d8018c3be42b71e394dd4de07e5e0d7d126f78c5) Thanks [@jarlacut](https://github.com/jarlacut)! - hide and reject unusable Bedrock models

- [#4720](https://github.com/Bike4Mind/bike4mind/pull/4720) [`2226e00`](https://github.com/Bike4Mind/bike4mind/commit/2226e00973fc2ec077a21149bd76b21551cb694c) Thanks [@onoya](https://github.com/onoya)! - bill image tool calls on delivery, not at start

- [#4730](https://github.com/Bike4Mind/bike4mind/pull/4730) [`19bf657`](https://github.com/Bike4Mind/bike4mind/commit/19bf65775fb89e9af54fe9b229bb912ae749b9cc) Thanks [@onoya](https://github.com/onoya)! - guard remaining server fetchers that take caller-steered URLs

- [#4735](https://github.com/Bike4Mind/bike4mind/pull/4735) [`d6275be`](https://github.com/Bike4Mind/bike4mind/commit/d6275bed435ad13e10d49f2aecd626a95740c2ea) Thanks [@onoya](https://github.com/onoya)! - isolate workflow-step runs from the runner's notebook and integrations

- [#4747](https://github.com/Bike4Mind/bike4mind/pull/4747) [`fcb16fc`](https://github.com/Bike4Mind/bike4mind/commit/fcb16fcb24b971f64a4f01e7cafd3f52415fb732) Thanks [@jarlacut](https://github.com/jarlacut)! - stop model discovery from un-retiring deprecated models

- [#4749](https://github.com/Bike4Mind/bike4mind/pull/4749) [`4a5422b`](https://github.com/Bike4Mind/bike4mind/commit/4a5422bb9be1f377adbef07f9429972e9abce063) Thanks [@onoya](https://github.com/onoya)! - log recoverable SerpAPI attempt failures at warn, not error

- [#4766](https://github.com/Bike4Mind/bike4mind/pull/4766) [`aa7ef67`](https://github.com/Bike4Mind/bike4mind/commit/aa7ef674f1e431277ae4b2a74ac857e2bb627c09) Thanks [@poysama](https://github.com/poysama)! - drop a held future deprecation date when the provider reports the model active

- [#4785](https://github.com/Bike4Mind/bike4mind/pull/4785) [`a501931`](https://github.com/Bike4Mind/bike4mind/commit/a501931f54a60ec752c66edff6b1f44cb849b869) Thanks [@julsanchez](https://github.com/julsanchez)! - keep model fallback on text models that can take the request's tools

- [#4787](https://github.com/Bike4Mind/bike4mind/pull/4787) [`342ed87`](https://github.com/Bike4Mind/bike4mind/commit/342ed873e4820f8e37e65afb39c2556b96a28a26) Thanks [@onoya](https://github.com/onoya)! - let GitHub and Atlassian reads run in subagents

- [#4789](https://github.com/Bike4Mind/bike4mind/pull/4789) [`34d23d0`](https://github.com/Bike4Mind/bike4mind/commit/34d23d0c1dd22dc5df8f8867c9cd751c2069c0ac) Thanks [@onoya](https://github.com/onoya)! - validate ElevenLabs output format and harden the credit hold paths

- [#4793](https://github.com/Bike4Mind/bike4mind/pull/4793) [`b63d2bc`](https://github.com/Bike4Mind/bike4mind/commit/b63d2bc6a1c2127f0bd4224b41473284d2de2b0b) Thanks [@julsanchez](https://github.com/julsanchez)! - stop a failing tool from looping until the tool-call cap

- [#4812](https://github.com/Bike4Mind/bike4mind/pull/4812) [`f59cd1a`](https://github.com/Bike4Mind/bike4mind/commit/f59cd1ae6389cb7e6ebd2a2707fcc6adb40f50e5) Thanks [@erikbethke](https://github.com/erikbethke)! - describe style instead of naming artists in song prompts

- [#4814](https://github.com/Bike4Mind/bike4mind/pull/4814) [`487348b`](https://github.com/Bike4Mind/bike4mind/commit/487348b72280f132767073d1580d8235c6eae201) Thanks [@jarlacut](https://github.com/jarlacut)! - tell users when a retired model is switched to its successor

- [#4815](https://github.com/Bike4Mind/bike4mind/pull/4815) [`803e17d`](https://github.com/Bike4Mind/bike4mind/commit/803e17db0f609c5587edc3e29e0ad76600b791b0) Thanks [@erikbethke](https://github.com/erikbethke)! - redirect hidden or disabled models before the availability check

- [#4816](https://github.com/Bike4Mind/bike4mind/pull/4816) [`dd91050`](https://github.com/Bike4Mind/bike4mind/commit/dd91050b61a636711de5c823775f8aaba3495212) Thanks [@maconard](https://github.com/maconard)! - search every data lake in a chat, not just the one whose files sort first

- [#4817](https://github.com/Bike4Mind/bike4mind/pull/4817) [`2532430`](https://github.com/Bike4Mind/bike4mind/commit/2532430b003c3d7734c0b45c4eac31bc7680ef4e) Thanks [@erikbethke](https://github.com/erikbethke)! - label a redirected reply with the model that answered

- [#4821](https://github.com/Bike4Mind/bike4mind/pull/4821) [`769a1c8`](https://github.com/Bike4Mind/bike4mind/commit/769a1c8d6fa0557d77a46bdd3de2534ea458f3b9) Thanks [@maconard](https://github.com/maconard)! - make an existing chat search the data lake picked for it

- [#4847](https://github.com/Bike4Mind/bike4mind/pull/4847) [`8ef244f`](https://github.com/Bike4Mind/bike4mind/commit/8ef244f7cc9a4e9f010422b66a17257fc3af3b30) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - show GitHub repo folders in the lake tree and keep them across re-syncs

- [#4849](https://github.com/Bike4Mind/bike4mind/pull/4849) [`20e307a`](https://github.com/Bike4Mind/bike4mind/commit/20e307a05c7a394ba3a2c51fc4a9455c7cee56b1) Thanks [@maconard](https://github.com/maconard)! - stop a too-high relevance threshold from emptying answers without notice

- [#4850](https://github.com/Bike4Mind/bike4mind/pull/4850) [`5d97d15`](https://github.com/Bike4Mind/bike4mind/commit/5d97d154517899ae09aabd9048ba63061efe3cc9) Thanks [@maconard](https://github.com/maconard)! - fail an upload when its embedding key is missing instead of using a different model

- [#4851](https://github.com/Bike4Mind/bike4mind/pull/4851) [`ada174b`](https://github.com/Bike4Mind/bike4mind/commit/ada174bca0c0d6024c7b59595bcbf81a34303bf6) Thanks [@maconard](https://github.com/maconard)! - find the right documents for follow-up questions

- [#4852](https://github.com/Bike4Mind/bike4mind/pull/4852) [`dd90faa`](https://github.com/Bike4Mind/bike4mind/commit/dd90faa62116d06b3b1865dfa183be4402029378) Thanks [@maconard](https://github.com/maconard)! - remove citation chips when the retrieved passages did not fit the model context

- [#4853](https://github.com/Bike4Mind/bike4mind/pull/4853) [`6df4968`](https://github.com/Bike4Mind/bike4mind/commit/6df4968d983f2e3c21ca16bc015cb69fae77b3af) Thanks [@maconard](https://github.com/maconard)! - keep forced retrieval on attachment turns when a lake is chosen

- [#4854](https://github.com/Bike4Mind/bike4mind/pull/4854) [`b8848c8`](https://github.com/Bike4Mind/bike4mind/commit/b8848c88f6a8099baf3aa155120af5dea41c5ff7) Thanks [@maconard](https://github.com/maconard)! - suffix a new lake's slug when a moved lake still holds its tag

- [#4856](https://github.com/Bike4Mind/bike4mind/pull/4856) [`197e1df`](https://github.com/Bike4Mind/bike4mind/commit/197e1df99af23886e08fd87e30a12be086f6acb1) Thanks [@maconard](https://github.com/maconard)! - report files whose passage rebuild has not committed yet

- [#4877](https://github.com/Bike4Mind/bike4mind/pull/4877) [`7546222`](https://github.com/Bike4Mind/bike4mind/commit/7546222b382d7cfa8a4357785a02ed1ae95dc171) Thanks [@onoya](https://github.com/onoya)! - reject replayed TOTP codes and make the MFA lockout race-safe

- [#4888](https://github.com/Bike4Mind/bike4mind/pull/4888) [`5ee132a`](https://github.com/Bike4Mind/bike4mind/commit/5ee132a43b86f0c85fad0ede144890ad6a6e5148) Thanks [@jjmarfa](https://github.com/jjmarfa)! - end an early-closed Responses stream as a stop or interrupted reply

- [#4900](https://github.com/Bike4Mind/bike4mind/pull/4900) [`b725422`](https://github.com/Bike4Mind/bike4mind/commit/b7254221e569379cb61a697eb55aa1d6c8ed85bf) Thanks [@jarlacut](https://github.com/jarlacut)! - stop a refused chat turn from pinning or running its model

- [#4902](https://github.com/Bike4Mind/bike4mind/pull/4902) [`65df5ea`](https://github.com/Bike4Mind/bike4mind/commit/65df5ea108ec75b8183966f8dba556c0a4a6a022) Thanks [@jjmarfa](https://github.com/jjmarfa)! - fair-order a registry lake as one bucket, not one per scope arm

- Updated dependencies [[`2684a62`](https://github.com/Bike4Mind/bike4mind/commit/2684a6225aca69a1d9cc1e522dc63b5dbcedee5d), [`413b085`](https://github.com/Bike4Mind/bike4mind/commit/413b0859331d804d8b26fbc3d6f53c173dea9764), [`7da670f`](https://github.com/Bike4Mind/bike4mind/commit/7da670f8868e9cf0f30ddf97b6bcd799c0cc0992), [`8b0b9ad`](https://github.com/Bike4Mind/bike4mind/commit/8b0b9add76f3d5a9737f448164349fe4dd1de927), [`ddd3792`](https://github.com/Bike4Mind/bike4mind/commit/ddd37926424c5748eb85b549c4265c95d6193cb3), [`270d5c2`](https://github.com/Bike4Mind/bike4mind/commit/270d5c2275d56b79fc9b4591682479cded1de442), [`d553e0d`](https://github.com/Bike4Mind/bike4mind/commit/d553e0d6e290d89abe8d5f375d463fbf9ff077d9), [`9e8e683`](https://github.com/Bike4Mind/bike4mind/commit/9e8e683270d93003dd254b8908cc878d40b1b6db), [`64135d1`](https://github.com/Bike4Mind/bike4mind/commit/64135d100a82bee95541f1a9c4ca4d9057aaa37f), [`416fe11`](https://github.com/Bike4Mind/bike4mind/commit/416fe118d70ecbb52e132a036ba5314d7fec6f3d), [`2684a62`](https://github.com/Bike4Mind/bike4mind/commit/2684a6225aca69a1d9cc1e522dc63b5dbcedee5d), [`8ad3249`](https://github.com/Bike4Mind/bike4mind/commit/8ad32497393db0a4a0d01b419ca398a276d46b11), [`8d879f2`](https://github.com/Bike4Mind/bike4mind/commit/8d879f25b3277e410269a5a254c3ab533d2a684c), [`e9b4d0a`](https://github.com/Bike4Mind/bike4mind/commit/e9b4d0a15a5f0048f72cc6f543b59e41f2ec0422), [`f927f61`](https://github.com/Bike4Mind/bike4mind/commit/f927f61ab02c5f46406bd628ef39470bdeca447b), [`6329fa6`](https://github.com/Bike4Mind/bike4mind/commit/6329fa625bbb7ce72e79bd5baf9ff70cd9676f67), [`d2535a6`](https://github.com/Bike4Mind/bike4mind/commit/d2535a668e73dea53c6002250e33d0dd7a10a12e), [`4014ce0`](https://github.com/Bike4Mind/bike4mind/commit/4014ce096c58cac673bcb0eebcd152a7848074ea), [`c6be81b`](https://github.com/Bike4Mind/bike4mind/commit/c6be81b06904f920d8deec900dc241daaffdd6bb), [`f405f92`](https://github.com/Bike4Mind/bike4mind/commit/f405f925af800f85079e35cb4c510bae6aca783c), [`6857653`](https://github.com/Bike4Mind/bike4mind/commit/6857653b24a6476d14e9efaad819b9ae1792a968), [`d645fac`](https://github.com/Bike4Mind/bike4mind/commit/d645fac844755c997e702bf95fe11faa1716cffd), [`a543c77`](https://github.com/Bike4Mind/bike4mind/commit/a543c77991e50229e34b0dbe4cc6e2b90687c95b), [`382f8f6`](https://github.com/Bike4Mind/bike4mind/commit/382f8f60b701d4b93046bd7ff1be6ad7a25a60fc), [`92970d1`](https://github.com/Bike4Mind/bike4mind/commit/92970d15401e0a7103b88a6caa65eba0b4085de7), [`36ba5dd`](https://github.com/Bike4Mind/bike4mind/commit/36ba5dd550bdff2d69e677100843c5a248d38553), [`1acb21d`](https://github.com/Bike4Mind/bike4mind/commit/1acb21dd1791b74254f9bc4390c0bc5d1e58acf1), [`3c62db5`](https://github.com/Bike4Mind/bike4mind/commit/3c62db5ca409311f0c5cbc15f9b33d85ba5a12c8), [`9c51de6`](https://github.com/Bike4Mind/bike4mind/commit/9c51de6ceabb5e6dd8859b78ad7cdaa34bc88802), [`921a039`](https://github.com/Bike4Mind/bike4mind/commit/921a039c1ec872eebeda409961a5c5cc2d2de5ac), [`0d068f3`](https://github.com/Bike4Mind/bike4mind/commit/0d068f356e3849a0b9dc180e9659b8e17bf2bc87), [`0cbe715`](https://github.com/Bike4Mind/bike4mind/commit/0cbe71548676fdbe7647fef37058133753b426e8), [`c1bcd94`](https://github.com/Bike4Mind/bike4mind/commit/c1bcd94a299e94300692291912384cba02810900), [`022470b`](https://github.com/Bike4Mind/bike4mind/commit/022470bd2471f0eddf60bd37bee0aca80028bbfd), [`d0c1e57`](https://github.com/Bike4Mind/bike4mind/commit/d0c1e5742deb81aaa000b7ea2074e0ce1cc1913c), [`57a3bdb`](https://github.com/Bike4Mind/bike4mind/commit/57a3bdb8e9ae0004ce01d384dfcd2fcd827c1e33), [`489980e`](https://github.com/Bike4Mind/bike4mind/commit/489980ed4b181a26b5a0086c23d1a2b663270d32), [`0692ff4`](https://github.com/Bike4Mind/bike4mind/commit/0692ff4250fceba00a2f6d3f33835f5bee8281fa), [`ac59e6e`](https://github.com/Bike4Mind/bike4mind/commit/ac59e6ebdb34b6fb3679ccc927ac3cbbebc02b11), [`1916e8a`](https://github.com/Bike4Mind/bike4mind/commit/1916e8ace1df142ec718e381859d57bfa4243245), [`3faee39`](https://github.com/Bike4Mind/bike4mind/commit/3faee396882e23c6957fb45163620d1bd7c91932), [`49ca156`](https://github.com/Bike4Mind/bike4mind/commit/49ca156c7b613e6bba234e2e3b57a1387a602ee9), [`00e7a26`](https://github.com/Bike4Mind/bike4mind/commit/00e7a261cdf3f296bbe22e5f6be68bc5f91d9e45), [`b8c8263`](https://github.com/Bike4Mind/bike4mind/commit/b8c826320505ff660ed366b7c5abaefc8d66f660), [`d075a46`](https://github.com/Bike4Mind/bike4mind/commit/d075a46d5310069e45521a88928ec9ac710b325e), [`a2f9d5f`](https://github.com/Bike4Mind/bike4mind/commit/a2f9d5fbda2485e4d00ee772a75d4df4e56a5c00), [`1744af0`](https://github.com/Bike4Mind/bike4mind/commit/1744af05c88e0b5ee9e83f501f6880af3ce2a229), [`ea17e18`](https://github.com/Bike4Mind/bike4mind/commit/ea17e18fb5e554819ba014eb5bc957681d00caca), [`863d5c8`](https://github.com/Bike4Mind/bike4mind/commit/863d5c8eb7ee78087acfee25baf526757a973e89), [`b75bf86`](https://github.com/Bike4Mind/bike4mind/commit/b75bf8688dc5b39b215c85e9674e9c436591eafd), [`bd39517`](https://github.com/Bike4Mind/bike4mind/commit/bd39517ba937413731087d9b86b6c515bd75af97), [`5b096c7`](https://github.com/Bike4Mind/bike4mind/commit/5b096c7f0db1014e2c924091202046b8d027088e), [`860624a`](https://github.com/Bike4Mind/bike4mind/commit/860624ac3e6284d64aefbea9915363dd98378e78), [`3e46049`](https://github.com/Bike4Mind/bike4mind/commit/3e46049023bdb7a05e69eb6fa2fd18577dca76a5), [`48016b1`](https://github.com/Bike4Mind/bike4mind/commit/48016b142b5168e849acf2454b2421ff0747cd0d), [`ad3098e`](https://github.com/Bike4Mind/bike4mind/commit/ad3098eb31c97cd100a2fbcb06ccffff6229c333), [`1f97700`](https://github.com/Bike4Mind/bike4mind/commit/1f97700b02f82f4f83f7fa57b5b6233aec76f597), [`f9b43d2`](https://github.com/Bike4Mind/bike4mind/commit/f9b43d2b2728a02f4870ce867adf900ca3db39ab), [`18d0d5f`](https://github.com/Bike4Mind/bike4mind/commit/18d0d5fe99dfe3256a72144d7a1924ceec545e21), [`231e762`](https://github.com/Bike4Mind/bike4mind/commit/231e7622bbf54023a8cd635bc4aa5cb3796520b3), [`b907917`](https://github.com/Bike4Mind/bike4mind/commit/b9079176ad40a5f54052e3e8b35a0251f31f7ba5), [`9e21e87`](https://github.com/Bike4Mind/bike4mind/commit/9e21e8716531d60e0bdb00d3c91b43c16ca6c14f), [`22c1443`](https://github.com/Bike4Mind/bike4mind/commit/22c1443a14104a38c671fcd339dbc457fecb985e), [`d9dfddf`](https://github.com/Bike4Mind/bike4mind/commit/d9dfddfa6cfff9dc63857e641b37af5963de3b35), [`d0e3bf4`](https://github.com/Bike4Mind/bike4mind/commit/d0e3bf4458d179006a2859cfeceb6a4805b27397), [`4eab687`](https://github.com/Bike4Mind/bike4mind/commit/4eab6879269b3e2d471786455def74043eda60b6), [`a71e697`](https://github.com/Bike4Mind/bike4mind/commit/a71e6975fcdf1ab8a0b64f3e1a8437483c7c941e), [`329f0db`](https://github.com/Bike4Mind/bike4mind/commit/329f0db7315cc330976a08b892b099117cdb2d9f), [`4622d0f`](https://github.com/Bike4Mind/bike4mind/commit/4622d0fbf4ecb1298c8ca5769387cc2e533299f6), [`1f030e3`](https://github.com/Bike4Mind/bike4mind/commit/1f030e3cf5e27b2d9fb32479bc9e426c16a600c2), [`86bba4a`](https://github.com/Bike4Mind/bike4mind/commit/86bba4a26562a43a06e28951b7b38d9e5867d4c0), [`4422a54`](https://github.com/Bike4Mind/bike4mind/commit/4422a542e14c9a2e3872d2cba72f747382d214c3), [`f629cdd`](https://github.com/Bike4Mind/bike4mind/commit/f629cdd5ac489deb5b4dcd9e65e8ee7d156b47b7), [`7c9f77a`](https://github.com/Bike4Mind/bike4mind/commit/7c9f77a2e344b1c743894931785195de54e11cc1), [`32923a0`](https://github.com/Bike4Mind/bike4mind/commit/32923a0af533f65121be2f29b928bfdef4417549), [`37a8844`](https://github.com/Bike4Mind/bike4mind/commit/37a8844e98868251b1725987d427f8810c86faeb), [`e77dac6`](https://github.com/Bike4Mind/bike4mind/commit/e77dac6f4bf07e81694a139e0deb96c9bde74cf7), [`9656d79`](https://github.com/Bike4Mind/bike4mind/commit/9656d7988332702d1c31040a31e0dc24db20d585), [`2bee04d`](https://github.com/Bike4Mind/bike4mind/commit/2bee04dbfae7582290d8e774efd28a8c10e57c96), [`76dc400`](https://github.com/Bike4Mind/bike4mind/commit/76dc4002c6e409fc8c69b67bbce9f11182fc35b4), [`8c93e44`](https://github.com/Bike4Mind/bike4mind/commit/8c93e442a61d092b35e9ede1cb02c0a64c989a1b), [`c8030a2`](https://github.com/Bike4Mind/bike4mind/commit/c8030a231a8227b656f316ff9265ad08a8f7b24a), [`aca73ca`](https://github.com/Bike4Mind/bike4mind/commit/aca73ca6908301a25aca1457c18a15b21ddd2185), [`0e24dce`](https://github.com/Bike4Mind/bike4mind/commit/0e24dcef3f637cd8d10f2d5495f1ee3062aaffbd), [`3c26baa`](https://github.com/Bike4Mind/bike4mind/commit/3c26baa783477b0a1fa9dbe24269160faffd00f6), [`34b28a5`](https://github.com/Bike4Mind/bike4mind/commit/34b28a5cc08bafe6c0083f325672a9d0a8087d1b), [`d82d8b3`](https://github.com/Bike4Mind/bike4mind/commit/d82d8b309fcf73291434ad6d1add189bc84ea03e), [`596a26c`](https://github.com/Bike4Mind/bike4mind/commit/596a26c579c1bfb76f2689d57ff2d47afddb86a0), [`c317966`](https://github.com/Bike4Mind/bike4mind/commit/c317966ac743b47b873b47b0148201ff0523b53a), [`bc0da01`](https://github.com/Bike4Mind/bike4mind/commit/bc0da019b191b6e8f942bf144666d1819629b1b1), [`dd37361`](https://github.com/Bike4Mind/bike4mind/commit/dd373618fa3206de0954958b7cf795b388179d6c), [`b3f1045`](https://github.com/Bike4Mind/bike4mind/commit/b3f10456d2830e0d4144d8846a08344b9fb2902f), [`feed5af`](https://github.com/Bike4Mind/bike4mind/commit/feed5af8ba445f23f90f68df4755642c30b8adaa), [`52ad028`](https://github.com/Bike4Mind/bike4mind/commit/52ad02860f51559f1bace89ad490102437e32d1c), [`a3dceab`](https://github.com/Bike4Mind/bike4mind/commit/a3dceabbca09029e112a2fcb2839602a19b41965), [`d6cbc27`](https://github.com/Bike4Mind/bike4mind/commit/d6cbc275e79e31f3dbd512f2b7db8c76a72a2eee), [`70eb763`](https://github.com/Bike4Mind/bike4mind/commit/70eb7633ee731cce9f4a41667cccd0e37bd87419), [`e522492`](https://github.com/Bike4Mind/bike4mind/commit/e5224921043739026e3a234e9dd29e6d5f8ee7b5), [`2db94ea`](https://github.com/Bike4Mind/bike4mind/commit/2db94ea1a1fca4dcf10b7e780560cf16613a1cdd), [`05ad035`](https://github.com/Bike4Mind/bike4mind/commit/05ad035faa1f9dc64b692808f8f0490e7c332591), [`9052a9d`](https://github.com/Bike4Mind/bike4mind/commit/9052a9d5ddcbfad02b978dc4218e4b26c530f281), [`6575b54`](https://github.com/Bike4Mind/bike4mind/commit/6575b5417f35708bd2e73cc7c46a5f865fee191c), [`eecffd3`](https://github.com/Bike4Mind/bike4mind/commit/eecffd346cbef79e0a633352b6212657ad6d2d8d), [`7b55415`](https://github.com/Bike4Mind/bike4mind/commit/7b55415e6fa513b53cb3756cb06ab99ac6d63b35), [`8bb7ec1`](https://github.com/Bike4Mind/bike4mind/commit/8bb7ec15c012844e019f709b43abdb51ccc6da8d), [`5ee2b91`](https://github.com/Bike4Mind/bike4mind/commit/5ee2b919a9a6d07505f8806b1a1b8eb4f0df97b9), [`9615cd3`](https://github.com/Bike4Mind/bike4mind/commit/9615cd38e8b27e4a3a1da37dbf4ca31c95d5f463), [`ac39448`](https://github.com/Bike4Mind/bike4mind/commit/ac39448c2386d772dcdaf5680ca5ff7c2576812d), [`6f26e26`](https://github.com/Bike4Mind/bike4mind/commit/6f26e2637ae06aa215ee79bc4dd0f507bb8e1d57), [`c295a57`](https://github.com/Bike4Mind/bike4mind/commit/c295a57cd01737da22ab10ce4992b9338e0cdbe8), [`e7aa767`](https://github.com/Bike4Mind/bike4mind/commit/e7aa767ae676f4a8377ec189e13fe1cfe0d4706d), [`eb0a121`](https://github.com/Bike4Mind/bike4mind/commit/eb0a121eb1e0b31f9f5359c984b20d8b6b9fdec9), [`3e4e742`](https://github.com/Bike4Mind/bike4mind/commit/3e4e7427a1e15330cc85ec0c83486cc7638ef3f5), [`abe12eb`](https://github.com/Bike4Mind/bike4mind/commit/abe12ebe0f3ef3f6ff3f1e9badedcac156cece48), [`d8018c3`](https://github.com/Bike4Mind/bike4mind/commit/d8018c3be42b71e394dd4de07e5e0d7d126f78c5), [`2226e00`](https://github.com/Bike4Mind/bike4mind/commit/2226e00973fc2ec077a21149bd76b21551cb694c), [`6711c5f`](https://github.com/Bike4Mind/bike4mind/commit/6711c5fe5f8d9c9f1d37e5ba7739fd9a3678a13a), [`c6ea6e2`](https://github.com/Bike4Mind/bike4mind/commit/c6ea6e2155fc40aff4c1d3e67868e79dd0adadd9), [`e841be1`](https://github.com/Bike4Mind/bike4mind/commit/e841be14c6840bd30f86ff8e618ddf4d0427f532), [`19bf657`](https://github.com/Bike4Mind/bike4mind/commit/19bf65775fb89e9af54fe9b229bb912ae749b9cc), [`d6275be`](https://github.com/Bike4Mind/bike4mind/commit/d6275bed435ad13e10d49f2aecd626a95740c2ea), [`04d2d8c`](https://github.com/Bike4Mind/bike4mind/commit/04d2d8c05738cff64119d4fdbaf8b480f93a18a1), [`fcb16fc`](https://github.com/Bike4Mind/bike4mind/commit/fcb16fcb24b971f64a4f01e7cafd3f52415fb732), [`719ca2d`](https://github.com/Bike4Mind/bike4mind/commit/719ca2ddd52c66e966f904772b4c4c58615254ab), [`ea9e434`](https://github.com/Bike4Mind/bike4mind/commit/ea9e4343899a55057f36211e87f5ceed2aad8332), [`8ed9273`](https://github.com/Bike4Mind/bike4mind/commit/8ed9273aeac5bf47dddeb0145725b03c34231046), [`819632e`](https://github.com/Bike4Mind/bike4mind/commit/819632e71b29e5dab434d2e8a021c8970982dc6c), [`0722e63`](https://github.com/Bike4Mind/bike4mind/commit/0722e630193fedaf627e3465404c8a1d121cd62f), [`0d96e9e`](https://github.com/Bike4Mind/bike4mind/commit/0d96e9e68a8082930b44ddf7153523f77532efb8), [`2f4069a`](https://github.com/Bike4Mind/bike4mind/commit/2f4069a8a45d1e73d11000c138cc28a7de8b01b9), [`6ea5a12`](https://github.com/Bike4Mind/bike4mind/commit/6ea5a12fd1255269b4b78ece0b2db57e46b350be), [`268235b`](https://github.com/Bike4Mind/bike4mind/commit/268235b2a7ab08d9f6e166eedc6019d6b1d07e23), [`a786791`](https://github.com/Bike4Mind/bike4mind/commit/a786791da684d73d4bf6ccccbb5713af175c3509), [`a501931`](https://github.com/Bike4Mind/bike4mind/commit/a501931f54a60ec752c66edff6b1f44cb849b869), [`342ed87`](https://github.com/Bike4Mind/bike4mind/commit/342ed873e4820f8e37e65afb39c2556b96a28a26), [`34d23d0`](https://github.com/Bike4Mind/bike4mind/commit/34d23d0c1dd22dc5df8f8867c9cd751c2069c0ac), [`b63d2bc`](https://github.com/Bike4Mind/bike4mind/commit/b63d2bc6a1c2127f0bd4224b41473284d2de2b0b), [`06e97d6`](https://github.com/Bike4Mind/bike4mind/commit/06e97d645237a84108a5a9dc9a1218905ce612ee), [`487348b`](https://github.com/Bike4Mind/bike4mind/commit/487348b72280f132767073d1580d8235c6eae201), [`803e17d`](https://github.com/Bike4Mind/bike4mind/commit/803e17db0f609c5587edc3e29e0ad76600b791b0), [`2532430`](https://github.com/Bike4Mind/bike4mind/commit/2532430b003c3d7734c0b45c4eac31bc7680ef4e), [`c6990f9`](https://github.com/Bike4Mind/bike4mind/commit/c6990f9de2dba3e7523c15c82c3986ea3e72f2c9), [`769a1c8`](https://github.com/Bike4Mind/bike4mind/commit/769a1c8d6fa0557d77a46bdd3de2534ea458f3b9), [`8ef244f`](https://github.com/Bike4Mind/bike4mind/commit/8ef244f7cc9a4e9f010422b66a17257fc3af3b30), [`20e307a`](https://github.com/Bike4Mind/bike4mind/commit/20e307a05c7a394ba3a2c51fc4a9455c7cee56b1), [`5d97d15`](https://github.com/Bike4Mind/bike4mind/commit/5d97d154517899ae09aabd9048ba63061efe3cc9), [`6df4968`](https://github.com/Bike4Mind/bike4mind/commit/6df4968d983f2e3c21ca16bc015cb69fae77b3af), [`f2088bb`](https://github.com/Bike4Mind/bike4mind/commit/f2088bb001a065c9224b4e06c64b239e707c7d26), [`197e1df`](https://github.com/Bike4Mind/bike4mind/commit/197e1df99af23886e08fd87e30a12be086f6acb1), [`aa5f140`](https://github.com/Bike4Mind/bike4mind/commit/aa5f140b3dab34eb8d90e521b64b5e26bff80979), [`17376a8`](https://github.com/Bike4Mind/bike4mind/commit/17376a88660f5ab5d0358a5f69b11ab645d1cb21), [`fac6156`](https://github.com/Bike4Mind/bike4mind/commit/fac61563ba10990bf9650fcb8852b564c3fe2c1b), [`8250a7f`](https://github.com/Bike4Mind/bike4mind/commit/8250a7f6249a237e039934db15a54b895e88f7a8), [`0bab465`](https://github.com/Bike4Mind/bike4mind/commit/0bab4656ac106d0513dc34a53e789ae03bd76430), [`42b55a9`](https://github.com/Bike4Mind/bike4mind/commit/42b55a94920cb0d47a26007e9230bb05ff84b974), [`8e28dd8`](https://github.com/Bike4Mind/bike4mind/commit/8e28dd83047b4d7274fa6fd84cfdd6d0271a9763), [`7546222`](https://github.com/Bike4Mind/bike4mind/commit/7546222b382d7cfa8a4357785a02ed1ae95dc171), [`e497e42`](https://github.com/Bike4Mind/bike4mind/commit/e497e423b78cd68a4737b243dc22755357012e58), [`5ee132a`](https://github.com/Bike4Mind/bike4mind/commit/5ee132a43b86f0c85fad0ede144890ad6a6e5148)]:
  - @bike4mind/common@15.0.0
  - @bike4mind/utils@7.1.0
  - @bike4mind/db-core@0.8.0
  - @bike4mind/fab-pipeline@2.1.0
  - @bike4mind/llm-adapters@1.1.0
  - @bike4mind/mcp@2.1.0
  - @bike4mind/auth@1.1.0
  - @bike4mind/agents@1.2.0

## 16.0.0

### Major Changes

- [#3968](https://github.com/Bike4Mind/bike4mind/pull/3968) [`342a68a`](https://github.com/Bike4Mind/bike4mind/commit/342a68aa84d32e921432728dd90c72641da010a1) Thanks [@onoya](https://github.com/onoya)! - replace the Sora video endpoint with multi-provider video generations

### Minor Changes

- [#3853](https://github.com/Bike4Mind/bike4mind/pull/3853) [`07bf79d`](https://github.com/Bike4Mind/bike4mind/commit/07bf79d8577905e36014edc10003c42e72a21316) Thanks [@poysama](https://github.com/poysama)! - execute local notebook curation with durable receipts

- [#3922](https://github.com/Bike4Mind/bike4mind/pull/3922) [`6358d6c`](https://github.com/Bike4Mind/bike4mind/commit/6358d6c21c8e34a493d1bd7e734317eb157a8114) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - create a GitHub lake and start its connect in one call

- [#3923](https://github.com/Bike4Mind/bike4mind/pull/3923) [`745dfea`](https://github.com/Bike4Mind/bike4mind/commit/745dfea4c0fdd093150fa546dd78e1510500ccb5) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - offer the lake's own source in the finish-connect banner

- [#3983](https://github.com/Bike4Mind/bike4mind/pull/3983) [`50c8fa5`](https://github.com/Bike4Mind/bike4mind/commit/50c8fa5d7cb961deee0f3b14ae11234b3cd2644d) Thanks [@onoya](https://github.com/onoya)! - add the Video Studio at /studio/video

- [#4012](https://github.com/Bike4Mind/bike4mind/pull/4012) [`a8c4ab2`](https://github.com/Bike4Mind/bike4mind/commit/a8c4ab24044e9937c2f0af22429016af73e0d425) Thanks [@onoya](https://github.com/onoya)! - add subject-agnostic lake RAG eval bank and grader

- [#4029](https://github.com/Bike4Mind/bike4mind/pull/4029) [`48ccf11`](https://github.com/Bike4Mind/bike4mind/commit/48ccf11ff9a536cf7c9fb7d3057ad3a3a23ea93c) Thanks [@onoya](https://github.com/onoya)! - add GET /api/v1/sessions to the generated public API docs

- [#4032](https://github.com/Bike4Mind/bike4mind/pull/4032) [`c52f485`](https://github.com/Bike4Mind/bike4mind/commit/c52f485cc9198289375e201c5aaaa24b24978283) Thanks [@onoya](https://github.com/onoya)! - add public v1 project list, get and create endpoints

- [#4033](https://github.com/Bike4Mind/bike4mind/pull/4033) [`5a067b0`](https://github.com/Bike4Mind/bike4mind/commit/5a067b09f79dc65f6f02d12b18280bf26b2f2268) Thanks [@onoya](https://github.com/onoya)! - let the chat agent generate videos with a live job card

- [#4038](https://github.com/Bike4Mind/bike4mind/pull/4038) [`2784aea`](https://github.com/Bike4Mind/bike4mind/commit/2784aea964ef1ba610407d28e94bfef2c92198e4) Thanks [@vinchi777](https://github.com/vinchi777)! - identified SSO-passthrough embed mode with per-user memory

- [#4042](https://github.com/Bike4Mind/bike4mind/pull/4042) [`3e5efa7`](https://github.com/Bike4Mind/bike4mind/commit/3e5efa790ed3bd5daa6824577cfd0025502d6a76) Thanks [@vinchi777](https://github.com/vinchi777)! - emit ProcessingFailed metric from CLI and embed completion paths

- [#4048](https://github.com/Bike4Mind/bike4mind/pull/4048) [`a3c0741`](https://github.com/Bike4Mind/bike4mind/commit/a3c0741674bb1f185110396241de8d1596001e7a) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - let lake chats leave out the caller's library, with a My files toggle

- [#4123](https://github.com/Bike4Mind/bike4mind/pull/4123) [`ad7b0b0`](https://github.com/Bike4Mind/bike4mind/commit/ad7b0b08cfc2b76ce511424ac3cee9d2e614dc8a) Thanks [@onoya](https://github.com/onoya)! - accept a generated image as the image-to-video input

### Patch Changes

- [#3880](https://github.com/Bike4Mind/bike4mind/pull/3880) [`979b44d`](https://github.com/Bike4Mind/bike4mind/commit/979b44d71823c0b82a4c1f922b3eabbe1013b824) Thanks [@julsanchez](https://github.com/julsanchez)! - resolve API-key principals to the key name in config history

- [#3908](https://github.com/Bike4Mind/bike4mind/pull/3908) [`e76712e`](https://github.com/Bike4Mind/bike4mind/commit/e76712e59e04b64fb113f8c140b933fe81f8ced5) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - include administered orgs in account-wide excluded count

- [#3921](https://github.com/Bike4Mind/bike4mind/pull/3921) [`42f93fb`](https://github.com/Bike4Mind/bike4mind/commit/42f93fb838829cb815d3f6a441ba450d7ad74cda) Thanks [@dea0030](https://github.com/dea0030)! - carry create-only session fields through clone, fork and snip

- [#3935](https://github.com/Bike4Mind/bike4mind/pull/3935) [`14b6798`](https://github.com/Bike4Mind/bike4mind/commit/14b6798f6ac2eb43e485242db67f34fd4682b369) Thanks [@julsanchez](https://github.com/julsanchez)! - group the lake picker by a stable effective-owner key

- [#3943](https://github.com/Bike4Mind/bike4mind/pull/3943) [`3b25f75`](https://github.com/Bike4Mind/bike4mind/commit/3b25f750531255ff3774935248d942db22dd73a4) Thanks [@vinchi777](https://github.com/vinchi777)! - let grant revocation reach soft-deleted docs

- [#3948](https://github.com/Bike4Mind/bike4mind/pull/3948) [`dbb9b9a`](https://github.com/Bike4Mind/bike4mind/commit/dbb9b9a32b6b8c41e74d4fce0fd733bd195ea0d0) Thanks [@vinchi777](https://github.com/vinchi777)! - enforce notebook import storage quota across imports

- [#3950](https://github.com/Bike4Mind/bike4mind/pull/3950) [`7063e18`](https://github.com/Bike4Mind/bike4mind/commit/7063e180b2ea5c405304e5eef56c208bd6ad74c9) Thanks [@vinchi777](https://github.com/vinchi777)! - show tool-generated audio and images in the File Browser

- [#3957](https://github.com/Bike4Mind/bike4mind/pull/3957) [`380dd56`](https://github.com/Bike4Mind/bike4mind/commit/380dd5669d9b25734410a83e5ef9240cb2baa8af) Thanks [@vinchi777](https://github.com/vinchi777)! - record refusal UsageEvents so the Spend refusal rate is populated

- [#3963](https://github.com/Bike4Mind/bike4mind/pull/3963) [`b39a54f`](https://github.com/Bike4Mind/bike4mind/commit/b39a54f19f4c35c44014a07fa0b9f34db1b2985b) Thanks [@onoya](https://github.com/onoya)! - serialize lake writes up to their external step against a grant revoke

- [#3965](https://github.com/Bike4Mind/bike4mind/pull/3965) [`6d59a74`](https://github.com/Bike4Mind/bike4mind/commit/6d59a7451d76d17f18b85d37c2f4c86f1972c283) Thanks [@onoya](https://github.com/onoya)! - serialize long manage writes up to their claim against a grant revoke

- [#3967](https://github.com/Bike4Mind/bike4mind/pull/3967) [`56d4363`](https://github.com/Bike4Mind/bike4mind/commit/56d43635e2e4302cebdf4a2e6b691177be434ae5) Thanks [@jjmarfa](https://github.com/jjmarfa)! - populate first-token timing so slow-first-token anomalies fire

- [#3971](https://github.com/Bike4Mind/bike4mind/pull/3971) [`d9bf1a1`](https://github.com/Bike4Mind/bike4mind/commit/d9bf1a13f467f8807a7972cc76b7fbbf0a0b9b03) Thanks [@julsanchez](https://github.com/julsanchez)! - pick a free tag prefix when recreating a deleted lake

- [#3986](https://github.com/Bike4Mind/bike4mind/pull/3986) [`5907b66`](https://github.com/Bike4Mind/bike4mind/commit/5907b66551679d755253a0e546d917f9dd4b90f6) Thanks [@dea0030](https://github.com/dea0030)! - resolve lifecycle actions by lake id only

- [#3990](https://github.com/Bike4Mind/bike4mind/pull/3990) [`281bf08`](https://github.com/Bike4Mind/bike4mind/commit/281bf0872309ca7774bfa59a770d0c5810aa7bfb) Thanks [@dea0030](https://github.com/dea0030)! - keep the source session's surface on a snip

- [#3991](https://github.com/Bike4Mind/bike4mind/pull/3991) [`89c5938`](https://github.com/Bike4Mind/bike4mind/commit/89c5938df001ef300d0221852b69ce2b9d2862fe) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - trust adapter price literals in model promotion

- [#4004](https://github.com/Bike4Mind/bike4mind/pull/4004) [`190c592`](https://github.com/Bike4Mind/bike4mind/commit/190c59227a558b03f9993f8582fcce8e646b2da9) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - make per-user key cap atomic via insert-then-recount

- [#4005](https://github.com/Bike4Mind/bike4mind/pull/4005) [`128c504`](https://github.com/Bike4Mind/bike4mind/commit/128c504ae50a80d29daa85613bba438c7acf0c2f) Thanks [@vinchi777](https://github.com/vinchi777)! - price cached context at the cache-read rate when reserving CLI credits

- [#4037](https://github.com/Bike4Mind/bike4mind/pull/4037) [`2142ebf`](https://github.com/Bike4Mind/bike4mind/commit/2142ebfdaeccde9177e7d9e5a301f4137790ea22) Thanks [@julsanchez](https://github.com/julsanchez)! - reach Bedrock on self-host through dedicated credentials

- [#4044](https://github.com/Bike4Mind/bike4mind/pull/4044) [`24ae8dc`](https://github.com/Bike4Mind/bike4mind/commit/24ae8dcfa1f40cb64ec6c0705c3b5c236c3a0fbf) Thanks [@jjmarfa](https://github.com/jjmarfa)! - break the llm cycle and expose leaf-clean subpaths

- [#4061](https://github.com/Bike4Mind/bike4mind/pull/4061) [`52d3b05`](https://github.com/Bike4Mind/bike4mind/commit/52d3b05ce83be476dbd6a66d241a7453fedb67a2) Thanks [@dea0030](https://github.com/dea0030)! - make the curated-to-connector-fed switch atomic with the GitHub connect start

- [#4070](https://github.com/Bike4Mind/bike4mind/pull/4070) [`c339691`](https://github.com/Bike4Mind/bike4mind/commit/c339691834b3b451c58a407b51766d5f5b975c58) Thanks [@dea0030](https://github.com/dea0030)! - carry tool lists and systemPromptId through clone, fork and snip

- [#4076](https://github.com/Bike4Mind/bike4mind/pull/4076) [`b403ac4`](https://github.com/Bike4Mind/bike4mind/commit/b403ac4a07d2c6d6faf9ca285833feaedfddb3fc) Thanks [@jarlacut](https://github.com/jarlacut)! - surface Bedrock profile ids that absence leaves frozen

- [#4080](https://github.com/Bike4Mind/bike4mind/pull/4080) [`b668e95`](https://github.com/Bike4Mind/bike4mind/commit/b668e9523f742f1506d63b2b4cde8260373cadbc) Thanks [@onoya](https://github.com/onoya)! - end the turn after a navigation-only tool round

- [#4085](https://github.com/Bike4Mind/bike4mind/pull/4085) [`fd749ed`](https://github.com/Bike4Mind/bike4mind/commit/fd749ed74f631f5d554939b41f7df8cf1398b754) Thanks [@aflordelis](https://github.com/aflordelis)! - move quest export and lake ingest queue handlers into apps/workers

- [#4086](https://github.com/Bike4Mind/bike4mind/pull/4086) [`10f55af`](https://github.com/Bike4Mind/bike4mind/commit/10f55af80887ca5ca6991dc29b4e8e6fbf85b0b0) Thanks [@aflordelis](https://github.com/aflordelis)! - move image generation and edit queue handlers into apps/workers

- [#4091](https://github.com/Bike4Mind/bike4mind/pull/4091) [`13c8d10`](https://github.com/Bike4Mind/bike4mind/commit/13c8d10c873f5448d4411cebe948fe630d430b3c) Thanks [@julsanchez](https://github.com/julsanchez)! - clear stale user organization pointers

- [#4092](https://github.com/Bike4Mind/bike4mind/pull/4092) [`8247441`](https://github.com/Bike4Mind/bike4mind/commit/8247441c95843c48a5bdfb740a839cd5651c5463) Thanks [@onoya](https://github.com/onoya)! - skip the incomplete-answer notice after a turn-ending tool

- [#4093](https://github.com/Bike4Mind/bike4mind/pull/4093) [`c4c3955`](https://github.com/Bike4Mind/bike4mind/commit/c4c39553e18eab2fe6f89bd2cfd9d37cd16ab17b) Thanks [@dea0030](https://github.com/dea0030)! - resolve the remaining manage and write routes by lake id only

- [#4116](https://github.com/Bike4Mind/bike4mind/pull/4116) [`05bf416`](https://github.com/Bike4Mind/bike4mind/commit/05bf416c5dbc126a5ab00dcfdd22df47f98b0d5f) Thanks [@onoya](https://github.com/onoya)! - check ownership of generated-image keys in edit_image

- [#4132](https://github.com/Bike4Mind/bike4mind/pull/4132) [`9e6e3b0`](https://github.com/Bike4Mind/bike4mind/commit/9e6e3b0c2481e9c6da6d1b75638fd16639ab8194) Thanks [@onoya](https://github.com/onoya)! - persist the chat video card as soon as the job is created

- [#4136](https://github.com/Bike4Mind/bike4mind/pull/4136) [`ccb4d30`](https://github.com/Bike4Mind/bike4mind/commit/ccb4d30ee6e2b6d7371b3b99774153ec8988b702) Thanks [@onoya](https://github.com/onoya)! - harden the write-tool confirmation flow

- [#4161](https://github.com/Bike4Mind/bike4mind/pull/4161) [`2602fc9`](https://github.com/Bike4Mind/bike4mind/commit/2602fc9e9aa35ac2f4fcaaf4e497e111f2395c38) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - carry prompt text, temperature and tool-call cap onto copies

- Updated dependencies [[`1b5ac9d`](https://github.com/Bike4Mind/bike4mind/commit/1b5ac9d8b5c5ca3dbeb5c23c60263d98d329a034), [`ccb4d30`](https://github.com/Bike4Mind/bike4mind/commit/ccb4d30ee6e2b6d7371b3b99774153ec8988b702), [`442c666`](https://github.com/Bike4Mind/bike4mind/commit/442c666523c42791cbb6b730853197ecd291a0f7), [`52cccac`](https://github.com/Bike4Mind/bike4mind/commit/52cccac190a8b81c973978038cf9f14400aeceb2), [`979b44d`](https://github.com/Bike4Mind/bike4mind/commit/979b44d71823c0b82a4c1f922b3eabbe1013b824), [`dfb0427`](https://github.com/Bike4Mind/bike4mind/commit/dfb042798fb6c92f16859980d00c14affcbdefa2), [`e76712e`](https://github.com/Bike4Mind/bike4mind/commit/e76712e59e04b64fb113f8c140b933fe81f8ced5), [`f0877e3`](https://github.com/Bike4Mind/bike4mind/commit/f0877e3893a2ad53d9ead07c8395792f1cb9cc80), [`6358d6c`](https://github.com/Bike4Mind/bike4mind/commit/6358d6c21c8e34a493d1bd7e734317eb157a8114), [`745dfea`](https://github.com/Bike4Mind/bike4mind/commit/745dfea4c0fdd093150fa546dd78e1510500ccb5), [`fa6cad8`](https://github.com/Bike4Mind/bike4mind/commit/fa6cad8adffaec711268808c1d37e2adc2a2af6e), [`d3156bf`](https://github.com/Bike4Mind/bike4mind/commit/d3156bf2127fbd01ea28fc50bb4360f60dee0dce), [`14b6798`](https://github.com/Bike4Mind/bike4mind/commit/14b6798f6ac2eb43e485242db67f34fd4682b369), [`3b25f75`](https://github.com/Bike4Mind/bike4mind/commit/3b25f750531255ff3774935248d942db22dd73a4), [`dbb9b9a`](https://github.com/Bike4Mind/bike4mind/commit/dbb9b9a32b6b8c41e74d4fce0fd733bd195ea0d0), [`7063e18`](https://github.com/Bike4Mind/bike4mind/commit/7063e180b2ea5c405304e5eef56c208bd6ad74c9), [`5ac32cf`](https://github.com/Bike4Mind/bike4mind/commit/5ac32cff321399a50eb3520ef2f2c2e9f5627fbe), [`380dd56`](https://github.com/Bike4Mind/bike4mind/commit/380dd5669d9b25734410a83e5ef9240cb2baa8af), [`34f491c`](https://github.com/Bike4Mind/bike4mind/commit/34f491c62e641d1121c15923364a8ec162512cdc), [`b39a54f`](https://github.com/Bike4Mind/bike4mind/commit/b39a54f19f4c35c44014a07fa0b9f34db1b2985b), [`56d4363`](https://github.com/Bike4Mind/bike4mind/commit/56d43635e2e4302cebdf4a2e6b691177be434ae5), [`342a68a`](https://github.com/Bike4Mind/bike4mind/commit/342a68aa84d32e921432728dd90c72641da010a1), [`d9bf1a1`](https://github.com/Bike4Mind/bike4mind/commit/d9bf1a13f467f8807a7972cc76b7fbbf0a0b9b03), [`d3690b4`](https://github.com/Bike4Mind/bike4mind/commit/d3690b461873e0f11989284a6f1d8f66e32ebe7f), [`50c8fa5`](https://github.com/Bike4Mind/bike4mind/commit/50c8fa5d7cb961deee0f3b14ae11234b3cd2644d), [`5907b66`](https://github.com/Bike4Mind/bike4mind/commit/5907b66551679d755253a0e546d917f9dd4b90f6), [`89c5938`](https://github.com/Bike4Mind/bike4mind/commit/89c5938df001ef300d0221852b69ce2b9d2862fe), [`6fa1181`](https://github.com/Bike4Mind/bike4mind/commit/6fa1181e7078c4e36a33e45d560fce7926e5fcc1), [`190c592`](https://github.com/Bike4Mind/bike4mind/commit/190c59227a558b03f9993f8582fcce8e646b2da9), [`128c504`](https://github.com/Bike4Mind/bike4mind/commit/128c504ae50a80d29daa85613bba438c7acf0c2f), [`2b0f761`](https://github.com/Bike4Mind/bike4mind/commit/2b0f7618a7cfb26689ebeceb6e236ec783cceacb), [`c9b6ce6`](https://github.com/Bike4Mind/bike4mind/commit/c9b6ce651dd88dbe666a253e439fce71435d10ea), [`fcec8c8`](https://github.com/Bike4Mind/bike4mind/commit/fcec8c8980df42d032df92b597519fd8b796a243), [`48ccf11`](https://github.com/Bike4Mind/bike4mind/commit/48ccf11ff9a536cf7c9fb7d3057ad3a3a23ea93c), [`85a6b07`](https://github.com/Bike4Mind/bike4mind/commit/85a6b07d0665e66ed8714c9113ea3774ff049368), [`5a067b0`](https://github.com/Bike4Mind/bike4mind/commit/5a067b09f79dc65f6f02d12b18280bf26b2f2268), [`2142ebf`](https://github.com/Bike4Mind/bike4mind/commit/2142ebfdaeccde9177e7d9e5a301f4137790ea22), [`2784aea`](https://github.com/Bike4Mind/bike4mind/commit/2784aea964ef1ba610407d28e94bfef2c92198e4), [`766aef9`](https://github.com/Bike4Mind/bike4mind/commit/766aef961bc8b721247f51a53b8f1f8ecb052aa3), [`1154408`](https://github.com/Bike4Mind/bike4mind/commit/1154408ea4686c9a330efac69b5e69007defa122), [`8af61ce`](https://github.com/Bike4Mind/bike4mind/commit/8af61ce21605847ddceb5d9d3b5901ba7706d19f), [`c5ce159`](https://github.com/Bike4Mind/bike4mind/commit/c5ce15963ab2d6bba555f653e331095ac7ec3275), [`45eca4d`](https://github.com/Bike4Mind/bike4mind/commit/45eca4db5004ec39ba8cc8b5d39461b87d009c4a), [`5ef61d6`](https://github.com/Bike4Mind/bike4mind/commit/5ef61d652da7feecd8259e8f8fbcc720ca86811d), [`c44d38d`](https://github.com/Bike4Mind/bike4mind/commit/c44d38d290bd775e08f65d3a6544c2b6a0121207), [`b668e95`](https://github.com/Bike4Mind/bike4mind/commit/b668e9523f742f1506d63b2b4cde8260373cadbc), [`8247441`](https://github.com/Bike4Mind/bike4mind/commit/8247441c95843c48a5bdfb740a839cd5651c5463), [`ebaf5cd`](https://github.com/Bike4Mind/bike4mind/commit/ebaf5cddc21461f41a6e27abb527cdc0287a9478), [`05bf416`](https://github.com/Bike4Mind/bike4mind/commit/05bf416c5dbc126a5ab00dcfdd22df47f98b0d5f), [`ad7b0b0`](https://github.com/Bike4Mind/bike4mind/commit/ad7b0b08cfc2b76ce511424ac3cee9d2e614dc8a), [`ac71151`](https://github.com/Bike4Mind/bike4mind/commit/ac71151caf575311863f5367e55e5fa73d38b432), [`54d7dd6`](https://github.com/Bike4Mind/bike4mind/commit/54d7dd6081da91698e0f3ca5fdc8b30680e775a3), [`42c7f71`](https://github.com/Bike4Mind/bike4mind/commit/42c7f71cc65d14733264a62e9e3f09eb430e165d), [`ccb4d30`](https://github.com/Bike4Mind/bike4mind/commit/ccb4d30ee6e2b6d7371b3b99774153ec8988b702), [`e9afd46`](https://github.com/Bike4Mind/bike4mind/commit/e9afd4637c67a4fee0c1a25a5dae8f0d8eab6e61), [`918379b`](https://github.com/Bike4Mind/bike4mind/commit/918379b5b3ef21d7cb43f8e297da6950ebef96e9), [`660f464`](https://github.com/Bike4Mind/bike4mind/commit/660f464289df7422c4cae71b66f0d8ce143b6065), [`519af20`](https://github.com/Bike4Mind/bike4mind/commit/519af2035fa1bd52cc8968601d705edc7e7d638b)]:
  - @bike4mind/auth@1.0.0
  - @bike4mind/common@14.0.0
  - @bike4mind/fab-pipeline@2.0.0
  - @bike4mind/utils@7.0.0
  - @bike4mind/db-core@0.7.4
  - @bike4mind/llm-adapters@1.0.0
  - @bike4mind/mcp@2.0.19
  - @bike4mind/agents@1.1.3

## 15.1.0

### Minor Changes

- [#3899](https://github.com/Bike4Mind/bike4mind/pull/3899) [`254ae9f`](https://github.com/Bike4Mind/bike4mind/commit/254ae9ff0702b92b3a41d620d5a020c9c026afb6) Thanks [@onoya](https://github.com/onoya)! - add the generation job engine and video job foundation

### Patch Changes

- [#3876](https://github.com/Bike4Mind/bike4mind/pull/3876) [`9bbfd8c`](https://github.com/Bike4Mind/bike4mind/commit/9bbfd8c1d6f66da7e433bcf233d4e2a6c37637c7) Thanks [@julsanchez](https://github.com/julsanchez)! - stop resolving deleted lakes by slug and preview the real slug

- [#3894](https://github.com/Bike4Mind/bike4mind/pull/3894) [`ea66cbb`](https://github.com/Bike4Mind/bike4mind/commit/ea66cbb0257bb8264c5c6e60a8a9209e9f24da9a) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - validate API keys with a SHA-256 digest instead of bcrypt

- Updated dependencies [[`9bbfd8c`](https://github.com/Bike4Mind/bike4mind/commit/9bbfd8c1d6f66da7e433bcf233d4e2a6c37637c7), [`ea66cbb`](https://github.com/Bike4Mind/bike4mind/commit/ea66cbb0257bb8264c5c6e60a8a9209e9f24da9a), [`254ae9f`](https://github.com/Bike4Mind/bike4mind/commit/254ae9ff0702b92b3a41d620d5a020c9c026afb6), [`45d7c5e`](https://github.com/Bike4Mind/bike4mind/commit/45d7c5e86ce91cbffcbf1efe3bf606593af5deac)]:
  - @bike4mind/common@13.1.0
  - @bike4mind/fab-pipeline@1.6.0
  - @bike4mind/utils@6.6.0
  - @bike4mind/agents@1.1.2
  - @bike4mind/auth@0.9.2
  - @bike4mind/db-core@0.7.3
  - @bike4mind/llm-adapters@0.16.2
  - @bike4mind/mcp@2.0.18

## 15.0.0

### Major Changes

- [#3884](https://github.com/Bike4Mind/bike4mind/pull/3884) [`31d4623`](https://github.com/Bike4Mind/bike4mind/commit/31d46236619fd7e0c2be3f3bc4d34ee69314e682) Thanks [@onoya](https://github.com/onoya)! - deliver all generated audio through one shared module, by URL when oversized

### Minor Changes

- [#3766](https://github.com/Bike4Mind/bike4mind/pull/3766) [`99033fe`](https://github.com/Bike4Mind/bike4mind/commit/99033fe34169925190d1cad36aa45c5c7fc956a4) Thanks [@onoya](https://github.com/onoya)! - expose per-model image capabilities (sizes, limits, supported params)

- [#3863](https://github.com/Bike4Mind/bike4mind/pull/3863) [`9bd1edf`](https://github.com/Bike4Mind/bike4mind/commit/9bd1edf146cbf8e6b43d413ff94b5f5f4740f311) Thanks [@onoya](https://github.com/onoya)! - show which image models support transparent backgrounds

- [#3866](https://github.com/Bike4Mind/bike4mind/pull/3866) [`23bd5c7`](https://github.com/Bike4Mind/bike4mind/commit/23bd5c7680423502c5033bb83f6988d9916e76c6) Thanks [@onoya](https://github.com/onoya)! - manage and show monthly member credit budgets

### Patch Changes

- [#3841](https://github.com/Bike4Mind/bike4mind/pull/3841) [`4c46065`](https://github.com/Bike4Mind/bike4mind/commit/4c46065b22954e0f8e6afdec0e497e741de92a2d) Thanks [@jarlacut](https://github.com/jarlacut)! - show each lake's uncategorized files inside its own folder

- [#3844](https://github.com/Bike4Mind/bike4mind/pull/3844) [`51967fa`](https://github.com/Bike4Mind/bike4mind/commit/51967fa9f533bdfec3eeefd9a14552259e40728a) Thanks [@julsanchez](https://github.com/julsanchez)! - hedge lake research web search across providers

- Updated dependencies [[`99033fe`](https://github.com/Bike4Mind/bike4mind/commit/99033fe34169925190d1cad36aa45c5c7fc956a4), [`4c46065`](https://github.com/Bike4Mind/bike4mind/commit/4c46065b22954e0f8e6afdec0e497e741de92a2d), [`ad14801`](https://github.com/Bike4Mind/bike4mind/commit/ad14801acd6de3230b2dc9819586f402ae047cb4), [`9bd1edf`](https://github.com/Bike4Mind/bike4mind/commit/9bd1edf146cbf8e6b43d413ff94b5f5f4740f311), [`88587cc`](https://github.com/Bike4Mind/bike4mind/commit/88587cc0acdfc7ca0658c8d0c92b8c6852cd79d1), [`23bd5c7`](https://github.com/Bike4Mind/bike4mind/commit/23bd5c7680423502c5033bb83f6988d9916e76c6), [`04d895f`](https://github.com/Bike4Mind/bike4mind/commit/04d895f7bf3053326bb8d0871ebefb389fe37dec), [`a728e8c`](https://github.com/Bike4Mind/bike4mind/commit/a728e8c8a459c177cce15a978dd0418a6085129e), [`3942bbc`](https://github.com/Bike4Mind/bike4mind/commit/3942bbc9dbceb5356ae18f016fe8c0684f43ffef), [`c8ac9ba`](https://github.com/Bike4Mind/bike4mind/commit/c8ac9ba4856dfc472f2e55d80b7013c28429f0eb), [`31d4623`](https://github.com/Bike4Mind/bike4mind/commit/31d46236619fd7e0c2be3f3bc4d34ee69314e682), [`c4d2bd4`](https://github.com/Bike4Mind/bike4mind/commit/c4d2bd49a6bc6bccec224924e899f89de9dca269), [`53b4bf8`](https://github.com/Bike4Mind/bike4mind/commit/53b4bf80608b99cfb16bfc58960621c332e7c0b3)]:
  - @bike4mind/common@13.0.0
  - @bike4mind/db-core@0.7.2
  - @bike4mind/utils@6.5.1
  - @bike4mind/agents@1.1.1
  - @bike4mind/auth@0.9.1
  - @bike4mind/fab-pipeline@1.5.3
  - @bike4mind/llm-adapters@0.16.1
  - @bike4mind/mcp@2.0.17

## 14.2.0

### Minor Changes

- [#3656](https://github.com/Bike4Mind/bike4mind/pull/3656) [`9c03692`](https://github.com/Bike4Mind/bike4mind/commit/9c03692a2b4bf06e81cfa3c9d73813d9ffa8e7bd) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - flag lakes chat retrieval cannot search in the picker and scope strip

- [#3700](https://github.com/Bike4Mind/bike4mind/pull/3700) [`db87b77`](https://github.com/Bike4Mind/bike4mind/commit/db87b7730203867c4e2f94a8900b51de804e8c90) Thanks [@onoya](https://github.com/onoya)! - let a personal data lake connect a Google Drive folder

- [#3713](https://github.com/Bike4Mind/bike4mind/pull/3713) [`8ada8ca`](https://github.com/Bike4Mind/bike4mind/commit/8ada8cae802a64ef92a635044e68539a51507965) Thanks [@erikbethke](https://github.com/erikbethke)! - clone, fork or move a notebook into another workspace

- [#3714](https://github.com/Bike4Mind/bike4mind/pull/3714) [`993d00e`](https://github.com/Bike4Mind/bike4mind/commit/993d00e916ce3f7b0b682544b3457b3a261095af) Thanks [@erikbethke](https://github.com/erikbethke)! - record session origin and generated image count

- [#3716](https://github.com/Bike4Mind/bike4mind/pull/3716) [`4401e08`](https://github.com/Bike4Mind/bike4mind/commit/4401e08ac6947ae1d61c06b89fb39b742e79dd03) Thanks [@erikbethke](https://github.com/erikbethke)! - hedge web_search with a backup provider

- [#3717](https://github.com/Bike4Mind/bike4mind/pull/3717) [`974f6a9`](https://github.com/Bike4Mind/bike4mind/commit/974f6a98798bd50b954802730c91886fc023307f) Thanks [@erikbethke](https://github.com/erikbethke)! - run SearXNG as an internal web-search backend

- [#3718](https://github.com/Bike4Mind/bike4mind/pull/3718) [`d1e2a5d`](https://github.com/Bike4Mind/bike4mind/commit/d1e2a5d22d42dc7dead35a2f53ca29e22d711994) Thanks [@erikbethke](https://github.com/erikbethke)! - render a reply's next-step choices as numbered buttons

- [#3811](https://github.com/Bike4Mind/bike4mind/pull/3811) [`377bea9`](https://github.com/Bike4Mind/bike4mind/commit/377bea9855a55de1140f6bbea9b815893d42bb6e) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - notify previous owner when API key changes hands on rotation

- [#3852](https://github.com/Bike4Mind/bike4mind/pull/3852) [`d0ac85c`](https://github.com/Bike4Mind/bike4mind/commit/d0ac85c3192529cc8b679856627031e7560a0ef9) Thanks [@vinchi777](https://github.com/vinchi777)! - forward a reasoningEffort option to the LLM adapter

- [#3862](https://github.com/Bike4Mind/bike4mind/pull/3862) [`51ac5f4`](https://github.com/Bike4Mind/bike4mind/commit/51ac5f4cf502ea00f4401c3b81158363d42f0705) Thanks [@onoya](https://github.com/onoya)! - make the per-member credit cap a monthly budget with per-member overrides

### Patch Changes

- [#3412](https://github.com/Bike4Mind/bike4mind/pull/3412) [`ac9be44`](https://github.com/Bike4Mind/bike4mind/commit/ac9be444b5961a25499f322645701ca4d2a37d35) Thanks [@vinchi777](https://github.com/vinchi777)! - persist and expose model fallback info

- [#3532](https://github.com/Bike4Mind/bike4mind/pull/3532) [`f38dd70`](https://github.com/Bike4Mind/bike4mind/commit/f38dd70dd37d2b80d47a131562cc8dcfdc907021) Thanks [@jjmarfa](https://github.com/jjmarfa)! - stop counting expired keys against the per-user API key cap

- [#3710](https://github.com/Bike4Mind/bike4mind/pull/3710) [`d4bb5f0`](https://github.com/Bike4Mind/bike4mind/commit/d4bb5f051b13778c2e24e7234d07e03068623532) Thanks [@erikbethke](https://github.com/erikbethke)! - harden web_search resilience and diagnosis accuracy

- [#3711](https://github.com/Bike4Mind/bike4mind/pull/3711) [`3700531`](https://github.com/Bike4Mind/bike4mind/commit/3700531d6a0160563a17339c3561d377c76a9e0c) Thanks [@erikbethke](https://github.com/erikbethke)! - keep a session's surface when cloning or forking

- [#3720](https://github.com/Bike4Mind/bike4mind/pull/3720) [`3bd6a36`](https://github.com/Bike4Mind/bike4mind/commit/3bd6a368a8db2f5a0a9a22099b389c4f521a025c) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - count administered-org lakes in excluded-lake count

- [#3732](https://github.com/Bike4Mind/bike4mind/pull/3732) [`ebc8be5`](https://github.com/Bike4Mind/bike4mind/commit/ebc8be501a76a99b10edc9814800e209b077443b) Thanks [@dea0030](https://github.com/dea0030)! - correct History upload and review rows

- [#3734](https://github.com/Bike4Mind/bike4mind/pull/3734) [`8eaa7fa`](https://github.com/Bike4Mind/bike4mind/commit/8eaa7fa134f16a2d1f3fb008b77fb21c0aa4e206) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - name a tool timeout in Answer Diagnosis

- [#3738](https://github.com/Bike4Mind/bike4mind/pull/3738) [`99331ef`](https://github.com/Bike4Mind/bike4mind/commit/99331ef96f581177736ce196c6ee03ce82db58e4) Thanks [@onoya](https://github.com/onoya)! - attribute a key-driven lake write from chat tools to the API key

- [#3739](https://github.com/Bike4Mind/bike4mind/pull/3739) [`155d3b5`](https://github.com/Bike4Mind/bike4mind/commit/155d3b599fc9ec7728b73f09f13c058eb40f923f) Thanks [@onoya](https://github.com/onoya)! - build the data-lake AccessContext in one place

- [#3740](https://github.com/Bike4Mind/bike4mind/pull/3740) [`0fd958e`](https://github.com/Bike4Mind/bike4mind/commit/0fd958ead53f3440f0536b049c72167376a16cad) Thanks [@dea0030](https://github.com/dea0030)! - give federated exchange keys their own per-user cap pool

- [#3748](https://github.com/Bike4Mind/bike4mind/pull/3748) [`2f3bcf0`](https://github.com/Bike4Mind/bike4mind/commit/2f3bcf082570da8babf604a0f0b56440e8ba7964) Thanks [@jarlacut](https://github.com/jarlacut)! - gate lake sharing controls on ownership in settings

- [#3751](https://github.com/Bike4Mind/bike4mind/pull/3751) [`ba37763`](https://github.com/Bike4Mind/bike4mind/commit/ba377630cc53b56ed23917287751ea7a19f6b0ef) Thanks [@onoya](https://github.com/onoya)! - accept seed on image edit requests

- [#3756](https://github.com/Bike4Mind/bike4mind/pull/3756) [`5f85ce9`](https://github.com/Bike4Mind/bike4mind/commit/5f85ce912fba2a42616f23d4fcf180e75db857a7) Thanks [@vinchi777](https://github.com/vinchi777)! - detach notebook attachments whose file no longer exists

- [#3759](https://github.com/Bike4Mind/bike4mind/pull/3759) [`abe503f`](https://github.com/Bike4Mind/bike4mind/commit/abe503f570c91fbf1cbaa0d0e37c5c6b357ded40) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - make data lake write tools work in agent runs and use the picker-attached agent

- [#3779](https://github.com/Bike4Mind/bike4mind/pull/3779) [`0e0d518`](https://github.com/Bike4Mind/bike4mind/commit/0e0d518938fbd8c17edfa8d227e27759a70bea39) Thanks [@erikbethke](https://github.com/erikbethke)! - keep reply choices from drifting out of later turns

- [#3812](https://github.com/Bike4Mind/bike4mind/pull/3812) [`eeed160`](https://github.com/Bike4Mind/bike4mind/commit/eeed1609e0bc67b04971ad03580c592552784afa) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - route Lattice LLM write tools through getModelForWrite

- [#3825](https://github.com/Bike4Mind/bike4mind/pull/3825) [`0588a01`](https://github.com/Bike4Mind/bike4mind/commit/0588a0186da265dc6853bd053893840023f927f8) Thanks [@jarlacut](https://github.com/jarlacut)! - fall back to the search hit title when a fetched research title is a placeholder

- [#3835](https://github.com/Bike4Mind/bike4mind/pull/3835) [`83fb75f`](https://github.com/Bike4Mind/bike4mind/commit/83fb75feff292c71203c2f22a7ae8795635eb25f) Thanks [@poysama](https://github.com/poysama)! - retain and recover permanent lake cleanup

- [#3838](https://github.com/Bike4Mind/bike4mind/pull/3838) [`f921f5d`](https://github.com/Bike4Mind/bike4mind/commit/f921f5d3ebe17c93a34ce981d8cedf5a9702b27f) Thanks [@jjmarfa](https://github.com/jjmarfa)! - stop absence retiring Bedrock inference-profile ids

- Updated dependencies [[`ac9be44`](https://github.com/Bike4Mind/bike4mind/commit/ac9be444b5961a25499f322645701ca4d2a37d35), [`f38dd70`](https://github.com/Bike4Mind/bike4mind/commit/f38dd70dd37d2b80d47a131562cc8dcfdc907021), [`9c03692`](https://github.com/Bike4Mind/bike4mind/commit/9c03692a2b4bf06e81cfa3c9d73813d9ffa8e7bd), [`db87b77`](https://github.com/Bike4Mind/bike4mind/commit/db87b7730203867c4e2f94a8900b51de804e8c90), [`d4bb5f0`](https://github.com/Bike4Mind/bike4mind/commit/d4bb5f051b13778c2e24e7234d07e03068623532), [`8ada8ca`](https://github.com/Bike4Mind/bike4mind/commit/8ada8cae802a64ef92a635044e68539a51507965), [`993d00e`](https://github.com/Bike4Mind/bike4mind/commit/993d00e916ce3f7b0b682544b3457b3a261095af), [`4401e08`](https://github.com/Bike4Mind/bike4mind/commit/4401e08ac6947ae1d61c06b89fb39b742e79dd03), [`974f6a9`](https://github.com/Bike4Mind/bike4mind/commit/974f6a98798bd50b954802730c91886fc023307f), [`d1e2a5d`](https://github.com/Bike4Mind/bike4mind/commit/d1e2a5d22d42dc7dead35a2f53ca29e22d711994), [`3bd6a36`](https://github.com/Bike4Mind/bike4mind/commit/3bd6a368a8db2f5a0a9a22099b389c4f521a025c), [`082ac10`](https://github.com/Bike4Mind/bike4mind/commit/082ac107adf29fefe2ba7764f5deb659823c42da), [`9c2d6f4`](https://github.com/Bike4Mind/bike4mind/commit/9c2d6f425f610821fc4bf453645255ae64d50b80), [`ebc8be5`](https://github.com/Bike4Mind/bike4mind/commit/ebc8be501a76a99b10edc9814800e209b077443b), [`6e4aa9b`](https://github.com/Bike4Mind/bike4mind/commit/6e4aa9bdc1f4ab10c956af484d6b2f212cc4d752), [`8eaa7fa`](https://github.com/Bike4Mind/bike4mind/commit/8eaa7fa134f16a2d1f3fb008b77fb21c0aa4e206), [`bd7e399`](https://github.com/Bike4Mind/bike4mind/commit/bd7e399fb2c28822fbdb7261c0633435e8b27406), [`a7144cc`](https://github.com/Bike4Mind/bike4mind/commit/a7144ccda6473317b1af3f70b822b4bed19204f0), [`155d3b5`](https://github.com/Bike4Mind/bike4mind/commit/155d3b599fc9ec7728b73f09f13c058eb40f923f), [`0fd958e`](https://github.com/Bike4Mind/bike4mind/commit/0fd958ead53f3440f0536b049c72167376a16cad), [`ba37763`](https://github.com/Bike4Mind/bike4mind/commit/ba377630cc53b56ed23917287751ea7a19f6b0ef), [`5f85ce9`](https://github.com/Bike4Mind/bike4mind/commit/5f85ce912fba2a42616f23d4fcf180e75db857a7), [`abe503f`](https://github.com/Bike4Mind/bike4mind/commit/abe503f570c91fbf1cbaa0d0e37c5c6b357ded40), [`1e06a2e`](https://github.com/Bike4Mind/bike4mind/commit/1e06a2e61d43c2d9011039e9b3bee03238d4ccaf), [`31f1493`](https://github.com/Bike4Mind/bike4mind/commit/31f1493086206e85ec1615a29b7a4556dd8305ec), [`0e0d518`](https://github.com/Bike4Mind/bike4mind/commit/0e0d518938fbd8c17edfa8d227e27759a70bea39), [`67c3be6`](https://github.com/Bike4Mind/bike4mind/commit/67c3be68863b2e2d38961a48ec7d2b2cbc908d91), [`8ea9990`](https://github.com/Bike4Mind/bike4mind/commit/8ea99907e0a798637880be470c65080098781268), [`6e68a5d`](https://github.com/Bike4Mind/bike4mind/commit/6e68a5d9a7994fcd3178978b4a135c63d2aafa58), [`377bea9`](https://github.com/Bike4Mind/bike4mind/commit/377bea9855a55de1140f6bbea9b815893d42bb6e), [`0588a01`](https://github.com/Bike4Mind/bike4mind/commit/0588a0186da265dc6853bd053893840023f927f8), [`83fb75f`](https://github.com/Bike4Mind/bike4mind/commit/83fb75feff292c71203c2f22a7ae8795635eb25f), [`2483e86`](https://github.com/Bike4Mind/bike4mind/commit/2483e86cb8ac92ed12fd719140337416b7947381), [`9d7b298`](https://github.com/Bike4Mind/bike4mind/commit/9d7b298a2b71380b1f3202f50b230e5ef33ac4e9), [`f921f5d`](https://github.com/Bike4Mind/bike4mind/commit/f921f5d3ebe17c93a34ce981d8cedf5a9702b27f), [`623d55d`](https://github.com/Bike4Mind/bike4mind/commit/623d55dd1aed920f84ee7480c3ba7f6b38b63149), [`2c3ed54`](https://github.com/Bike4Mind/bike4mind/commit/2c3ed543d7d596805a352a0e93a1cbe124d09d9d), [`dfeb6d7`](https://github.com/Bike4Mind/bike4mind/commit/dfeb6d74c81e8e652932f3e5732979622479d345), [`07d3d0d`](https://github.com/Bike4Mind/bike4mind/commit/07d3d0dabe5d7b79575aa5da18838d2c313c63bb), [`d0ac85c`](https://github.com/Bike4Mind/bike4mind/commit/d0ac85c3192529cc8b679856627031e7560a0ef9), [`c854733`](https://github.com/Bike4Mind/bike4mind/commit/c854733c09bae678de0ffa4b22658ffed391b9d1), [`51ac5f4`](https://github.com/Bike4Mind/bike4mind/commit/51ac5f4cf502ea00f4401c3b81158363d42f0705), [`b96f722`](https://github.com/Bike4Mind/bike4mind/commit/b96f7222812a1f638a96e02fff84d6215069f856)]:
  - @bike4mind/common@12.2.0
  - @bike4mind/auth@0.9.0
  - @bike4mind/llm-adapters@0.16.0
  - @bike4mind/utils@6.5.0
  - @bike4mind/agents@1.1.0
  - @bike4mind/fab-pipeline@1.5.2
  - @bike4mind/db-core@0.7.1
  - @bike4mind/mcp@2.0.16

## 14.1.0

### Minor Changes

- [#3410](https://github.com/Bike4Mind/bike4mind/pull/3410) [`ede9899`](https://github.com/Bike4Mind/bike4mind/commit/ede9899b6ec98aeb9f7936eaa6bd99624ce1b6d6) Thanks [@onoya](https://github.com/onoya)! - add metadata-only documentDate backfill script

- [#3509](https://github.com/Bike4Mind/bike4mind/pull/3509) [`60845e1`](https://github.com/Bike4Mind/bike4mind/commit/60845e1ee2b6605fe8a2e05fa4b8431360c07dd0) Thanks [@onoya](https://github.com/onoya)! - publish the data lake API in the public contract

### Patch Changes

- [#3394](https://github.com/Bike4Mind/bike4mind/pull/3394) [`fb13127`](https://github.com/Bike4Mind/bike4mind/commit/fb13127fa17159715f2465edc13aa79ba9fbb371) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - scan artifact tags, titles and tool-output results in linear time

- [#3482](https://github.com/Bike4Mind/bike4mind/pull/3482) [`35e91bf`](https://github.com/Bike4Mind/bike4mind/commit/35e91bf9d09751fea6d066d20273a23bf2c596e4) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - move lattice intent scanners into @bike4mind/common

- [#3485](https://github.com/Bike4Mind/bike4mind/pull/3485) [`9ff0885`](https://github.com/Bike4Mind/bike4mind/commit/9ff088558998b3b8a98437e43305701cd7602e25) Thanks [@onoya](https://github.com/onoya)! - enforce scope containment when an API key mints a key

- [#3492](https://github.com/Bike4Mind/bike4mind/pull/3492) [`ada05e5`](https://github.com/Bike4Mind/bike4mind/commit/ada05e5375c6ece452390fd894b7ba5ee8ca7eca) Thanks [@vinchi777](https://github.com/vinchi777)! - mark a killed turn's recovered quest unfinished and bound web_search in the Lambda

- [#3493](https://github.com/Bike4Mind/bike4mind/pull/3493) [`9358808`](https://github.com/Bike4Mind/bike4mind/commit/9358808b851943c909443297d9cbd820c6b5abdf) Thanks [@onoya](https://github.com/onoya)! - pick forced-retrieval candidates by relevance, not file name

- [#3502](https://github.com/Bike4Mind/bike4mind/pull/3502) [`5d94e2b`](https://github.com/Bike4Mind/bike4mind/commit/5d94e2b2eea151c86fe4c697bd7e39feda74dfec) Thanks [@julsanchez](https://github.com/julsanchez)! - re-check sharee write access at write time for projects, quest plans, artifacts and sessions

- [#3512](https://github.com/Bike4Mind/bike4mind/pull/3512) [`cd64e03`](https://github.com/Bike4Mind/bike4mind/commit/cd64e03790355e26c51079385cd09797514d066e) Thanks [@onoya](https://github.com/onoya)! - let a lake's system prompt reach readers on sessions scoped to it

- [#3524](https://github.com/Bike4Mind/bike4mind/pull/3524) [`dc4e5e7`](https://github.com/Bike4Mind/bike4mind/commit/dc4e5e769c83097326252f36cb6e628910eb5368) Thanks [@julsanchez](https://github.com/julsanchez)! - serialize short manage writes against grant revokes

- Updated dependencies [[`ede9899`](https://github.com/Bike4Mind/bike4mind/commit/ede9899b6ec98aeb9f7936eaa6bd99624ce1b6d6), [`0aa75f9`](https://github.com/Bike4Mind/bike4mind/commit/0aa75f9b925474b221817fb70fd7f4222f69c4e8), [`5f21257`](https://github.com/Bike4Mind/bike4mind/commit/5f21257e89df2bdb9ed84b37ec157a98220dc678), [`420acfd`](https://github.com/Bike4Mind/bike4mind/commit/420acfd544dd1c4825ccf3e6730906609e8d5f56), [`fb13127`](https://github.com/Bike4Mind/bike4mind/commit/fb13127fa17159715f2465edc13aa79ba9fbb371), [`790d14a`](https://github.com/Bike4Mind/bike4mind/commit/790d14a2083f7bbf957f52b1b5920c6a172602cf), [`cd61e6a`](https://github.com/Bike4Mind/bike4mind/commit/cd61e6ada5b9802c9bf749a50735d7c2b7b39bce), [`35e91bf`](https://github.com/Bike4Mind/bike4mind/commit/35e91bf9d09751fea6d066d20273a23bf2c596e4), [`870a2e5`](https://github.com/Bike4Mind/bike4mind/commit/870a2e53453e8c62afe271d4cccd147eb70a6ca9), [`9d369fd`](https://github.com/Bike4Mind/bike4mind/commit/9d369fd0083bbddfd4a87ae05c7ace87c945f1a5), [`0a36217`](https://github.com/Bike4Mind/bike4mind/commit/0a362178b0ad60b07877666862ac98815ed5af54), [`fd7ef89`](https://github.com/Bike4Mind/bike4mind/commit/fd7ef89592e6228fd7df9a5bbdd7e750d2249e6b), [`ada05e5`](https://github.com/Bike4Mind/bike4mind/commit/ada05e5375c6ece452390fd894b7ba5ee8ca7eca), [`9358808`](https://github.com/Bike4Mind/bike4mind/commit/9358808b851943c909443297d9cbd820c6b5abdf), [`5d94e2b`](https://github.com/Bike4Mind/bike4mind/commit/5d94e2b2eea151c86fe4c697bd7e39feda74dfec), [`a92d5d3`](https://github.com/Bike4Mind/bike4mind/commit/a92d5d31c493960010cdf1abe03333450c7dd6b0), [`31a0baa`](https://github.com/Bike4Mind/bike4mind/commit/31a0baaf98a63c51f68f1c08822c71ced2276307), [`60845e1`](https://github.com/Bike4Mind/bike4mind/commit/60845e1ee2b6605fe8a2e05fa4b8431360c07dd0), [`cd64e03`](https://github.com/Bike4Mind/bike4mind/commit/cd64e03790355e26c51079385cd09797514d066e), [`4831bd9`](https://github.com/Bike4Mind/bike4mind/commit/4831bd9ef0985fe36d5b9baf5683c6284e8cb103), [`fe2a7d4`](https://github.com/Bike4Mind/bike4mind/commit/fe2a7d46ecf40fddb8e62394880f523708dbf6d9), [`7f4bd83`](https://github.com/Bike4Mind/bike4mind/commit/7f4bd8359d1c62f70e16adfc46ddce1fd9034f82), [`776c265`](https://github.com/Bike4Mind/bike4mind/commit/776c26538dad4ba1877a53ae5edfcb023ec54181), [`f1ea579`](https://github.com/Bike4Mind/bike4mind/commit/f1ea579eebadc28794000f28f38d3677191b26c5), [`652e3d7`](https://github.com/Bike4Mind/bike4mind/commit/652e3d7fd01ccaed317482ec6e6b5b53a3239774), [`256decd`](https://github.com/Bike4Mind/bike4mind/commit/256decd57dc5da987bf910dec45abb3d13327875), [`3b49048`](https://github.com/Bike4Mind/bike4mind/commit/3b49048715891aac4f5d427f717980c5626bd4d3), [`75221ca`](https://github.com/Bike4Mind/bike4mind/commit/75221ca572e6a06fee2e41f57bdbbd9574b75d3c), [`670d839`](https://github.com/Bike4Mind/bike4mind/commit/670d8392bb00f941697a8721a4eea94e826d32b6), [`c1d63f0`](https://github.com/Bike4Mind/bike4mind/commit/c1d63f01520b74289224c66b9a04aaddc34093a4), [`373f891`](https://github.com/Bike4Mind/bike4mind/commit/373f89198fec59b61f1bc7e1057b7556a9fb95fb), [`edfe671`](https://github.com/Bike4Mind/bike4mind/commit/edfe6718c78309af24d2057d0d428e5dea7f208d), [`0a36217`](https://github.com/Bike4Mind/bike4mind/commit/0a362178b0ad60b07877666862ac98815ed5af54), [`ca70725`](https://github.com/Bike4Mind/bike4mind/commit/ca707256c38a5a660672ef0bee27829189a21e08)]:
  - @bike4mind/common@12.1.0
  - @bike4mind/utils@6.4.0
  - @bike4mind/llm-adapters@0.15.9
  - @bike4mind/auth@0.8.12
  - @bike4mind/fab-pipeline@1.5.1
  - @bike4mind/agents@1.0.15
  - @bike4mind/mcp@2.0.15
  - @bike4mind/observability@0.2.3
  - @bike4mind/db-core@0.7.0

## 14.0.0

### Major Changes

- [#3401](https://github.com/Bike4Mind/bike4mind/pull/3401) [`be2db69`](https://github.com/Bike4Mind/bike4mind/commit/be2db69ef7fba5d85121c016e140f77b64bb79c0) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - Several exported `dataLakeResearchService`/`dataLakeService` functions gained required parameters so their History-audit writes can name the real actor and grant set instead of silently falling back to `system`: `createResearchConfig`/`updateResearchConfig`/`deleteResearchConfig` and `startResearchRun` now take the caller's already-loaded `lake`/`actor`/`grants` rather than re-deriving them; `deleteResearchConfig` gained an `actor` param it previously had none of; `recordResearchRunOutcome` gained a required `runId` param so its History row can be paired with the matching `start-research-run` row for the same run. An out-of-repo caller of any of these must update its call sites accordingly.

- [#3215](https://github.com/Bike4Mind/bike4mind/pull/3215) [`e6a34e6`](https://github.com/Bike4Mind/bike4mind/commit/e6a34e6b657e237e7c010c5af9a2823962993cd0) Thanks [@choyno](https://github.com/choyno)! - `ChatCompletionProcess.resolveEntitlementKeys()` now returns `EntitlementResolution` (`{ keys, resolved }`) instead of `string[]`. The method is reachable from the published `@bike4mind/services/llm` subpath, so an out-of-repo caller reading the array directly must destructure `keys`. `EntitlementResolution` is exported from both that subpath and `dataLakeService`.

- [#3098](https://github.com/Bike4Mind/bike4mind/pull/3098) [`a97d7b0`](https://github.com/Bike4Mind/bike4mind/commit/a97d7b07e980c2c74ec8d6a895483cf98786a0a5) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - show when access excluded lakes from a turn

- [#3108](https://github.com/Bike4Mind/bike4mind/pull/3108) [`a9ad19f`](https://github.com/Bike4Mind/bike4mind/commit/a9ad19f2eb4367773fb9fb97697477f6a00f1a76) Thanks [@juicewaa](https://github.com/juicewaa)! - carry summaryTrigger through clone, fork and snip

- [#3113](https://github.com/Bike4Mind/bike4mind/pull/3113) [`8472dd6`](https://github.com/Bike4Mind/bike4mind/commit/8472dd6719f154c8d393a1f0ec36210b5a2d9a84) Thanks [@onoya](https://github.com/onoya)! - stop rendering ingestion time as the document date

- [#3163](https://github.com/Bike4Mind/bike4mind/pull/3163) [`74b798c`](https://github.com/Bike4Mind/bike4mind/commit/74b798c9f2e9e7b0a86a10afa2640714926bb878) Thanks [@jarlacut](https://github.com/jarlacut)! - declare a lake origin and refuse unattended ingest into curated lakes

- [#3219](https://github.com/Bike4Mind/bike4mind/pull/3219) [`a31113d`](https://github.com/Bike4Mind/bike4mind/commit/a31113d843a081d1cef3175f95c39134ebd16fd5) Thanks [@jjmarfa](https://github.com/jjmarfa)! - make ownership transfer a pending offer

### Minor Changes

- [#3071](https://github.com/Bike4Mind/bike4mind/pull/3071) [`fcc343b`](https://github.com/Bike4Mind/bike4mind/commit/fcc343bb3c2c6d5ffa8cba42f60dd024b2e1c2d4) Thanks [@choyno](https://github.com/choyno)! - record a durable membership change log for file add/remove

- [#3115](https://github.com/Bike4Mind/bike4mind/pull/3115) [`b34fd8c`](https://github.com/Bike4Mind/bike4mind/commit/b34fd8cecce82f4159a3cd4b44a3528d8760b3a9) Thanks [@onoya](https://github.com/onoya)! - mark disagreeing sources on the citation chips

- [#3134](https://github.com/Bike4Mind/bike4mind/pull/3134) [`e4b4032`](https://github.com/Bike4Mind/bike4mind/commit/e4b40325c25d79379755d074379f4f6de2a47d64) Thanks [@onoya](https://github.com/onoya)! - add a model-driven contradiction detection pass

- [#3140](https://github.com/Bike4Mind/bike4mind/pull/3140) [`eb67058`](https://github.com/Bike4Mind/bike4mind/commit/eb670588d2b95ae9bd03440638decb3107aa6495) Thanks [@vinchi777](https://github.com/vinchi777)! - persist finding resolution decisions across detector reruns

- [#3147](https://github.com/Bike4Mind/bike4mind/pull/3147) [`d4faf36`](https://github.com/Bike4Mind/bike4mind/commit/d4faf36852e6beb2834d60541a8fe21471664647) Thanks [@vinchi777](https://github.com/vinchi777)! - show images inline in reply for visual queries

- [#3152](https://github.com/Bike4Mind/bike4mind/pull/3152) [`f80d464`](https://github.com/Bike4Mind/bike4mind/commit/f80d4642733eefccd6b273e7b8596035eb733b3d) Thanks [@vinchi777](https://github.com/vinchi777)! - scan inconsistencies on a schedule and persist findings as rows

- [#3153](https://github.com/Bike4Mind/bike4mind/pull/3153) [`9d995b5`](https://github.com/Bike4Mind/bike4mind/commit/9d995b5cb90c47453dc003629788314fc3c2661e) Thanks [@vinchi777](https://github.com/vinchi777)! - add curator merge, supersede and retag actions

- [#3195](https://github.com/Bike4Mind/bike4mind/pull/3195) [`bef318c`](https://github.com/Bike4Mind/bike4mind/commit/bef318c78b56e34ab5c4b8f79a876a0d77f73479) Thanks [@onoya](https://github.com/onoya)! - capture real document vintage at ingest

- [#3220](https://github.com/Bike4Mind/bike4mind/pull/3220) [`fdae2d7`](https://github.com/Bike4Mind/bike4mind/commit/fdae2d7bb32d8bbafade0b64730482c8868148fe) Thanks [@jarlacut](https://github.com/jarlacut)! - report personal-lake shares kept on member offboarding

- [#3264](https://github.com/Bike4Mind/bike4mind/pull/3264) [`77a8559`](https://github.com/Bike4Mind/bike4mind/commit/77a85598922c4a09b28d68581260074ae64fe5bf) Thanks [@vinchi777](https://github.com/vinchi777)! - render an inline map for location-based search results

- [#3281](https://github.com/Bike4Mind/bike4mind/pull/3281) [`075e39c`](https://github.com/Bike4Mind/bike4mind/commit/075e39ca3ab0825d25ff2c832b41ed83728ce642) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - let firecrawlFetch callers keep headers, navs and footers

### Patch Changes

- [#2999](https://github.com/Bike4Mind/bike4mind/pull/2999) [`a7ba63b`](https://github.com/Bike4Mind/bike4mind/commit/a7ba63b4ab07f41afa4ed513c5158cebc342b825) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - linearize the fence and document scans in both artifact parsers

- [#3000](https://github.com/Bike4Mind/bike4mind/pull/3000) [`1a1ade0`](https://github.com/Bike4Mind/bike4mind/commit/1a1ade073fd08cd23a93f28fe7c452390934a59e) Thanks [@dea0030](https://github.com/dea0030)! - attribute the tool_usage ledger row to the model that charged

- [#3103](https://github.com/Bike4Mind/bike4mind/pull/3103) [`8da8172`](https://github.com/Bike4Mind/bike4mind/commit/8da8172b5e2b75f39aa9c1889f1c9a89f0a50173) Thanks [@dea0030](https://github.com/dea0030)! - render an omitted GPT-Image quality at the tier it bills

- [#3114](https://github.com/Bike4Mind/bike4mind/pull/3114) [`6f80ed6`](https://github.com/Bike4Mind/bike4mind/commit/6f80ed65693a52dddd16874b81a5ef6eb49384b4) Thanks [@dea0030](https://github.com/dea0030)! - normalize org ids and stamp org/session on chat-created models

- [#3121](https://github.com/Bike4Mind/bike4mind/pull/3121) [`9a44e23`](https://github.com/Bike4Mind/bike4mind/commit/9a44e239dc3734ba992a8524d956aeb9f3ed009f) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - fix owner-only 401 on shared-session agent routes

- [#3122](https://github.com/Bike4Mind/bike4mind/pull/3122) [`b96d0e6`](https://github.com/Bike4Mind/bike4mind/commit/b96d0e60e388330f5dfb9271cae032facc4bf7f2) Thanks [@vinchi777](https://github.com/vinchi777)! - stop lastCreditsPurchasedAt from reverting on credit-free admin saves

- [#3123](https://github.com/Bike4Mind/bike4mind/pull/3123) [`a3a135f`](https://github.com/Bike4Mind/bike4mind/commit/a3a135fe6d24b17a484c0bab8c02f9a1765e3b42) Thanks [@vinchi777](https://github.com/vinchi777)! - guard downloadImageAsBuffer against SSRF via caller-supplied URLs

- [#3125](https://github.com/Bike4Mind/bike4mind/pull/3125) [`1eaa5dc`](https://github.com/Bike4Mind/bike4mind/commit/1eaa5dc4a71a91911d0fb30def5de46d1a710150) Thanks [@vinchi777](https://github.com/vinchi777)! - preserve streamed text across a reopened thinking block

- [#3144](https://github.com/Bike4Mind/bike4mind/pull/3144) [`1e68664`](https://github.com/Bike4Mind/bike4mind/commit/1e6866430e93902f0e1dfa64aa138dedfcaa753b) Thanks [@poysama](https://github.com/poysama)! - await handlers before completing schedules

- [#3177](https://github.com/Bike4Mind/bike4mind/pull/3177) [`052574d`](https://github.com/Bike4Mind/bike4mind/commit/052574d726ef6bdd2042f07b592e404135f34774) Thanks [@julsanchez](https://github.com/julsanchez)! - re-confirm silent fuzzy edit_local_file edits under trust/auto-accept

- [#3190](https://github.com/Bike4Mind/bike4mind/pull/3190) [`ab64edb`](https://github.com/Bike4Mind/bike4mind/commit/ab64edbbaa475b44fb7400a0b5e3fee16ad6f985) Thanks [@dea0030](https://github.com/dea0030)! - scope the edit-image mask lookup to the caller

- [#3197](https://github.com/Bike4Mind/bike4mind/pull/3197) [`9ea0a72`](https://github.com/Bike4Mind/bike4mind/commit/9ea0a7268402fe4f824a7bd472fa424e729a1203) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - keep exclusion telemetry unknown on read failure

- [#3207](https://github.com/Bike4Mind/bike4mind/pull/3207) [`cb836c5`](https://github.com/Bike4Mind/bike4mind/commit/cb836c5ba2952c9e5eb5168c8e82a4740b97f687) Thanks [@aflordelis](https://github.com/aflordelis)! - offer only priceable image sizes in the edit tool

- [#3215](https://github.com/Bike4Mind/bike4mind/pull/3215) [`9f34f8d`](https://github.com/Bike4Mind/bike4mind/commit/9f34f8d3e9bcb0a11e6187b1764fbbabb98707de) Thanks [@choyno](https://github.com/choyno)! - make the entitlement-completeness signal unforgettable

- [#3245](https://github.com/Bike4Mind/bike4mind/pull/3245) [`1124e9a`](https://github.com/Bike4Mind/bike4mind/commit/1124e9a02c6826f985231e083047db14a4376db4) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - sync data lake storage counters on lifecycle sweeps

- [#3247](https://github.com/Bike4Mind/bike4mind/pull/3247) [`0d52f70`](https://github.com/Bike4Mind/bike4mind/commit/0d52f70329b5ab8304d1e78fb81924124c30208e) Thanks [@onoya](https://github.com/onoya)! - disclose that a newly created data lake is a non-serving draft

- [#3248](https://github.com/Bike4Mind/bike4mind/pull/3248) [`4dd4a83`](https://github.com/Bike4Mind/bike4mind/commit/4dd4a83b3e289a22758eeb263f4bf5f86f81e9e6) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - only extract tool artifacts from the tools that emit them

- [#3252](https://github.com/Bike4Mind/bike4mind/pull/3252) [`428f495`](https://github.com/Bike4Mind/bike4mind/commit/428f495ec204e784bba8599409ec1541b3c367b9) Thanks [@onoya](https://github.com/onoya)! - surface an error instead of a blank reply on failed or killed runs

- [#3267](https://github.com/Bike4Mind/bike4mind/pull/3267) [`09244fa`](https://github.com/Bike4Mind/bike4mind/commit/09244fa12aebbff8a6b9a9febe400367dd91646b) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - skip edit_local_file's redundant resolve in the write path

- [#3272](https://github.com/Bike4Mind/bike4mind/pull/3272) [`6457ac5`](https://github.com/Bike4Mind/bike4mind/commit/6457ac5bab1bc23afe6f0c8669a2ce543a3e74bf) Thanks [@erikbethke](https://github.com/erikbethke)! - unstick the composer's send/stop button

- [#3274](https://github.com/Bike4Mind/bike4mind/pull/3274) [`766fdbb`](https://github.com/Bike4Mind/bike4mind/commit/766fdbbe86fbc079736f4469f11d69ee984b9831) Thanks [@aflordelis](https://github.com/aflordelis)! - list model options through the shared getAvailableModels fan-out

- [#3278](https://github.com/Bike4Mind/bike4mind/pull/3278) [`03cf8e9`](https://github.com/Bike4Mind/bike4mind/commit/03cf8e9a3fa441da61c4da4050c7fd42b0ceca2f) Thanks [@erikbethke](https://github.com/erikbethke)! - treat an Anthropic stream that ends before message_stop as incomplete

- [#3301](https://github.com/Bike4Mind/bike4mind/pull/3301) [`69b0b27`](https://github.com/Bike4Mind/bike4mind/commit/69b0b276012b7086ff0638888b95bc45a8f999de) Thanks [@dea0030](https://github.com/dea0030)! - show readable categories on source chips, not raw lake tag paths

- [#3302](https://github.com/Bike4Mind/bike4mind/pull/3302) [`885223c`](https://github.com/Bike4Mind/bike4mind/commit/885223c354a4b9f8ae91b4cbce840225dd625824) Thanks [@maconard](https://github.com/maconard)! - promote Responses-only OpenAI models and map models.dev release dates

- [#3303](https://github.com/Bike4Mind/bike4mind/pull/3303) [`387a876`](https://github.com/Bike4Mind/bike4mind/commit/387a8768355b571a62899cc823f2a8880c92d6e8) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - delete stored objects on whole-lake purge

- [#3307](https://github.com/Bike4Mind/bike4mind/pull/3307) [`004260f`](https://github.com/Bike4Mind/bike4mind/commit/004260f1c28eb7d25f503d85a5fbb4959a6870cb) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - debit owner storage when a session's owned files are deleted

- [#3323](https://github.com/Bike4Mind/bike4mind/pull/3323) [`6ba3dc9`](https://github.com/Bike4Mind/bike4mind/commit/6ba3dc9d56dd0fd8ca7db94880a5413982b436da) Thanks [@julsanchez](https://github.com/julsanchez)! - deactivate a user's API keys on ban, dispute or suspension

- [#3326](https://github.com/Bike4Mind/bike4mind/pull/3326) [`773f2e3`](https://github.com/Bike4Mind/bike4mind/commit/773f2e34fa47c7fe61d91cd02076613020a7a7a4) Thanks [@julsanchez](https://github.com/julsanchez)! - scope edit-image org/session and bind image/video retry quests to their session

- [#3328](https://github.com/Bike4Mind/bike4mind/pull/3328) [`b761d1a`](https://github.com/Bike4Mind/bike4mind/commit/b761d1a5de3667c210611ee1b1d1b3f6a1c31e19) Thanks [@vinchi777](https://github.com/vinchi777)! - report failure when lattice_set_value entity is missing

- [#3330](https://github.com/Bike4Mind/bike4mind/pull/3330) [`d256617`](https://github.com/Bike4Mind/bike4mind/commit/d256617f418ae03e4db2459a8ef1a878098d11a8) Thanks [@julsanchez](https://github.com/julsanchez)! - re-check share permission and not-deleted at write time for sharee session writes

- [#3334](https://github.com/Bike4Mind/bike4mind/pull/3334) [`5fe5e01`](https://github.com/Bike4Mind/bike4mind/commit/5fe5e018dec86925650e1d1e06c307974593974e) Thanks [@onoya](https://github.com/onoya)! - order and label research judge models, validate levers, confirm delete

- Updated dependencies [[`31e0dd9`](https://github.com/Bike4Mind/bike4mind/commit/31e0dd9a905a7a125f7489efc951a7d21157bc17), [`a7ba63b`](https://github.com/Bike4Mind/bike4mind/commit/a7ba63b4ab07f41afa4ed513c5158cebc342b825), [`1a1ade0`](https://github.com/Bike4Mind/bike4mind/commit/1a1ade073fd08cd23a93f28fe7c452390934a59e), [`fcc343b`](https://github.com/Bike4Mind/bike4mind/commit/fcc343bb3c2c6d5ffa8cba42f60dd024b2e1c2d4), [`57aa4cd`](https://github.com/Bike4Mind/bike4mind/commit/57aa4cdfa2cfdf8da565d06b97286a2b49343787), [`3c63288`](https://github.com/Bike4Mind/bike4mind/commit/3c63288073622e8463180ff59fd07fe428d12e26), [`a97d7b0`](https://github.com/Bike4Mind/bike4mind/commit/a97d7b07e980c2c74ec8d6a895483cf98786a0a5), [`8da8172`](https://github.com/Bike4Mind/bike4mind/commit/8da8172b5e2b75f39aa9c1889f1c9a89f0a50173), [`4f6bb28`](https://github.com/Bike4Mind/bike4mind/commit/4f6bb2897af5ba0301f118b99617bd13aa2f6716), [`a9ad19f`](https://github.com/Bike4Mind/bike4mind/commit/a9ad19f2eb4367773fb9fb97697477f6a00f1a76), [`312210a`](https://github.com/Bike4Mind/bike4mind/commit/312210a847ea3748a4b0f7a0e99b7d2fdc41aa2b), [`8472dd6`](https://github.com/Bike4Mind/bike4mind/commit/8472dd6719f154c8d393a1f0ec36210b5a2d9a84), [`b34fd8c`](https://github.com/Bike4Mind/bike4mind/commit/b34fd8cecce82f4159a3cd4b44a3528d8760b3a9), [`a3a135f`](https://github.com/Bike4Mind/bike4mind/commit/a3a135fe6d24b17a484c0bab8c02f9a1765e3b42), [`1eaa5dc`](https://github.com/Bike4Mind/bike4mind/commit/1eaa5dc4a71a91911d0fb30def5de46d1a710150), [`b5943fc`](https://github.com/Bike4Mind/bike4mind/commit/b5943fc377b3563359211bc64d242d27c455f23b), [`e4b4032`](https://github.com/Bike4Mind/bike4mind/commit/e4b40325c25d79379755d074379f4f6de2a47d64), [`eb67058`](https://github.com/Bike4Mind/bike4mind/commit/eb670588d2b95ae9bd03440638decb3107aa6495), [`1e68664`](https://github.com/Bike4Mind/bike4mind/commit/1e6866430e93902f0e1dfa64aa138dedfcaa753b), [`d4faf36`](https://github.com/Bike4Mind/bike4mind/commit/d4faf36852e6beb2834d60541a8fe21471664647), [`baae0c8`](https://github.com/Bike4Mind/bike4mind/commit/baae0c8c658f31a98fbfce09aea2a83a16d87889), [`f80d464`](https://github.com/Bike4Mind/bike4mind/commit/f80d4642733eefccd6b273e7b8596035eb733b3d), [`9d995b5`](https://github.com/Bike4Mind/bike4mind/commit/9d995b5cb90c47453dc003629788314fc3c2661e), [`1b3627b`](https://github.com/Bike4Mind/bike4mind/commit/1b3627b78929c6ce18de724b07d8822133287a29), [`74b798c`](https://github.com/Bike4Mind/bike4mind/commit/74b798c9f2e9e7b0a86a10afa2640714926bb878), [`ab64edb`](https://github.com/Bike4Mind/bike4mind/commit/ab64edbbaa475b44fb7400a0b5e3fee16ad6f985), [`f2f49db`](https://github.com/Bike4Mind/bike4mind/commit/f2f49dbfdda2b223c0c9bfd983f003d5637b3016), [`bef318c`](https://github.com/Bike4Mind/bike4mind/commit/bef318c78b56e34ab5c4b8f79a876a0d77f73479), [`cb836c5`](https://github.com/Bike4Mind/bike4mind/commit/cb836c5ba2952c9e5eb5168c8e82a4740b97f687), [`46b4494`](https://github.com/Bike4Mind/bike4mind/commit/46b4494b60d5f961bca266304e119d08aa5f97ff), [`32573fe`](https://github.com/Bike4Mind/bike4mind/commit/32573fef42d5e35e2b7569c567d96752a3cab0fe), [`a31113d`](https://github.com/Bike4Mind/bike4mind/commit/a31113d843a081d1cef3175f95c39134ebd16fd5), [`0cc7540`](https://github.com/Bike4Mind/bike4mind/commit/0cc7540adeb1661e10cb24c57e716e6416932773), [`d12a958`](https://github.com/Bike4Mind/bike4mind/commit/d12a958bf4d933dbb90368ae70df81e8dc48e2a1), [`250695d`](https://github.com/Bike4Mind/bike4mind/commit/250695d7f282ddfef87f2259d50cf9e706e328a8), [`1124e9a`](https://github.com/Bike4Mind/bike4mind/commit/1124e9a02c6826f985231e083047db14a4376db4), [`4dd4a83`](https://github.com/Bike4Mind/bike4mind/commit/4dd4a83b3e289a22758eeb263f4bf5f86f81e9e6), [`5d7bd7e`](https://github.com/Bike4Mind/bike4mind/commit/5d7bd7ede4999db91c67eff2e507c1db359f55db), [`e5e3914`](https://github.com/Bike4Mind/bike4mind/commit/e5e391430b35b19b630dfea134a1915e3914f7d9), [`77a8559`](https://github.com/Bike4Mind/bike4mind/commit/77a85598922c4a09b28d68581260074ae64fe5bf), [`4c80f75`](https://github.com/Bike4Mind/bike4mind/commit/4c80f7535b1cd71d617c45a9b6284a5454555968), [`766fdbb`](https://github.com/Bike4Mind/bike4mind/commit/766fdbbe86fbc079736f4469f11d69ee984b9831), [`03cf8e9`](https://github.com/Bike4Mind/bike4mind/commit/03cf8e9a3fa441da61c4da4050c7fd42b0ceca2f), [`69b0b27`](https://github.com/Bike4Mind/bike4mind/commit/69b0b276012b7086ff0638888b95bc45a8f999de), [`885223c`](https://github.com/Bike4Mind/bike4mind/commit/885223c354a4b9f8ae91b4cbce840225dd625824), [`387a876`](https://github.com/Bike4Mind/bike4mind/commit/387a8768355b571a62899cc823f2a8880c92d6e8), [`428335f`](https://github.com/Bike4Mind/bike4mind/commit/428335fd995d74ed26e1d9bbab1a6a84e27342a9), [`a401245`](https://github.com/Bike4Mind/bike4mind/commit/a40124590f2bc00c3dd0ced05429d617f209f348), [`d1f749e`](https://github.com/Bike4Mind/bike4mind/commit/d1f749e671f825f1631f7cb7081272a0cb6bdd90), [`d256617`](https://github.com/Bike4Mind/bike4mind/commit/d256617f418ae03e4db2459a8ef1a878098d11a8), [`09f0be2`](https://github.com/Bike4Mind/bike4mind/commit/09f0be29bcce33e5d4a79ac27bdf70300771aadd), [`5fe5e01`](https://github.com/Bike4Mind/bike4mind/commit/5fe5e018dec86925650e1d1e06c307974593974e), [`9c3d451`](https://github.com/Bike4Mind/bike4mind/commit/9c3d4516e3bbbe26c44887e9159420efa63bee20), [`e8f6e3c`](https://github.com/Bike4Mind/bike4mind/commit/e8f6e3c3b41bbacf7f05f3029cbe35066e64b61e), [`a0f807c`](https://github.com/Bike4Mind/bike4mind/commit/a0f807ca795552fb2dfd2546774cf0911a313adf), [`2ba749e`](https://github.com/Bike4Mind/bike4mind/commit/2ba749ec17fdba6ed92adb872d11f6ce7a655790), [`257ec7e`](https://github.com/Bike4Mind/bike4mind/commit/257ec7eb8cd445da41492047dbeb397e3f779832), [`dd940f7`](https://github.com/Bike4Mind/bike4mind/commit/dd940f709ea10a20393cdaeb6f5a1b35b5d942b6), [`7759faa`](https://github.com/Bike4Mind/bike4mind/commit/7759faaff96fc87926a604a1ff16e80506583a62), [`72212ae`](https://github.com/Bike4Mind/bike4mind/commit/72212aee86c932bd918d17454543d6f7ad71758b), [`be2db69`](https://github.com/Bike4Mind/bike4mind/commit/be2db69ef7fba5d85121c016e140f77b64bb79c0), [`e3762b4`](https://github.com/Bike4Mind/bike4mind/commit/e3762b4ee3d15dacc58f0ea6b25a0afb23d95f91), [`8da8278`](https://github.com/Bike4Mind/bike4mind/commit/8da8278053702e80311b3104b13a0689d6da4f10), [`4bea648`](https://github.com/Bike4Mind/bike4mind/commit/4bea648addc68d3c254eff55edf187db08a9f5d2)]:
  - @bike4mind/utils@6.3.0
  - @bike4mind/common@12.0.0
  - @bike4mind/auth@0.8.11
  - @bike4mind/llm-adapters@0.15.8
  - @bike4mind/agents@1.0.14
  - @bike4mind/fab-pipeline@1.5.0
  - @bike4mind/observability@0.2.2
  - @bike4mind/db-core@0.6.6
  - @bike4mind/mcp@2.0.14

## 13.0.0

### Major Changes

- [#3073](https://github.com/Bike4Mind/bike4mind/pull/3073) [`3f5f10f`](https://github.com/Bike4Mind/bike4mind/commit/3f5f10f92fa61cc3155dbd669608b3cc539c5c40) Thanks [@choyno](https://github.com/choyno)! - replace implicit draft-lake activation with explicit promote and demote

- [#3093](https://github.com/Bike4Mind/bike4mind/pull/3093) [`6a790ec`](https://github.com/Bike4Mind/bike4mind/commit/6a790ec74715947c11caa5441f51e65cb7d9fb55) Thanks [@jjmarfa](https://github.com/jjmarfa)! - delete the uploaded object when a knowledge-file import write fails

### Minor Changes

- [#2990](https://github.com/Bike4Mind/bike4mind/pull/2990) [`0b5b296`](https://github.com/Bike4Mind/bike4mind/commit/0b5b29675bd15a076e3a4cc721ef9bb5d657b54b) Thanks [@ken-b4m](https://github.com/ken-b4m)! - migrate the corpus to text-embedding-3-small, repair blank embedding labels, and refit the retrieval floors

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

- [#2952](https://github.com/Bike4Mind/bike4mind/pull/2952) [`eb7dd3c`](https://github.com/Bike4Mind/bike4mind/commit/eb7dd3c80a29133d726df7d03a45529cbd4e7d47) Thanks [@dea0030](https://github.com/dea0030)! - offer only priceable image sizes to the chat image tool

- [#3002](https://github.com/Bike4Mind/bike4mind/pull/3002) [`a37e4ac`](https://github.com/Bike4Mind/bike4mind/commit/a37e4ac2572b4fe6c0b0d4a97ed2dd69f95b1cfc) Thanks [@jarlacut](https://github.com/jarlacut)! - carry taggedAt through clone, fork and snip

- [#3016](https://github.com/Bike4Mind/bike4mind/pull/3016) [`27173c2`](https://github.com/Bike4Mind/bike4mind/commit/27173c2de2852fcd8f6f0b04a8b5f9281ae0016e) Thanks [@vinchi777](https://github.com/vinchi777)! - distinguish a derived output cap from a declared one

- [#3019](https://github.com/Bike4Mind/bike4mind/pull/3019) [`6481767`](https://github.com/Bike4Mind/bike4mind/commit/6481767f9507cf6f440f7e941c986762ef3079f0) Thanks [@vinchi777](https://github.com/vinchi777)! - mark degenerate-loop turns so they are not billed as clean successes

- [#3023](https://github.com/Bike4Mind/bike4mind/pull/3023) [`f96ee0a`](https://github.com/Bike4Mind/bike4mind/commit/f96ee0a3490e75881b69c4617dd3cca60bf120f9) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - let org members create and cancel org invites

- [#3077](https://github.com/Bike4Mind/bike4mind/pull/3077) [`a27d416`](https://github.com/Bike4Mind/bike4mind/commit/a27d4169b82c17089b0a8c54106babe51dc66367) Thanks [@choyno](https://github.com/choyno)! - scheduled lake health sweep with fair per-run cap

- [#3092](https://github.com/Bike4Mind/bike4mind/pull/3092) [`0192e3f`](https://github.com/Bike4Mind/bike4mind/commit/0192e3f70714d04a4f65f346a15145a581c80e26) Thanks [@vinchi777](https://github.com/vinchi777)! - honor configured Image Size for BFL Pro models

- [#3099](https://github.com/Bike4Mind/bike4mind/pull/3099) [`954f1fe`](https://github.com/Bike4Mind/bike4mind/commit/954f1fe9f7967fc13f40b44eda28a6f94af43c05) Thanks [@jarlacut](https://github.com/jarlacut)! - import attachments on notebook overwrite and merge

- [#3112](https://github.com/Bike4Mind/bike4mind/pull/3112) [`b9ddc38`](https://github.com/Bike4Mind/bike4mind/commit/b9ddc386391140d6bdd30ee5b00ba8324f68b98a) Thanks [@julsanchez](https://github.com/julsanchez)! - route every model-callable tool through the permission wrapper and shared path validator

- Updated dependencies [[`254337c`](https://github.com/Bike4Mind/bike4mind/commit/254337c91edeefc41333a60559a15673411bea01), [`c6c35c3`](https://github.com/Bike4Mind/bike4mind/commit/c6c35c3ac15cf06526b4503bf4a18cef7a929b30), [`311f5cd`](https://github.com/Bike4Mind/bike4mind/commit/311f5cd69a083a3a0afc4c1a81602950086b8c83), [`0b5b296`](https://github.com/Bike4Mind/bike4mind/commit/0b5b29675bd15a076e3a4cc721ef9bb5d657b54b), [`38e6673`](https://github.com/Bike4Mind/bike4mind/commit/38e667337bd28b5b61dc7a1b635b9a25e6ee0df1), [`27173c2`](https://github.com/Bike4Mind/bike4mind/commit/27173c2de2852fcd8f6f0b04a8b5f9281ae0016e), [`6481767`](https://github.com/Bike4Mind/bike4mind/commit/6481767f9507cf6f440f7e941c986762ef3079f0), [`f96ee0a`](https://github.com/Bike4Mind/bike4mind/commit/f96ee0a3490e75881b69c4617dd3cca60bf120f9), [`886d895`](https://github.com/Bike4Mind/bike4mind/commit/886d8952c29b81a907fcf1455b0eb19ebd1313e1), [`1295822`](https://github.com/Bike4Mind/bike4mind/commit/129582275b2f94d06a2009583a4a52519f74a3c7), [`044d447`](https://github.com/Bike4Mind/bike4mind/commit/044d447eeb24b1b1af3e532663c6486d49257ec3), [`3f5f10f`](https://github.com/Bike4Mind/bike4mind/commit/3f5f10f92fa61cc3155dbd669608b3cc539c5c40), [`0485840`](https://github.com/Bike4Mind/bike4mind/commit/0485840d81f1bbc2a2925099d57c1cf832b6ad4a), [`db3408d`](https://github.com/Bike4Mind/bike4mind/commit/db3408dbcf750db35d815f74a435c2daa27ed3a0), [`a27d416`](https://github.com/Bike4Mind/bike4mind/commit/a27d4169b82c17089b0a8c54106babe51dc66367), [`8039f4c`](https://github.com/Bike4Mind/bike4mind/commit/8039f4cabc06a1d8fa07121e41736f2206e61a71), [`919b705`](https://github.com/Bike4Mind/bike4mind/commit/919b7051c1ce4ae7552f93a7592e76a9727b2d0e), [`280ef10`](https://github.com/Bike4Mind/bike4mind/commit/280ef104977de1c415c5dabca67c6866887d6d27), [`0192e3f`](https://github.com/Bike4Mind/bike4mind/commit/0192e3f70714d04a4f65f346a15145a581c80e26), [`3720b09`](https://github.com/Bike4Mind/bike4mind/commit/3720b099adcc38f5e1d2592819088c15f7b41ce8), [`4b080b8`](https://github.com/Bike4Mind/bike4mind/commit/4b080b812bb78e81c5fbeb45ab6a6dd8beb3e03c)]:
  - @bike4mind/common@11.0.0
  - @bike4mind/fab-pipeline@1.4.0
  - @bike4mind/llm-adapters@0.15.7
  - @bike4mind/utils@6.2.0
  - @bike4mind/db-core@0.6.5
  - @bike4mind/observability@0.2.1
  - @bike4mind/agents@1.0.13
  - @bike4mind/auth@0.8.10
  - @bike4mind/mcp@2.0.13

## 12.1.0

### Minor Changes

- [#2949](https://github.com/Bike4Mind/bike4mind/pull/2949) [`8e31cbf`](https://github.com/Bike4Mind/bike4mind/commit/8e31cbfad875f80f372f16032f487cde1e624ce1) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - add an org-level feedback analysis report

### Patch Changes

- [#2977](https://github.com/Bike4Mind/bike4mind/pull/2977) [`4ce553e`](https://github.com/Bike4Mind/bike4mind/commit/4ce553ebc6d706aef224317811c004f64a8df5f3) Thanks [@dea0030](https://github.com/dea0030)! - bill 'auto' GPT-Image quality at the ceiling tier

- [#2981](https://github.com/Bike4Mind/bike4mind/pull/2981) [`3593192`](https://github.com/Bike4Mind/bike4mind/commit/3593192f407f6a1a337824d2d2b1d5e9d9065a8e) Thanks [@onoya](https://github.com/onoya)! - let tool narrowing reach MCP tools

- [#2991](https://github.com/Bike4Mind/bike4mind/pull/2991) [`f687f87`](https://github.com/Bike4Mind/bike4mind/commit/f687f87600e726f00d1a480d12b8e72bbe3f9691) Thanks [@dea0030](https://github.com/dea0030)! - bill edit-image for the one image it renders, not the requested n

- [#2995](https://github.com/Bike4Mind/bike4mind/pull/2995) [`579ec68`](https://github.com/Bike4Mind/bike4mind/commit/579ec682e39f6b7538cf06c9dda3507e0b0f84e0) Thanks [@jjmarfa](https://github.com/jjmarfa)! - pair tags with taggedAt on notebook overwrite import

- [#3008](https://github.com/Bike4Mind/bike4mind/pull/3008) [`08d11ca`](https://github.com/Bike4Mind/bike4mind/commit/08d11ca36b62bd36e49eb09e8b7ab87477d40512) Thanks [@vinchi777](https://github.com/vinchi777)! - let an explicit lake scope imply forced retrieval

- [#3022](https://github.com/Bike4Mind/bike4mind/pull/3022) [`34443c6`](https://github.com/Bike4Mind/bike4mind/commit/34443c6911e1e96197c2f1d6306fc3ebabde5153) Thanks [@onoya](https://github.com/onoya)! - follow effective ownership for lake memory shredding

- Updated dependencies [[`8e31cbf`](https://github.com/Bike4Mind/bike4mind/commit/8e31cbfad875f80f372f16032f487cde1e624ce1), [`4ce553e`](https://github.com/Bike4Mind/bike4mind/commit/4ce553ebc6d706aef224317811c004f64a8df5f3), [`3593192`](https://github.com/Bike4Mind/bike4mind/commit/3593192f407f6a1a337824d2d2b1d5e9d9065a8e), [`f687f87`](https://github.com/Bike4Mind/bike4mind/commit/f687f87600e726f00d1a480d12b8e72bbe3f9691), [`34443c6`](https://github.com/Bike4Mind/bike4mind/commit/34443c6911e1e96197c2f1d6306fc3ebabde5153)]:
  - @bike4mind/common@10.1.0
  - @bike4mind/utils@6.1.2
  - @bike4mind/agents@1.0.12
  - @bike4mind/auth@0.8.9
  - @bike4mind/db-core@0.6.4
  - @bike4mind/fab-pipeline@1.3.12
  - @bike4mind/llm-adapters@0.15.6
  - @bike4mind/mcp@2.0.12

## 12.0.0

### Major Changes

- [#2886](https://github.com/Bike4Mind/bike4mind/pull/2886) [`e44dc29`](https://github.com/Bike4Mind/bike4mind/commit/e44dc2991b87b37d8b69e1bdc39972ed68d14db6) Thanks [@jarlacut](https://github.com/jarlacut)! - gate imports on the admin file-size limit and a per-import storage quota

- [#2930](https://github.com/Bike4Mind/bike4mind/pull/2930) [`f3f76c2`](https://github.com/Bike4Mind/bike4mind/commit/f3f76c21ef2e882fad72db3f0f36c8c5e8113065) Thanks [@jarlacut](https://github.com/jarlacut)! - gate the remaining FabFile ingest doors

### Patch Changes

- [#2852](https://github.com/Bike4Mind/bike4mind/pull/2852) [`ae494b7`](https://github.com/Bike4Mind/bike4mind/commit/ae494b7b21b97337a9af3e715be20e38ea1d696d) Thanks [@vinchi777](https://github.com/vinchi777)! - strip page chrome from URL-ingest text before it reaches embeddings

- Updated dependencies [[`ae494b7`](https://github.com/Bike4Mind/bike4mind/commit/ae494b7b21b97337a9af3e715be20e38ea1d696d), [`f3f76c2`](https://github.com/Bike4Mind/bike4mind/commit/f3f76c21ef2e882fad72db3f0f36c8c5e8113065), [`b8bd20d`](https://github.com/Bike4Mind/bike4mind/commit/b8bd20d40a1551f6b999cb84745a677984144916)]:
  - @bike4mind/fab-pipeline@1.3.11
  - @bike4mind/common@10.0.0
  - @bike4mind/utils@6.1.1
  - @bike4mind/agents@1.0.11
  - @bike4mind/auth@0.8.8
  - @bike4mind/db-core@0.6.3
  - @bike4mind/llm-adapters@0.15.5
  - @bike4mind/mcp@2.0.11

## 11.0.0

### Major Changes

- [#2932](https://github.com/Bike4Mind/bike4mind/pull/2932) [`4717962`](https://github.com/Bike4Mind/bike4mind/commit/4717962ddba858b806befe85578d29ac59c41e2f) Thanks [@jasonbdaro](https://github.com/jasonbdaro)! - owner-gate lake access widening and replace the invite bearer secret

- [#2389](https://github.com/Bike4Mind/bike4mind/pull/2389) [`9f936cd`](https://github.com/Bike4Mind/bike4mind/commit/9f936cd95670f4e4a254e457ccd5156da26e8242) Thanks [@julsanchez](https://github.com/julsanchez)! - Require the `agents` adapter on the `createUserApiKey` and `updateEmbedKey` service inputs. It was typed optional but threw at runtime when minting or rebinding an `embed:chat` key, so a consumer could compile clean and then fail at runtime; the requirement is now enforced at the type level (the runtime guard remains as defense in depth). Because it is now required on the input, every caller of these two services must pass `db.agents` (a repository exposing `findById`) to compile, not only the ones that mint or configure embed keys.

### Minor Changes

- [#2916](https://github.com/Bike4Mind/bike4mind/pull/2916) [`1f4cf3e`](https://github.com/Bike4Mind/bike4mind/commit/1f4cf3e673a53ab86e7710e20a1bf031751aaf8f) Thanks [@onoya](https://github.com/onoya)! - lock the lake-reachability clause set and close two capture-harness gaps

- [#2921](https://github.com/Bike4Mind/bike4mind/pull/2921) [`c29a80d`](https://github.com/Bike4Mind/bike4mind/commit/c29a80d73048693e57572b20ba281185f795e5b6) Thanks [@vinchi777](https://github.com/vinchi777)! - pass background and output_format through for gpt-image

- [#2933](https://github.com/Bike4Mind/bike4mind/pull/2933) [`be523ac`](https://github.com/Bike4Mind/bike4mind/commit/be523ac69c05c884f17b8f222898f931f23800a2) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add a premium system-prompt registry contribution to codegen

- [#2935](https://github.com/Bike4Mind/bike4mind/pull/2935) [`fee23c5`](https://github.com/Bike4Mind/bike4mind/commit/fee23c53d6c72f083d96dc6664f2294cbecb0b51) Thanks [@maconard](https://github.com/maconard)! - let a user see the context breakdown for their own message

- [#2941](https://github.com/Bike4Mind/bike4mind/pull/2941) [`6db0ddc`](https://github.com/Bike4Mind/bike4mind/commit/6db0ddce9e850b148e6ab9bd5243122a454a6fe6) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - export a session's correction chain as evaluation triples

### Patch Changes

- [#2727](https://github.com/Bike4Mind/bike4mind/pull/2727) [`aa70a4a`](https://github.com/Bike4Mind/bike4mind/commit/aa70a4abe4a87af1a1966d55c20b450d457ac2b3) Thanks [@onoya](https://github.com/onoya)! - gate session-event operational spend behind a credit pre-flight

- [#2919](https://github.com/Bike4Mind/bike4mind/pull/2919) [`7fb76ae`](https://github.com/Bike4Mind/bike4mind/commit/7fb76aee29b002f205b26e0cae13fbfd83c5ba27) Thanks [@jjmarfa](https://github.com/jjmarfa)! - bill chat image generation by the requested quality tier

- [#2920](https://github.com/Bike4Mind/bike4mind/pull/2920) [`abfce42`](https://github.com/Bike4Mind/bike4mind/commit/abfce420f22de9373d1104d88d3648b5281ac9c1) Thanks [@vinchi777](https://github.com/vinchi777)! - normalize multimodal content across providers

- [#2925](https://github.com/Bike4Mind/bike4mind/pull/2925) [`0404fe3`](https://github.com/Bike4Mind/bike4mind/commit/0404fe3d3c75c1f3f47242487375cbf645396b2f) Thanks [@jjmarfa](https://github.com/jjmarfa)! - catch a supplied absent fact in the groundedNoInvention eval

- [#2938](https://github.com/Bike4Mind/bike4mind/pull/2938) [`c7e2540`](https://github.com/Bike4Mind/bike4mind/commit/c7e2540741a46e6d3e0454d28d3a77e6b89b77b0) Thanks [@MattTan257](https://github.com/MattTan257)! - keep the fallback-model badge visible until dismissed

- [#2939](https://github.com/Bike4Mind/bike4mind/pull/2939) [`e477588`](https://github.com/Bike4Mind/bike4mind/commit/e477588bdee7ffa298f9a38e1b32dd2267a29430) Thanks [@allan-gar2x](https://github.com/allan-gar2x)! - surface terminal flag on refresh_recovery_capped audit event

- [#2940](https://github.com/Bike4Mind/bike4mind/pull/2940) [`9030863`](https://github.com/Bike4Mind/bike4mind/commit/9030863d3f86bad75e00767b6d76254b2508daee) Thanks [@dea0030](https://github.com/dea0030)! - bill the chat edit_image tool against the model that renders

- [#2950](https://github.com/Bike4Mind/bike4mind/pull/2950) [`8c3870b`](https://github.com/Bike4Mind/bike4mind/commit/8c3870b58e57fa98f97672ea8c2dbedd4d4348a3) Thanks [@vinchi777](https://github.com/vinchi777)! - spend the search budget fairly across a session's lakes

- [#2951](https://github.com/Bike4Mind/bike4mind/pull/2951) [`d0ad77c`](https://github.com/Bike4Mind/bike4mind/commit/d0ad77cecbdace4bb0bdeb109aa754f76f1ee9f1) Thanks [@onoya](https://github.com/onoya)! - resolve every creator-provenance access arm through effective ownership

- [#2953](https://github.com/Bike4Mind/bike4mind/pull/2953) [`a09600c`](https://github.com/Bike4Mind/bike4mind/commit/a09600c89f6366a45990afa6cb45c789ba672c4d) Thanks [@vinchi777](https://github.com/vinchi777)! - gate forced retrieval on the turn's own score spread

- [#2959](https://github.com/Bike4Mind/bike4mind/pull/2959) [`145215c`](https://github.com/Bike4Mind/bike4mind/commit/145215cc4c3acd67a1921c10137e0c70576bf251) Thanks [@onoya](https://github.com/onoya)! - trim the three fattest tool schemas and guard the budget

- [#2967](https://github.com/Bike4Mind/bike4mind/pull/2967) [`efe48c1`](https://github.com/Bike4Mind/bike4mind/commit/efe48c1d12ea20cc7759f61c2dc6f0ba6f1d52ee) Thanks [@onoya](https://github.com/onoya)! - scope the admin key-mint lake picker to the target user

- Updated dependencies [[`9f936cd`](https://github.com/Bike4Mind/bike4mind/commit/9f936cd95670f4e4a254e457ccd5156da26e8242), [`a5dddf3`](https://github.com/Bike4Mind/bike4mind/commit/a5dddf329c18fb52da5c0b69ecb164c22cd006b6), [`17daf4c`](https://github.com/Bike4Mind/bike4mind/commit/17daf4cfae91f1b83887ce05816446c5d4834ea3), [`1f4cf3e`](https://github.com/Bike4Mind/bike4mind/commit/1f4cf3e673a53ab86e7710e20a1bf031751aaf8f), [`8edb070`](https://github.com/Bike4Mind/bike4mind/commit/8edb070c37947550d9f1fcc2b06eda15069e93a4), [`abfce42`](https://github.com/Bike4Mind/bike4mind/commit/abfce420f22de9373d1104d88d3648b5281ac9c1), [`c29a80d`](https://github.com/Bike4Mind/bike4mind/commit/c29a80d73048693e57572b20ba281185f795e5b6), [`45469bd`](https://github.com/Bike4Mind/bike4mind/commit/45469bd8142119d63393cb5fc353914633acbe88), [`4717962`](https://github.com/Bike4Mind/bike4mind/commit/4717962ddba858b806befe85578d29ac59c41e2f), [`2c9221c`](https://github.com/Bike4Mind/bike4mind/commit/2c9221c0fca6903ff823b064627bb2100c696697), [`8c3870b`](https://github.com/Bike4Mind/bike4mind/commit/8c3870b58e57fa98f97672ea8c2dbedd4d4348a3), [`d0ad77c`](https://github.com/Bike4Mind/bike4mind/commit/d0ad77cecbdace4bb0bdeb109aa754f76f1ee9f1), [`a09600c`](https://github.com/Bike4Mind/bike4mind/commit/a09600c89f6366a45990afa6cb45c789ba672c4d)]:
  - @bike4mind/common@9.0.0
  - @bike4mind/llm-adapters@0.15.4
  - @bike4mind/utils@6.1.0
  - @bike4mind/agents@1.0.10
  - @bike4mind/auth@0.8.7
  - @bike4mind/db-core@0.6.2
  - @bike4mind/fab-pipeline@1.3.10
  - @bike4mind/mcp@2.0.10

## 10.0.0

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

- [#2884](https://github.com/Bike4Mind/bike4mind/pull/2884) [`9310a7a`](https://github.com/Bike4Mind/bike4mind/commit/9310a7a4ef4f5348d3ce57495513d6f087d5b4b8) Thanks [@ken-b4m](https://github.com/ken-b4m)! - bind the leave-it-open licence in the grounded-no-invention rule

- [#2887](https://github.com/Bike4Mind/bike4mind/pull/2887) [`b757a71`](https://github.com/Bike4Mind/bike4mind/commit/b757a7120009f60171e04684b4582f13bddf31b0) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - read admin settings fresh on a manual run

- [#2888](https://github.com/Bike4Mind/bike4mind/pull/2888) [`5d79949`](https://github.com/Bike4Mind/bike4mind/commit/5d7994926622a7af9d6aa38d8e547e014d3838ac) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - surface the sources a discovery run skipped

- [#2889](https://github.com/Bike4Mind/bike4mind/pull/2889) [`d6b86bf`](https://github.com/Bike4Mind/bike4mind/commit/d6b86bf0e7c644adb387d17b48e48ee6da58652c) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - forward quality param to OpenAI for GPT-Image models

- Updated dependencies [[`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39), [`718232a`](https://github.com/Bike4Mind/bike4mind/commit/718232ac8b73f441d39cbf74041f3a06316a7248), [`c619705`](https://github.com/Bike4Mind/bike4mind/commit/c619705a92c6cbbb614b893caee446ae868beab2), [`e4263b7`](https://github.com/Bike4Mind/bike4mind/commit/e4263b73e1c24301fe4e9f6414903697bc715bfa), [`7bd1432`](https://github.com/Bike4Mind/bike4mind/commit/7bd143228cbc2b9be3434ad8d795c2ae76623241), [`b9bc64a`](https://github.com/Bike4Mind/bike4mind/commit/b9bc64a4291420be50017fb34c1dc80f92e64c89), [`d6cd7dd`](https://github.com/Bike4Mind/bike4mind/commit/d6cd7dddabe0428fee52db8fc33d045461ae4c79), [`b757a71`](https://github.com/Bike4Mind/bike4mind/commit/b757a7120009f60171e04684b4582f13bddf31b0), [`5d79949`](https://github.com/Bike4Mind/bike4mind/commit/5d7994926622a7af9d6aa38d8e547e014d3838ac), [`d6b86bf`](https://github.com/Bike4Mind/bike4mind/commit/d6b86bf0e7c644adb387d17b48e48ee6da58652c), [`d086ed5`](https://github.com/Bike4Mind/bike4mind/commit/d086ed5f0049fea32dd03034fe8f084c600b5bd7), [`b91b853`](https://github.com/Bike4Mind/bike4mind/commit/b91b853a865f8f1cf5ab417ade6fac88184886c2), [`91a73c9`](https://github.com/Bike4Mind/bike4mind/commit/91a73c9b9494408f126d267e859f9a9629e6e126), [`13e0733`](https://github.com/Bike4Mind/bike4mind/commit/13e0733c9faf196143a79225d4bcd74623f36dee), [`897db4d`](https://github.com/Bike4Mind/bike4mind/commit/897db4d71005adb476705a5e5bc0f59d4a8ccc39)]:
  - @bike4mind/common@8.0.0
  - @bike4mind/db-core@0.6.1
  - @bike4mind/fab-pipeline@1.3.9
  - @bike4mind/auth@0.8.6
  - @bike4mind/utils@6.0.2
  - @bike4mind/agents@1.0.9
  - @bike4mind/llm-adapters@0.15.3
  - @bike4mind/mcp@2.0.9

## 9.1.0

### Minor Changes

- [#2720](https://github.com/Bike4Mind/bike4mind/pull/2720) [`40f31bd`](https://github.com/Bike4Mind/bike4mind/commit/40f31bd9c9f63e6a2db9d5569222145c84fa46a0) Thanks [@vinchi777](https://github.com/vinchi777)! - add a /feedback slash command for session-level reports

### Patch Changes

- [#2885](https://github.com/Bike4Mind/bike4mind/pull/2885) [`00fb861`](https://github.com/Bike4Mind/bike4mind/commit/00fb8615644725e4936aec459d5dec0bdbac121d) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - name the field behind a refused catalog record

- Updated dependencies [[`bf76770`](https://github.com/Bike4Mind/bike4mind/commit/bf7677008efbd820c9d235e1cbad8a7797fbd4b4), [`40f31bd`](https://github.com/Bike4Mind/bike4mind/commit/40f31bd9c9f63e6a2db9d5569222145c84fa46a0), [`bf76770`](https://github.com/Bike4Mind/bike4mind/commit/bf7677008efbd820c9d235e1cbad8a7797fbd4b4)]:
  - @bike4mind/db-core@0.6.0
  - @bike4mind/common@7.5.0
  - @bike4mind/fab-pipeline@1.3.8
  - @bike4mind/agents@1.0.8
  - @bike4mind/auth@0.8.5
  - @bike4mind/llm-adapters@0.15.2
  - @bike4mind/mcp@2.0.8
  - @bike4mind/utils@6.0.1

## 9.0.0

### Major Changes

- [#2786](https://github.com/Bike4Mind/bike4mind/pull/2786) [`4f8f445`](https://github.com/Bike4Mind/bike4mind/commit/4f8f445aa1d025a5187158fc0a527f475cefbd91) Thanks [@jarlacut](https://github.com/jarlacut)! - resolve ingest file type by extension, with per-door precedence

  **Breaking change.** `resolveSupportedMimeType`'s third parameter is now an options object instead of
  a bare predicate function:

  ```ts
  resolveSupportedMimeType(fileName, claimedMimeType, {
    isAcceptable?: (mimeType: string | null | undefined) => boolean; // defaults to isSupportedFabFileMimeType
    precedence?: 'extension-first' | 'claim-first'; // defaults to 'extension-first'
    extensionlessFallback?: SupportedFabFileMimeTypes;
  })
  ```

  A bare predicate passed as the third argument no longer works - wrap it as
  `{ isAcceptable: yourPredicate }`. `precedence` controls whether the filename
  extension or the caller-supplied MIME type is consulted first, and
  `extensionlessFallback` is the type used for a filename that carries no
  extension at all (and no claim) - omit it to keep a caller strict.

  **Inputs that were previously accepted and are now refused:**

  - A filename with a dot-tail that does not resolve to a known extension is
    refused outright - a claimed MIME type no longer rescues it. (`deploy.sh` or
    `malware.exe` claiming `text/plain` is no longer admitted.)
  - A dotted date or version filename (`Meeting notes 2026.09.07`, `My Report
v1.2`) is refused, because its tail is read as an unrecognized extension.
  - A trailing-dot filename (`payload.`) is treated as malformed rather than
    extension-less, so it no longer receives a plain-text fallback.
  - A URL import that yields no extractable text is now refused with an error
    instead of silently creating an empty file.
  - The Slack ingest door now applies the same extension rule as the other
    ingest doors: an attachment whose filename has an unrecognized or
    date-style tail is refused.

- [#2786](https://github.com/Bike4Mind/bike4mind/pull/2786) [`4f8f445`](https://github.com/Bike4Mind/bike4mind/commit/4f8f445aa1d025a5187158fc0a527f475cefbd91) Thanks [@jarlacut](https://github.com/jarlacut)! - resolve ingest file type by extension, with per-door precedence

### Minor Changes

- [#2863](https://github.com/Bike4Mind/bike4mind/pull/2863) [`8cc4c68`](https://github.com/Bike4Mind/bike4mind/commit/8cc4c68855dcb550815abba6ccbc665bb2b251f0) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - add effective-settings admin read endpoint

### Patch Changes

- [#2782](https://github.com/Bike4Mind/bike4mind/pull/2782) [`7a214d5`](https://github.com/Bike4Mind/bike4mind/commit/7a214d5aa0fb5aa65302f887a3fac356ab3dc8ca) Thanks [@onoya](https://github.com/onoya)! - end a departing member's lake access, and pass on lakes they created

- [#2814](https://github.com/Bike4Mind/bike4mind/pull/2814) [`10dd200`](https://github.com/Bike4Mind/bike4mind/commit/10dd2000171021022593d2c20d866f1d38cc30c7) Thanks [@julsanchez](https://github.com/julsanchez)! - route blog tool fetches through the SSRF guard

- [#2841](https://github.com/Bike4Mind/bike4mind/pull/2841) [`2cfe44d`](https://github.com/Bike4Mind/bike4mind/commit/2cfe44d452803f4be8d6689edfb4ad250b0c881c) Thanks [@onoya](https://github.com/onoya)! - schedule the Anthropic concurrency pool fairly and bound its wait line

- [#2842](https://github.com/Bike4Mind/bike4mind/pull/2842) [`068e14f`](https://github.com/Bike4Mind/bike4mind/commit/068e14f2ab9e45cb7e7cecbae8a49fca1ce85dc6) Thanks [@choyno](https://github.com/choyno)! - validate requiredUserTag as a single matchable tag

- [#2844](https://github.com/Bike4Mind/bike4mind/pull/2844) [`fa08028`](https://github.com/Bike4Mind/bike4mind/commit/fa08028c91136b4f051a45bc4976a7714677f845) Thanks [@choyno](https://github.com/choyno)! - surface lake status on computeLakeHealth so a non-active lake cannot read healthy

- [#2860](https://github.com/Bike4Mind/bike4mind/pull/2860) [`6ea0d28`](https://github.com/Bike4Mind/bike4mind/commit/6ea0d28a8a8db0625f81cba61fd7a5f545dc3483) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - scope settings reads to verified org membership

- [#2861](https://github.com/Bike4Mind/bike4mind/pull/2861) [`0a4253e`](https://github.com/Bike4Mind/bike4mind/commit/0a4253e4f31492b6fea19976a469ffd5e79f4af9) Thanks [@vinchi777](https://github.com/vinchi777)! - report lake lifecycle status in lake health

- Updated dependencies [[`4f8f445`](https://github.com/Bike4Mind/bike4mind/commit/4f8f445aa1d025a5187158fc0a527f475cefbd91), [`7a214d5`](https://github.com/Bike4Mind/bike4mind/commit/7a214d5aa0fb5aa65302f887a3fac356ab3dc8ca), [`4f8f445`](https://github.com/Bike4Mind/bike4mind/commit/4f8f445aa1d025a5187158fc0a527f475cefbd91), [`6f662d8`](https://github.com/Bike4Mind/bike4mind/commit/6f662d81308d53bb430665ed048607da97c4e9ef), [`46ea8e1`](https://github.com/Bike4Mind/bike4mind/commit/46ea8e1efc42e992ebc0a19c4542f65d2665832c), [`2cfe44d`](https://github.com/Bike4Mind/bike4mind/commit/2cfe44d452803f4be8d6689edfb4ad250b0c881c), [`068e14f`](https://github.com/Bike4Mind/bike4mind/commit/068e14f2ab9e45cb7e7cecbae8a49fca1ce85dc6), [`fa08028`](https://github.com/Bike4Mind/bike4mind/commit/fa08028c91136b4f051a45bc4976a7714677f845), [`0a4253e`](https://github.com/Bike4Mind/bike4mind/commit/0a4253e4f31492b6fea19976a469ffd5e79f4af9), [`6ce4b99`](https://github.com/Bike4Mind/bike4mind/commit/6ce4b99b9ab5d4fe8142647a9b3dcef6f0c8ebfd)]:
  - @bike4mind/utils@6.0.0
  - @bike4mind/common@7.4.0
  - @bike4mind/fab-pipeline@1.3.7
  - @bike4mind/llm-adapters@0.15.1
  - @bike4mind/agents@1.0.7
  - @bike4mind/auth@0.8.4
  - @bike4mind/db-core@0.5.7
  - @bike4mind/mcp@2.0.7

## 8.0.0

### Major Changes

- [#2778](https://github.com/Bike4Mind/bike4mind/pull/2778) [`f3d4563`](https://github.com/Bike4Mind/bike4mind/commit/f3d4563c442e4471fd37d3bf35baac96095f5fc5) Thanks [@onoya](https://github.com/onoya)! - keep the LLM tool closure out of the package barrel

### Minor Changes

- [#2812](https://github.com/Bike4Mind/bike4mind/pull/2812) [`fee546f`](https://github.com/Bike4Mind/bike4mind/commit/fee546f162297fbd3cf5acdb41b71906bdabab46) Thanks [@maconard](https://github.com/maconard)! - restore DeepSeek V4 Pro

### Patch Changes

- [#2783](https://github.com/Bike4Mind/bike4mind/pull/2783) [`5e1eee0`](https://github.com/Bike4Mind/bike4mind/commit/5e1eee08f765b93a1c30160c03858e7c5e9fd798) Thanks [@onoya](https://github.com/onoya)! - verify membership and roster authority at every use site

- [#2823](https://github.com/Bike4Mind/bike4mind/pull/2823) [`a4e980d`](https://github.com/Bike4Mind/bike4mind/commit/a4e980d956c721aa734dde981420adcb4bfaa243) Thanks [@onoya](https://github.com/onoya)! - escape dynamic regex inputs and guard dynamic object writes

- [#2826](https://github.com/Bike4Mind/bike4mind/pull/2826) [`d1836db`](https://github.com/Bike4Mind/bike4mind/commit/d1836db1eb4c3d9c738a56b94d01da63f16e325a) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - dedupe sibling private-address guards onto a shared predicate

- [#2828](https://github.com/Bike4Mind/bike4mind/pull/2828) [`2922d00`](https://github.com/Bike4Mind/bike4mind/commit/2922d0061d5ee3673da2a3b9bd88f11b7005e5db) Thanks [@onoya](https://github.com/onoya)! - let a caller rung only raise the search serve budget

- [#2843](https://github.com/Bike4Mind/bike4mind/pull/2843) [`13322f6`](https://github.com/Bike4Mind/bike4mind/commit/13322f6bcc3473bdc243d1d4e397e069204273a6) Thanks [@onoya](https://github.com/onoya)! - harden the shared settings int-coercion helpers

- Updated dependencies [[`5e1eee0`](https://github.com/Bike4Mind/bike4mind/commit/5e1eee08f765b93a1c30160c03858e7c5e9fd798), [`fee546f`](https://github.com/Bike4Mind/bike4mind/commit/fee546f162297fbd3cf5acdb41b71906bdabab46), [`a4e980d`](https://github.com/Bike4Mind/bike4mind/commit/a4e980d956c721aa734dde981420adcb4bfaa243), [`2922d00`](https://github.com/Bike4Mind/bike4mind/commit/2922d0061d5ee3673da2a3b9bd88f11b7005e5db), [`afba631`](https://github.com/Bike4Mind/bike4mind/commit/afba6315105929e9b39672a2d0d23caad7f8e4aa)]:
  - @bike4mind/common@7.3.0
  - @bike4mind/llm-adapters@0.15.0
  - @bike4mind/utils@5.2.0
  - @bike4mind/agents@1.0.6
  - @bike4mind/fab-pipeline@1.3.6
  - @bike4mind/auth@0.8.3
  - @bike4mind/db-core@0.5.6
  - @bike4mind/mcp@2.0.6

## 7.2.2

### Patch Changes

- [#2765](https://github.com/Bike4Mind/bike4mind/pull/2765) [`2298140`](https://github.com/Bike4Mind/bike4mind/commit/229814036a13097cae1cd3ccc19d052d4d6c17f9) Thanks [@onoya](https://github.com/onoya)! - resolve search budgets on the caller scope in the semantic-search route

- Updated dependencies [[`2298140`](https://github.com/Bike4Mind/bike4mind/commit/229814036a13097cae1cd3ccc19d052d4d6c17f9)]:
  - @bike4mind/common@7.2.2
  - @bike4mind/agents@1.0.5
  - @bike4mind/auth@0.8.2
  - @bike4mind/db-core@0.5.5
  - @bike4mind/fab-pipeline@1.3.5
  - @bike4mind/llm-adapters@0.14.2
  - @bike4mind/mcp@2.0.5
  - @bike4mind/utils@5.1.2

## 7.2.1

### Patch Changes

- [#2796](https://github.com/Bike4Mind/bike4mind/pull/2796) [`8ef2c17`](https://github.com/Bike4Mind/bike4mind/commit/8ef2c17f7b54b0df8c3809f17a62544784e65029) Thanks [@onoya](https://github.com/onoya)! - derive the scoped-retrieval Lake-rung guard from the reads' own key lists

- Updated dependencies [[`8ef2c17`](https://github.com/Bike4Mind/bike4mind/commit/8ef2c17f7b54b0df8c3809f17a62544784e65029)]:
  - @bike4mind/common@7.2.1
  - @bike4mind/agents@1.0.4
  - @bike4mind/auth@0.8.1
  - @bike4mind/db-core@0.5.4
  - @bike4mind/fab-pipeline@1.3.4
  - @bike4mind/llm-adapters@0.14.1
  - @bike4mind/mcp@2.0.4
  - @bike4mind/utils@5.1.1

## 7.2.0

### Minor Changes

- [#2760](https://github.com/Bike4Mind/bike4mind/pull/2760) [`f72cd4b`](https://github.com/Bike4Mind/bike4mind/commit/f72cd4b612275d641680699cfd4f6e91976903f7) Thanks [@onoya](https://github.com/onoya)! - measure and alarm on ANN query duration

- [#2762](https://github.com/Bike4Mind/bike4mind/pull/2762) [`adc900a`](https://github.com/Bike4Mind/bike4mind/commit/adc900ab152e00d3324bc228ac73c98a5cb5e2ef) Thanks [@maconard](https://github.com/maconard)! - add DeepSeek as a first-party provider and close Moonshot gaps

- [#2773](https://github.com/Bike4Mind/bike4mind/pull/2773) [`b660460`](https://github.com/Bike4Mind/bike4mind/commit/b6604604904ae62ab4c6745ec4e2335e05706e68) Thanks [@vinchi777](https://github.com/vinchi777)! - record which lake prompts the owner/curator grant arm admitted

### Patch Changes

- [#2682](https://github.com/Bike4Mind/bike4mind/pull/2682) [`f6407e2`](https://github.com/Bike4Mind/bike4mind/commit/f6407e27d91175446e28246e1234d4c0a409c694) Thanks [@onoya](https://github.com/onoya)! - fall back to a keyless Bedrock embedder when no provider credential resolves

- [#2758](https://github.com/Bike4Mind/bike4mind/pull/2758) [`0a931d2`](https://github.com/Bike4Mind/bike4mind/commit/0a931d25ddbfc35963f82f1bb6ea26b89a10f39e) Thanks [@onoya](https://github.com/onoya)! - resolve cosine relevance floors per embedding space

- [#2759](https://github.com/Bike4Mind/bike4mind/pull/2759) [`671c753`](https://github.com/Bike4Mind/bike4mind/commit/671c753fc81d65561729f591bc7038e4c605126c) Thanks [@onoya](https://github.com/onoya)! - report unmeasured lake members as unmeasured, and disclose the corpus-scope gap

- [#2770](https://github.com/Bike4Mind/bike4mind/pull/2770) [`e543fe6`](https://github.com/Bike4Mind/bike4mind/commit/e543fe695608f0c4fb9aade7a0be974aa2c44f4e) Thanks [@wescarda](https://github.com/wescarda)! - use isObjectIdShaped instead of lowercase-only hex regex

- [#2775](https://github.com/Bike4Mind/bike4mind/pull/2775) [`36fae3b`](https://github.com/Bike4Mind/bike4mind/commit/36fae3b0e2a448442c65b83735de0406ed233370) Thanks [@vinchi777](https://github.com/vinchi777)! - record the resolved lake scope at the retrieval seed site

- [#2776](https://github.com/Bike4Mind/bike4mind/pull/2776) [`534d9c6`](https://github.com/Bike4Mind/bike4mind/commit/534d9c69e757aa69d4d68ef713199afbb94d53a5) Thanks [@wescarda](https://github.com/wescarda)! - resolve OpenAI bare model aliases (gpt-4.1) in the public completions API

- Updated dependencies [[`b5c25db`](https://github.com/Bike4Mind/bike4mind/commit/b5c25db2ff248dd7491f7c263ae69cd1aaf23eca), [`0abc901`](https://github.com/Bike4Mind/bike4mind/commit/0abc9019ce87dc58c96e63273c32eb1310e121fa), [`aedbc31`](https://github.com/Bike4Mind/bike4mind/commit/aedbc312f5c166b52e166d795c7a2c6917134964), [`f6407e2`](https://github.com/Bike4Mind/bike4mind/commit/f6407e27d91175446e28246e1234d4c0a409c694), [`a756c37`](https://github.com/Bike4Mind/bike4mind/commit/a756c379f89401a9cfefc41735df4610dd5da0ce), [`0a931d2`](https://github.com/Bike4Mind/bike4mind/commit/0a931d25ddbfc35963f82f1bb6ea26b89a10f39e), [`671c753`](https://github.com/Bike4Mind/bike4mind/commit/671c753fc81d65561729f591bc7038e4c605126c), [`adc900a`](https://github.com/Bike4Mind/bike4mind/commit/adc900ab152e00d3324bc228ac73c98a5cb5e2ef), [`b660460`](https://github.com/Bike4Mind/bike4mind/commit/b6604604904ae62ab4c6745ec4e2335e05706e68), [`36fae3b`](https://github.com/Bike4Mind/bike4mind/commit/36fae3b0e2a448442c65b83735de0406ed233370)]:
  - @bike4mind/common@7.2.0
  - @bike4mind/mcp@2.0.3
  - @bike4mind/llm-adapters@0.14.0
  - @bike4mind/fab-pipeline@1.3.3
  - @bike4mind/utils@5.1.0
  - @bike4mind/auth@0.8.0
  - @bike4mind/agents@1.0.3
  - @bike4mind/db-core@0.5.3

## 7.1.1

### Patch Changes

- Updated dependencies [[`7958ee1`](https://github.com/Bike4Mind/bike4mind/commit/7958ee13d277295ed9877a24686aa266265a727f), [`0e11dab`](https://github.com/Bike4Mind/bike4mind/commit/0e11dab88d9141c364c2f9192681fd94023050d3)]:
  - @bike4mind/common@7.1.1
  - @bike4mind/llm-adapters@0.13.0
  - @bike4mind/agents@1.0.2
  - @bike4mind/auth@0.7.6
  - @bike4mind/db-core@0.5.2
  - @bike4mind/fab-pipeline@1.3.2
  - @bike4mind/mcp@2.0.2
  - @bike4mind/utils@5.0.2

## 7.1.0

### Minor Changes

- [#2465](https://github.com/Bike4Mind/bike4mind/pull/2465) [`576f59f`](https://github.com/Bike4Mind/bike4mind/commit/576f59f9cb237c473c2793e72cd33e1648f12327) Thanks [@onoya](https://github.com/onoya)! - per-document search cap + rescue sweep metrics ([#1422](https://github.com/Bike4Mind/bike4mind/issues/1422))

### Patch Changes

- Updated dependencies [[`576f59f`](https://github.com/Bike4Mind/bike4mind/commit/576f59f9cb237c473c2793e72cd33e1648f12327)]:
  - @bike4mind/common@7.1.0
  - @bike4mind/agents@1.0.1
  - @bike4mind/auth@0.7.5
  - @bike4mind/db-core@0.5.1
  - @bike4mind/fab-pipeline@1.3.1
  - @bike4mind/llm-adapters@0.12.2
  - @bike4mind/mcp@2.0.1
  - @bike4mind/utils@5.0.1

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

- [#2458](https://github.com/Bike4Mind/bike4mind/pull/2458) [`b8c6d29`](https://github.com/Bike4Mind/bike4mind/commit/b8c6d290a814bdf7e9cc04eb2c90c970d53976df) Thanks [@jjmarfa](https://github.com/jjmarfa)! - flag cross-document retrieval conflicts for the model

- Updated dependencies [[`49f96c3`](https://github.com/Bike4Mind/bike4mind/commit/49f96c3ca5303a29ac6acb318d6178a7ec7efa48), [`920a061`](https://github.com/Bike4Mind/bike4mind/commit/920a061ec7c079a86b8e4b8a2627b631af8e8fef), [`51b306b`](https://github.com/Bike4Mind/bike4mind/commit/51b306b8b5c12062e54bd586f51a80c35e581f99), [`1bdf739`](https://github.com/Bike4Mind/bike4mind/commit/1bdf7391cc8f83d42b2b00ecab7b528e5a3c0d09), [`ddd4e75`](https://github.com/Bike4Mind/bike4mind/commit/ddd4e7592d99876c8910f02afdc8d1782878f55f), [`787c867`](https://github.com/Bike4Mind/bike4mind/commit/787c867b9445547e05a4ab32c69cd58716aa3c53), [`116346b`](https://github.com/Bike4Mind/bike4mind/commit/116346b680d797c539e5112086aae7ed91f36273), [`70ec2a6`](https://github.com/Bike4Mind/bike4mind/commit/70ec2a68decf31e67edc8d354115b0ef7299730f), [`214d076`](https://github.com/Bike4Mind/bike4mind/commit/214d076194b7b5792af4011b29a9d071c7b7a35e), [`f2f9b3d`](https://github.com/Bike4Mind/bike4mind/commit/f2f9b3d6ae4dc69aa763b15bfc5af3f8e7ada12c), [`a467b99`](https://github.com/Bike4Mind/bike4mind/commit/a467b99c43e695a3c1657a08ddd874da4e2438ca), [`1c39465`](https://github.com/Bike4Mind/bike4mind/commit/1c394654b3ace280b8b0941742d09fbb01a236a8), [`95d158a`](https://github.com/Bike4Mind/bike4mind/commit/95d158a96782d16dceb7e56e9984ed7ab7bb5cd9), [`b6bcd64`](https://github.com/Bike4Mind/bike4mind/commit/b6bcd64d712d5231937518f329194d6504b4d3df), [`9c5588c`](https://github.com/Bike4Mind/bike4mind/commit/9c5588c25e8025755ebe0eab77c4af208ef27538), [`469c391`](https://github.com/Bike4Mind/bike4mind/commit/469c391f0e9d48ba9285210f00f597bdafb26810), [`545e51b`](https://github.com/Bike4Mind/bike4mind/commit/545e51b5a17c439ba7bd303bd4033fe0b8d4cd37), [`d6cf4b1`](https://github.com/Bike4Mind/bike4mind/commit/d6cf4b1e7a6bb09d05f3cbf041a0b1d158bb3e2b), [`1d65698`](https://github.com/Bike4Mind/bike4mind/commit/1d656985af6f8c2b3b2a486d932feca5e541a9cd), [`2351bad`](https://github.com/Bike4Mind/bike4mind/commit/2351bad305a9ea7a249669078792d970f40e73a6), [`e465103`](https://github.com/Bike4Mind/bike4mind/commit/e465103247d17e39750edc7bc9a7dddee249db7e), [`55fb6c3`](https://github.com/Bike4Mind/bike4mind/commit/55fb6c39ffc7e881293dc715594770f43c865e1a), [`354f3c6`](https://github.com/Bike4Mind/bike4mind/commit/354f3c65b4a9e84401801e3e868f217c7454cd3f), [`ad5801f`](https://github.com/Bike4Mind/bike4mind/commit/ad5801f5d44cfd198e424af10c9780aff3c04643), [`7703e89`](https://github.com/Bike4Mind/bike4mind/commit/7703e8901332dc54d0533f0784dbfbb21df7772d), [`68cfd6b`](https://github.com/Bike4Mind/bike4mind/commit/68cfd6b0458c9c45a387cd24ab46399ed5afbca9), [`c7ac7d2`](https://github.com/Bike4Mind/bike4mind/commit/c7ac7d2d76150ef30c20e692d0445c4518575b1d), [`3ac67a8`](https://github.com/Bike4Mind/bike4mind/commit/3ac67a8ef1540c89b885458d2dedb4be77a3d752), [`4af59ad`](https://github.com/Bike4Mind/bike4mind/commit/4af59adbd76c4de00d78db6c8f3d2ed9eeea7085), [`72430db`](https://github.com/Bike4Mind/bike4mind/commit/72430db9a825facba11528fbd04ad620d91761f7), [`f191816`](https://github.com/Bike4Mind/bike4mind/commit/f19181619bceed9c225ca4586305fb219cdb2589), [`ed62ab7`](https://github.com/Bike4Mind/bike4mind/commit/ed62ab7149c9af24b36e772a5bbf934d512674b7), [`8fd5c09`](https://github.com/Bike4Mind/bike4mind/commit/8fd5c09dc29ac2b516552a1d289d5113631520d0), [`f712bb8`](https://github.com/Bike4Mind/bike4mind/commit/f712bb827c37af41c43d26ef9e5b4c607ee7f056), [`1cd2b7d`](https://github.com/Bike4Mind/bike4mind/commit/1cd2b7d520bd9150e54c3f8a3df2f1bc2b51afcd), [`9b317ab`](https://github.com/Bike4Mind/bike4mind/commit/9b317ab5825776b433e69a1d8f255a12e8be625b), [`fbc0c09`](https://github.com/Bike4Mind/bike4mind/commit/fbc0c0959bf597d4dc253d5ef1bdf1f7f2b2723b), [`32f72a1`](https://github.com/Bike4Mind/bike4mind/commit/32f72a160b0bb5827dd9a458ea16a6adb7abae39), [`201bf43`](https://github.com/Bike4Mind/bike4mind/commit/201bf436ba987b47c363ebc7a6c7b4ece8801860), [`b0b13bf`](https://github.com/Bike4Mind/bike4mind/commit/b0b13bf82601945d456dd0bf59b3aecf19eed137), [`ea49d82`](https://github.com/Bike4Mind/bike4mind/commit/ea49d82a08e85ff27a43699b7ecdd85a526857c5), [`8c183d3`](https://github.com/Bike4Mind/bike4mind/commit/8c183d3f6b7ce48eaf1e8bfe61e82e18332cf9b2), [`cc0e8e3`](https://github.com/Bike4Mind/bike4mind/commit/cc0e8e3ae147c45f375e8ddecea5503e97fb78e7), [`e285e73`](https://github.com/Bike4Mind/bike4mind/commit/e285e738ff13227869492811f1a10865d6d82f03), [`be2fd04`](https://github.com/Bike4Mind/bike4mind/commit/be2fd04c6fd9d591ed48a46e62df95da3d0c1816), [`99ca5cf`](https://github.com/Bike4Mind/bike4mind/commit/99ca5cff668240c067a0ac31ad9caeeb8b45de34), [`3061759`](https://github.com/Bike4Mind/bike4mind/commit/3061759af9f5140a0d3f01667973f8f574f191ff), [`42c04cc`](https://github.com/Bike4Mind/bike4mind/commit/42c04cc38d47b51d9579c3d7dced5df42cd1b7f8), [`b8c6d29`](https://github.com/Bike4Mind/bike4mind/commit/b8c6d290a814bdf7e9cc04eb2c90c970d53976df), [`f4cce81`](https://github.com/Bike4Mind/bike4mind/commit/f4cce81c67e29b74f6ba7f9775438e3799fd92b0), [`cb227a3`](https://github.com/Bike4Mind/bike4mind/commit/cb227a3ad54ecfd5647ff92f4ebf68e3a4651c99), [`e79c63d`](https://github.com/Bike4Mind/bike4mind/commit/e79c63dc24c06e36e690282c2190e944a67b00f1), [`466e5a9`](https://github.com/Bike4Mind/bike4mind/commit/466e5a9b2ed4276f8886faec3aea42ff8484434b), [`872164a`](https://github.com/Bike4Mind/bike4mind/commit/872164aef40a5fc24673a0c0a6ced35c97be36e2), [`466e5a9`](https://github.com/Bike4Mind/bike4mind/commit/466e5a9b2ed4276f8886faec3aea42ff8484434b)]:
  - @bike4mind/common@7.0.0
  - @bike4mind/utils@5.0.0
  - @bike4mind/db-core@0.5.0
  - @bike4mind/llm-adapters@0.12.1
  - @bike4mind/fab-pipeline@1.3.0
  - @bike4mind/agents@1.0.0
  - @bike4mind/mcp@2.0.0
  - @bike4mind/auth@0.7.4

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
