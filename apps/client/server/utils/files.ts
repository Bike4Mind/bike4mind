import archiver from 'archiver';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Logger } from '@bike4mind/observability';

/**
 * Sanitize a filename to prevent path traversal
 */
function sanitizeFilename(filename: string): string {
  // Remove any directory traversal attempts
  return path.basename(filename);
}

/**
 * Create a temporary file with the given content.
 *
 * @returns The path to the temporary file.
 */
export async function createTempFile(filename: string, content: string): Promise<string> {
  const safeFilename = sanitizeFilename(filename);
  const tempFileName = path.join(os.tmpdir(), safeFilename);

  const resolvedPath = path.resolve(tempFileName);
  if (!resolvedPath.startsWith(os.tmpdir())) {
    throw new Error('Invalid file path');
  }

  return new Promise((resolve, reject) => {
    fs.writeFile(tempFileName, content, err => {
      if (err) {
        reject(err);
        return;
      }
      resolve(tempFileName);
    });
  });
}

/**
 * Zip the given files into the given output zip file.
 */
export async function zipFiles(filePaths: string[], outputZip: string): Promise<void> {
  // Sanitize output filename while preserving the directory path
  const outputDir = path.dirname(outputZip);
  const safeOutputZip = path.join(outputDir, sanitizeFilename(path.basename(outputZip)));

  // Validate the resolved path stays within the temp directory. This mirrors
  // createTempFile and guards against a future caller passing a user-influenced
  // path (e.g. '/tmp/../etc/foo.zip') that path.join would collapse out of /tmp.
  const resolvedPath = path.resolve(safeOutputZip);
  if (!resolvedPath.startsWith(os.tmpdir())) {
    throw new Error('Invalid output path');
  }

  const output = fs.createWriteStream(safeOutputZip);
  const archive = archiver('zip', {
    zlib: { level: 9 },
  });

  return new Promise((resolve, reject) => {
    output.on('close', () => {
      Logger.log(`Zipped successfully to ${safeOutputZip}. Total bytes: ${archive.pointer()}`);
      resolve();
    });

    archive.on('error', err => {
      reject(err);
    });

    archive.pipe(output);

    filePaths.forEach(filePath => {
      const safeFilePath = sanitizeFilename(filePath);
      archive.file(filePath, { name: safeFilePath });
    });

    archive.finalize();
  });
}
