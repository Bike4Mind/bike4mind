CONSTRUCTED, not captured: GET /models needs a live DeepSeek key and none was
available. The field set (id/object/owned_by, nothing else) comes from the
vendor's own API reference (api-docs.deepseek.com, read 2026-09-13), which
documents no context window, capability flag or pricing on this endpoint.
deepseek-flash and deepseek-v4-pro are the two live ids that reference states;
deepseek-chat and deepseek-reasoner, the prior generation, were hard-retired
2026-07-24 and are deliberately absent from models.json.

unknown-namespace.json pins the same fail-closed behavior kimi's does: a
modality marker wins over the one deepseek- namespace, and a non-'model'
object type (deepseek-tts-preview, served as "file") is dropped entirely
rather than guessed at.
