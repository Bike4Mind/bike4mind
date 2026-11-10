import { mongoose } from '@bike4mind/database';
import { type MigrationFile } from './index';

/**
 * Migration: rewrite Modal.imageUrl from a presigned S3 URL to the bare `modal-images/<file>` key.
 * Modal image URLs are now signed when modals are served, so a stored presigned URL is redundant.
 * Only URLs whose path is a `modal-images/` object are rewritten; external URLs are untouched.
 * Idempotent: bare keys no longer match the filter.
 */

const BATCH_SIZE = 1000;

const PRESIGNED_MODAL_IMAGE = /^https?:\/\/[^?#]*\/(modal-images\/[^/?#]+)\?.*X-Amz-Algorithm=/;

export function toModalImageKey(imageUrl: string): string | null {
  const match = PRESIGNED_MODAL_IMAGE.exec(imageUrl);
  return match ? decodeURIComponent(match[1]) : null;
}

const migration: MigrationFile = {
  id: 20260921000002,
  name: 'modal-image-url-to-key',

  up: async () => {
    const db = mongoose.connection.db;
    if (!db) throw new Error('Database connection not established');

    const modals = db.collection('modals');
    const filter = { imageUrl: { $regex: '/modal-images/[^?]*\\?.*X-Amz-Algorithm=' } };

    let lastId: mongoose.Types.ObjectId | undefined;
    let rewritten = 0;

    while (true) {
      const batch = await modals
        .find(lastId ? { ...filter, _id: { $gt: lastId } } : filter, { projection: { _id: 1, imageUrl: 1 } })
        .sort({ _id: 1 })
        .limit(BATCH_SIZE)
        .toArray();

      if (batch.length === 0) break;
      lastId = batch[batch.length - 1]._id;

      for (const doc of batch) {
        const key = typeof doc.imageUrl === 'string' ? toModalImageKey(doc.imageUrl) : null;
        if (!key) continue;
        const result = await modals.updateOne({ _id: doc._id }, { $set: { imageUrl: key } });
        rewritten += result.modifiedCount;
      }

      if (batch.length < BATCH_SIZE) break;
    }

    console.log(`Rewrote ${rewritten} modal imageUrl value(s) to bare keys`);
  },

  down: async () => {
    // Not reversible: the original presigned URLs were short-lived credentials.
  },
};

export default migration;
