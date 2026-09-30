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
  DataLakeModel,
  DataLakeAccessGrantModel,
} from '@bike4mind/database';
import mongoose from 'mongoose';
import {
  BASE_E2E_EMAIL_PATTERN,
  BASE_E2E_USERNAME_PATTERN,
  buildE2EEmailPattern,
  buildE2EUsernamePattern,
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
    // Cast because baseApi types req.query as unknown; both values are re-validated below
    // (sanitizeTestId / resolveStaleSweepMinutes tolerate arrays and non-strings).
    const { testId: rawTestId, staleMinutes } = req.query as { testId?: string; staleMinutes?: string };
    const testId = sanitizeTestId(rawTestId);
    // Emailless test users (create-user.ts with no `email`) carry the marker on the
    // username, so both fields are swept or they would leak past every cleanup.
    const emailPattern = buildE2EEmailPattern(testId);
    const usernamePattern = buildE2EUsernamePattern(testId);

    const scoped = await User.find(
      { $or: [{ email: { $regex: emailPattern } }, { username: { $regex: usernamePattern } }] },
      { _id: 1 }
    ).lean();
    const byId = new Map(scoped.map(u => [u._id.toString(), u._id] as const));

    // Aged sweep: reclaims users orphaned by runs that died before their own teardown
    // (cancelled job, runner timeout). Necessary because a per-run testId scope never matches
    // a previous run's leftovers, so nothing else would ever collect them - and it is also the
    // only thing that reaches specs whose emails carry no testId at all (mfa/admin/signup).
    // Age is createdAt, not the email's digits: those are a truncated clock, not a real time.
    // The window is floored server-side, so this only ever sees runs that are long finished,
    // and a doc with no createdAt is skipped rather than assumed old.
    let staleSwept = 0;
    if (staleMinutes !== undefined) {
      const cutoff = new Date(Date.now() - resolveStaleSweepMinutes(staleMinutes) * 60_000);
      const orphans = await User.find(
        {
          $or: [{ email: { $regex: BASE_E2E_EMAIL_PATTERN } }, { username: { $regex: BASE_E2E_USERNAME_PATTERN } }],
          createdAt: { $lt: cutoff },
        },
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
    const sessionIdStrings = sessions.map(s => s._id.toString());

    // Lakes the swept users own. `createdByUserId` (and `dataLakeId` on the grants) is a String
    // field, like nearly every other user reference; the grants are reclaimed alongside the lakes
    const ownedLakes = await DataLakeModel.collection
      .find({ createdByUserId: { $in: userIdStrings } }, { projection: { _id: 1 } })
      .toArray();
    const lakeIdStrings = ownedLakes.map(l => l._id.toString());

    // Helper to delete and track count per collection
    const counts: Record<string, number> = {};
    async function deleteFrom(label: string, promise: Promise<{ deletedCount: number }>) {
      const result = await promise;
      counts[label] = result.deletedCount;
    }

    // Hard-delete across collections using the native driver to bypass the soft-delete plugin.
    // The native driver does NOT cast, so each filter must carry the value type the field stores:
    // every user reference below is a String EXCEPT Tool.userId (ObjectId) and User._id, which are
    // the only two that take `userIds`. Passing an ObjectId to a String field matches nothing, which
    // silently orphans the row while still deleting the user - the bug this list exists to avoid.
    await Promise.all([
      // Leaf collections (session-dependent)
      deleteFrom('quests', Quest.collection.deleteMany({ sessionId: { $in: sessionIdStrings } })),

      // Leaf collections (user-dependent)
      deleteFrom('favorites', Favorite.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom(
        'inbox',
        Inbox.collection.deleteMany({
          $or: [{ userId: { $in: userIdStrings } }, { receiverId: { $in: userIdStrings } }],
        })
      ),
      deleteFrom('activityCounters', UserActivityCounter.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom(
        'friendships',
        Friendship.collection.deleteMany({
          $or: [{ requester: { $in: userIdStrings } }, { recipient: { $in: userIdStrings } }],
        })
      ),
      deleteFrom('emailPreferences', EmailPreferences.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('voices', Voice.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('userApiKeys', UserApiKey.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('apiKeys', ApiKey.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('artifacts', Artifact.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('tools', Tool.collection.deleteMany({ userId: { $in: userIds } })),
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
                model.collection.deleteMany({ userId: { $in: userIdStrings } })
              ),
            ]
          : [];
      }),

      // Parent collections
      deleteFrom('files', FabFile.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('agents', Agent.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('projects', Project.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('organizations', Organization.collection.deleteMany({ userId: { $in: userIdStrings } })),

      // Data lakes: grants held on the swept users' lakes plus grants where a swept user is the
      // principal, then the lakes themselves.
      deleteFrom(
        'dataLakeAccessGrants',
        DataLakeAccessGrantModel.collection.deleteMany({
          $or: [{ dataLakeId: { $in: lakeIdStrings } }, { principalType: 'user', principalId: { $in: userIdStrings } }],
        })
      ),
      deleteFrom('dataLakes', DataLakeModel.collection.deleteMany({ createdByUserId: { $in: userIdStrings } })),

      // Sessions, then users
      deleteFrom('sessions', Session.collection.deleteMany({ userId: { $in: userIdStrings } })),
      deleteFrom('users', User.collection.deleteMany({ _id: { $in: userIds } })),
    ]);

    const totalDeleted = Object.values(counts).reduce((sum, n) => sum + n, 0);

    // A swept user with zero child rows is either genuinely childless or the signature of a value
    // type mismatch that deletes the user and orphans everything else. Warn so it cannot pass
    // silently, but keep `success: true` - a brand-new account with no children is legitimate.
    const childDeleted = Object.entries(counts)
      .filter(([label]) => label !== 'users')
      .reduce((sum, [, n]) => sum + n, 0);
    const warning =
      childDeleted === 0
        ? 'Swept users but deleted no child rows - check cleanup filters against the schema field types'
        : undefined;
    if (warning) console.warn(`[e2e cleanup] ${warning}`);

    return res.json({
      success: true,
      ...(warning ? { warning } : {}),
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
        dataLakes: counts.dataLakes || 0,
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
