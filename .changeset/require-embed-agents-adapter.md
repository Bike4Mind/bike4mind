---
"@bike4mind/services": major
---

Require the `agents` adapter on the `createUserApiKey` and `updateEmbedKey` service inputs. It was typed optional but threw at runtime when minting or rebinding an `embed:chat` key, so a consumer could compile clean and then fail at runtime; the requirement is now enforced at the type level (the runtime guard remains as defense in depth). Consumers that mint or configure embed keys must pass `db.agents` (a repository exposing `findById`).
