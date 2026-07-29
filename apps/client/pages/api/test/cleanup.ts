import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@server/utils/config';
import { Resource } from 'sst';
import {
  User,
  Session,
  Quest,
  Favorite,
  Inbox,
  UserActivityCounter,
  Friendship,
  EmailPreferences,
  Voice,
  UserApiKey,
  ApiKey,
  Artifact,
  Tool,
  RegistrationInvite,
  FabFile,
  Agent,
  Project,
  Organization,
} from '@bike4mind/database';
import mongoose from 'mongoose';
import {
  BASE_E2E_EMAIL_PATTERN,
  buildE2EEmailPattern,
  resolveStaleSweepMinutes,
  sanitizeTestId,
} from '@server/utils/e2eCleanupScope';

const handler = baseApi({ auth: false }).delete(
  asyncHandler(async (req, res) => {
    // Guard 1: Only allow on local dev and preview deployments
    if (!isE2EEnabled()) {
      return res.status(403).json({ error: 'Cleanup endpoint is only available in development/preview' });
    }

    // Guard 2: Require shared secret - read from SST secret (local/staging) or env var (preview deploys)
    const secret = req.headers['x-e2e-cleanup-secret'];
    const expectedSecret = Resource.E2E_CLEANUP_SECRET?.value || process.env.E2E_CLEANUP_SECRET;
    if (!expectedSecret || expectedSecret === 'not-configured' || secret !== expectedSecret) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    // Scope cleanup to one run's users (multi-tester isolation, and in CI a per-run id so
    // concurrent suites never delete each other's live users - see .github/workflows/e2e-run.yml).
    // Unscoped is the local-dev fallback only: it matches EVERY ephemeral e2e user on the stage.
    const testId = sanitizeTestId(req.query.testId);
    const emailPattern = buildE2EEmailPattern(testId);

    const scoped = await User.find({ email: { $regex: emailPattern } }, { _id: 1 }).lean();
    const byId = new Map(scoped.map(u => [u._id.toString(), u._id] as const));

    // Aged sweep: reclaims users orphaned by runs that died before their own teardown
    // (cancelled job, runner timeout). Necessary because a per-run testId scope never matches
    // a previous run's leftovers, so nothing else would ever collect them - and it is also the
    // only thing that reaches specs whose emails carry no testId at all (mfa/admin/signup).
    // Age is createdAt, not the email's digits: those are a truncated clock, not a real time.
    // The window is floored server-side, so this only ever sees runs that are long finished,
    // and a doc with no createdAt is skipped rather than assumed old.
    let staleSwept = 0;
    if (req.query.staleMinutes !== undefined) {
      const cutoff = new Date(Date.now() - resolveStaleSweepMinutes(req.query.staleMinutes) * 60_000);
      const orphans = await User.find(
        { email: { $regex: BASE_E2E_EMAIL_PATTERN }, createdAt: { $lt: cutoff } },
        { _id: 1 }
      ).lean();
      for (const orphan of orphans) {
        const key = orphan._id.toString();
        if (byId.has(key)) continue;
        byId.set(key, orphan._id);
        staleSwept++;
      }
    }

    const userIds = [...byId.values()];
    const userIdStrings = [...byId.keys()];

    if (userIds.length === 0) {
      return res.json({ success: true, cleaned: { users: 0 }, message: 'No e2e test users found' });
    }

    const sessions = await Session.find({ userId: { $in: userIds } }, { _id: 1 }).lean();
    const sessionIds = sessions.map(s => s._id);

    // Helper to delete and track count per collection
    const counts: Record<string, number> = {};
    async function deleteFrom(label: string, promise: Promise<{ deletedCount: number }>) {
      const result = await promise;
      counts[label] = result.deletedCount;
    }

    // Hard-delete across collections using native driver to bypass soft-delete plugin
    await Promise.all([
      // Leaf collections (session-dependent)
      deleteFrom('quests', Quest.collection.deleteMany({ sessionId: { $in: sessionIds } })),

      // Leaf collections (user-dependent)
      deleteFrom('favorites', Favorite.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom(
        'inbox',
        Inbox.collection.deleteMany({ $or: [{ userId: { $in: userIds } }, { receiverId: { $in: userIds } }] })
      ),
      deleteFrom('activityCounters', UserActivityCounter.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom(
        'friendships',
        Friendship.collection.deleteMany({
          $or: [{ requester: { $in: userIds } }, { recipient: { $in: userIds } }],
        })
      ),
      deleteFrom('emailPreferences', EmailPreferences.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('voices', Voice.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('userApiKeys', UserApiKey.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('apiKeys', ApiKey.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('artifacts', Artifact.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('tools', Tool.collection.deleteMany({ userId: { $in: userIds } })),
      // RegistrationInvite stores userId/usedbyId as String, not ObjectId
      deleteFrom(
        'registrationInvites',
        RegistrationInvite.collection.deleteMany({
          $or: [
            { userId: { $in: userIdStrings } },
            { usedbyId: { $in: userIdStrings } },
            { 'usageHistory.userId': { $in: userIdStrings } },
          ],
        })
      ),

      // Optional collections (may not be registered if never used)
      ...(['Tag', 'Activity', 'ResearchData', 'ResearchTask', 'ResearchAgent'] as const).flatMap(name => {
        const model = mongoose.models[name];
        return model
          ? [
              deleteFrom(
                name.charAt(0).toLowerCase() + name.slice(1) + 's',
                model.collection.deleteMany({ userId: { $in: userIds } })
              ),
            ]
          : [];
      }),

      // Parent collections
      deleteFrom('files', FabFile.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('agents', Agent.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('projects', Project.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('organizations', Organization.collection.deleteMany({ userId: { $in: userIds } })),

      // Sessions, then users
      deleteFrom('sessions', Session.collection.deleteMany({ userId: { $in: userIds } })),
      deleteFrom('users', User.collection.deleteMany({ _id: { $in: userIds } })),
    ]);

    const totalDeleted = Object.values(counts).reduce((sum, n) => sum + n, 0);

    return res.json({
      success: true,
      cleaned: {
        users: userIds.length,
        staleSwept,
        sessions: sessionIds.length,
        files: counts.files || 0,
        agents: counts.agents || 0,
        projects: counts.projects || 0,
        organizations: counts.organizations || 0,
        quests: counts.quests || 0,
        artifacts: counts.artifacts || 0,
        registrationInvites: counts.registrationInvites || 0,
        totalDeleted,
        byCollection: counts,
      },
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
