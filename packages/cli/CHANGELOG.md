# @bike4mind/cli

## 4.1.0

### Minor Changes

- [#5271](https://github.com/Bike4Mind/bike4mind/pull/5271) [`aa80549`](https://github.com/Bike4Mind/bike4mind/commit/aa8054946833fbe7b083f239c7d073d74d48d871) Thanks [@poysama](https://github.com/poysama)! - let the shared provider keys authenticate through workload identity federation on AWS

### Patch Changes

- [#5421](https://github.com/Bike4Mind/bike4mind/pull/5421) [`3beb481`](https://github.com/Bike4Mind/bike4mind/commit/3beb4812789587be08ce490f4293b01ead4cfe5b) Thanks [@onoya](https://github.com/onoya)! - sanitize untrusted text through one terminal escaping layer

- [#5559](https://github.com/Bike4Mind/bike4mind/pull/5559) [`c668716`](https://github.com/Bike4Mind/bike4mind/commit/c668716920ee4cd0147bf9711cb3235844cc13b7) Thanks [@choyno](https://github.com/choyno)! - tighten sandbox path defaults and host git invocation

- [#5562](https://github.com/Bike4Mind/bike4mind/pull/5562) [`60bb993`](https://github.com/Bike4Mind/bike4mind/commit/60bb9933603f8f61a15a85425dbf386c486e5dc3) Thanks [@choyno](https://github.com/choyno)! - scope session approval for shell commands to the approved command

- [#5566](https://github.com/Bike4Mind/bike4mind/pull/5566) [`aee3b68`](https://github.com/Bike4Mind/bike4mind/commit/aee3b683f830087b8ca9ef272a54cd8c432ce8e6) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - lower sound-effects prompt cap to 450 chars

- [#5571](https://github.com/Bike4Mind/bike4mind/pull/5571) [`25c233f`](https://github.com/Bike4Mind/bike4mind/commit/25c233f13123129551704ef1906810bb9a3266a3) Thanks [@onoya](https://github.com/onoya)! - remove the unused Keep command handler

- [#5616](https://github.com/Bike4Mind/bike4mind/pull/5616) [`56ad0d4`](https://github.com/Bike4Mind/bike4mind/commit/56ad0d415fb07e69fb65105284014169e5463a5c) Thanks [@choyno](https://github.com/choyno)! - enforce the sandbox network allowlist at the sandbox boundary

- [#5641](https://github.com/Bike4Mind/bike4mind/pull/5641) [`bd09831`](https://github.com/Bike4Mind/bike4mind/commit/bd09831db3775906aee7aca9ba9fe421fd36f15e) Thanks [@julsanchez](https://github.com/julsanchez)! - match --allowedTools mcp__<server>__* against MCP tools

- [#5642](https://github.com/Bike4Mind/bike4mind/pull/5642) [`534bb10`](https://github.com/Bike4Mind/bike4mind/commit/534bb10a49564c827a6d6150045636de7f6c15c9) Thanks [@julsanchez](https://github.com/julsanchez)! - skip the folder-trust prompt on a host launch with a queued prompt

## 4.0.0

### Major Changes

- [#5483](https://github.com/Bike4Mind/bike4mind/pull/5483) [`bf81707`](https://github.com/Bike4Mind/bike4mind/commit/bf81707cf7211ad846748bc012454ec79e721504) Thanks [@choyno](https://github.com/choyno)! - require a bearer token for mcp serve --http

### Minor Changes

- [#5162](https://github.com/Bike4Mind/bike4mind/pull/5162) [`3d73686`](https://github.com/Bike4Mind/bike4mind/commit/3d7368634829f526d919c5b09bbb704d95c04348) Thanks [@julsanchez](https://github.com/julsanchez)! - upload local skills and publish them to the Skill Market

- [#5168](https://github.com/Bike4Mind/bike4mind/pull/5168) [`cb1220f`](https://github.com/Bike4Mind/bike4mind/commit/cb1220fd8fb877a50bd8a5cefbb9124794d2a1c0) Thanks [@julsanchez](https://github.com/julsanchez)! - add b4m skills push to import a SKILL.md as a skill

- [#5212](https://github.com/Bike4Mind/bike4mind/pull/5212) [`8541a8e`](https://github.com/Bike4Mind/bike4mind/commit/8541a8e776eacefc3f241e15060493355333cf92) Thanks [@jebie](https://github.com/jebie)! - load deferred tools via tool_reference on Anthropic models

- [#5219](https://github.com/Bike4Mind/bike4mind/pull/5219) [`d8bd931`](https://github.com/Bike4Mind/bike4mind/commit/d8bd931acf4e64c953a632f500c87c8040743686) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - serve solver tools from the stdio MCP server

- [#5315](https://github.com/Bike4Mind/bike4mind/pull/5315) [`758a71f`](https://github.com/Bike4Mind/bike4mind/commit/758a71f49506ea81f3e665f0e179e10b123d449c) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - add Bob site-read tools to the B4M MCP server

- [#5428](https://github.com/Bike4Mind/bike4mind/pull/5428) [`d0f839c`](https://github.com/Bike4Mind/bike4mind/commit/d0f839cb64f6db020c5184c038dca4a971cfed47) Thanks [@jebie](https://github.com/jebie)! - native tool search on Bedrock

- [#5430](https://github.com/Bike4Mind/bike4mind/pull/5430) [`ba24fb7`](https://github.com/Bike4Mind/bike4mind/commit/ba24fb71a1c8ef55208cd4799f380883d76329db) Thanks [@onoya](https://github.com/onoya)! - queue steering and follow-up messages with race-safe cancel

- [#5452](https://github.com/Bike4Mind/bike4mind/pull/5452) [`753dde5`](https://github.com/Bike4Mind/bike4mind/commit/753dde5096907966ae493c52748f38522a774fb6) Thanks [@vinchi777](https://github.com/vinchi777)! - collapse skill groups and list only SKILL.md as a skill

- [#5481](https://github.com/Bike4Mind/bike4mind/pull/5481) [`40fa1d2`](https://github.com/Bike4Mind/bike4mind/commit/40fa1d2890551fb9f2cf6933be3725652ee8e655) Thanks [@vinchi777](https://github.com/vinchi777)! - list every model-invocable skill in the agent prompt

### Patch Changes

- [#5240](https://github.com/Bike4Mind/bike4mind/pull/5240) [`06b1887`](https://github.com/Bike4Mind/bike4mind/commit/06b1887b08c3fc4544168b6421e5aacfd1509627) Thanks [@jarlacut](https://github.com/jarlacut)! - return retryable 503 when Ollama or local image listing fails

- [#5300](https://github.com/Bike4Mind/bike4mind/pull/5300) [`40c9433`](https://github.com/Bike4Mind/bike4mind/commit/40c9433f8be4b9c7df8bd1ddffe9d0fe24cb062e) Thanks [@vinchi777](https://github.com/vinchi777)! - show a started session before its worktree is ready

- [#5313](https://github.com/Bike4Mind/bike4mind/pull/5313) [`e9a2ece`](https://github.com/Bike4Mind/bike4mind/commit/e9a2ece4478baa42ad0a3e4d95752d8e79c7a9a5) Thanks [@onoya](https://github.com/onoya)! - run redaction, output cap and checkpoint in the tool gateway

- [#5460](https://github.com/Bike4Mind/bike4mind/pull/5460) [`0741792`](https://github.com/Bike4Mind/bike4mind/commit/074179264f77d6c72938e1d9769c906727d1b801) Thanks [@vinchi777](https://github.com/vinchi777)! - classify upstream caller errors

- [#5507](https://github.com/Bike4Mind/bike4mind/pull/5507) [`920dd45`](https://github.com/Bike4Mind/bike4mind/commit/920dd4527f5a7e68dab5043cf5ec6fef7f6eb9d4) Thanks [@jjmarfa](https://github.com/jjmarfa)! - report hearth hook stdin errors and failed POSTs

## 3.4.0

### Minor Changes

- [#5191](https://github.com/Bike4Mind/bike4mind/pull/5191) [`a68d013`](https://github.com/Bike4Mind/bike4mind/commit/a68d013d2a4c7a59268f3bfbb2ed9b343a0a36c0) Thanks [@jjmarfa](https://github.com/jjmarfa)! - Add the `decide` server tool to the CLI and shared tool schemas, with deployment-aware availability and permission handling.

- [#5154](https://github.com/Bike4Mind/bike4mind/pull/5154) [`2d33506`](https://github.com/Bike4Mind/bike4mind/commit/2d33506efd4f95460139dedb554780ac544be23c) Thanks [@julsanchez](https://github.com/julsanchez)! - export skills to Claude Code as SKILL.md and import SKILL.md into new skills

## 3.3.0

### Minor Changes

- [#4996](https://github.com/Bike4Mind/bike4mind/pull/4996) [`de55441`](https://github.com/Bike4Mind/bike4mind/commit/de554410692906f78ff0c6f51c6edbdb26b4b760) Thanks [@onoya](https://github.com/onoya)! - ask before retrying a sandbox-denied command outside the sandbox

- [#5161](https://github.com/Bike4Mind/bike4mind/pull/5161) [`ded54cd`](https://github.com/Bike4Mind/bike4mind/commit/ded54cd85be360b44f87070416c46c30918a627f) Thanks [@julsanchez](https://github.com/julsanchez)! - RemoteSkillSource: opt-in `includeImports` (Skill Market imports kept and marked `untrusted`, for hosts that run them wrapped as untrusted content) and `invalidate()` to refetch inside the TTL. CLI behaviour is unchanged.

## 3.2.0

### Minor Changes

- [#4966](https://github.com/Bike4Mind/bike4mind/pull/4966) [`167e186`](https://github.com/Bike4Mind/bike4mind/commit/167e186fb7ee88df6a07b6e3539a0a72c92e2f0f) Thanks [@onoya](https://github.com/onoya)! - typed response schemas for quest plans, quest timeout and groups

### Patch Changes

- [#4969](https://github.com/Bike4Mind/bike4mind/pull/4969) [`697c9a6`](https://github.com/Bike4Mind/bike4mind/commit/697c9a6326b28232ecb44befe662b0dcbc8de617) Thanks [@erikbethke](https://github.com/erikbethke)! - match the MCP Registry name casing to the Bike4Mind org login

- [#4989](https://github.com/Bike4Mind/bike4mind/pull/4989) [`6a2291f`](https://github.com/Bike4Mind/bike4mind/commit/6a2291f29592aff2a57f1d48b88d105b90d10a7b) Thanks [@onoya](https://github.com/onoya)! - derive tool policy from per-tool descriptors in a tool gateway

- [#4991](https://github.com/Bike4Mind/bike4mind/pull/4991) [`06f2578`](https://github.com/Bike4Mind/bike4mind/commit/06f2578e3753ee70ad8df59b3b3ed16fd6c754a1) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - extract the CLI tool search into b4m-core/agents

## 3.1.0

### Minor Changes

- [#4935](https://github.com/Bike4Mind/bike4mind/pull/4935) [`5a491df`](https://github.com/Bike4Mind/bike4mind/commit/5a491df942d3af2691ee0d2873aa77128efd5285) Thanks [@onoya](https://github.com/onoya)! - add create_artifact tool to the B4M MCP server

## 3.0.0

### Major Changes

- [#4331](https://github.com/Bike4Mind/bike4mind/pull/4331) [`0cbe715`](https://github.com/Bike4Mind/bike4mind/commit/0cbe71548676fdbe7647fef37058133753b426e8) Thanks [@dea0030](https://github.com/dea0030)! - require an explicit authOrigin on ToolContext

- [#4724](https://github.com/Bike4Mind/bike4mind/pull/4724) [`6711c5f`](https://github.com/Bike4Mind/bike4mind/commit/6711c5fe5f8d9c9f1d37e5ba7739fd9a3678a13a) Thanks [@onoya](https://github.com/onoya)! - serve generated media through short-lived signed URLs

### Minor Changes

- [#4187](https://github.com/Bike4Mind/bike4mind/pull/4187) [`8ad3249`](https://github.com/Bike4Mind/bike4mind/commit/8ad32497393db0a4a0d01b419ca398a276d46b11) Thanks [@vinchi777](https://github.com/vinchi777)! - emit a toolStarted frame when a tool call opens

- [#4210](https://github.com/Bike4Mind/bike4mind/pull/4210) [`b9a1e41`](https://github.com/Bike4Mind/bike4mind/commit/b9a1e41588a85d9ff0f38447c84bfc403880cdbf) Thanks [@julsanchez](https://github.com/julsanchez)! - fail send_message on errored/stopped turns and stop the turn on cancel

- [#4211](https://github.com/Bike4Mind/bike4mind/pull/4211) [`9f7195a`](https://github.com/Bike4Mind/bike4mind/commit/9f7195a28ff0128a595428a065bdf3a8c986c0bf) Thanks [@julsanchez](https://github.com/julsanchez)! - add a typed @bike4mind/sdk client generated from the OpenAPI spec

- [#4670](https://github.com/Bike4Mind/bike4mind/pull/4670) [`70eb763`](https://github.com/Bike4Mind/bike4mind/commit/70eb7633ee731cce9f4a41667cccd0e37bd87419) Thanks [@vinchi777](https://github.com/vinchi777)! - add the Electron desktop client

- [#4671](https://github.com/Bike4Mind/bike4mind/pull/4671) [`e522492`](https://github.com/Bike4Mind/bike4mind/commit/e5224921043739026e3a234e9dd29e6d5f8ee7b5) Thanks [@julsanchez](https://github.com/julsanchez)! - add the Skill Market (publish, safety scan, review, import, rate)

- [#4694](https://github.com/Bike4Mind/bike4mind/pull/4694) [`eb0a121`](https://github.com/Bike4Mind/bike4mind/commit/eb0a121eb1e0b31f9f5359c984b20d8b6b9fdec9) Thanks [@onoya](https://github.com/onoya)! - stream assistant text to the TUI as it arrives

- [#4725](https://github.com/Bike4Mind/bike4mind/pull/4725) [`89ed029`](https://github.com/Bike4Mind/bike4mind/commit/89ed029b1cccec68a5651b3843da2a769e1746ea) Thanks [@julsanchez](https://github.com/julsanchez)! - show Bike4Mind account skills in Customize and the picker

- [#4768](https://github.com/Bike4Mind/bike4mind/pull/4768) [`0d96e9e`](https://github.com/Bike4Mind/bike4mind/commit/0d96e9e68a8082930b44ddf7153523f77532efb8) Thanks [@onoya](https://github.com/onoya)! - add publish_artifact tool to the B4M MCP server

- [#4772](https://github.com/Bike4Mind/bike4mind/pull/4772) [`6ea5a12`](https://github.com/Bike4Mind/bike4mind/commit/6ea5a12fd1255269b4b78ece0b2db57e46b350be) Thanks [@onoya](https://github.com/onoya)! - repair the transcript before every model request

- [#4786](https://github.com/Bike4Mind/bike4mind/pull/4786) [`0c814ff`](https://github.com/Bike4Mind/bike4mind/commit/0c814ffd06baa6d5f9199c8c9eaaee07a137f1c6) Thanks [@onoya](https://github.com/onoya)! - typed model-call errors and one retry decision

- [#4863](https://github.com/Bike4Mind/bike4mind/pull/4863) [`0bab465`](https://github.com/Bike4Mind/bike4mind/commit/0bab4656ac106d0513dc34a53e789ae03bd76430) Thanks [@vinchi777](https://github.com/vinchi777)! - report reasoning tokens in the completions usage event

- [#4899](https://github.com/Bike4Mind/bike4mind/pull/4899) [`f0bb340`](https://github.com/Bike4Mind/bike4mind/commit/f0bb3402751dc6f7dd9c514b0b8e32dad97ef4c5) Thanks [@onoya](https://github.com/onoya)! - route every CLI-built tool through the permission wrapper

### Patch Changes

- [#4372](https://github.com/Bike4Mind/bike4mind/pull/4372) [`57a3bdb`](https://github.com/Bike4Mind/bike4mind/commit/57a3bdb8e9ae0004ce01d384dfcd2fcd827c1e33) Thanks [@erikbethke](https://github.com/erikbethke)! - one picker row per model, keyboard-selectable cards, catalog-only Gemini ids

- [#4414](https://github.com/Bike4Mind/bike4mind/pull/4414) [`d075a46`](https://github.com/Bike4Mind/bike4mind/commit/d075a46d5310069e45521a88928ec9ac710b325e) Thanks [@jarlacut](https://github.com/jarlacut)! - return real HTTP status for pre-stream completion failures

- [#4466](https://github.com/Bike4Mind/bike4mind/pull/4466) [`48016b1`](https://github.com/Bike4Mind/bike4mind/commit/48016b142b5168e849acf2454b2421ff0747cd0d) Thanks [@erikbethke](https://github.com/erikbethke)! - add explicit uploadFile for local-file uploads

- [#4599](https://github.com/Bike4Mind/bike4mind/pull/4599) [`37a8844`](https://github.com/Bike4Mind/bike4mind/commit/37a8844e98868251b1725987d427f8810c86faeb) Thanks [@michaeljymsgutierrez](https://github.com/michaeljymsgutierrez)! - rate-limit WS JWT completions at the cli cap

- [#4698](https://github.com/Bike4Mind/bike4mind/pull/4698) [`80a4077`](https://github.com/Bike4Mind/bike4mind/commit/80a4077b2690c53e5ae8b2e881c55e049c11fc05) Thanks [@onoya](https://github.com/onoya)! - make the @ file crawl async, bounded and gitignore-correct

- [#4705](https://github.com/Bike4Mind/bike4mind/pull/4705) [`abe12eb`](https://github.com/Bike4Mind/bike4mind/commit/abe12ebe0f3ef3f6ff3f1e9badedcac156cece48) Thanks [@onoya](https://github.com/onoya)! - start the CLI faster by skipping the update wait and heavy imports

- [#4709](https://github.com/Bike4Mind/bike4mind/pull/4709) [`22e6f85`](https://github.com/Bike4Mind/bike4mind/commit/22e6f85410139977e665ba89a42766dfa136e30d) Thanks [@onoya](https://github.com/onoya)! - stop token counting, checkpoint git and @ file reads from freezing the TUI

- [#4716](https://github.com/Bike4Mind/bike4mind/pull/4716) [`d8018c3`](https://github.com/Bike4Mind/bike4mind/commit/d8018c3be42b71e394dd4de07e5e0d7d126f78c5) Thanks [@jarlacut](https://github.com/jarlacut)! - hide and reject unusable Bedrock models

- [#4733](https://github.com/Bike4Mind/bike4mind/pull/4733) [`8b8fb20`](https://github.com/Bike4Mind/bike4mind/commit/8b8fb20167f5905631212800ffb27517412cdccb) Thanks [@onoya](https://github.com/onoya)! - run ! shell commands without freezing the TUI

- [#4805](https://github.com/Bike4Mind/bike4mind/pull/4805) [`bef1cdf`](https://github.com/Bike4Mind/bike4mind/commit/bef1cdfe235fa4dcb1e83b2c34f1854b9a601b69) Thanks [@erikbethke](https://github.com/erikbethke)! - declare BUSL-1.1 license on the CLI and SDK packages

- [#4813](https://github.com/Bike4Mind/bike4mind/pull/4813) [`91f136e`](https://github.com/Bike4Mind/bike4mind/commit/91f136e63f596f7cc06162754a3c55c7d701457a) Thanks [@erikbethke](https://github.com/erikbethke)! - point model aliases at active models

- [#4896](https://github.com/Bike4Mind/bike4mind/pull/4896) [`f26469d`](https://github.com/Bike4Mind/bike4mind/commit/f26469da76796c614c0a3d47cfc3b71a671fac49) Thanks [@onoya](https://github.com/onoya)! - run MCP, skill and other wrapped tools instead of rejecting them

- [#4906](https://github.com/Bike4Mind/bike4mind/pull/4906) [`20607df`](https://github.com/Bike4Mind/bike4mind/commit/20607df0e21e734bdf9d0dcbea573297f5d1bbd2) Thanks [@onoya](https://github.com/onoya)! - stop signing users out on transient or racing token refreshes

## 2.1.0

### Minor Changes

- [#4039](https://github.com/Bike4Mind/bike4mind/pull/4039) [`766aef9`](https://github.com/Bike4Mind/bike4mind/commit/766aef961bc8b721247f51a53b8f1f8ecb052aa3) Thanks [@jjmarfa](https://github.com/jjmarfa)! - return datalake_tag from GET /api/v1/data-lakes

- [#4041](https://github.com/Bike4Mind/bike4mind/pull/4041) [`d926531`](https://github.com/Bike4Mind/bike4mind/commit/d926531cee78330864ca4144ba303a6b0a3c64b6) Thanks [@vinchi777](https://github.com/vinchi777)! - add generate_image MCP tool

- [#4054](https://github.com/Bike4Mind/bike4mind/pull/4054) [`5d1d429`](https://github.com/Bike4Mind/bike4mind/commit/5d1d42996972fa555319d56d8bda375bf9d4eb2c) Thanks [@julsanchez](https://github.com/julsanchez)! - add list, get and create project tools to the MCP server

- [#4056](https://github.com/Bike4Mind/bike4mind/pull/4056) [`20adbdd`](https://github.com/Bike4Mind/bike4mind/commit/20adbdd525e80075f9d7dadf810de4ad65e83fca) Thanks [@julsanchez](https://github.com/julsanchez)! - add rename/clone/delete notebook tools to mcp serve

- [#4109](https://github.com/Bike4Mind/bike4mind/pull/4109) [`1d78b45`](https://github.com/Bike4Mind/bike4mind/commit/1d78b4565729be4bd00b676e09080c3768743101) Thanks [@onoya](https://github.com/onoya)! - report send_message progress while the reply is generated

- [#4111](https://github.com/Bike4Mind/bike4mind/pull/4111) [`8fa77ac`](https://github.com/Bike4Mind/bike4mind/commit/8fa77acfb4991a300fd63ca9e7adf6758d2bb367) Thanks [@onoya](https://github.com/onoya)! - expose Briefcase prompts as MCP prompts

### Patch Changes

- [#3961](https://github.com/Bike4Mind/bike4mind/pull/3961) [`658303a`](https://github.com/Bike4Mind/bike4mind/commit/658303af566aece2e8fdc716a96a984a34abb3e7) Thanks [@vinchi777](https://github.com/vinchi777)! - bound the live trace under an open prompt and keep the trace on abort

- [#3962](https://github.com/Bike4Mind/bike4mind/pull/3962) [`34f491c`](https://github.com/Bike4Mind/bike4mind/commit/34f491c62e641d1121c15923364a8ec162512cdc) Thanks [@jjmarfa](https://github.com/jjmarfa)! - calibrate CLI token estimates to the session model

- [#3972](https://github.com/Bike4Mind/bike4mind/pull/3972) [`f3f5853`](https://github.com/Bike4Mind/bike4mind/commit/f3f585305efb9c7053c1901fda332584a9af3d7b) Thanks [@julsanchez](https://github.com/julsanchez)! - raise sharp and shell-quote overrides past new advisories

- [#3976](https://github.com/Bike4Mind/bike4mind/pull/3976) [`d3690b4`](https://github.com/Bike4Mind/bike4mind/commit/d3690b461873e0f11989284a6f1d8f66e32ebe7f) Thanks [@onoya](https://github.com/onoya)! - bump @modelcontextprotocol/sdk past GHSA-6qxp-vccf-f47h

- [#4047](https://github.com/Bike4Mind/bike4mind/pull/4047) [`8af61ce`](https://github.com/Bike4Mind/bike4mind/commit/8af61ce21605847ddceb5d9d3b5901ba7706d19f) Thanks [@jarlacut](https://github.com/jarlacut)! - type AgentStep toolInput as unknown

- [#4122](https://github.com/Bike4Mind/bike4mind/pull/4122) [`0838962`](https://github.com/Bike4Mind/bike4mind/commit/0838962cc87930266d8b4918c081b3dc4bade3eb) Thanks [@julsanchez](https://github.com/julsanchez)! - stop API keys posting as the human actor, record event origin, validate delegations

- [#4139](https://github.com/Bike4Mind/bike4mind/pull/4139) [`e9afd46`](https://github.com/Bike4Mind/bike4mind/commit/e9afd4637c67a4fee0c1a25a5dae8f0d8eab6e61) Thanks [@julsanchez](https://github.com/julsanchez)! - stop streaming tagged reasoning text to completions callers

## 2.0.0

### Major Changes

- [#3884](https://github.com/Bike4Mind/bike4mind/pull/3884) [`31d4623`](https://github.com/Bike4Mind/bike4mind/commit/31d46236619fd7e0c2be3f3bc4d34ee69314e682) Thanks [@onoya](https://github.com/onoya)! - deliver all generated audio through one shared module, by URL when oversized

### Patch Changes

- [#3858](https://github.com/Bike4Mind/bike4mind/pull/3858) [`ad14801`](https://github.com/Bike4Mind/bike4mind/commit/ad14801acd6de3230b2dc9819586f402ae047cb4) Thanks [@juicewaa](https://github.com/juicewaa)! - derive quest reply text from replies[] on poll and wait bodies

## 1.4.0

### Minor Changes

- [#3836](https://github.com/Bike4Mind/bike4mind/pull/3836) [`2483e86`](https://github.com/Bike4Mind/bike4mind/commit/2483e86cb8ac92ed12fd719140337416b7947381) Thanks [@onoya](https://github.com/onoya)! - async post-edit diagnostics loop

- [#3843](https://github.com/Bike4Mind/bike4mind/pull/3843) [`2c3ed54`](https://github.com/Bike4Mind/bike4mind/commit/2c3ed543d7d596805a352a0e93a1cbe124d09d9d) Thanks [@onoya](https://github.com/onoya)! - add MCP text to speech tool

- [#3851](https://github.com/Bike4Mind/bike4mind/pull/3851) [`07d3d0d`](https://github.com/Bike4Mind/bike4mind/commit/07d3d0dabe5d7b79575aa5da18838d2c313c63bb) Thanks [@vinchi777](https://github.com/vinchi777)! - accept the b4m-desktop client in the device flow

- [#3865](https://github.com/Bike4Mind/bike4mind/pull/3865) [`0beaa0e`](https://github.com/Bike4Mind/bike4mind/commit/0beaa0e53469277116632c1c46055bdbfe904ccb) Thanks [@julsanchez](https://github.com/julsanchez)! - add data lake tools to b4m mcp serve

### Patch Changes

- [#3698](https://github.com/Bike4Mind/bike4mind/pull/3698) [`3412bf6`](https://github.com/Bike4Mind/bike4mind/commit/3412bf663a5068ed68e712d276790e00754eb7db) Thanks [@jjmarfa](https://github.com/jjmarfa)! - distinguish a missing credential from an expired session

- [#3747](https://github.com/Bike4Mind/bike4mind/pull/3747) [`fc67333`](https://github.com/Bike4Mind/bike4mind/commit/fc673338c4450638acb93708a423298141b98e28) Thanks [@julsanchez](https://github.com/julsanchez)! - escape untrusted text in CLI approval and question prompts

- [#3749](https://github.com/Bike4Mind/bike4mind/pull/3749) [`52c290e`](https://github.com/Bike4Mind/bike4mind/commit/52c290eb2a6812aaaee1c47fd321ca2301dbd99f) Thanks [@julsanchez](https://github.com/julsanchez)! - name a missing verification URL and strip control chars from login strings

- [#3837](https://github.com/Bike4Mind/bike4mind/pull/3837) [`9d7b298`](https://github.com/Bike4Mind/bike4mind/commit/9d7b298a2b71380b1f3202f50b230e5ef33ac4e9) Thanks [@jjmarfa](https://github.com/jjmarfa)! - isolate API-key chat sessions from the user's open notebook

- [#3872](https://github.com/Bike4Mind/bike4mind/pull/3872) [`061bb61`](https://github.com/Bike4Mind/bike4mind/commit/061bb61868b98e855f72aaf29d61d469b93ea88c) Thanks [@onoya](https://github.com/onoya)! - restore the model after a custom-command model override

## 1.3.0

### Minor Changes

- [#3703](https://github.com/Bike4Mind/bike4mind/pull/3703) [`31f1547`](https://github.com/Bike4Mind/bike4mind/commit/31f15478fe43bea7b7d76a4104d87cf9abf812d7) Thanks [@julsanchez](https://github.com/julsanchez)! - name the bound account on login and only auto-open same-origin verification URLs

- [#3708](https://github.com/Bike4Mind/bike4mind/pull/3708) [`2628352`](https://github.com/Bike4Mind/bike4mind/commit/2628352ca0036977581c53846d3b2b6133fc1e78) Thanks [@julsanchez](https://github.com/julsanchez)! - require approval of each repo MCP server definition before spawning

### Patch Changes

- [#3394](https://github.com/Bike4Mind/bike4mind/pull/3394) [`fb13127`](https://github.com/Bike4Mind/bike4mind/commit/fb13127fa17159715f2465edc13aa79ba9fbb371) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - scan artifact tags, titles and tool-output results in linear time

- [#3605](https://github.com/Bike4Mind/bike4mind/pull/3605) [`3b49048`](https://github.com/Bike4Mind/bike4mind/commit/3b49048715891aac4f5d427f717980c5626bd4d3) Thanks [@onoya](https://github.com/onoya)! - bump axios to 1.20.0 for seven high-severity advisories

- [#3701](https://github.com/Bike4Mind/bike4mind/pull/3701) [`71cb783`](https://github.com/Bike4Mind/bike4mind/commit/71cb7835d59579ea20349dfa9988ac015c2eae5f) Thanks [@julsanchez](https://github.com/julsanchez)! - ignore a model-supplied confirmedFuzzyHash in edit_local_file

- [#3706](https://github.com/Bike4Mind/bike4mind/pull/3706) [`edfe671`](https://github.com/Bike4Mind/bike4mind/commit/edfe6718c78309af24d2057d0d428e5dea7f208d) Thanks [@erikbethke](https://github.com/erikbethke)! - bump vulnerable dependencies (HIGH)

## 1.2.0

### Minor Changes

- [#3036](https://github.com/Bike4Mind/bike4mind/pull/3036) [`31e0dd9`](https://github.com/Bike4Mind/bike4mind/commit/31e0dd9a905a7a125f7489efc951a7d21157bc17) Thanks [@julsanchez](https://github.com/julsanchez)! - harden the CLI trust boundary against a hostile cloned repo

  Behavior changes (all user-visible effects of hardening the CLI against an untrusted clone):

  - The shared utils barrel no longer runs `dotenv.config()` on import, so a project-local `.env` is no longer auto-loaded. Configuration now resolves from the real process environment. Set the variables in your shell (or your process manager) instead of relying on a cwd `.env`.
  - Non-YAML frontmatter in a skill, command, or agent file (e.g. a `---js` fence) no longer evaluates; such frontmatter is treated as empty instead of running code at load time.
  - A `--session-id`/`--resume` value outside the strict session-id charset is now rejected up front rather than used as a filesystem path component.
  - A project skill/command/agent whose file is a symlink escaping the project root is refused when loading from an untrusted checkout.
  - A `global` or `remote` skill whose name is reserved (a built-in or live feature/plugin command) is no longer advertised to the model or invokable, matching the dispatch gate.
  - Agent lifecycle hooks (PreToolUse/PostToolUse/Stop and friends) that previously ran their shell command unprompted are now gated through the same permission prompt as any other shell command, and can be denied. Trusting the project folder loads the hook definitions; it no longer pre-authorizes the commands they carry.
  - A `.b4m/checkpoints.json` whose root is not an object (e.g. a committed `[]`) no longer overwrites the metadata container, so checkpoints created after such a file is read are kept across restarts instead of being silently discarded.

- [#3173](https://github.com/Bike4Mind/bike4mind/pull/3173) [`c5caa17`](https://github.com/Bike4Mind/bike4mind/commit/c5caa1792c8d7bb54da303842d74aa0e76ecee86) Thanks [@julsanchez](https://github.com/julsanchez)! - Harden the CLI sandbox network gate. Network egress is now fail-closed by default: with the sandbox enabled, all IP egress is denied unless it is explicitly turned on, and the runtime treats network as enabled only when a filtering proxy is actually running (no command sequence can leave the flag on with no proxy). Adds a `/sandbox:network <on|off>` command to toggle egress at runtime. When enabled, HTTP(S)_PROXY-aware clients are filtered against the allowed-domain list; raw sockets bypass the proxy, so leave egress off to deny all outbound connections.

### Patch Changes

- [#3172](https://github.com/Bike4Mind/bike4mind/pull/3172) [`319d72b`](https://github.com/Bike4Mind/bike4mind/commit/319d72b4431751e1531015bfa2e2111ee071865a) Thanks [@julsanchez](https://github.com/julsanchez)! - escape control chars in the permission-prompt Arguments block

- [#3173](https://github.com/Bike4Mind/bike4mind/pull/3173) [`c5caa17`](https://github.com/Bike4Mind/bike4mind/commit/c5caa1792c8d7bb54da303842d74aa0e76ecee86) Thanks [@julsanchez](https://github.com/julsanchez)! - confine sandbox writable root and honor network.enabled

- [#3177](https://github.com/Bike4Mind/bike4mind/pull/3177) [`052574d`](https://github.com/Bike4Mind/bike4mind/commit/052574d726ef6bdd2042f07b592e404135f34774) Thanks [@julsanchez](https://github.com/julsanchez)! - re-confirm silent fuzzy edit_local_file edits under trust/auto-accept

- [#3178](https://github.com/Bike4Mind/bike4mind/pull/3178) [`cdab71d`](https://github.com/Bike4Mind/bike4mind/commit/cdab71dd2e14ad509746f7a037d11c2b9601cf66) Thanks [@julsanchez](https://github.com/julsanchez)! - authenticate the bridge peer before disclosing hookSecret

- [#3218](https://github.com/Bike4Mind/bike4mind/pull/3218) [`9050e73`](https://github.com/Bike4Mind/bike4mind/commit/9050e73ced9ca0c6c9d6344abcc5f8346841fc04) Thanks [@julsanchez](https://github.com/julsanchez)! - escape Unicode bidi/isolate overrides in the permission prompt

## 1.1.0

### Minor Changes

- [#3035](https://github.com/Bike4Mind/bike4mind/pull/3035) [`fce5f89`](https://github.com/Bike4Mind/bike4mind/commit/fce5f89e763183642afcce37706252073aa20baf) Thanks [@julsanchez](https://github.com/julsanchez)! - gate repo config, MCP, hooks and skills behind a per-project trust decision

### Patch Changes

- [#2848](https://github.com/Bike4Mind/bike4mind/pull/2848) [`c6c35c3`](https://github.com/Bike4Mind/bike4mind/commit/c6c35c3ac15cf06526b4503bf4a18cef7a929b30) Thanks [@choyno](https://github.com/choyno)! - surface the credit-exhaustion classifier and emit type on both chat surfaces

- [#3058](https://github.com/Bike4Mind/bike4mind/pull/3058) [`c2ff307`](https://github.com/Bike4Mind/bike4mind/commit/c2ff307506fc29e14b7d88fabb0dce89f01a2085) Thanks [@onoya](https://github.com/onoya)! - report omitted research file references

- [#3112](https://github.com/Bike4Mind/bike4mind/pull/3112) [`b9ddc38`](https://github.com/Bike4Mind/bike4mind/commit/b9ddc386391140d6bdd30ee5b00ba8324f68b98a) Thanks [@julsanchez](https://github.com/julsanchez)! - route every model-callable tool through the permission wrapper and shared path validator

## 1.0.0

### Major Changes

- [#2778](https://github.com/Bike4Mind/bike4mind/pull/2778) [`f3d4563`](https://github.com/Bike4Mind/bike4mind/commit/f3d4563c442e4471fd37d3bf35baac96095f5fc5) Thanks [@onoya](https://github.com/onoya)! - keep the LLM tool closure out of the package barrel

### Patch Changes

- [#2823](https://github.com/Bike4Mind/bike4mind/pull/2823) [`a4e980d`](https://github.com/Bike4Mind/bike4mind/commit/a4e980d956c721aa734dde981420adcb4bfaa243) Thanks [@onoya](https://github.com/onoya)! - escape dynamic regex inputs and guard dynamic object writes

## 0.22.0

### Minor Changes

- [#2762](https://github.com/Bike4Mind/bike4mind/pull/2762) [`adc900a`](https://github.com/Bike4Mind/bike4mind/commit/adc900ab152e00d3324bc228ac73c98a5cb5e2ef) Thanks [@maconard](https://github.com/maconard)! - add DeepSeek as a first-party provider and close Moonshot gaps

## 0.21.0

### Minor Changes

- [#2417](https://github.com/Bike4Mind/bike4mind/pull/2417) [`b85c4ae`](https://github.com/Bike4Mind/bike4mind/commit/b85c4aea800dd4513ca3c749d6dd80705d7c21e6) Thanks [@ken-b4m](https://github.com/ken-b4m)! - add caller-supplied systemPrompt field to POST /api/chat

### Patch Changes

- [#2076](https://github.com/Bike4Mind/bike4mind/pull/2076) [`0b11eb7`](https://github.com/Bike4Mind/bike4mind/commit/0b11eb73ef02ce7acbf9fdfab991e36cec755ef7) Thanks [@TRAP-RCG](https://github.com/TRAP-RCG)! - make the published package installable, and add the MCP registry entry

- [#2138](https://github.com/Bike4Mind/bike4mind/pull/2138) [`9c5588c`](https://github.com/Bike4Mind/bike4mind/commit/9c5588c25e8025755ebe0eab77c4af208ef27538) Thanks [@onoya](https://github.com/onoya)! - derive every sub-quest status surface from one enum

- [#2345](https://github.com/Bike4Mind/bike4mind/pull/2345) [`e285e73`](https://github.com/Bike4Mind/bike4mind/commit/e285e738ff13227869492811f1a10865d6d82f03) Thanks [@vinchi777](https://github.com/vinchi777)! - hide gemini-2.5-flash and redirect pinned sessions

- [#2379](https://github.com/Bike4Mind/bike4mind/pull/2379) [`9e88972`](https://github.com/Bike4Mind/bike4mind/commit/9e889727a1d83a25e38ccec9354c6ffbb2150b70) Thanks [@vinchi777](https://github.com/vinchi777)! - skip npm's audit when removing a plugin

## 0.20.2

### Patch Changes

- [#1801](https://github.com/Bike4Mind/bike4mind/pull/1801) [`e49346a`](https://github.com/Bike4Mind/bike4mind/commit/e49346a617d10bc8ec15b05e0626975d85e2a720) Thanks [@onoya](https://github.com/onoya)! - stop benign concurrent refreshes from revoking healthy sessions

- [#1886](https://github.com/Bike4Mind/bike4mind/pull/1886) [`e7d93b8`](https://github.com/Bike4Mind/bike4mind/commit/e7d93b8ff0a10b16ad54b93eafea3f5681eec4b4) Thanks [@onoya](https://github.com/onoya)! - discover skills and agents behind symlinks

- [#1891](https://github.com/Bike4Mind/bike4mind/pull/1891) [`7edcf84`](https://github.com/Bike4Mind/bike4mind/commit/7edcf84060227e9384274dccbbde54c197d25425) Thanks [@onoya](https://github.com/onoya)! - stop reasoning from starving the visible answer

## 0.20.1

### Patch Changes

- Updated dependencies [[`c7b5854`](https://github.com/Bike4Mind/bike4mind/commit/c7b5854b3a02afdcd4d8c480d93f1005d5ee47c6)]:
  - @bike4mind/hearth@0.3.0

## 0.20.0

### Minor Changes

- [#672](https://github.com/Bike4Mind/bike4mind/pull/672) [`b102c56`](https://github.com/Bike4Mind/bike4mind/commit/b102c56e0599dc4465c6935f016fe453cac92f11) Thanks [@vinchi777](https://github.com/vinchi777)! - use SSE-only transport for LLM completions

  Completions no longer attempt the WebSocket transport, which fixed the indefinite
  "thinking" hang on stacks whose realtime relay emits `streamed_chat_completion`
  instead of the CLI's chunk protocol. Two WebSocket-only capabilities go with it:
  the Keep command relay (web HUD executing commands on the local machine) and
  WebSocket-based server-side tool execution (tools now run CLI-side). Feature
  modules that consume realtime events (Tavern's activity stream) keep their socket.

- [#1090](https://github.com/Bike4Mind/bike4mind/pull/1090) [`38a8ba8`](https://github.com/Bike4Mind/bike4mind/commit/38a8ba8ebd7bf047916ed3df399bda5b5893a488) Thanks [@erikbethke](https://github.com/erikbethke)! - Treat Hearth log content as data, never instructions

  Every `hearth_*` read now arrives inside an envelope marking it untrusted, and the
  system prompt states that log content is data to report rather than instructions
  to follow, that a delegation is a request to surface rather than an authorization
  to execute, and that only the user directs the agent's actions. Channel names are
  covered as well as event bodies: a name is 200 characters of unfiltered text
  writable by any `hearth:write` holder, and the agent is told to read channels
  first, so it was the earliest attacker-controlled string in a session.

  Not named `pr-1090.md` deliberately. The auto-changeset workflow owns `pr-<N>.md`
  files and only clears a stale one when the PR type becomes non-publishable, so a
  retitle from `feat(hearth)` to `feat(cli)` left a bump for `@bike4mind/hearth`
  in place - a package this change does not touch. A manually-named changeset is
  outside the workflow's management and is what the repo already does for
  cli-sse-only-transport.md.

- [#606](https://github.com/Bike4Mind/bike4mind/pull/606) [`93c2e0e`](https://github.com/Bike4Mind/bike4mind/commit/93c2e0e5e71c246cf379caac576974c165f5a1c5) Thanks [@vinchi777](https://github.com/vinchi777)! - re-inject live workflow state into context each turn

- [#629](https://github.com/Bike4Mind/bike4mind/pull/629) [`7c7422e`](https://github.com/Bike4Mind/bike4mind/commit/7c7422e6273b12e68c34bcc652a693bc52719c11) Thanks [@jjmarfa](https://github.com/jjmarfa)! - enrich the offline local handoff fallback

- [#669](https://github.com/Bike4Mind/bike4mind/pull/669) [`8effb75`](https://github.com/Bike4Mind/bike4mind/commit/8effb754095aa58a1fbcb70a416e7e03151b38ab) Thanks [@vinchi777](https://github.com/vinchi777)! - load persisted workflow state on session resume ([#593](https://github.com/Bike4Mind/bike4mind/issues/593))

- [#671](https://github.com/Bike4Mind/bike4mind/pull/671) [`a627407`](https://github.com/Bike4Mind/bike4mind/commit/a627407f1c5b1ca68da0e91e1584cca19df90cb3) Thanks [@vinchi777](https://github.com/vinchi777)! - add /model command to switch models directly

- [#697](https://github.com/Bike4Mind/bike4mind/pull/697) [`5beb2cc`](https://github.com/Bike4Mind/bike4mind/commit/5beb2cc807df26706056700bebb9c0d3f9a109e6) Thanks [@erikbethke](https://github.com/erikbethke)! - add hearth feature module with event log tools and Claude Code hook

- [#702](https://github.com/Bike4Mind/bike4mind/pull/702) [`0d81f58`](https://github.com/Bike4Mind/bike4mind/commit/0d81f5886f9053706451bbe527430226ebabe615) Thanks [@maconard](https://github.com/maconard)! - add b4m mcp serve to expose bike4mind as an mcp server

- [#714](https://github.com/Bike4Mind/bike4mind/pull/714) [`b066c96`](https://github.com/Bike4Mind/bike4mind/commit/b066c96cc20a2ec518aad8718ae199e01b310741) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - plugin system for external feature modules

- [#718](https://github.com/Bike4Mind/bike4mind/pull/718) [`d3d47a7`](https://github.com/Bike4Mind/bike4mind/commit/d3d47a7c3d8c52a2d18d189bdf7ad43b68e87307) Thanks [@jjmarfa](https://github.com/jjmarfa)! - widen handoff conversation window to head + tail

- [#911](https://github.com/Bike4Mind/bike4mind/pull/911) [`b30d4af`](https://github.com/Bike4Mind/bike4mind/commit/b30d4af0561241ec08dda8de91a4fa31ec368c26) Thanks [@jjmarfa](https://github.com/jjmarfa)! - expose file, project and artifact MCP resources

### Patch Changes

- [#603](https://github.com/Bike4Mind/bike4mind/pull/603) [`1f53b07`](https://github.com/Bike4Mind/bike4mind/commit/1f53b07e25ea79e8de334d0200a9ac8f1ab9ffdd) Thanks [@onoya](https://github.com/onoya)! - sync durable workflow state each turn so compaction keeps it

- [#605](https://github.com/Bike4Mind/bike4mind/pull/605) [`e7bb9dc`](https://github.com/Bike4Mind/bike4mind/commit/e7bb9dc2874c0876b098f4373b73023009078a86) Thanks [@onoya](https://github.com/onoya)! - invalidate usage cache when /compact swaps the session

- [#637](https://github.com/Bike4Mind/bike4mind/pull/637) [`61df8ce`](https://github.com/Bike4Mind/bike4mind/commit/61df8ced554f980d9e18390e694e07c0362bef1a) Thanks [@onoya](https://github.com/onoya)! - declare transitive npm deps bundled from @bike4mind/* packages

- [#670](https://github.com/Bike4Mind/bike4mind/pull/670) [`6e8d3ba`](https://github.com/Bike4Mind/bike4mind/commit/6e8d3ba7e944e937854aab26e7729d7114c9b329) Thanks [@vinchi777](https://github.com/vinchi777)! - repaint live frame on terminal resize

- [#793](https://github.com/Bike4Mind/bike4mind/pull/793) [`d083562`](https://github.com/Bike4Mind/bike4mind/commit/d08356278004a036c0c90d079b655ecb8260ba21) Thanks [@onoya](https://github.com/onoya)! - stop bundling server-only services/utils code into the CLI ([#660](https://github.com/Bike4Mind/bike4mind/issues/660))

- [#809](https://github.com/Bike4Mind/bike4mind/pull/809) [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8) Thanks [@poysama](https://github.com/poysama)! - remediate transitive Dependabot vulns via pnpm overrides

- Updated dependencies [[`e565ba9`](https://github.com/Bike4Mind/bike4mind/commit/e565ba9e34555694eb58ef608a38dc9aba210989), [`7649b72`](https://github.com/Bike4Mind/bike4mind/commit/7649b72711987dc50e07b21cb0659c4b32f56221), [`a25e9ff`](https://github.com/Bike4Mind/bike4mind/commit/a25e9ff98a714cbca6980a8902e309bb6263de5e), [`04f4964`](https://github.com/Bike4Mind/bike4mind/commit/04f4964b1630bdf1e5cd178d7d6bff1bc28adb58), [`8a899b2`](https://github.com/Bike4Mind/bike4mind/commit/8a899b26677a9fab54b5652ba9c06f429b2a5abe), [`25bc463`](https://github.com/Bike4Mind/bike4mind/commit/25bc46318510bc2631d86692995c1335397d62a6), [`ccd97cd`](https://github.com/Bike4Mind/bike4mind/commit/ccd97cda43b3344ca99b5a8fa81f7819ff701ade), [`42b99f8`](https://github.com/Bike4Mind/bike4mind/commit/42b99f8a22137a01c951a60ab67cef7273e9f43b), [`87425da`](https://github.com/Bike4Mind/bike4mind/commit/87425dafa8b98d5bae718dd52763483b24aee1b5), [`dd5355f`](https://github.com/Bike4Mind/bike4mind/commit/dd5355f5c98d23fc93a603dc9a24a5da18226b16), [`fc5bfd8`](https://github.com/Bike4Mind/bike4mind/commit/fc5bfd8c3e5b14453c7d79ecfe589537b9f5eec6), [`db1655c`](https://github.com/Bike4Mind/bike4mind/commit/db1655c7072131f55b3dbdeb5a212768786fe9ef), [`e56ac60`](https://github.com/Bike4Mind/bike4mind/commit/e56ac603af3e5bb6333d63137d97c695794175a6)]:
  - @bike4mind/hearth@0.2.0

## 0.19.0

### Minor Changes

- Version, document, and strictly validate the headless stream-JSON protocol.

  Every headless event (and the `json` result/error object) now carries a
  `schemaVersion` + stable `runId`; the full contract is documented in
  `packages/cli/docs/headless-protocol.md`. Permission decisions surface in-band
  as `permission_request` / `permission_decision` events, and a new
  `--permission-policy` flag drives unattended runs without blanket
  auto-approval.

  Note: `B4M_ADDITIONAL_DIRS` is now validated strictly - a malformed value (not a
  JSON array of strings) fails the run with a clear error instead of being
  silently ignored.

- guided first-run backend onboarding (picker + dev-mode default)

- parse-based shell command risk classification (not tool-name/regex only)

- expose the agent over ACP via a 'b4m acp' subcommand

- backgroundable + pollable shell sessions for bash_execute

- background shell session UX -- live indicators + reaping

- recursion-depth cap and permission clamp for subagents

- record operational-model and KB embedding usage

### Patch Changes

- model API endpoint as discriminated union, fail loud when unconfigured

- stop WS auth rejections from becoming zombie connections + graceful revoke

- make the Zustand store the single source of truth for the session

- unify on a rich message model + a ConversationContext deep module

- shared streaming-completion core for both LLM transports

- redact secrets + enforce output ceiling on all tool return paths

- freeze deferred-tool directory snapshot to keep system-prompt cache stable

- replace exceljs with write-excel-file in excel_generation

- extract slash-command dispatch into a registry

- extract the turn lifecycle into session/turnController
