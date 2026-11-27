import { useQuery } from '@tanstack/react-query';
import type { ElevenLabsPlanUsage } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

/** ElevenLabs plan consumption for the billing cycle `cyclesBack` cycles before the current one. */
export const useElevenLabsUsage = (cyclesBack: number) =>
  useQuery({
    queryKey: ['elevenlabs-usage', cyclesBack],
    queryFn: async () => {
      const { data } = await api.get<ElevenLabsPlanUsage>('/api/admin/elevenlabs-usage', { params: { cyclesBack } });
      return data;
    },
    staleTime: 1000 * 60 * 5,
  });
