import { useQuery } from '@tanstack/react-query';
import type { SoundGenerationVendor, VoiceGenerationVendor } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export type UsableAudioProviders = {
  speech: VoiceGenerationVendor[];
  soundEffects: SoundGenerationVendor[];
};

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
