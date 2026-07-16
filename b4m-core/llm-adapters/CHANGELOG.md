# @bike4mind/llm-adapters

## 0.10.0

### Minor Changes

- fail loud on models without a published price

- extend insufficient-credits CTA to image/video/tool generation paths

- move per-model provider prices to a versioned price catalog

- settle realtime voice from the model price catalog

- add OpenAI GPT-5.6 Sol, Luna, and Terra models

- out-of-the-box local Ollama models (Qwen), no API keys

- tool support, capability detection, and lean prompt for local models

- stream GPT-5.6 responses via /v1/responses

- add xAI Grok 4.5 (grok-4.5)

### Patch Changes

- settle chat on provider-reported token usage

- populate stopReason on OpenAI, xAI, Gemini, and Ollama backends

- allow SSO link into unverified pure-OAuth accounts

- Updated dependencies:
  - @bike4mind/common@3.0.0
