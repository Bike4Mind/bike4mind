import type { GenerationJobDelivery } from '@bike4mind/common';
import type { VideoToolConfig } from '@bike4mind/services/llm/tools';

/**
 * Stamps every job the tool creates with a delivery target, and tells the model the clip will be posted there
 * on its own (a surface without a progress UI would otherwise leave the user waiting on a bare job id).
 */
export const withJobDelivery = (
  config: VideoToolConfig | null,
  delivery: GenerationJobDelivery,
  deliveryNote: string
): VideoToolConfig | null =>
  config && {
    ...config,
    deliveryNote,
    createJob: input => config.createJob({ ...input, delivery }),
  };
