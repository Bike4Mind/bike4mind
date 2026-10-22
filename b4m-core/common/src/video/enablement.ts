import type { VideoGenerationSettings } from '../schemas/settings';
import { VIDEO_MODEL_CATALOG, type VideoModelId } from './catalog';

export const isVideoModelEnabled = (id: VideoModelId, settings: VideoGenerationSettings | undefined): boolean =>
  settings?.enabledModels[id] ?? VIDEO_MODEL_CATALOG[id].defaultEnabled;
