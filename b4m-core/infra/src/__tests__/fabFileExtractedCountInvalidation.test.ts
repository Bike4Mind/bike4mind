import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Every site that rewrites a FabFile's bytes in place must also clear the cached extracted length.
 *
 * A stale `extractedCharCount` makes the pre-send attachment warning silent about a file that no
 * longer fits, which is the one failure that warning exists to prevent: an AI edit growing a 4k file
 * to 44k leaves the document saying 4,000, and the dry-run short-circuits to "fits".
 *
 * A source-pattern test, like fabFileModerationGate, and for the same reason: the first version of the
 * invalidation covered fabFileService/update and missed three live edit routes, while its own comment
 * claimed it was "the one place content is rewritten in place". Enumeration is the only thing that
 * catches that class of mistake, so this fails when a NEW rewrite site appears without the patch
 * rather than trusting anyone to remember.
 */

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PATCH = 'FAB_FILE_CONTENT_REWRITE_PATCH';

/**
 * Files that upload FabFile content. Each must reference the shared patch.
 *
 * `create.ts` and `createByUrl.ts` are absent on purpose: they write a file's FIRST bytes, so there is
 * no prior measurement to invalidate. A backup upload (writing the OLD bytes to a backup path) does not
 * change the live file either, which is why presence-of-`upload(` alone is not the rule.
 */
const REWRITE_SITES = [
  'apps/client/pages/api/fabfiles/[id]/apply-edit.ts',
  'apps/client/pages/api/fabfiles/[id]/edit.ts',
  'b4m-core/services/src/fabFileService/update.ts',
  'b4m-core/services/src/fabFileService/edit.ts',
];

