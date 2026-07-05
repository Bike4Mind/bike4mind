import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';

/**
 * A single voice in the configured ElevenLabs workspace (NOT a B4M voice
 * agent: voice agents are full IAgent docs that link to one of these voices
 * via `elevenLabsAgentId`). Used by the admin Voice Settings create-form to
 * populate the voice picker.
 */
export interface ElevenLabsVoice {
  id: string;
  name: string;
  labels: Record<string, string>;
  previewUrl?: string;
}

interface VoicesResponse {
  voices: ElevenLabsVoice[];
}

const QUERY_KEY = ['voice-v2/voices'] as const;

export function useElevenLabsVoices() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async (): Promise<ElevenLabsVoice[]> => {
      const res = await api.get<VoicesResponse>('/api/voice/v2/voices');
      return res.data.voices;
    },
    // The server caches for 15 min; matching here keeps tab switches snappy
    // without rehammering ElevenLabs.
    staleTime: 5 * 60 * 1000,
  });
}
