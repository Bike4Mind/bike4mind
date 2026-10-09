/**
 * GET /api/v1/artifacts/{id}/versions - one artifact's version history, in version order and
 * cursor-paginated. Read access is checked through artifactService.get first, as the SPA route does.
 */

import { listArtifactVersionsContract } from '@bike4mind/common';
import { artifactVersionRepository } from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { UnprocessableEntityError } from '@server/utils/errors';
import { toPublicArtifactVersion } from '@server/artifacts/toPublicArtifact';
import { ARTIFACT_DB, hideArtifactDenial } from '@server/artifacts/artifactAccess';

const CURSOR_SCOPE = 'v1.artifacts.versions';

const handler = nextRouteForContract(listArtifactVersionsContract, {
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/artifacts/[id]/versions'),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  // The cursor carries the last version number served, so anything else was not minted here.
  const afterVersion = cursor === undefined ? undefined : Number(decodeCursor(cursor, CURSOR_SCOPE));
  if (afterVersion !== undefined && !(Number.isInteger(afterVersion) && afterVersion > 0)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  const { artifact } = await hideArtifactDenial(
    artifactService.get(
      req.user.id,
      { id: req.validatedParams.id, includeContent: false, includeVersions: false },
      { db: ARTIFACT_DB }
    )
  );
  const page = await artifactVersionRepository.listByArtifactAfterVersion(artifact.id, { afterVersion, limit });
  const last = page.data.at(-1)?.version;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    data: page.data.map(version => toPublicArtifactVersion(version, null)),
    next_cursor: page.hasMore && last !== undefined ? encodeCursor(CURSOR_SCOPE, String(last)) : null,
  });
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
