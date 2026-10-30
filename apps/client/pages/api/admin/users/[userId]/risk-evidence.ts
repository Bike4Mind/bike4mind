import { userRepository } from '@bike4mind/database';
import {
  ApiKeyScope,
  adminRiskEvidenceViewSchema,
  riskEvidenceRefreshStateSchema,
  riskEvidenceSummarySchema,
  type AdminRiskEvidenceView,
} from '@bike4mind/common';
import { baseApi } from '@server/middlewares/baseApi';
import { BadRequestError, ensureAdmin, NotFoundError } from '@server/utils/errors';

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

/**
 * The signup risk score beside the shadow-only behavioral evidence, with its observation window,
 * per-fact provenance and missing reasons, and the last refresh failure. Read-only.
 */
const handler = baseApi({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] }).get(async (req, res) => {
  ensureAdmin(req.user?.isAdmin);

  const { userId } = req.query;
  if (typeof userId !== 'string' || !OBJECT_ID_PATTERN.test(userId)) throw new BadRequestError('Invalid user id');

  const user = await userRepository.findById(userId);
  if (!user) throw new NotFoundError('User not found');

  // Each part is parsed on its own: an older-version or corrupted part reads as null without
  // hiding the others, and is never misread.
  const storedSummary = user.riskEvidence?.summary;
  const summary = riskEvidenceSummarySchema.safeParse(storedSummary);
  const refresh = riskEvidenceRefreshStateSchema.safeParse(user.riskEvidence?.refresh);
  const risk = user.riskScore;
  const riskScore = adminRiskEvidenceViewSchema.shape.riskScore.safeParse(
    risk
      ? { score: risk.score, signals: risk.signals, computedAt: risk.computedAt, reviewState: risk.reviewState }
      : null
  );
  const view: AdminRiskEvidenceView = {
    riskScore: riskScore.success ? riskScore.data : null,
    evidence: summary.success ? summary.data : null,
    evidenceUnreadable: !summary.success && storedSummary !== null && storedSummary !== undefined,
    refresh: refresh.success ? refresh.data : null,
  };
  return res.json(adminRiskEvidenceViewSchema.parse(view));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
