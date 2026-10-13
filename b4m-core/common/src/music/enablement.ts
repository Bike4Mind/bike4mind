import type { MusicGenerationSettings } from '../schemas/settings';
import { MUSIC_MODEL_CATALOG, type MusicModelId } from './catalog';

export const isMusicModelEnabled = (id: MusicModelId, settings: MusicGenerationSettings | undefined): boolean =>
  settings?.enabledModels[id] ?? MUSIC_MODEL_CATALOG[id].defaultEnabled;
