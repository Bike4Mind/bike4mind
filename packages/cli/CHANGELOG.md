# @bike4mind/cli

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
