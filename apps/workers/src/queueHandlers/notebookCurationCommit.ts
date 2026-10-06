import { NotebookCurationJob, withTransaction } from '@bike4mind/database';
import type { CurationResult } from '@bike4mind/common';

export function createNotebookCommit(
  identity: { curationJobId: string; sessionId: string; userId: string },
  removeObject: (path: string) => Promise<unknown>,
  warn: (message: string) => void
) {
  return async (write: () => Promise<CurationResult>, stagedFilePath?: string): Promise<CurationResult> => {
    const readReceipt = () => NotebookCurationJob.findOne({ curationJobId: identity.curationJobId }).lean();
    const validate = (receipt: { sessionId: string; userId?: string }) => {
      if (receipt.sessionId !== identity.sessionId || receipt.userId !== identity.userId) {
        throw new Error('Curation receipt identity mismatch');
      }
    };
    const discard = async (winnerPath?: string) => {
      if (!stagedFilePath || stagedFilePath === winnerPath) return;
      try {
        await removeObject(stagedFilePath);
      } catch {
        warn('Could not remove uncommitted curation object');
      }
    };
    try {
      const receipt = await withTransaction(async () => {
        const existing = await readReceipt();
        if (existing) {
          validate(existing);
          if (!existing.result) throw new Error('Curation receipt has no persisted result');
          return existing;
        }
        const result = await write();
        await NotebookCurationJob.create([{ ...identity, status: 'completed', result, filePath: stagedFilePath }]);
        return { ...identity, result, filePath: stagedFilePath };
      });
      await discard(receipt.filePath);
      return receipt.result!;
    } catch (error) {
      // A commit acknowledgement may be lost. Never remove an object owned by a committed receipt.
      const winner = await readReceipt();
      if (winner) {
        validate(winner);
        if (winner.result) {
          await discard(winner.filePath);
          return winner.result;
        }
      }
      throw error;
    }
  };
}
