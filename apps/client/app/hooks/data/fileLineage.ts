import { useQuery } from '@tanstack/react-query';
import { api } from '@client/app/contexts/ApiContext';
import type { FileLineage } from '@server/files/fileLineage';
import { fabFileKeys } from './fabFileKeys';

/** The trail behind a generated file: its bounded ancestry and the files made from it. */
export function useFileLineage(fileId: string | null) {
  return useQuery({
    queryKey: fabFileKeys.lineage(fileId ?? ''),
    queryFn: async () => {
      const { data } = await api.get<FileLineage>(`/api/studio/files/${encodeURIComponent(fileId ?? '')}/lineage`);
      return data;
    },
    enabled: !!fileId,
    refetchOnWindowFocus: false,
  });
}
