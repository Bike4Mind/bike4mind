LIVE CAPTURE from a local Ollama 0.31.1 daemon on 2026-07-26. tags.json and
show.json are the real responses; the only edit is scrubbing the absolute blob
path Ollama leaves in details.parent_model for a pulled-from-file model, and
dropping /api/show's license, modelfile, template, parameters and tensors blocks
(large, and none of them is read).

legacy-tags.json is DERIVED from the same capture: the pre-0.30 /api/tags shape,
which is the live one minus capabilities[] and minus details.context_length. It
exists to exercise the /api/show fallback the version probe selects.

Note gemma4 is the interesting case in both directions: /api/tags reports no
context_length for it, so the fast path leaves the window at 0, while
/api/show's model_info carries gemma4.context_length.
