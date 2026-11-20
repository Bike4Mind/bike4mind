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
import { ACCOUNT_DATA_EXPORT_TTL_MS } from '../../packages/server-utils/src/utils/accountDataExport';
import {
  NOTEBOOK_DOWNLOAD_URL_TTL_SECONDS,
  notebookConvertedDownloadKey,
  notebookZipDownloadKey,
} from '../../packages/server-utils/src/notebooks/downloadCopyKeys';

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

  it('keeps account data exports under the lifecycle prefix, since nothing else deletes them', () => {
    const keyTemplate = read('packages/server-utils/src/utils/accountDataExport.ts').match(
      /export const accountDataExportKey = [^`]*`([^`]+)`/
    )?.[1];

    expect(keyTemplate).toBeDefined();
    expect(rulePrefix).toBeDefined();
    expect(keyTemplate?.startsWith(rulePrefix!)).toBe(true);
  });

  it('keeps the lifecycle prefix reserved from durable FabFile keys', () => {
    const reserved = CREATE_FAB_FILE_SOURCE.match(/export const RESERVED_FAB_FILE_KEY_PREFIX = '([^']+)'/)?.[1];

    expect(reserved).toBeDefined();
    expect(rulePrefix).toBe(reserved);
  });

  it('keeps organization metadata exports under the expiring prefix', () => {
    const source = read('packages/server-utils/src/utils/organizationDataExport.ts');
    const prefixTemplate = source.match(/export const organizationExportPrefix = [^`]*`([^`]+)`/)?.[1];
    const keyTemplate = source.match(/export const organizationExportKey = [^`]*`([^`]+)`/)?.[1];
    const legacyTemplate = source.match(/export const legacyOrganizationExportKey = [^`]*`([^`]+)`/)?.[1];
    expect(rulePrefix).toBeDefined();
    expect(prefixTemplate?.startsWith(rulePrefix!)).toBe(true);
    expect(keyTemplate?.startsWith('${organizationExportPrefix(userId)}')).toBe(true);
    expect(legacyTemplate?.startsWith(rulePrefix!)).toBe(true);
    expect(source).toContain('ORGANIZATION_EXPORT_TTL_MS = 24 * 60 * 60 * 1000');
  });

  it('keeps the generated-audio offload rule on the shared prefix, reserved and present in compose', () => {
    const offloadRule =
      LIFECYCLE_BLOCK.split(/(?=\bid:\s*')/).find(r => r.startsWith("id: 'expire-generated-audio-offload'")) ?? '';
    const offloadRulePrefix = offloadRule.match(/prefix:\s*'([^']+)'/)?.[1];
    const literal = read('b4m-core/common/src/generatedAudio.ts').match(
      /GENERATED_AUDIO_OFFLOAD_PREFIX = '([^']+)'/
    )?.[1];

    expect(literal).toBeDefined();
    expect(offloadRulePrefix).toBe(literal);
    expect(read('compose.selfhost.yaml')).toContain(`--prefix "${literal}"`);
    expect(CREATE_FAB_FILE_SOURCE).toMatch(
      /RESERVED_FAB_FILE_KEY_PREFIXES = \[[^\]]*GENERATED_AUDIO_OFFLOAD_PREFIX[^\]]*\]/
    );
  });

  it('expires noncurrent versions bucket-wide, so deletes free bytes on a versioned stage', () => {
    const rule =
      LIFECYCLE_BLOCK.split(/(?=\bid:\s*')/).find(r => r.startsWith("id: 'expire-noncurrent-versions'")) ?? '';

    expect(rule).toMatch(/status:\s*'Enabled'/);
    // An empty filter is what makes it bucket-wide; a prefix here would leave files/ uncovered.
    expect(rule).toMatch(/filter:\s*\{\s*\}/);
    expect(Number(rule.match(/noncurrentDays:\s*(\d+)/)?.[1])).toBe(30);
    expect(rule).toMatch(/expiredObjectDeleteMarker:\s*true/);
  });

  it('expires exports after 1 day, never before the signed URL handed out for them', () => {
    const signedUrlSeconds = Number(STORE_EXPORT_FILE_BODY.match(/getSignedUrl\(path,\s*(\d+)\)/)?.[1]);

    expect(ruleDays).toBe(1);
    expect(signedUrlSeconds).toBeGreaterThan(0);
    expect(ruleDays * 86400).toBeGreaterThan(signedUrlSeconds);
  });

  it('keeps the account data export TTL within what the 1 day rule can guarantee', () => {
    expect(ruleDays).toBe(1);
    // S3 rounds expiry up to the next UTC midnight, so an object can outlive the rule by a day.
    expect(ACCOUNT_DATA_EXPORT_TTL_MS).toBeLessThanOrEqual(2 * 86400000);
  });

  // The download route's zip and converted copies are never deleted by the app either.
  it('keeps notebook download copies under the expiring exports prefix, signed for less than the rule', () => {
    const keys = [notebookZipDownloadKey('u1', 'id'), notebookConvertedDownloadKey('u1', 's1', 'id', '.html')];

    expect(rulePrefix).toBeDefined();
    for (const key of keys) expect(key.startsWith(rulePrefix ?? '<missing>')).toBe(true);
    expect(NOTEBOOK_DOWNLOAD_URL_TTL_SECONDS).toBeGreaterThan(0);
    expect(NOTEBOOK_DOWNLOAD_URL_TTL_SECONDS).toBeLessThan(ruleDays * 86400);
  });

  // Audit exports hold actor emails and IPs, so they must land somewhere this rule reaps.
  it('keeps the admin audit export prefix under the expiring exports prefix', () => {
    const auditExportSource = read('apps/client/server/utils/adminAuditExportStorage.ts');
    const auditPrefix = auditExportSource.match(/ADMIN_AUDIT_EXPORT_PREFIX = '([^']+)'/)?.[1];

    expect(rulePrefix).toBeDefined();
    expect(auditPrefix?.startsWith(rulePrefix ?? '<missing>')).toBe(true);
  });

  it('reaps shared email files on the prefix they are written under, after their links expire', () => {
    const rule =
      LIFECYCLE_BLOCK.split(/(?=\bid:\s*')/).find(r => r.startsWith("id: 'expire-shared-email-files'")) ?? '';
    const source = read('apps/client/server/utils/mailer/emailAttachments.ts');
    const prefix = source.match(/export const SHARED_EMAIL_FILES_PREFIX = '([^']+)'/)?.[1];
    const linkDays = Number(source.match(/export const SHARED_EMAIL_FILE_LINK_TTL_DAYS = (\d+);/)?.[1]);
    const days = Number(rule.match(/\bexpiration:\s*\{\s*days:\s*(\d+)/)?.[1]);

    expect(rule).toMatch(/status:\s*'Enabled'/);
    expect(prefix).toBeDefined();
    expect(rule.match(/prefix:\s*'([^']+)'/)?.[1]).toBe(prefix);
    expect(source).toContain('`${SHARED_EMAIL_FILES_PREFIX}${userId}/');
    expect(linkDays).toBeGreaterThan(0);
    expect(days).toBeGreaterThanOrEqual(linkDays);
  });
});
