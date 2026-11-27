import { describe, expect, it } from 'vitest';
import { BadRequestError, KnowledgeType, MAX_LAKE_FILE_TAG_NAME_LENGTH } from '@bike4mind/common';
import { setupMongoTest } from '../../__test__/utils';
import { FabFile, fabFileRepository } from './FabFileModel';

setupMongoTest();

describe.each(['updateTagsByUserId', 'claimTagRewriteByUserId'] as const)('%s tag name cap', writer => {
  const userId = 'tag-rename-length-user';
  const seed = (name = 'old') =>
    FabFile.create({
      userId,
      fileName: 'rename.txt',
      type: KnowledgeType.FILE,
      mimeType: 'text/plain',
      tags: [{ name, strength: 1 }],
      primaryTag: name,
    });

  it.each([MAX_LAKE_FILE_TAG_NAME_LENGTH + 1, 10_000])(
    'rejects a %i-character destination without changing stored tags or primaryTag',
    async length => {
      const file = await seed();

      await expect(fabFileRepository[writer](userId, 'old', 'x'.repeat(length))).rejects.toBeInstanceOf(
        BadRequestError
      );

      const stored = await FabFile.findById(file._id);
      expect(stored?.tags).toEqual([{ name: 'old', strength: 1 }]);
      expect(stored?.primaryTag).toBe('old');
    }
  );

  it('accepts a destination exactly at the shared cap', async () => {
    const file = await seed();
    const name = 'x'.repeat(MAX_LAKE_FILE_TAG_NAME_LENGTH);

    await fabFileRepository[writer](userId, 'old', name);

    expect((await FabFile.findById(file._id))?.tags).toEqual([{ name, strength: 1 }]);
  });

  it('allows repairing a legacy overlong source name', async () => {
    const oldName = 'x'.repeat(MAX_LAKE_FILE_TAG_NAME_LENGTH + 1);
    const file = await seed(oldName);

    await fabFileRepository[writer](userId, oldName, 'repaired');

    expect((await FabFile.findById(file._id))?.tags).toEqual([{ name: 'repaired', strength: 1 }]);
  });
});
