import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { api } from '@/app/contexts/ApiContext';
import { useSubscribeCollection, updateAllQueryData } from '@/app/utils/react-query';
import { IArtifactDocument, IArtifactVersionDocument } from '@bike4mind/common';

interface ArtifactVersion {
  _id: string;
  artifactId: string;
  version: number;
  versionTag?: string;
  changes: string[];
  changeDescription?: string;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
}

interface CreateVersionRequest {
  versionTag?: string;
  changeDescription?: string;
  content?: string;
}

export function useArtifactVersions(artifactId: string | null) {
  const isLegacyId = artifactId && !artifactId.startsWith('artifact_');

  // Check if this is an incomplete artifact ID (missing timestamp and index)
  // Complete format: artifact_{type}_{identifier}_{timestamp}_{index}
  // Incomplete format: artifact_{type}_{identifier}
  const isIncompleteId = artifactId && artifactId.startsWith('artifact_') && artifactId.split('_').length < 5;

  return useQuery({
    queryKey: ['artifactVersions', artifactId],
    queryFn: async () => {
      if (isLegacyId || isIncompleteId) {
        return [];
      }

      const response = await api.get<{
        success: boolean;
        data: ArtifactVersion[];
        total: number;
      }>(`/api/artifacts/${artifactId}/versions`);

      // TEMPORARY FIX: If versions don't have version numbers, assign them based on creation date
      const versionsWithNumbers = response.data.data.map((v: any, index: number) => {
        if (!v.version) {
          return {
            ...v,
            version: index + 1,
          };
        }
        return v;
      });

      // Sort by createdAt to ensure correct version numbering (handle missing createdAt)
      versionsWithNumbers.sort((a: any, b: any) => {
        const aDate = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bDate = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return aDate - bDate;
      });

      // Re-assign version numbers after sorting
      const finalVersions = versionsWithNumbers.map((v: any, index: number) => ({
        ...v,
        version: index + 1,
      }));

      return finalVersions;
    },
    enabled: !!artifactId && !isLegacyId && !isIncompleteId,
    staleTime: 30000, // 30 seconds
  });
}

export const useCreateArtifactVersion = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ artifactId, data }: { artifactId: string; data: CreateVersionRequest }) => {
      const response = await api.post(`/api/artifacts/${artifactId}/versions`, data);
      return response.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['artifact-versions', variables.artifactId] });

      // Also invalidate the artifact itself since it may have been updated
      queryClient.invalidateQueries({ queryKey: ['artifact', variables.artifactId] });
    },
  });
};

export const useSubscribeToArtifact = (artifactId?: string) => {
  const queryClient = useQueryClient();

  const callback = useCallback(
    (type: string, val: IArtifactDocument) => {
      updateAllQueryData(queryClient, 'artifacts', type === 'delete' ? 'delete' : 'write', val, {
        keysAllowedToCreate: [['artifacts']],
      });

      if (val.id) {
        queryClient.invalidateQueries({ queryKey: ['artifact', val.id] });
      }
    },
    [queryClient]
  );

  // Memoize the query object to prevent re-subscription churn
  const query = useMemo(() => (artifactId ? { _id: artifactId } : null), [artifactId]);
  useSubscribeCollection('artifacts', query, callback);
};

export const useSubscribeToArtifactVersions = (artifactId?: string) => {
  const queryClient = useQueryClient();

  const callback = useCallback(
    (type: string, val: IArtifactVersionDocument) => {
      // Ensure the data has an id field for updateAllQueryData
      const dataWithId = { ...val, id: val._id?.toString() || '' };

      updateAllQueryData(queryClient, 'artifact_versions', type === 'delete' ? 'delete' : 'write', dataWithId, {
        keysAllowedToCreate: [['artifact-versions']],
      });

      if (val.artifactId) {
        queryClient.invalidateQueries({ queryKey: ['artifact-versions', val.artifactId] });
      }
    },
    [queryClient]
  );

  // Memoize the query object to prevent infinite re-subscriptions
  const query = useMemo(() => {
    return artifactId ? { artifactId } : null;
  }, [artifactId]);

  // Call useSubscribeCollection directly as a hook (not inside useEffect)
  useSubscribeCollection('artifact_versions', query, callback);
};

export const useArtifact = (
  artifactId: string | null,
  options?: { includeContent?: boolean; includeVersions?: boolean }
) => {
  return useQuery({
    queryKey: ['artifact', artifactId, options],
    queryFn: async () => {
      if (!artifactId) return null;

      const params = new URLSearchParams();
      if (options?.includeContent) params.append('includeContent', 'true');
      if (options?.includeVersions) params.append('includeVersions', 'true');

      const response = await api.get(`/api/artifacts/${artifactId}?${params.toString()}`);
      return response.data;
    },
    enabled: !!artifactId,
    staleTime: 30000, // 30 seconds
  });
};

export const useSessionArtifacts = (sessionId: string | null) => {
  return useQuery({
    queryKey: ['session-artifacts', sessionId],
    queryFn: async () => {
      if (!sessionId) return [];

      const response = await api.get<{
        artifacts: IArtifactDocument[];
        pagination: {
          total: number;
          limit: number;
          offset: number;
          hasMore: boolean;
        };
      }>(`/api/artifacts`, {
        params: {
          sessionId,
          limit: 100,
          includeDeleted: false,
        },
      });

      return response.data.artifacts;
    },
    enabled: !!sessionId,
    staleTime: 30000, // 30 seconds
  });
};

export const useAddArtifactToSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, artifactId }: { sessionId: string; artifactId: string }) => {
      const response = await api.put(`/api/sessions/${sessionId}`, {
        artifactIds: [artifactId], // This will be merged with existing artifactIds in the service
      });
      return response.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session-artifacts', variables.sessionId] });
    },
  });
};

export const useRemoveArtifactFromSession = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ sessionId, artifactId }: { sessionId: string; artifactId: string }) => {
      // Fetch current artifactIds and remove the one we want
      const sessionResponse = await api.get(`/api/sessions/${sessionId}`);
      const currentArtifactIds = sessionResponse.data.artifactIds || [];
      const updatedArtifactIds = currentArtifactIds.filter((id: string) => id !== artifactId);

      const response = await api.put(`/api/sessions/${sessionId}`, {
        artifactIds: updatedArtifactIds,
      });
      return response.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['sessions', variables.sessionId] });
      queryClient.invalidateQueries({ queryKey: ['session-artifacts', variables.sessionId] });
    },
  });
};

export function useArtifactVersionContent(artifactId: string | null, version: number | null) {
  return useQuery({
    queryKey: ['artifactVersionContent', artifactId, version],
    queryFn: async () => {
      if (!artifactId || !version) return null;

      const response = await api.get<{
        success: boolean;
        data: {
          version: number;
          content: string;
          versionTag?: string;
          createdAt: string;
        };
      }>(`/api/artifacts/${artifactId}/versions/${version}`);

      return response.data.data;
    },
    enabled: !!artifactId && !!version,
    staleTime: 60000, // 1 minute - version content is stable
  });
}
