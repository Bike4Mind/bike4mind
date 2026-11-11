import { hkdfSync } from 'crypto';
import { mintFileContentSig } from '@bike4mind/utils';
import { Config } from '@bike4mind/server-utils/utils/config';
import { getFilesStorage } from '@bike4mind/server-utils/utils/storage/index';

// A purpose-derived key, so a file content sig and a JWT_SECRET-signed token can never stand in for each other.
let contentKey: Buffer | undefined;
export const fileContentKey = (): Buffer =>
  (contentKey ??= Buffer.from(hkdfSync('sha256', Config.JWT_SECRET, '', 'b4m-file-content/v1', 32)));

const appOrigin = (): string => {
  try {
    return process.env.APP_URL ? new URL(process.env.APP_URL).origin : '';
  } catch {
    return '';
  }
};

/**
 * The stable browser URL for a file: pages/api/files/[id]/content.ts redirects it to a fresh S3 link.
 * Relative only when APP_URL is unset or malformed, which still resolves in the browser.
 */
export const fileContentUrl = ({ id, filePath }: { id: string; filePath: string }, exp: number): string => {
  const sig = mintFileContentSig({ fileId: id, filePath, exp }, fileContentKey());
  return `${appOrigin()}/api/files/${encodeURIComponent(id)}/content?exp=${exp}&sig=${sig}`;
};

/** Storage adapter for fabFileService reads whose response goes to the browser (see generateSignedUrl). */
export const browserFileStorage = () => ({
  generateSignedUrl: (path: string, expiresIn: number, options?: { signingDate?: Date }) =>
    getFilesStorage().getSignedUrl(path, 'get', { expiresIn, audience: 'browser', signingDate: options?.signingDate }),
  contentUrl: fileContentUrl,
});
