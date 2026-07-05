// GET /api/business-links - List all research links with category info
// POST /api/business-links - Create a new research link

import { ResearchLink, ResearchLinkCategory } from '@bike4mind/database/content';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';

interface IQuery {
  pageSize?: string;
  pageNumber?: string;
  searchTerm?: string;
  categoryId?: string;
}

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, IQuery>(async (req, res) => {
      const queryParams = req.query as IQuery;
      const pageSize = parseInt(queryParams.pageSize || '10');
      const pageNumber = parseInt(queryParams.pageNumber || '1');
      const searchTerm = queryParams.searchTerm || '';
      const categoryId = queryParams.categoryId;

      const query: any = {};

      if (categoryId) {
        query.categoryId = categoryId;
      }

      if (searchTerm) {
        const escapedSearchTerm = escapeRegex(searchTerm);
        query.$or = [
          { name: { $regex: escapedSearchTerm, $options: 'i' } },
          { url: { $regex: escapedSearchTerm, $options: 'i' } },
          { ticker: { $regex: escapedSearchTerm, $options: 'i' } },
          { type: { $regex: escapedSearchTerm, $options: 'i' } },
        ];
      }

      const total = await ResearchLink.countDocuments(query);
      const links = await ResearchLink.find(query)
        .sort({ name: 1 })
        .skip((pageNumber - 1) * pageSize)
        .limit(pageSize)
        .lean();

      // Populate category information
      const linksWithCategory = await Promise.all(
        links.map(async link => {
          if (link.categoryId) {
            const category = await ResearchLinkCategory.findById(link.categoryId).lean();
            return { ...link, category };
          }
          return { ...link, category: null };
        })
      );

      const totalPages = Math.ceil(total / pageSize);
      const pagePosition = pageNumber === 1 ? 'first' : pageNumber === totalPages ? 'last' : 'middle';

      return res.json({
        data: linksWithCategory,
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
      const body = req.body as { name?: string; url?: string; ticker?: string; type?: string; categoryId?: string };
      const { name, url, ticker, type, categoryId } = body;

      if (!name || !url) {
        return res.status(400).json({ message: 'Name and URL are required' });
      }

      const link = await ResearchLink.create({
        name,
        url,
        ticker,
        type,
        categoryId,
      });

      return res.status(201).json(link);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
