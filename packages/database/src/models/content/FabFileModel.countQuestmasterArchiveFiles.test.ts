import { describe, it, expect } from 'vitest';
import { FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import { FabFile, fabFileRepository } from './FabFileModel';
import { setupMongoTest } from '../../__test__/utils';

const makeFile = (overrides: { userId?: string; sourceType?: FabFileSourceType; deleted?: boolean } = {}) =>
  FabFile.create({
    userId: overrides.userId ?? 'user-1',
    fileName: 'plan.md',
    type: KnowledgeType.FILE,
    sourceType: overrides.sourceType ?? FabFileSourceType.QUESTMASTER_ARCHIVE,
    ...(overrides.deleted ? { deletedAt: new Date() } : {}),
  });

describe('FabFileRepository.countQuestmasterArchiveFiles', () => {
  setupMongoTest();

  it("counts only the user's live archive files", async () => {
    await makeFile();
    await makeFile();
    await makeFile({ deleted: true });
    await makeFile({ userId: 'user-2' });
    await makeFile({ sourceType: FabFileSourceType.TOOL_GENERATED });

    expect(await fabFileRepository.countQuestmasterArchiveFiles('user-1')).toBe(2);
    expect(await fabFileRepository.countQuestmasterArchiveFiles('user-3')).toBe(0);
  });
});
