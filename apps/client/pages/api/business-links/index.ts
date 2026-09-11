// GET /api/business-links - List all research links with category info
// POST /api/business-links - Create a new research link

import { ResearchLink, ResearchLinkCategory } from '@bike4mind/database/content';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import qs from 'qs';

interface IQuery {
  pageSize?: string;
  pageNumber?: string;
  searchTerm?: string;
  categoryId?: string;
}

// The nested shape the app sends, recovered from the bracket keys in `req.query`.
interface IParsedQuery extends IQuery {
  filters?: {
    search?: unknown;
    categoryId?: unknown;
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
      // reading them, the way `pages/api/organizations/index.ts` does. The flat
      // `searchTerm`/`categoryId` params stay supported for existing API-key callers.
      const queryParams = qs.parse(req.query as Record<string, string>) as IParsedQuery;
      const pageSize = parseInt(queryParams.pageSize || '10');
      const pageNumber = parseInt(queryParams.pageNumber || '1');
      const searchTerm = filterString(queryParams.filters?.search) ?? filterString(queryParams.searchTerm) ?? '';
      const categoryId = filterString(queryParams.filters?.categoryId) ?? filterString(queryParams.categoryId);

      const query: any = {};

      if (categoryId) {
        // categoryId is an ObjectId-typed field, so an unvalidated junk value casts
        // and throws rather than answering the caller. 400 is the right answer.
        if (!isValidObjectId(categoryId)) {
          return res.status(400).json({ error: 'Invalid category ID format' });
        }
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
