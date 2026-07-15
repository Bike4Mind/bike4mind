# @bike4mind/auth

## 0.6.0

### Minor Changes

- docker compose stack for self-host

- organization API tokens billed to the org credit pool

- out-of-the-box local Ollama models (Qwen), no API keys

### Patch Changes

- sanitize OAuth callback failure reason

- allow SSO link into unverified pure-OAuth accounts

- stop storing fake passwords on provisioning paths (#360)

- extract shared OAuth auto-link gate into decideAutoLink

- extract shared applyAccountLink write helper

- Updated dependencies:
  - @bike4mind/common@3.0.0
