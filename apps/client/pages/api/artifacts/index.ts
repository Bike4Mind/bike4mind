import { ArtifactTypeSchema, queryBool, readExperimentalFeaturePreference } from '@bike4mind/common';
import { artifactService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  artifactRepository,
  artifactContentRepository,
  artifactVersionRepository,
  sessionRepository,
  questRepository,
} from '@bike4mind/database';
import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { resolveUserArtifactGate } from '@server/utils/artifactGate';
import { assertArtifactSourceRefsAccessible } from '@server/utils/assertArtifactSourceRefsAccessible';
import { z } from 'zod';
import qs from 'qs';

const ListArtifactsSchema = z.object({
  limit: z.coerce.number().min(1).max(100).prefault(20),
  offset: z.coerce.number().min(0).prefault(0),
  sortBy: z.enum(['type', 'title', 'createdAt', 'updatedAt']).prefault('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).prefault('desc'),
  includeDeleted: queryBool,
  type: z.string().optional(),
  status: z.enum(['draft', 'review', 'published', 'archived']).optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).optional(),
  projectId: z.string().optional(),
  sessionId: z.string().optional(),
  tags: z.array(z.string()).prefault([]),
  search: z.string().optional(),
});

const CreateArtifactSchema = z.object({
  id: z.string().optional(),
  type: ArtifactTypeSchema,
  title: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  content: z.string().min(1),
  projectId: z.string().optional(),
  organizationId: z.string().optional(),
  visibility: z.enum(['private', 'project', 'organization', 'public']).prefault('private'),
  tags: z.array(z.string().max(50)).max(20).prefault([]),
  versionTag: z.string().max(100).optional(),
  sourceQuestId: z.string().optional(),
  sessionId: z.string().optional(),
  parentArtifactId: z.string().optional(),
  permissions: z
    .object({
      canRead: z.array(z.string()).prefault([]),
      canWrite: z.array(z.string()).prefault([]),
      canDelete: z.array(z.string()).prefault([]),
      isPublic: z.boolean().prefault(false),
      inheritFromProject: z.boolean().prefault(true),
    })
    .optional(),
  metadata: z.record(z.string(), z.unknown()).prefault({}),
});

/**
 * Whether a create is a model-authored row rather than something the user hand-wrote.
 *
 * Only the AI-authored writes honor the artifact opt-out. Deliberately keyed on `aiGenerated`, which
 * only `artifactPersistence.ts` sets: the artifact editor and the Knowledge viewer's create-on-404
 * fallbacks build their metadata from scratch, so a user who turned artifacts off can still author
 * one by hand - the preference withdraws a feature, it does not seal the collection.
 *
 * Scoped to POST on purpose. The PUT path forwards an existing artifact's metadata verbatim, so the
 * same check there would block a user's own edit of a row generated back when the flag was on.
 */
function isAiAuthoredCreate(metadata: Record<string, unknown>): boolean {
  return metadata.aiGenerated === true;
}

/**
 * Whether this user's model-authored artifacts may be persisted at all.
 *
 * Chat mode parses the finished quest in the BROWSER and posts the rows itself, so this route is the
 * only server-side point where that write can be refused. Without it the preference gated the
 * emission prompt and the extraction but not the durable row, and a fenced HTML block the fallback
 * parser promoted still landed in the collection for a caller who had opted out.
 */
async function areUserArtifactsEnabled(user: Express.User): Promise<boolean> {
  const [adminEnableArtifacts, adminEnableArtifactsDefault] = await Promise.all([
    adminSettingsRepository.getSettingsValue('EnableArtifacts'),
    adminSettingsRepository.getSettingsValue('EnableArtifactsDefault'),
  ]);
  return resolveUserArtifactGate({
    adminEnableArtifacts,
    adminEnableArtifactsDefault,
    userPreference: readExperimentalFeaturePreference(user, 'enableArtifacts'),
  });
}

const handler = baseApi()
  /**
   * GET /api/artifacts
   * List artifacts with filtering and pagination
   */
  .get(
    asyncHandler(async (req, res) => {
      const userId = req.user?.id;
      if (!userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const queryParams = qs.parse(req.query as any);
      const validatedParams = ListArtifactsSchema.parse(queryParams);

      const result = await artifactService.list(userId, validatedParams, {
        db: {
          artifacts: artifactRepository as any,
        },
      });

      return res.json(result);
    })
  )
  /**
   * POST /api/artifacts
   * Create a new artifact
   */
  .post(
    asyncHandler(async (req, res) => {
      const user = req.user;
      const userId = user?.id;
      if (!user || !userId) {
        return res.status(401).json({ error: 'Unauthorized' });
      }

      const validatedData = CreateArtifactSchema.parse(req.body);

      if (isAiAuthoredCreate(validatedData.metadata) && !(await areUserArtifactsEnabled(user))) {
        return res.status(403).json({ error: 'Artifacts are disabled for this user' });
      }

      // The refs below are written verbatim onto the new artifact, so a caller must be entitled to
      // any it supplies - otherwise it could claim another user's session/quest/artifact as its
      // source. Sessions are shareable and stamping a session is a write into its graph, so the bar
      // is update access (owner or update-shared), matching the collaborator-in-a-shared-session
      // flow; artifacts are not shareable, so parent stays owner-only.
      await assertArtifactSourceRefsAccessible(
        userId,
        {
          sessionId: validatedData.sessionId,
          sourceQuestId: validatedData.sourceQuestId,
          parentArtifactId: validatedData.parentArtifactId,
        },
        {
          // Include the global-write share arm: a global-write sharee may write into the session
          // graph (stamp an artifact with its id), matching the CASL update ability. Owner and
          // update/group-update shares still pass; read-only sharees and strangers still 403.
          canUpdateSession: async id =>
            !!(await sessionRepository.shareable.findUpdateAccessById(req.user!, id, { includeGlobalWrite: true })),
          getQuestSessionId: async id => (await questRepository.findById(id))?.sessionId ?? null,
          getArtifactOwner: async id => (await artifactRepository.findOne({ id }))?.userId ?? null,
        }
      );

      const result = await artifactService.create(userId, validatedData, {
        db: {
          artifacts: artifactRepository as any,
          artifactContents: artifactContentRepository as any,
          artifactVersions: artifactVersionRepository as any,
        },
      });

      return res.status(201).json(result);
    })
  );

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
