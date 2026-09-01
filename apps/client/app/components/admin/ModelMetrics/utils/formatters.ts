import { ttfvtState } from '@bike4mind/common';

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
  switch (ttfvtState(firstTokenTime, firstChunkTime)) {
    case 'measured':
      return formatDuration(firstTokenTime);
    case 'never-rendered':
      return `never rendered (streamed at ${formatDuration(firstChunkTime)})`;
    default:
      return 'n/a';
  }
};

/**
 * Joy colour for a TTFVT readout. Only a turn that streamed and never rendered earns danger:
 * colouring `unknown` red too would paint every media generation and every pre-fields row as
 * a frozen turn, which is the opposite of a signal.
 */
export const ttfvtColor = (firstTokenTime?: number, firstChunkTime?: number): 'success' | 'danger' | 'neutral' => {
  switch (ttfvtState(firstTokenTime, firstChunkTime)) {
    case 'measured':
      return 'success';
    case 'never-rendered':
      return 'danger';
    default:
      return 'neutral';
  }
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
