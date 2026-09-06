// PUT /api/business-links/category/[id] - Update a research link category
// DELETE /api/business-links/category/[id] - Delete a research link category

import { ResearchLinkCategory } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import { z } from 'zod';

interface IParams {
  id?: string;
}

// Both fields are String-typed and reach an update payload, which casts before validators run.
// An array or object from a JSON body throws `CastError kind='string'` instead of being
// rejected. Same guard and same reasoning as the sibling route on ../[id].ts.
const updateBodySchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
});

const handler = baseApi()
  .put(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      ensureAdmin(req.user.isAdmin);
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ message: 'Category ID is required' });
      }

      const parsedBody = updateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({ message: 'Invalid request body' });
      }
      const { name, description } = parsedBody.data;

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
