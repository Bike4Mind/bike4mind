export const formatDuration = (ms?: number): string => {
  if (!ms) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
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
