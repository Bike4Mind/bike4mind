models.json is a REAL capture of GET https://api.moonshot.ai/v1/models, taken
2026-07-28 with a live key. Two fields were dropped: `permission` (an
OpenAI-legacy block nothing here reads) and `created` (a timestamp that would
churn the fixture on every recapture). Everything retained is a model id or a
capability flag; none of it is secret.

The capture is what corrected this driver. The endpoint had been assumed to be as
thin as OpenAI's - ids only - and the normalizer therefore threw away
context_length, supports_image_in, supports_reasoning, and the reasoning_efforts
block that names the valid effort levels and their default. It also settled two
guesses: `kimi-k2-thinking` and `kimi-latest` are NOT served here (they exist in
models.dev and litellm, but not on this endpoint), and kimi-k3 reports
supports_thinking_type: "only", confirming it cannot be asked to stop reasoning.

To recapture (any machine with a Moonshot key exported as MOONSHOT_API_KEY):
  curl -s https://api.moonshot.ai/v1/models \
    -H "Authorization: Bearer $MOONSHOT_API_KEY" > /tmp/moonshot-models.json
  # then drop the `permission` and `created` fields before committing.

unknown-namespace.json is hand-written, not captured: it pins the fail-closed
behavior for an id whose modality the namespace does not state.
