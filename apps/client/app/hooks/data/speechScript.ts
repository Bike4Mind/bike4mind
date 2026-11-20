import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { SpeechScript } from '@server/files/speechScript';
import { fabFileKeys } from './fabFileKeys';

/** What a generated voice clip says, with word timings when its provider aligned it; null for any other file. */
export function useSpeechScript(fileId: string | null) {
  return useQuery({
    queryKey: fabFileKeys.speechScript(fileId ?? ''),
    queryFn: async () => {
      const { data } = await api.get<{ script: SpeechScript | null }>(
        `/api/studio/files/${encodeURIComponent(fileId ?? '')}/speech-script`
      );
      return data.script;
    },
    enabled: !!fileId,
    // A generated clip's script never changes.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
