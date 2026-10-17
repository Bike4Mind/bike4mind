import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
// The route answers with the util's own result, so its type is the one source for the response shape.
import type { UsableAudioProviders } from '@server/utils/listUsableAudioProviders';

export const audioProviderKeys = {
  usable: ['audioProviders', 'usable'] as const,
};

/** The speech and sound-effect providers this user has a key for (GET /api/ai/audio-providers). */
export function useAudioProviders() {
  return useQuery({
    queryKey: audioProviderKeys.usable,
    queryFn: async () => (await api.get<UsableAudioProviders>('/api/ai/audio-providers')).data,
    staleTime: 5 * 60_000,
  });
}
