import { FabFile } from '@bike4mind/database';
import { KEY_CHUNK, findOwnedKeys } from './purgeDeletedNotebookMedia';

/**
 * The subset of `keys` a notebook import may write into `userId`'s messages as media: keys whose
 * earliest referencing message is in one of the user's own notebooks (findOwnedKeys), or that name
 * one of the user's own uploaded files. A key nothing ties to the user is never written, since a
 * message's media list is what export, signed-URL and account-erasure paths trust.
 */
export async function findImportableMediaKeys(keys: string[], userId: string): Promise<Set<string>> {
  const importable = new Set<string>();
  const unique = [...new Set(keys.filter(key => typeof key === 'string' && key.length > 0))];
  if (!userId || unique.length === 0) return importable;
  const owners = new Set([userId]);
  for (let i = 0; i < unique.length; i += KEY_CHUNK) {
    const chunk = unique.slice(i, i + KEY_CHUNK);
    for (const key of await findOwnedKeys(chunk, owners)) importable.add(key);
    const rest = chunk.filter(key => !importable.has(key));
    if (rest.length === 0) continue;
    const files = await FabFile.find({ filePath: { $in: rest }, userId }, { filePath: 1 }).lean();
    for (const file of files) if (typeof file.filePath === 'string') importable.add(file.filePath);
  }
  return importable;
}
