import { z } from 'zod';

const IndexObjectPathSchema = z
  .string()
  .regex(/^revisions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/index\.html$/);

export type PublishedContentSnapshot = {
  sha256Index?: string | null;
  indexObjectPath?: string | null;
};

/** Maps the logical current index to its immutable payload, retaining legacy canonical objects. */
export function currentPublishedIndexKey(page: { storageKeyPrefix: string; indexObjectPath?: string | null }): string {
  const path = page.indexObjectPath == null ? 'index.html' : IndexObjectPathSchema.parse(page.indexObjectPath);
  return `${page.storageKeyPrefix}${path}`;
}

/** Mongo null equality also matches legacy records that predate these optional fields. */
export function publishedContentSnapshotFilter(page: PublishedContentSnapshot) {
  return { sha256Index: page.sha256Index ?? null, indexObjectPath: page.indexObjectPath ?? null };
}

/** Retire only a replaced revision after its bytes were archived and the metadata switch is confirmed. */
export async function deleteRetiredPublishedIndex(
  page: { storageKeyPrefix: string; indexObjectPath?: string | null },
  storage: { delete: (key: string) => Promise<unknown> },
  onError: (error: unknown) => void
): Promise<void> {
  if (!page.indexObjectPath) return;
  try {
    await storage.delete(currentPublishedIndexKey(page));
  } catch (error) {
    onError(error);
  }
}

/** A reader that already observed a retired revision can still load its archived, identical bytes. */
export async function downloadPublishedIndex(
  page: PublishedContentSnapshot & { storageKeyPrefix: string },
  storage: { download: (key: string) => Promise<Buffer> }
): Promise<Buffer> {
  const currentKey = currentPublishedIndexKey(page);
  try {
    return await storage.download(currentKey);
  } catch (error) {
    if (
      !page.indexObjectPath ||
      !z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .safeParse(page.sha256Index).success
    )
      throw error;
    try {
      return await storage.download(`${page.storageKeyPrefix}versions/${page.sha256Index}.html`);
    } catch {
      throw error;
    }
  }
}
