/**
 * GET  /api/v1/artifacts - list the caller's own artifacts, cursor-paginated.
 * POST /api/v1/artifacts - create an artifact; the public twin of POST /api/artifacts.
 *
 * Both call the same artifactService and source-ref guard as the SPA-internal route, so the doors
 * cannot authorize differently; these handlers only map the published snake_case shape.
 */

import { createArtifactContract, listArtifactsContract } from '@bike4mind/common';
import { artifactRepository, projectRepository, userRepository } from '@bike4mind/database';
import { artifactService, projectService } from '@bike4mind/services';
import { nextRouteForContract } from '@server/middlewares/defineNextRoute';
import { dispatchByMethod } from '@server/middlewares/dispatchByMethod';
import { perUserRateLimit } from '@server/middlewares/perUserRateLimit';
import { decodeCursor, encodeCursor } from '@server/utils/cursorPagination';
import { isValidObjectId } from '@server/utils/objectId';
import { ForbiddenError, NotFoundError, UnprocessableEntityError } from '@server/utils/errors';
import { assertArtifactSourceRefsAccessible } from '@server/utils/assertArtifactSourceRefsAccessible';
import { toPublicArtifact } from '@server/artifacts/toPublicArtifact';
import { ARTIFACT_DB, artifactSourceRefDeps } from '@server/artifacts/artifactAccess';

const CURSOR_SCOPE = 'v1.artifacts';

const listRoute = nextRouteForContract(listArtifactsContract, {
  // Like every sibling v1 read: a page costs no daily slot; the per-minute limit still applies.
  exemptReadsFromDailyRateLimit: true,
  rateLimit: perUserRateLimit('GET /api/v1/artifacts'),
}).get(async (req, res) => {
  const { limit, cursor } = req.validatedQuery;
  const beforeId = cursor === undefined ? undefined : decodeCursor(cursor, CURSOR_SCOPE);
  // A cursor carries the last _id this endpoint served, so anything else was not minted here.
  if (beforeId !== undefined && !isValidObjectId(beforeId)) {
    throw new UnprocessableEntityError('Invalid cursor');
  }

  const page = await artifactRepository.listOwnedBeforeId(req.user.id, { beforeId, limit });
  const lastId = page.data.at(-1)?._id;

  res.setHeader('Cache-Control', 'private, no-store');
  return res.json({
    data: page.data.map(artifact => toPublicArtifact(artifact, null)),
    next_cursor: page.hasMore && lastId ? encodeCursor(CURSOR_SCOPE, String(lastId)) : null,
  });
});

const createRoute = nextRouteForContract(createArtifactContract, {
  rateLimit: perUserRateLimit('POST /api/v1/artifacts'),
}).post(async (req, res) => {
  const { type, title, content, description, session_id, project_id, tags } = req.validated;
  const userId = req.user.id;

  // The SPA route stamps projectId unchecked; here filing under a project needs read access to it.
  // projectService.get answers NotFoundError for an unknown or inaccessible project alike.
  if (project_id !== undefined) {
    await projectService.get(
      userId,
      { id: project_id },
      { db: { projects: projectRepository, users: userRepository } }
    );
  }

  // Same guard and session predicate as POST /api/artifacts. Its 403 becomes a 404 here: 403 is
  // reserved for scope (CONVENTIONS.md), and a session you cannot edit reads as one that does not exist.
  try {
    await assertArtifactSourceRefsAccessible(userId, { sessionId: session_id }, artifactSourceRefDeps(req.user));
  } catch (err) {
    if (err instanceof ForbiddenError) throw new NotFoundError('Session not found');
    throw err;
  }

  const { artifact } = await artifactService.create(
    userId,
    {
      type,
      title,
      content,
      description,
      sessionId: session_id,
      projectId: project_id,
      tags: tags ?? [],
      visibility: 'private',
      metadata: {},
    },
    { db: ARTIFACT_DB }
  );

  return res.status(201).json(toPublicArtifact(artifact, content));
});

export const config = {
  api: {
    externalResolver: true,
  },
};

export default dispatchByMethod({ GET: listRoute, POST: createRoute });
