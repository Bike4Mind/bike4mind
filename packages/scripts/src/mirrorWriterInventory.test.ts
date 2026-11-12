import { describe, expect, it } from 'vitest';
import { directWritesInSource, inventoryDirectWrites, mirrorWriterFailures } from './mirrorWriterInventory';

describe('account mirror writer inventory', () => {
  it('finds raw and bulk writes without counting comments', () => {
    const writes = directWritesInSource(
      'sample.ts',
      `// collection.bulkWrite([])
      await collection.bulkWrite([]); await model.updateOne({}, {}); await doc.save();`
    );
    expect(writes.map(w => w.method)).toEqual(['bulkWrite', 'updateOne', 'save']);
    expect(mirrorWriterFailures(writes, true)).toContain('sample.ts:2 bulkWrite has no verified outbox mapping');
  });

  it('enumerates direct writes across app, worker and script trees and blocks mirror readiness', () => {
    const writes = inventoryDirectWrites();
    for (const dir of ['apps/client/', 'apps/workers/src/', 'packages/scripts/']) {
      expect(writes.some(w => w.file.startsWith(dir))).toBe(true);
    }
    expect(writes.some(w => w.method === 'bulkWrite')).toBe(true);
    expect(mirrorWriterFailures(writes, false)).toEqual([
      `${writes.length} direct write calls require owner/outbox coverage review`,
    ]);
    expect(mirrorWriterFailures(writes, true).length).toBe(writes.length);
  });
});
