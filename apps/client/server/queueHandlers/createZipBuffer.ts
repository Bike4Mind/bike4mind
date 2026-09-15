import archiver from 'archiver';

export async function createZipBuffer(
  markdown: string,
  images: Array<{ filename: string; buffer: Buffer }>,
  markdownFilename: string,
  summary?: string | null
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 6 } });

    archive.on('data', (chunk: Buffer) => chunks.push(chunk));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    archive.on('error', reject);

    // Add executive summary if available (first for visibility)
    if (summary) {
      archive.append(summary, { name: 'executive-summary.md' });
    }

    // Add full markdown file
    archive.append(markdown, { name: markdownFilename });

    // Add images
    for (const { filename, buffer } of images) {
      archive.append(buffer, { name: filename });
    }

    archive.finalize();
  });
}
