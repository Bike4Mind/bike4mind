import type { VideoGenerationSettings } from '../schemas/settings';
import { isVideoModelRetired, VIDEO_MODEL_CATALOG, type VideoModelId } from './catalog';

// A retired model stays off even under an admin override: the provider no longer serves it.
export const isVideoModelEnabled = (id: VideoModelId, settings: VideoGenerationSettings | undefined): boolean =>
  !isVideoModelRetired(id) && (settings?.enabledModels[id] ?? VIDEO_MODEL_CATALOG[id].defaultEnabled);
