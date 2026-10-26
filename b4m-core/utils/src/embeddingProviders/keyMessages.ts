// Operator-facing messages for a missing or placeholder cloud embedding key. Both name the two exits (set a real key,
// or go keyless with a local Ollama embedder). Must stay in sync with the same constants in fab-pipeline's
// EmbeddingFactory, which does not export them; tests pin the text.
export const OPENAI_KEY_MISSING_MESSAGE =
  'OpenAI API key is not configured (found a missing or placeholder value). Set a real OPENAI_API_KEY, or for an airgapped self-host unset it and set OLLAMA_BASE_URL to use a local embedder.';
export const VOYAGE_KEY_MISSING_MESSAGE =
  'VoyageAI API key is not configured (found a missing or placeholder value). Set a real VOYAGE_API_KEY, or for an airgapped self-host set OLLAMA_BASE_URL to use a local embedder.';
