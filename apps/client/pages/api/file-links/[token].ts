import { isImageServeable } from '@bike4mind/common';
import { GenerationJobModel, fabFileRepository, userRepository } from '@bike4mind/database';
import { accountBlockReasons } from '@bike4mind/services/userService/accountState';
import {
  FILE_LINK_REDIRECT_TTL_SECONDS,
  verifyFileLinkToken,
  type FileLinkTarget,
} from '@bike4mind/server-utils/files/fileLinkToken';
import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { userCanAccessGeneratedImage } from '@bike4mind/server-utils/utils/generatedImageAccess';
import { getFilesStorage, getGeneratedImageStorage } from '@bike4mind/server-utils/utils/storage/index';
import { SHARED_EMAIL_FILES_PREFIX } from '@server/utils/mailer/emailAttachments';
import { baseApi } from '@server/middlewares/baseApi';

type LinkUser = NonNullable<Awaited<ReturnType<typeof userRepository.findById>>>;
type Resolved = { storage: 'files' | 'generated'; key: string; filename: string };

const lastSegment = (key: string) => key.slice(key.lastIndexOf('/') + 1) || 'download';

const contentDisposition = (filename: string) => {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
};

async function resolveTarget(target: FileLinkTarget, user: LinkUser): Promise<Resolved | null> {
  if (target.kind === 'fabFile') {
    const file = await fabFileRepository.shareable.findAccessibleById(user, target.fileId);
    if (!file?.filePath || file.deletedAt || !isImageServeable(file)) return null;
    return { storage: 'files', key: file.filePath, filename: file.fileName || lastSegment(file.filePath) };
  }
  if (target.kind === 'filesKey') {
    const ownPrefix = `${SHARED_EMAIL_FILES_PREFIX}${user.id}/`;
    if (!target.key.startsWith(ownPrefix) || target.key.split('/').includes('..')) return null;
    return { storage: 'files', key: target.key, filename: lastSegment(target.key) };
  }
  // A video job's output falls back to the generated bucket when saving it to Files fails; no quest references it then.
  const ownJobOutput = await GenerationJobModel.exists({ requestedBy: user.id, 'payload.output.s3Key': target.key });
  if (!ownJobOutput && !(await userCanAccessGeneratedImage(target.key, user))) return null;
  return { storage: 'generated', key: target.key, filename: lastSegment(target.key) };
}

/**
 * GET /api/file-links/:token - redeems a file link minted by buildFileLinkUrl (sent in emails and
 * Slack messages). The signed token is the credential, so this route takes no session; access is
 * re-checked for the issuing user on every click and the redirect target is a short-lived URL.
 * Every refusal is the same 404.
 */
const handler = baseApi({ auth: false, allowedMethods: ['GET'] })
  // No user on a public route, so the limiter keys on the client IP.
  .use(rateLimit({ limit: 30, windowMs: 60_000, bucket: 'GET /api/file-links' }))
  .get(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');

    const check = verifyFileLinkToken(req.query.token, Math.floor(Date.now() / 1000));
    if (!check.ok) return res.status(404).end();
    const { target, userId } = check.claims;

    const user = await userRepository.findById(userId);
    if (!user || user.isSystem || accountBlockReasons(user).length > 0) return res.status(404).end();

    const resolved = await resolveTarget(target, user);
    if (!resolved) return res.status(404).end();

    const storage = resolved.storage === 'files' ? getFilesStorage() : getGeneratedImageStorage();
    const url = await storage.getSignedUrl(resolved.key, 'get', {
      expiresIn: FILE_LINK_REDIRECT_TTL_SECONDS,
      ResponseContentDisposition: contentDisposition(resolved.filename),
    });
    return res.redirect(302, url);
  });

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
