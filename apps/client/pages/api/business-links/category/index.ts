// GET /api/business-links/category - List all research link categories
// POST /api/business-links/category - Create a new research link category

import { ResearchLinkCategory } from '@bike4mind/database/content';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';

interface IQuery {
  pageSize?: string;
  pageNumber?: string;
  searchTerm?: string;
}

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, IQuery>(async (req, res) => {
      const queryParams = req.query as IQuery;
      const pageSize = parseInt(queryParams.pageSize || '10');
      const pageNumber = parseInt(queryParams.pageNumber || '1');
      const searchTerm = queryParams.searchTerm || '';

      const query = searchTerm
        ? {
            $or: [
              { name: { $regex: escapeRegex(searchTerm), $options: 'i' } },
              { description: { $regex: escapeRegex(searchTerm), $options: 'i' } },
            ],
          }
        : {};

      const total = await ResearchLinkCategory.countDocuments(query);
      const categories = await ResearchLinkCategory.find(query)
        .sort({ name: 1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize);

      const totalPages = Math.ceil(total / pageSize);
      const pagePosition = pageNumber === 1 ? 'first' : pageNumber === totalPages ? 'last' : 'middle';

      return res.json({
        data: categories,
        meta: {
          pagination: {
            total,
            page: pageNumber,
            totalPages,
            pagePosition,
          },
          overallTotal: total,
        },
      });
    })
  )
  .post(
    asyncHandler<{}, unknown, unknown>(async (req, res) => {
      ensureAdmin(req.user.isAdmin);
      const body = req.body as { name?: string; description?: string };
      const { name, description } = body;

      if (!name || !description) {
        return res.status(400).json({ message: 'Name and description are required' });
      }

      const category = await ResearchLinkCategory.create({
        name,
        description,
      });

      return res.status(201).json(category);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
