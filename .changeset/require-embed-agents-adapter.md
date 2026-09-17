---
"@bike4mind/services": major
---

Require the `agents` adapter on the `createUserApiKey` and `updateEmbedKey` service inputs. It was typed optional but threw at runtime when minting or rebinding an `embed:chat` key, so a consumer could compile clean and then fail at runtime; the requirement is now enforced at the type level (the runtime guard remains as defense in depth). Because it is now required on the input, every caller of these two services must pass `db.agents` (a repository exposing `findById`) to compile, not only the ones that mint or configure embed keys.
