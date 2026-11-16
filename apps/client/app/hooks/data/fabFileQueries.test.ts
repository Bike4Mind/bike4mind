import { describe, expect, it } from 'vitest';
import type { IFabFileDocument } from '@bike4mind/common';
import { fabFilePollInterval } from './fabFileQueries';

const file = (fields: Partial<IFabFileDocument>) => ({ id: 'f1', ...fields }) as IFabFileDocument;

describe('fabFilePollInterval', () => {
  it('polls fast while the moderation scan is in flight', () => {
    expect(fabFilePollInterval(file({ moderationStatus: 'pending' }), { pollWhileScanning: true })).toBe(1000);
    expect(fabFilePollInterval(file({ moderationStatus: 'scanning' }), { pollWhileScanning: true })).toBe(1000);
  });

  it('stops once the scan settles, either way', () => {
    expect(fabFilePollInterval(file({ moderationStatus: 'clean' }), { pollWhileScanning: true })).toBe(false);
    expect(fabFilePollInterval(file({ moderationStatus: 'blocked' }), { pollWhileScanning: true })).toBe(false);
  });

  it('does not poll a scanning file unless asked to', () => {
    expect(fabFilePollInterval(file({ moderationStatus: 'scanning' }), {})).toBe(false);
  });

  it('keeps the processing poll for a file whose pipeline is still running', () => {
    expect(fabFilePollInterval(file({ moderationStatus: 'clean' }), { pollWhileProcessing: true })).toBe(4000);
    expect(fabFilePollInterval(file({ chunkEmbeddingModelStampedAt: new Date() }), { pollWhileProcessing: true })).toBe(
      false
    );
  });

  it('waits for a first read before polling', () => {
    expect(fabFilePollInterval(undefined, { pollWhileScanning: true, pollWhileProcessing: true })).toBe(false);
  });
});
