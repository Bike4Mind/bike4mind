# @bike4mind/services

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
