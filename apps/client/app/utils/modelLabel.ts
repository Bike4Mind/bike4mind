type ModelRow = { provider: string; model: string; executedProvider?: string; executedModel?: string };

export const isSubstituted = (r: ModelRow): boolean =>
  !!r.executedModel && (r.executedProvider !== r.provider || r.executedModel !== r.model);

export const modelLabel = (r: ModelRow): string => {
  const base = `${r.provider} / ${r.model}`;
  return isSubstituted(r) ? `${base} (ran: ${r.executedProvider} / ${r.executedModel})` : base;
};

export const modelKey = (r: ModelRow): string =>
  `${r.provider}-${r.model}-${r.executedProvider ?? ''}-${r.executedModel ?? ''}`;
