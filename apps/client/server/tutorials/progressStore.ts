import type { ITutorialModuleProgress, TutorialModels } from './models';
import type { TutorialDeps } from './service';

/** The progress store over one owner's progress model. */
export function progressStoreFor(Progress: TutorialModels['Progress']): TutorialDeps['progress'] {
  const rowOf = async (userId: string) =>
    (await Progress.findOne({ userId }).lean())?.modules as unknown as
      Record<string, ITutorialModuleProgress> | undefined;
  return {
    async read(userId, moduleId) {
      return (await rowOf(userId))?.[moduleId];
    },
    async all(userId) {
      return { ...((await rowOf(userId)) ?? {}) };
    },
    async begin(userId, moduleId, entry) {
      await Progress.updateOne({ userId }, { $set: { [`modules.${moduleId}`]: entry } }, { upsert: true });
    },
    async claimTurn(userId, moduleId, sessionId, from, to, at) {
      const key = `modules.${moduleId}`;
      const claimed = await Progress.findOneAndUpdate(
        { userId, [`${key}.sessionId`]: sessionId, [`${key}.turn`]: from },
        { $set: { [`${key}.turn`]: to, [`${key}.turnClaimedAt`]: at, [`${key}.updatedAt`]: at } }
      );
      return claimed !== null;
    },
    async reclaimTurn(userId, moduleId, sessionId, turn, expected, at) {
      const key = `modules.${moduleId}`;
      const leased = await Progress.findOneAndUpdate(
        { userId, [`${key}.sessionId`]: sessionId, [`${key}.turn`]: turn, [`${key}.turnClaimedAt`]: expected },
        { $set: { [`${key}.turnClaimedAt`]: at, [`${key}.updatedAt`]: at } }
      );
      return leased !== null;
    },
    async setPosition(userId, moduleId, stepId, status, at) {
      const key = `modules.${moduleId}`;
      const updated = await Progress.findOneAndUpdate(
        { userId, [key]: { $exists: true } },
        { $set: { [`${key}.stepId`]: stepId, [`${key}.status`]: status, [`${key}.updatedAt`]: at } }
      );
      return updated !== null;
    },
  };
}
