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

// Only sweep EPHEMERAL test users, which always carry a numeric timestamp segment
// (e.g. setup-admin-12345678-e2e@test.com - see e2e/core.setup.ts + apiCreateTestUser).
// Standing seeded QA accounts (qa-admin-e2e@test.com / qa-user-e2e@test.com from
// UserSeeder) deliberately omit the timestamp so this cleanup never deletes them -
// otherwise every Playwright/CI run would wipe the accounts QA logs in with.
const BASE_E2E_EMAIL_PATTERN = /-\d+-e2e@test\.com$/i;

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

    // Optional: scope cleanup to a specific test ID (for multi-tester isolation on shared preview builds)
    const { testId } = req.query as { testId?: string };
    const emailPattern = testId ? new RegExp(`${testId}-[0-9]+-e2e@test\\.com$`, 'i') : BASE_E2E_EMAIL_PATTERN;

    const users = await User.find({ email: { $regex: emailPattern } }, { _id: 1 }).lean();
    const userIds = users.map(u => u._id);
    const userIdStrings = userIds.map(id => id.toString());

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
