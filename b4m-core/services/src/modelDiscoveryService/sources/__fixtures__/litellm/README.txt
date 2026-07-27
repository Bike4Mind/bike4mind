LIVE CAPTURE of model_prices_and_context_window.json from the PINNED release tag
github.com/BerriAI/litellm@v1.93.0, fetched 2026-07-26, trimmed from 2,963 entries
to 34. No value was edited. The subset is picked to cover every branch: direct
and dated keys, bedrock dot-namespaced and us./global. regional keys, the
provider-qualified first-party namespaces (xai/, black_forest_labs/,
elevenlabs/), a past deprecation_date and a future one, two
supports_sampling_params: false entries, sample_spec (which must be skipped as a
key, not parsed as a model), and three reseller spellings
(azure_ai/, openrouter/) that must never outrank the direct key of the same model.
