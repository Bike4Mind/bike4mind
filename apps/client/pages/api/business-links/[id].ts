// PUT /api/business-links/[id] - Update a research link
// DELETE /api/business-links/[id] - Delete a research link

import { ResearchLink } from '@bike4mind/database/content';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { ensureAdmin } from '@server/utils/errors';
import { isValidObjectId } from '@server/utils/objectId';
import { z } from 'zod';

interface IParams {
  id?: string;
}

// Every field here reaches a `findByIdAndUpdate` payload, and update payloads cast before
// validators run, so `runValidators: true` does not cover them. A non-string on a String path
// -- `{"ticker":["AAPL","MSFT"]}` or a nested object, both of which a JSON body can carry --
// throws `CastError path='ticker' kind='string'` rather than being rejected. Validating the
// whole body keeps that a client error; unknown keys are stripped, so they cannot reach the
// payload at all. `categoryId` also accepts null, which is the clear-the-field value and the
// only non-string that casts cleanly on an ObjectId path.
//
// This is deliberately stricter than mongoose. A number or boolean on a String path does NOT
// throw -- mongoose coerces it and writes `"123"`/`"true"` -- so `{"ticker":123}` used to be
// accepted and is a 400 now. Rejecting is the intended behavior: the coercion silently stores
// a type the client did not send, and no in-app caller relies on it. Stated here because it is
// a wire-visible tightening that is invisible in the throwing-shape tests below.
const updateBodySchema = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  ticker: z.string().optional(),
  type: z.string().optional(),
  categoryId: z.union([z.string(), z.null()]).optional(),
});

const handler = baseApi()
  .put(
    asyncHandler<{}, unknown, unknown, IParams>(async (req, res) => {
      ensureAdmin(req.user.isAdmin);
      const { id } = req.query;

      if (!id) {
        return res.status(400).json({ message: 'Link ID is required' });
      }

      const parsedBody = updateBodySchema.safeParse(req.body);
      if (!parsedBody.success) {
        return res.status(400).json({ message: 'Invalid request body' });
      }
      const { name, url, ticker, type, categoryId } = parsedBody.data;

      // The UI cannot reach here with '' (BusinessLink.tsx gates the query on a truthy
      // categoryId), so reading '' as "no category" and normalizing it onto null is a
      // direct-API-caller convenience, not a destructive write the form sends. Anything else
      // non-null must be a well-formed id or the cast would throw instead of answering.
      const normalizedCategoryId = categoryId === '' ? null : categoryId;
      if (
        normalizedCategoryId !== undefined &&
        normalizedCategoryId !== null &&
        !isValidObjectId(normalizedCategoryId)
      ) {
        return res.status(400).json({ message: 'Invalid category ID format' });
      }

      const link = await ResearchLink.findByIdAndUpdate(
        id,
        { name, url, ticker, type, categoryId: normalizedCategoryId },
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
