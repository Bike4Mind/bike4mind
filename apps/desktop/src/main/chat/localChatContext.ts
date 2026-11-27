/** Token counts read from Ollama's /api/show, shared by OllamaLocal and the Models screen's fit badges. */
export function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

// The reviewed-build check in @bike4mind/local-models reads num_ctx the same way, so there is one parser.
export { configuredNumCtx } from '@bike4mind/local-models';
