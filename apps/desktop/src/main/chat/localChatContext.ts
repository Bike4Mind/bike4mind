/** Token counts read from Ollama's /api/show, shared by OllamaLocal and the Models screen's fit badges. */
export function positiveTokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** The Modelfile's num_ctx, from the `parameters` text Ollama's /api/show prints. */
export function configuredNumCtx(parameters: string | null | undefined): number | undefined {
  const value = /^num_ctx[ \t]+(\S+)[ \t]*$/m.exec(parameters ?? '')?.[1];
  return value === undefined ? undefined : positiveTokenCount(Number(value));
}
