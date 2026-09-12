// GET /api/business-links/category - List all research link categories
// POST /api/business-links/category - Create a new research link category

import { ResearchLinkCategory } from '@bike4mind/database/content';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import qs from 'qs';

interface IQuery {
  pageSize?: string;
  pageNumber?: string;
  searchTerm?: string;
}

// The nested shape the app sends, recovered from the bracket keys in `req.query`.
interface IParsedQuery extends IQuery {
  filters?: {
    search?: unknown;
  };
}

// Bracket keys nest arbitrarily (`filters[search][x]=1` parses to an object) and a
// repeated key parses to an array, so only a plain string is a usable filter value.
// Anything else is treated as absent rather than reaching `escapeRegex`, which throws
// on a non-string.
const filterString = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const handler = baseApi()
  .get(
    asyncHandler<{}, unknown, IQuery>(async (req, res) => {
      // The client serializes the filters nested (`filters[search]=...`) through qs, and
      // Next.js leaves those bracket keys unexpanded in `req.query` - so re-parse before
      // reading them, the way the sibling `pages/api/business-links/index.ts` does. The
      // flat `searchTerm` param stays supported for existing API-key callers.
      const queryParams = qs.parse(req.query as Record<string, string>) as IParsedQuery;
      const pageSize = parseInt(queryParams.pageSize || '10');
      const pageNumber = parseInt(queryParams.pageNumber || '1');
      const searchTerm = filterString(queryParams.filters?.search) ?? filterString(queryParams.searchTerm) ?? '';

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
