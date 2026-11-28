import { outboundActionGate } from '@server/auth/assertOutboundActionAllowed';
import { baseApi } from '@server/middlewares/baseApi';
import { PublishServiceError } from '@server/services/publish/publishServiceError';
import { restorePublishedVersion } from '@server/services/publish/restorePublishedVersion';

/**
 * POST /api/publish/[publicId]/restore[?sha={version}] - roll a published bundle
 * back to a prior version (the given known version, or the immediately-previous
 * by default). Owner/admin only; see `restorePublishedVersion` for the contract.
 */
const handler = baseApi().post(outboundActionGate(), async (req, res) => {
  if (!req.user?.id) return res.status(401).json({ error: 'Authentication required' });

  const query = req.query as { publicId?: string; sha?: string };
  try {
    const restored = await restorePublishedVersion({
      user: req.user,
      logger: req.logger,
      publicId: String(query.publicId ?? ''),
      sha: typeof query.sha === 'string' ? query.sha : undefined,
    });
    return res.status(200).json({ ...restored, publishedAt: restored.publishedAt.toISOString() });
  } catch (error) {
    if (!(error instanceof PublishServiceError)) throw error;
    const { errorCode, details, violations } = error.additionalInfo ?? {};
    return res
      .status(error.statusCode)
      .json({ error: error.message, ...(errorCode ? { code: errorCode } : {}), details, violations });
  }
});

export const config = {
  api: { externalResolver: true },
};

export default handler;
