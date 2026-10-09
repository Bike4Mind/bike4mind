import { describe, it, expect } from 'vitest';
import { createZipBuffer } from './createZipBuffer';
import yauzl from 'yauzl';

/**
 * Helper: extract entry names and contents from a ZIP buffer using yauzl.
 * Returns a map of { filename -> Buffer }.
 */
async function extractZipEntries(zipBuffer: Buffer): Promise<Map<string, Buffer>> {
  const entries = new Map<string, Buffer>();

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(zipBuffer, { lazyEntries: true }, (err, zf) => {
      if (err || !zf) return reject(err ?? new Error('No zipfile'));
      resolve(zf);
    });
  });

  return new Promise((resolve, reject) => {
    zipfile.on('error', reject);
    zipfile.on('end', () => resolve(entries));
    zipfile.readEntry();

    zipfile.on('entry', (entry: yauzl.Entry) => {
      zipfile.openReadStream(entry, (err, stream) => {
        if (err || !stream) return reject(err ?? new Error('No stream'));
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('end', () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zipfile.readEntry();
        });
        stream.on('error', reject);
      });
    });
  });
}

describe('createZipBuffer', () => {
  it('creates a ZIP with only the markdown file when no summary or images', async () => {
    const markdown = '# Quest Report\n\nSome content here.';
    const result = await createZipBuffer(markdown, [], 'report.md');

    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);

    const entries = await extractZipEntries(result);
    expect(entries.size).toBe(1);
    expect(entries.has('report.md')).toBe(true);
    expect(entries.get('report.md')!.toString()).toBe(markdown);
  });

  it('includes executive-summary.md when summary is provided', async () => {
    const markdown = '# Full Report';
    const summary = '# Executive Summary\n\nKey findings...';

    const result = await createZipBuffer(markdown, [], 'report.md', summary);
    const entries = await extractZipEntries(result);

    expect(entries.size).toBe(2);
    expect(entries.has('executive-summary.md')).toBe(true);
    expect(entries.has('report.md')).toBe(true);
    expect(entries.get('executive-summary.md')!.toString()).toBe(summary);
  });

  it('skips executive summary when summary is null', async () => {
    const result = await createZipBuffer('content', [], 'report.md', null);
    const entries = await extractZipEntries(result);

    expect(entries.size).toBe(1);
    expect(entries.has('executive-summary.md')).toBe(false);
  });

  it('skips executive summary when summary is empty string', async () => {
    const result = await createZipBuffer('content', [], 'report.md', '');
    const entries = await extractZipEntries(result);

    expect(entries.size).toBe(1);
    expect(entries.has('executive-summary.md')).toBe(false);
  });

  it('includes image buffers with correct filenames', async () => {
    const markdown = '# Report with images';
    const imageData = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG magic bytes
    const images = [
      { filename: 'images/chart.png', buffer: imageData },
      { filename: 'images/diagram.png', buffer: Buffer.from('fake-image-data') },
    ];

    const result = await createZipBuffer(markdown, images, 'report.md');
    const entries = await extractZipEntries(result);

    expect(entries.size).toBe(3);
    expect(entries.has('report.md')).toBe(true);
    expect(entries.has('images/chart.png')).toBe(true);
    expect(entries.has('images/diagram.png')).toBe(true);
    expect(Buffer.compare(entries.get('images/chart.png')!, imageData)).toBe(0);
  });

  it('includes all parts: summary + markdown + images', async () => {
    const summary = 'Executive summary content';
    const markdown = '# Full report\n\nWith details.';
    const images = [{ filename: 'photo.jpg', buffer: Buffer.from('jpg-data') }];

    const result = await createZipBuffer(markdown, images, 'quest-export.md', summary);
    const entries = await extractZipEntries(result);

    expect(entries.size).toBe(3);
    expect(entries.has('executive-summary.md')).toBe(true);
    expect(entries.has('quest-export.md')).toBe(true);
    expect(entries.has('photo.jpg')).toBe(true);
  });

  it('handles string content correctly (archiver v7 compatibility)', async () => {
    // This test explicitly validates that archiver v7 handles string input
    // via normalizeInputSource converting strings to Buffer.from()
    const unicodeContent = 'Report with unicode: café, naïve, 日本語';
    const result = await createZipBuffer(unicodeContent, [], 'unicode.md');
    const entries = await extractZipEntries(result);

    expect(entries.get('unicode.md')!.toString('utf-8')).toBe(unicodeContent);
  });

  it('preserves custom markdown filename', async () => {
    const result = await createZipBuffer('content', [], 'my-custom-export-2024.md');
    const entries = await extractZipEntries(result);

    expect(entries.has('my-custom-export-2024.md')).toBe(true);
  });
});
