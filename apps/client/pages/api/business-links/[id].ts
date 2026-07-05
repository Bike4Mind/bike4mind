// PUT /api/business-links/[id] - Update a research link
// DELETE /api/business-links/[id] - Delete a research link

import { ResearchLink } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';

interface IParams {
  id?: string;
}

const handler = baseApi()
  .put(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      ensureAdmin(req.user.isAdmin);
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ message: 'Link ID is required' });
      }

      const body = req.body as { name?: string; url?: string; ticker?: string; type?: string; categoryId?: string };
      const { name, url, ticker, type, categoryId } = body;

      const link = await ResearchLink.findByIdAndUpdate(
        id,
        { name, url, ticker, type, categoryId },
        { new: true, runValidators: true }
      );

      if (!link) {
        return res.status(404).json({ message: 'Link not found' });
      }

      return res.json(link);
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      ensureAdmin(req.user.isAdmin);
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ message: 'Link ID is required' });
      }

      const link = await ResearchLink.findByIdAndDelete(id);

      if (!link) {
        return res.status(404).json({ message: 'Link not found' });
      }

      return res.json({ message: 'Link deleted successfully' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
