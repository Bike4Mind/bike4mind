import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import { useUser } from '@client/app/contexts/UserContext';
import type { ElevenLabsVoice } from './elevenLabsVoices';

/**
 * The ElevenLabs voices the current user can synthesize with (their own key, else the admin one),
 * for Studio's voice picker. Unlike useElevenLabsVoices (the admin voice agent catalog) it works
 * without Voice v2. Empty when no ElevenLabs key is configured.
 */
export function useElevenLabsTtsVoices() {
  const userId = useUser(state => state.currentUser?.id);
  return useQuery({
    // Per user: the list depends on whose key the server resolves, so another account must not reuse it.
    queryKey: ['ai/elevenlabs-voices', userId],
    queryFn: async (): Promise<ElevenLabsVoice[]> => {
      const res = await api.get<{ voices: ElevenLabsVoice[] }>('/api/ai/elevenlabs-voices');
      return res.data.voices;
    },
    // The server caches each key's list for 15 min.
    staleTime: 5 * 60 * 1000,
  });
}
