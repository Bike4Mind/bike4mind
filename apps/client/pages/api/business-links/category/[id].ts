// PUT /api/business-links/category/[id] - Update a research link category
// DELETE /api/business-links/category/[id] - Delete a research link category

import { ResearchLinkCategory } from '@bike4mind/database/content';
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
        return res.status(400).json({ message: 'Category ID is required' });
      }

      const body = req.body as { name?: string; description?: string };
      const { name, description } = body;

      const category = await ResearchLinkCategory.findByIdAndUpdate(
        id,
        { name, description },
        { new: true, runValidators: true }
      );

      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }

      return res.json(category);
    })
  )
  .delete(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      ensureAdmin(req.user.isAdmin);
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ message: 'Category ID is required' });
      }

      const category = await ResearchLinkCategory.findByIdAndDelete(id);

      if (!category) {
        return res.status(404).json({ message: 'Category not found' });
      }

      return res.json({ message: 'Category deleted successfully' });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
