import { useQuery } from '@tanstack/react-query';
import { FavoriteDocumentType } from '@bike4mind/common';
import { api } from '@client/app/contexts/ApiContext';

export function useCheckFavorite(documentId: string, documentType: FavoriteDocumentType) {
  return useQuery({
    queryKey: ['favorites', documentId, documentType],
    queryFn: async () => {
      const { data } = await api.get('/api/favorites/check', {
        params: {
          documentId,
          documentType,
        },
      });
      return data.isFavorite;
    },
    // Don't refetch on window focus since favorites don't change often
    refetchOnWindowFocus: false,
  });
}
