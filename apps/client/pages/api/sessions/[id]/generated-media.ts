import { questRepository, sessionRepository } from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { NotFoundError } from '@server/utils/errors';
import { GENERATED_MEDIA_URL_TTL_SECONDS, signGeneratedMediaUrls } from '@server/utils/generatedMediaUrls';
import { toObjectIdString } from '@server/utils/objectId';
import { z } from 'zod';

// A chat turn produces a handful of files; this bounds one request, not a session.
const MAX_KEYS_PER_REQUEST = 200;

// Bare generated-bucket basenames (`<uuid>.png`, `report-1a2b3c4d.xlsx`). Never a path: the key
// must also be referenced by a quest in the session before it is signed.
const generatedKeySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^/\\]+$/, 'Expected a bare generated-file key');

const bodySchema = z.object({
  keys: z.array(generatedKeySchema).min(1).max(MAX_KEYS_PER_REQUEST),
});

/**
 * Presigned URLs for the generated media (images, audio, video, generated files) a session's turns
 * produced. A browser media element cannot carry the Bearer token, so the chat UI fetches these as
 * JSON and renders the URLs. Read access follows the session: anyone who can read the chat
 * (owner or sharee) can read what it generated. Keys the session does not reference are omitted,
 * so a foreign key is indistinguishable from a nonexistent one.
 */
const handler = baseApi({ auth: 'jwtOnly' }).post(
  asyncHandler<unknown, unknown, unknown, { id?: string }>(async (req, res) => {
    // Canonicalized: QuestModel.sessionId is a plain string, compared byte-for-byte.
    const sessionId = req.query.id ? toObjectIdString(req.query.id) : undefined;
    if (!sessionId) throw new NotFoundError('Session not found');

    const { keys } = bodySchema.parse(req.body);

    const session = await sessionRepository.shareable.findAccessibleById(req.user!, sessionId);
    if (!session) throw new NotFoundError('Session not found');

    const readableKeys = await questRepository.findGeneratedMediaKeysInSession(sessionId, keys);
    const urls = await signGeneratedMediaUrls(readableKeys);

    return res.json({
      urls,
      expiresAt: new Date(Date.now() + GENERATED_MEDIA_URL_TTL_SECONDS * 1000).toISOString(),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
