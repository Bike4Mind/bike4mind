/**
 * @vitest-environment node
 *
 * Guard for the fab-file bucket's expire-notebook-exports rule: nothing in the app deletes a
 * notebook export (storeExportFile hands back a 1h signed URL and forgets the key), so the
 * lifecycle rule is the only reaper. If its prefix drifts from the key storeExportFile writes,
 * exports silently accumulate forever; if it drifts from the prefix createFabFile reserves, a
 * durable FabFile can be stored under it and deleted a day later.
 *
 * All sides are read as text for the same reasons as orgFeedbackSummaryLifecycle.test.ts:
 * infra/ files use SST globals at module scope, and each prefix is extracted from source rather
 * than re-declared here, which is what would let them drift silently.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), 'utf8');

const BUCKETS_SOURCE = read('infra/buckets.ts');
const EXPORT_SERVICE_SOURCE = read('b4m-core/services/src/notebookExportService/index.ts');
const CREATE_FAB_FILE_SOURCE = read('b4m-core/services/src/fabFileService/create.ts');

// Bounded to the fabFileBucketLifecycle resource, then to the one rule object inside it, so a
// matching id or field elsewhere in buckets.ts can't satisfy an assertion by luck.
const LIFECYCLE_BLOCK =
  BUCKETS_SOURCE.match(/new aws\.s3\.BucketLifecycleConfigurationV2\('fabFileBucketLifecycle',[\s\S]*?\n\}\);/)?.[0] ??
  '';
const RULE_BLOCK =
  LIFECYCLE_BLOCK.split(/(?=\bid:\s*')/).find(r => r.startsWith("id: 'expire-notebook-exports'")) ?? '';
const STORE_EXPORT_FILE_BODY =
  EXPORT_SERVICE_SOURCE.match(/private async storeExportFile\([^)]*\)[^{]*\{[\s\S]*?\n {2}\}/)?.[0] ?? '';

const rulePrefix = RULE_BLOCK.match(/prefix:\s*'([^']+)'/)?.[1];
const ruleDays = Number(RULE_BLOCK.match(/\bexpiration:\s*\{\s*days:\s*(\d+)/)?.[1]);

describe('fab-file bucket notebook export lifecycle', () => {
  it('attaches an enabled expire-notebook-exports rule with a prefix and a day count to fabFileBucket', () => {
    expect(LIFECYCLE_BLOCK).toMatch(/bucket:\s*fabFileBucket\.name,/);
    expect(RULE_BLOCK).toMatch(/status:\s*'Enabled'/);
    expect(rulePrefix).toBeDefined();
    expect(ruleDays).toBeGreaterThan(0);
  });

  it('keeps the lifecycle prefix in sync with the key storeExportFile actually writes', () => {
    const keyTemplate = STORE_EXPORT_FILE_BODY.match(/const path = `([^`]+)`/)?.[1];

    expect(keyTemplate).toBeDefined();
    // The key template's leading static segment - the "exports/" of `exports/${uuidv4()}/...`.
    expect(rulePrefix).toBe(keyTemplate?.split('${')[0]);
  });

  it('keeps the lifecycle prefix reserved from durable FabFile keys', () => {
    const reserved = CREATE_FAB_FILE_SOURCE.match(/export const RESERVED_FAB_FILE_KEY_PREFIX = '([^']+)'/)?.[1];

    expect(reserved).toBeDefined();
    expect(rulePrefix).toBe(reserved);
  });

  it('expires exports after 1 day, never before the signed URL handed out for them', () => {
    const signedUrlSeconds = Number(STORE_EXPORT_FILE_BODY.match(/getSignedUrl\(path,\s*(\d+)\)/)?.[1]);

    expect(ruleDays).toBe(1);
    expect(signedUrlSeconds).toBeGreaterThan(0);
    expect(ruleDays * 86400).toBeGreaterThan(signedUrlSeconds);
  });
});
