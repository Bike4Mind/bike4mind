import { FabFile, releaseNoteRepository } from '@bike4mind/database';
import { getWhatsNewMediaContract, isImageServeable, NotFoundError, releaseNoteMediaUrl } from '@bike4mind/common';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';
import { Resource } from 'sst';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { findDeniedInNote, loadReleaseNotesConfig } from '@bike4mind/server-utils/releaseNotes/adminReleaseNotes';
import { ownModalMediaKey } from '@server/releaseNotes/publicMedia';

// Seconds. The URL is signed for longer than the redirect may be cached (both figures are published in
// whatsNew.contract.ts), though the signing credentials can expire sooner.
const SIGNED_URL_TTL_SECONDS = 3600;
const CACHE_CONTROL = 'public, max-age=600, s-maxage=600';

const handler = nextRouteForContract(getWhatsNewMediaContract, {
  // Up to four files per note (a still is fetched only for a note without a video), so the budget is wider
  // than the feed's.
  rateLimit: rateLimit({ limit: 300, windowMs: 60_000, bucket: 'GET /api/v1/whats-new/media' }),
}).get(async (req, res) => {
  const { id, asset } = req.validatedParams;
  // Served under the same rules as the local feed (pages/api/v1/whats-new.ts), so a note's media is
  // never reachable while the note itself is withheld.
  const { config, malformed } = await loadReleaseNotesConfig(req.logger);
  const note = !malformed && config.enabled ? await releaseNoteRepository.findPublishedById(id, new Date()) : null;
  if (!note || findDeniedInNote(note, config.denylist)) throw new NotFoundError('Release note not found');

  const url = releaseNoteMediaUrl(note, asset);
  const key = url ? ownModalMediaKey(url, Resource.fabFileBucket.name) : null;
  if (!key) throw new NotFoundError('Release note media not found');
  // The moderation gate of /api/files/presigned-url: a held, blocked or deleted upload is never signed.
  // An untracked key still signs, as its `modals/` allowlist does. includeDeleted: the soft-delete
  // plugin would otherwise hide the row, so the deletedAt check below never saw it.
  const file = await FabFile.findOne({ filePath: key }).setOptions({ includeDeleted: true }).lean();
  if (file && (file.deletedAt || !isImageServeable(file))) throw new NotFoundError('Release note media not found');

  const signed = await getFilesStorage().getSignedUrl(key, 'get', {
    expiresIn: SIGNED_URL_TTL_SECONDS,
    audience: 'browser',
  });
  res.setHeader('Cache-Control', CACHE_CONTROL);
  return res.redirect(303, signed);
});

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
