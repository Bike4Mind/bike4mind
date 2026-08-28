export const formatDuration = (ms?: number): string => {
  if (!ms) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
};

/**
 * TTFVT for display. An absent value is not missing data: the server leaves it unset when a
 * turn streamed nothing the user could see, so it must read as the failure it is rather than
 * as a blank. firstChunkTime, when present, proves the model did respond - it streamed hidden
 * reasoning - while the transcript stayed empty.
 */
export const formatTtfvt = (firstTokenTime?: number, firstChunkTime?: number): string => {
  if (firstTokenTime) return formatDuration(firstTokenTime);
  if (firstChunkTime) return `never rendered (streamed at ${formatDuration(firstChunkTime)})`;
  return 'n/a';
};

export const getDisplayName = (modelId: string, modelInfos: any[] = [], simplifiedNames: boolean = true): string => {
  if (!modelId) return 'Unknown';

  if (!simplifiedNames) {
    return modelId;
  }

  const modelInfo = modelInfos.find(model => model.id === modelId);
  if (modelInfo?.name) {
    return modelInfo.name;
  }

  // Fallback: return the original ID if no match found
  return modelId;
};
