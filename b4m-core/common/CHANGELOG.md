# @bike4mind/common

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
