import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * Guards the #1535 fix (PR #1540 human review): every PutObject-capable S3Client must go
 * through createS3Client() so requestChecksumCalculation stays WHEN_REQUIRED. A raw
 * `new S3Client(` outside the helper silently reintroduces XAmzContentSHA256Mismatch on
 * whichever new site adds it. GET/HEAD/Delete-only clients (never PutObject) and the
 * manually-run dev scripts under packages/scripts are exempt - keep this list in sync with
 * the audit on PR #1540.
 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const ALLOWLIST = new Set([
  'b4m-core/fab-pipeline/src/storage/createS3Client.ts',
  'apps/client/server/tools/modalImageHandler.ts',
  'apps/client/server/security/cloudScan.ts',
  'apps/client/server/emailIngestion/emailParser.ts',
  'apps/client/pages/api/files/presigned-url.ts',
  'apps/client/pages/api/app-files/serve/[...key].ts',
  'apps/client/pages/api/ai/transcribe/index.ts',
  'apps/client/pages/api/ai/transcribe/init.ts',
  'apps/client/pages/api/slack/export/status/[jobId].ts',
  'b4m-core/services/src/speech/speechToTexService.ts',
  'packages/scripts/testEmailIngestLambda.ts',
  'packages/scripts/datalake/ingest-pdf-datalake.ts',
  'packages/scripts/src/uploadTavernIcons.ts',
]);

// This file's own path relative to REPO_ROOT, so it excludes itself by exact match rather
// than by basename (grep's --exclude matches any file with this name, anywhere in the tree).
const SELF_PATH = path.relative(REPO_ROOT, fileURLToPath(import.meta.url)).replace(/\\/g, '/'); // normalize on Windows

describe('every S3Client construction routes through createS3Client', () => {
  it('has no raw `new S3Client(` outside the allowlist', () => {
    const out = execSync('grep -rln "new S3Client(" --include="*.ts" apps/client b4m-core packages || true', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    const hits = out.split('\n').filter(Boolean);
    const unexpected = hits.filter(f => f !== SELF_PATH && !ALLOWLIST.has(f));

    expect(
      unexpected,
      'Construct via createS3Client() from @bike4mind/fab-pipeline instead, or add the file to ALLOWLIST with a reason if it never does PutObject.'
    ).toEqual([]);
  });
});
