import { baseApi } from '@server/middlewares/baseApi';
import { favoriteRepository } from '@bike4mind/database';
import { FavoriteDocumentType } from '@bike4mind/common';

const handler = baseApi().get(async (req, res) => {
  const { documentId, documentType } = req.query;

  if (!documentId || !documentType) {
    return res.status(400).json({ error: 'Missing required parameters' });
  }

  const favorite = await favoriteRepository.findOne({
    userId: req.user.id,
    documentId: documentId as string,
    documentType: documentType as FavoriteDocumentType,
  });

  return res.json({ isFavorite: !!favorite });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
