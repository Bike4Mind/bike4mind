import { useInfiniteSearchFabFiles } from '@client/app/hooks/data/fabFileSearch';
import type { AudioGenMode } from '@client/app/stores/useAudioGenSettings';
import { audioModeTag } from './generatedAudioSettings';

/**
 * Saved speech or sound-effect files, newest first. They have no job record, so the Files copy is the history.
 * This is the Files default view, so it also admits generated audio shared with the user (groups, data lakes), not
 * only their own. useGenerateAudio invalidates every fabFiles query after a save, which refreshes this list too.
 */
export const useRecentGeneratedAudio = (mode: AudioGenMode) =>
  useInfiniteSearchFabFiles({
    filters: { generated: true, tags: [audioModeTag(mode)] },
    order: { by: 'createdAt', direction: 'desc' },
  });
