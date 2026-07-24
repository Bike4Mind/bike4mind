# @bike4mind/cli

## 0.20.0

### Minor Changes

- [#606](https://github.com/Bike4Mind/bike4mind/pull/606) [`93c2e0e`](https://github.com/Bike4Mind/bike4mind/commit/93c2e0e5e71c246cf379caac576974c165f5a1c5) Thanks [@vinchi777](https://github.com/vinchi777)! - re-inject live workflow state into context each turn

- [#629](https://github.com/Bike4Mind/bike4mind/pull/629) [`7c7422e`](https://github.com/Bike4Mind/bike4mind/commit/7c7422e6273b12e68c34bcc652a693bc52719c11) Thanks [@jjmarfa](https://github.com/jjmarfa)! - enrich the offline local handoff fallback

- [#669](https://github.com/Bike4Mind/bike4mind/pull/669) [`8effb75`](https://github.com/Bike4Mind/bike4mind/commit/8effb754095aa58a1fbcb70a416e7e03151b38ab) Thanks [@vinchi777](https://github.com/vinchi777)! - load persisted workflow state on session resume ([#593](https://github.com/Bike4Mind/bike4mind/issues/593))

- [#697](https://github.com/Bike4Mind/bike4mind/pull/697) [`5beb2cc`](https://github.com/Bike4Mind/bike4mind/commit/5beb2cc807df26706056700bebb9c0d3f9a109e6) Thanks [@erikbethke](https://github.com/erikbethke)! - add hearth feature module with event log tools and Claude Code hook

- [#702](https://github.com/Bike4Mind/bike4mind/pull/702) [`0d81f58`](https://github.com/Bike4Mind/bike4mind/commit/0d81f5886f9053706451bbe527430226ebabe615) Thanks [@maconard](https://github.com/maconard)! - add b4m mcp serve to expose bike4mind as an mcp server

- [#714](https://github.com/Bike4Mind/bike4mind/pull/714) [`b066c96`](https://github.com/Bike4Mind/bike4mind/commit/b066c96cc20a2ec518aad8718ae199e01b310741) Thanks [@cleffrem-dev](https://github.com/cleffrem-dev)! - plugin system for external feature modules

- [#718](https://github.com/Bike4Mind/bike4mind/pull/718) [`d3d47a7`](https://github.com/Bike4Mind/bike4mind/commit/d3d47a7c3d8c52a2d18d189bdf7ad43b68e87307) Thanks [@jjmarfa](https://github.com/jjmarfa)! - widen handoff conversation window to head + tail

### Patch Changes

- [#603](https://github.com/Bike4Mind/bike4mind/pull/603) [`1f53b07`](https://github.com/Bike4Mind/bike4mind/commit/1f53b07e25ea79e8de334d0200a9ac8f1ab9ffdd) Thanks [@onoya](https://github.com/onoya)! - sync durable workflow state each turn so compaction keeps it

- [#605](https://github.com/Bike4Mind/bike4mind/pull/605) [`e7bb9dc`](https://github.com/Bike4Mind/bike4mind/commit/e7bb9dc2874c0876b098f4373b73023009078a86) Thanks [@onoya](https://github.com/onoya)! - invalidate usage cache when /compact swaps the session

- [#637](https://github.com/Bike4Mind/bike4mind/pull/637) [`61df8ce`](https://github.com/Bike4Mind/bike4mind/commit/61df8ced554f980d9e18390e694e07c0362bef1a) Thanks [@onoya](https://github.com/onoya)! - declare transitive npm deps bundled from @bike4mind/* packages

- [#793](https://github.com/Bike4Mind/bike4mind/pull/793) [`d083562`](https://github.com/Bike4Mind/bike4mind/commit/d08356278004a036c0c90d079b655ecb8260ba21) Thanks [@onoya](https://github.com/onoya)! - stop bundling server-only services/utils code into the CLI ([#660](https://github.com/Bike4Mind/bike4mind/issues/660))

- [#809](https://github.com/Bike4Mind/bike4mind/pull/809) [`88f7d2f`](https://github.com/Bike4Mind/bike4mind/commit/88f7d2f92ca825a34c16fc4ff991abcd5a5c1ed8) Thanks [@poysama](https://github.com/poysama)! - remediate transitive Dependabot vulns via pnpm overrides

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
