Captured from a live GET /models on 2026-09-14. The vendor returns only
id/object/owned_by on this endpoint - no context window, capability flag or
pricing. deepseek-flash and deepseek-v4-pro are the two ids in the listing;
deepseek-chat and deepseek-reasoner, the prior generation, no longer appear in
it, though POST /chat/completions still accepts both and nothing in this build
routes to either.

unknown-namespace.json pins the same fail-closed behavior kimi's does: a
modality marker wins over the one deepseek- namespace, and a non-'model'
object type (deepseek-tts-preview, served as "file") is dropped entirely
rather than guessed at. It carries the id sort as well: the embedding row is
listed second and comes back first.
