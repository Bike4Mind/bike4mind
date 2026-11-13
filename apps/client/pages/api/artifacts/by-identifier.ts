import type { IArtifactRepository } from '@bike4mind/common';
import { artifactService } from '@bike4mind/services';
import { artifactRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { z } from 'zod';
import qs from 'qs';

// Plain strings: qs.parse turns `identifier[$ne]=x` into an object, which these reject.
const ByIdentifierSchema = z.object({
  sessionId: z.string().min(1),
  type: z.string().min(1),
  identifier: z.string().min(1),
});

const handler = baseApi({ auth: 'jwtOnly' })
  /**
   * GET /api/artifacts/by-identifier
   * The session's artifact for a type + identifier that the caller may read (owner, shared or public)
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const validatedParams = ByIdentifierSchema.parse(qs.parse(req.query as Record<string, string>));

      const match = await artifactService.findByIdentifier(userId, validatedParams, {
        db: {
          artifacts: artifactRepository as unknown as IArtifactRepository,
        },
      });

      res.setHeader('Cache-Control', 'private, no-store');
      return res.json({ artifact: match });
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