/** Content-upload call shapes, used to spot a rewrite site nobody added to the list above. */
const UPLOAD_CALL = /\.\s*upload(File)?\s*\(/;
const UPLOAD_PATTERN = new RegExp(`${UPLOAD_CALL.source}|PutObjectCommand|putObject`);

/** First-write and backup paths: they upload bytes but invalidate nothing. */
const NOT_A_REWRITE = new Set([
  'b4m-core/services/src/fabFileService/create.ts',
  'b4m-core/services/src/fabFileService/createByUrl.ts',
  // Stages an admin audit-log CSV under exports/ (no FabFile row); nothing to invalidate.
  'apps/client/server/utils/adminAuditExportStorage.ts',
  // Only uploads while the row is still `pending` (a first write); the S3 event charges it.
  'apps/client/pages/api/files/[id]/upload.ts',
  // Each creates a NEW row (or presigns the first write for one); the S3 event charges it.
  'apps/client/pages/api/files/copy-generated-image.ts',
  'apps/client/pages/api/files/createFabFile.ts',
  'apps/client/pages/api/files/createFabFileURL.ts',
  'apps/client/pages/api/files/generate-presigned-urls-batch.ts',
  // Each creates a new FabFile (or writes a first copy for one) and uploads its first bytes; the S3 event charges it.
  'apps/workers/src/queueHandlers/lakeIngestShared.ts',
  'apps/workers/src/queueHandlers/notebookCuration.ts',
  'apps/workers/src/emailIngestion/emailParser.ts',
  'apps/client/server/s3/notebookImportComplete.ts',
  'packages/server-utils/src/utils/saveGeneratedAssetToFiles.ts',
  'apps/client/server/slack/dataLakeIngestDeps.ts',
  'apps/client/server/dataLakes/proposalAdmissionDeps.ts',
  // Uploads a freshly generated avatar under a new filename and creates a new FabFile row; a first write.
  'apps/client/server/agents/authoring/generateAgentAvatar.ts',
  'apps/client/server/files/createPresignedUpload.ts',
  // Its upload writes the FabFile it has just created through createFabFile (a first write). It is ALSO
  // listed in ADAPTER_WIRING_SITES on purpose: line ~248 reaches a real rewrite through updateFabFile.
  'apps/workers/src/events/sessionSummarization.ts',
  // Not FabFile content: exports, attachments, generated media, caches, QA fixtures and public artifacts.
  'apps/workers/src/queueHandlers/slackExport.ts',
  'apps/workers/src/queueHandlers/slackQuestProcessor.ts',
  'apps/client/server/qa/storage.ts',
  'apps/client/server/utils/publicSettingsArtifact.ts',
  'apps/client/server/utils/cacheExternalImage.ts',
  'apps/client/server/utils/generatedAudioDelivery.ts',
  'apps/client/server/utils/mailer/emailAttachments.ts',
  'apps/client/server/generationJobs/wiring.ts',
  // Posts a clip to Slack (SlackClient.uploadFile); it writes no FabFile bytes.
  'apps/client/server/generationJobs/slackJobDelivery.ts',
  'apps/workers/src/queueHandlers/orgFeedbackSummary.ts',
  'apps/workers/src/queueHandlers/questExport.ts',
  // Stages HTML and stores published-artifact thumbnails; neither upload rewrites FabFile content.
  'apps/workers/src/queueHandlers/publishThumbnail.ts',
]);

/**
 * Files that only wire a storage adapter into a service that rewrites (updateFabFile, the research
 * task service), so the service does the charging. The wiring is the risk: a `users` adapter that lacks
 * `incrementCurrentStorage` type-checks only through a cast, and the rewrite then goes uncounted.
 */
const ADAPTER_WIRING_SITES = [
  'apps/workers/src/queueHandlers/researchEngineQueue.ts',
  'apps/workers/src/events/sessionSummarization.ts',
  'apps/client/server/files/updateFileForUser.ts',
];

/** A call that hands a `users` adapter to the rewrite accounting, so the caller must be in a list above. */
const REWRITE_SERVICE_CALL =
  /(updateFabFile\(|editFabFile\(|assertRewriteFits\(|commitContentRewrite\(|researchTaskService\.(process|processDiscoveredLinks|downloadRelevantLinks)\()/;

/** Rewrite sites that charge through the accounting helper but do not use the extracted-count patch. */
const CHARGED_ELSEWHERE = ['b4m-core/services/src/researchTaskService/utils.ts'];

const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

// Comments stripped (keeping `://` in strings) so a commented-out call cannot satisfy a check.
const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');

// Same skip set as fabFileModerationGate.test.ts (a copy: the walker is ten lines, and a shared
// helper would need a non-test module in this directory just for two guards).
const EXCLUDED_DIR_NAMES = new Set(['__tests__', 'dist', '.next', 'node_modules']);

const walkTs = (dir: string, visit: (rel: string) => void) => {
  const abs = path.join(REPO_ROOT, dir);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) walkTs(rel, visit);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) visit(rel.split(path.sep).join('/'));
  }
};

describe('every FabFile content rewrite clears the cached extracted length', () => {
  it.each(REWRITE_SITES)('%s references the shared invalidation patch', rel => {
    expect(read(rel)).toContain(PATCH);
  });

  // The list above is only as good as its completeness, so hunt for a site nobody listed.
  it('has no unlisted file that uploads FabFile content', () => {
    const searchRoots = [
      'apps/client/pages/api/fabfiles',
      'apps/client/pages/api/files',
      'apps/client/server',
      'packages/server-utils/src',
      'apps/workers/src',
      'b4m-core/services/src/fabFileService',
      'b4m-core/services/src/researchTaskService',
      'packages/server-utils/src',
    ];
    const found: string[] = [];
    searchRoots.forEach(root => walkTs(root, rel => UPLOAD_PATTERN.test(read(rel)) && found.push(rel)));

    const unaccounted = found.filter(
      f =>
        !REWRITE_SITES.includes(f) &&
        !NOT_A_REWRITE.has(f) &&
        !CHARGED_ELSEWHERE.includes(f) &&
        !ADAPTER_WIRING_SITES.includes(f)
    );
    expect(
      unaccounted,
      `These upload FabFile content but are neither listed as rewrite sites nor excluded as first-write/backup. ` +
        `If one rewrites an existing file's bytes, spread ${PATCH} into its update and add it to REWRITE_SITES; ` +
        `if it only writes a new file or a backup copy, add it to NOT_A_REWRITE with a reason.`
    ).toEqual([]);
  });

  // A rewrite that skips the accounting helper charges the full new size on its S3 event and never
  // refunds the old one (fabFileService/rewriteStorage.ts). The research re-crawl rewrites bytes too,
  // outside the extracted-count roots, so it is pinned by name. fabFileService/edit.ts is exempt: it has no production caller.
  it.each([
    ...REWRITE_SITES.filter(rel => rel !== 'b4m-core/services/src/fabFileService/edit.ts'),
    ...CHARGED_ELSEWHERE,
  ])('%s charges its rewrite through the storage accounting helper', rel => {
    const source = stripComments(read(rel));
    const branches = source.split('commitContentRewrite(');
    expect(branches.length).toBeGreaterThan(1);
    // Every commit is preceded, since the previous one, by a quota check and then the upload. The check
    // must come before the FIRST upload (a backup counts), so a refused rewrite writes nothing.
    for (const branch of branches.slice(0, -1)) {
      const check = branch.indexOf('assertRewriteFits(');
      expect(check).toBeGreaterThanOrEqual(0);
      expect(branch.search(UPLOAD_CALL)).toBeGreaterThan(check);
    }
    // Nothing is written after the last commit: bytes the row never charged would be unaccounted.
    expect(branches[branches.length - 1]).not.toMatch(UPLOAD_CALL);
    expect(source).not.toMatch(/FabFile\.(updateOne|findOneAndUpdate)\(/);
  });

  // The accounting helper moves the owner's counter through `users.incrementCurrentStorage`, or
  // `organizations.incrementCurrentStorage` for an org-owned file (storageOwner.ts). A hand-built or
  // cast adapter without it compiles but does not update the owner's storage usage.
  const COUNTER_ADAPTERS = [
    { key: 'users', repository: 'userRepository', type: 'IUserRepository' },
    { key: 'organizations', repository: 'organizationRepository', type: 'IOrganizationRepository' },
  ];
  const WIRED_SITES = [...ADAPTER_WIRING_SITES, ...REWRITE_SITES.filter(rel => rel.startsWith('apps/'))];

  it.each(WIRED_SITES.flatMap(rel => COUNTER_ADAPTERS.map(adapter => [rel, adapter.key, adapter] as const)))(
    '%s wires the real %s repository into the rewrite accounting',
    (rel, key, { repository, type }) => {
      const source = stripComments(read(rel));
      const adapters = [
        ...[...source.matchAll(new RegExp(`\\b${key}\\s*:\\s*([^,}\\n]+)`, 'g'))].map(m => m[1].trim()),
        ...[...source.matchAll(new RegExp(`[{,]\\s*${key}\\s*(?=[,}])`, 'g'))].map(() => `${key} (shorthand)`),
      ];
      const bad = adapters.filter(rhs => !new RegExp(`(^|\\.)${repository}$`).test(rhs));
      const cast = new RegExp(`\\bas\\s+(unknown\\s+as\\s+)?${type}\\b`).test(source);
      const fromRealModule = new RegExp(
        `import\\s*\\{[^}]*\\b${repository}\\b[^}]*\\}\\s*from\\s*'@bike4mind/database'`
      ).test(source);

      expect(adapters.length, `${rel}: no ${key} adapter found`).toBeGreaterThan(0);
      expect(bad, `${rel}: ${key} adapter must be ${repository}, found: ${bad.join(' | ')}`).toEqual([]);
      expect(cast, `${rel}: ${key} adapter is cast to ${type}`).toBe(false);
      expect(fromRealModule, `${rel}: ${repository} must come from @bike4mind/database`).toBe(true);
    }
  );

  it('lists only paths that exist', () => {
    const listed = [...NOT_A_REWRITE, ...ADAPTER_WIRING_SITES, ...REWRITE_SITES, ...CHARGED_ELSEWHERE];
    expect(listed.filter(rel => !fs.existsSync(path.join(REPO_ROOT, rel)))).toEqual([]);
  });

  it('has no unlisted app file that hands a users adapter to the rewrite accounting', () => {
    const known = new Set([...REWRITE_SITES, ...ADAPTER_WIRING_SITES, ...CHARGED_ELSEWHERE]);
    const found: string[] = [];
    walkTs('apps/client/server', rel => REWRITE_SERVICE_CALL.test(stripComments(read(rel))) && found.push(rel));
    walkTs('packages/server-utils/src', rel => REWRITE_SERVICE_CALL.test(stripComments(read(rel))) && found.push(rel));
    walkTs('apps/client/pages', rel => REWRITE_SERVICE_CALL.test(stripComments(read(rel))) && found.push(rel));
    walkTs('apps/workers/src', rel => REWRITE_SERVICE_CALL.test(stripComments(read(rel))) && found.push(rel));

    expect(
      found.filter(f => !known.has(f)),
      'These call a rewrite service but are not in REWRITE_SITES or ADAPTER_WIRING_SITES, so their users adapter is unchecked.'
    ).toEqual([]);
  });

  // undefined is stripped from a Mongoose $set, so that form of the fix silently changes nothing.
  it('clears with null rather than undefined', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');

    expect(source).toMatch(/FAB_FILE_CONTENT_REWRITE_PATCH\s*=\s*\{[^}]*extractedCharCount:\s*null[^}]*\}/);
  });

  it('the shared patch also clears every chunk-derived rollup a rewrite invalidates', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');
    // The patch object literal spans from the const to its first closing brace.
    const patch = source.match(/FAB_FILE_CONTENT_REWRITE_PATCH\s*=\s*\{[^}]*\}/)?.[0] ?? '';
    // A rewrite invalidates the chunks these rollups were computed from, so all must be nulled - a
    // stale one would grade lake health (#1666) against the previous content.
    for (const field of ['chunkedCharCount', 'maxChunkCharLength', 'embeddedChunkCount', 'embeddedCharCount']) {
      expect(patch).toMatch(new RegExp(`${field}:\\s*null`));
    }
  });

  // The admission-contract text hash (#1679) is content-derived too, so a byte rewrite must clear it
  // rather than leave a fingerprint that claims text the file no longer holds.
  it('the shared patch also clears the server-verified text hash (serverTextHash)', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');
    expect(source).toMatch(/FAB_FILE_CONTENT_REWRITE_PATCH\s*=\s*\{[^}]*serverTextHash:\s*null[^}]*\}/);
  });

  // Terminal for the chunk rescue sweep (buildFabFileChunkScanFilter), so a stamp left over a byte
  // rewrite excludes the new content from repair forever.
  it('the shared patch also clears the no-extractable-text stamp (noExtractableTextAt)', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');
    expect(source).toMatch(/FAB_FILE_CONTENT_REWRITE_PATCH\s*=\s*\{[^}]*noExtractableTextAt:\s*null[^}]*\}/);
  });

  // The inverse pin: a rewrite leaves the old chunks served, and the vintage describes those chunks,
  // so clearing it would render still-accurate passages undated. Re-derived by the next re-chunk.
  it('the shared patch deliberately leaves the document vintage alone', () => {
    const source = read('b4m-core/common/src/types/entities/FabFileTypes.ts');
    const patch = source.match(/FAB_FILE_CONTENT_REWRITE_PATCH\s*=\s*\{[^}]*\}/)?.[0] ?? '';
    expect(patch).toContain('noExtractableTextAt');
    expect(patch).not.toMatch(/documentDate/);
  });
});
