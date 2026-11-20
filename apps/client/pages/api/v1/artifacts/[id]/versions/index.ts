/**
 * GET  /api/v1/artifacts/{id}/versions - one artifact's version history, in version order and
 *      cursor-paginated. Read access is checked through artifactService.get first, as the SPA route does.
 * POST /api/v1/artifacts/{id}/versions - add a version; the public twin of POST /api/artifacts/[id]/versions.
 */

import { createArtifactVersionContract, listArtifactVersionsContract } from '@bike4mind/common';
import { artifactVersionRepository } from '@bike4mind/database';
import { artifactService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { UnprocessableEntityError } from '@bike4mind/server-utils/utils/errors';
import { toPublicArtifact, toPublicArtifactVersion } from '@server/artifacts/toPublicArtifact';
import { ARTIFACT_DB, hideArtifactDenial } from '@bike4mind/server-utils/artifacts/artifactAccess';

const CURSOR_SCOPE = 'v1.artifacts.versions';

const listRoute = nextRouteForContract(listArtifactVersionsContract, {
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

const createRoute = nextRouteForContract(createArtifactVersionContract, {
  rateLimit: perUserRateLimit('POST /api/v1/artifacts/[id]/versions'),
}).post(async (req, res) => {
  const { content, change_description, version_tag } = req.validated;

  // A denied edit is a 404 here, like PATCH: a caller cannot tell an artifact it may not edit from
  // one that does not exist.
  const { artifact } = await hideArtifactDenial(
    artifactService.update(
      req.user.id,
      {
        id: req.validatedParams.id,
        content,
        createNewVersion: true,
        // Spread so an omitted field stays absent instead of being set undefined.
        ...(version_tag !== undefined && { versionTag: version_tag }),
        ...(change_description !== undefined && { versionMessage: change_description }),
      },
      { db: ARTIFACT_DB }
    )
  );

  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(201).json(toPublicArtifact(artifact, content));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });
