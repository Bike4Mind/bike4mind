import { useInfiniteSearchFabFiles } from '@client/app/hooks/data/fabFileSearch';
import type { AudioGenMode } from '@client/app/stores/useAudioGenSettings';
import { audioModeTag } from './generatedAudioSettings';

/**
 * The caller's own saved speech or sound-effect files, newest first. They have no job record, so the Files copy is
 * the history. `owned` keeps out generated audio shared through groups or data lakes, matching the owner-only Music
 * and Video recents (listOwnGenerationJobs). useGenerateAudio invalidates every fabFiles query after a save, which
 * refreshes this list too.
 */
export const useRecentGeneratedAudio = (mode: AudioGenMode) =>
  useInfiniteSearchFabFiles({
    filters: { generated: true, owned: true, tags: [audioModeTag(mode)] },
    order: { by: 'createdAt', direction: 'desc' },
  });
