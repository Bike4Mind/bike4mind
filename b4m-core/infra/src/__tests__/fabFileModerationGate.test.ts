import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Static-analysis guard: hold uploaded images until moderation clears them.
 * `isImageServeable(fabFile)` (`b4m-core/common/src/utils/isImageServeable.ts`)
 * is the single predicate that decides whether an uploaded image's bytes/URL may be
 * handed out - false for an image whose `moderationStatus !== 'clean'` (still pending
 * scan, or confirmed blocked).
 *
 * A systematic sweep found ~17 places across the serve/distribution surface that
 * minted a signed URL or downloaded FabFile bytes WITHOUT checking this predicate -
 * each one a potential leak of unmoderated (possibly section 2258A-relevant) image content.
 * All were hand-fixed. This test is the durable CI guard that stops an 18th site
 * from shipping ungated.
 *
 * Modeled on `bucketRouteCollision.test.ts` in this same directory: pure string/regex
 * scanning of source files for a fixed set of historically-dangerous call-site
 * patterns - no AWS/DB calls, no app-code imports. A file that matches a pattern must
 * EITHER reference `isImageServeable` itself, OR be in the `ALLOWLIST` below with an
 * honest one-line reason (e.g. it's a DI passthrough to an already-gated shared
 * function, an upload-only/delete-only path, or provably never touches an image).
 */

// b4m-core/infra/src/__tests__ -> repo root is four levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

/** Directories swept for FabFile serve/distribution call sites. */
const SCAN_ROOTS = ['apps/client/pages', 'apps/client/server', 'b4m-core/services/src', 'b4m-core/slack/src'];

const EXCLUDED_DIR_NAMES = new Set(['__tests__', 'dist', '.next', 'node_modules']);
const isTestFileName = (name: string): boolean => /\.test\.tsx?$/.test(name);
const isSourceFileName = (name: string): boolean => /\.tsx?$/.test(name);

/** Recursively collect non-test `.ts`/`.tsx` files under `dir`. */
function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out);
    } else if (isSourceFileName(entry) && !isTestFileName(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Repo-relative, forward-slash path - used as the ALLOWLIST key and in failure messages. */
const toRepoRelative = (absPath: string): string => relative(REPO_ROOT, absPath).split(sep).join('/');

interface DangerPattern {
  /** Human-readable name surfaced in failure messages. */
  name: string;
  test: (source: string) => boolean;
}

/**
 * Historically-dangerous call-site shapes that serve FabFile bytes or mint a signed
 * URL for one. Each is a reliable textual signal, not a full semantic parse - see
 * class doc comment for the "why regex, not AST" rationale (same tradeoff
 * `bucketRouteCollision.test.ts` makes).
 */
const DANGER_PATTERNS: DangerPattern[] = [
  {
    // Co-occurrence, not a chained call: `getFilesStorage()` returns the fabFileBucket
    // S3Storage handle; a file that also calls `.download(` or `.getSignedUrl(`
    // anywhere (directly, or via a local variable holding the handle) is reading or
    // minting a URL for FabFile bytes.
    name: 'getFilesStorage() + .download()/.getSignedUrl()',
    test: source => /getFilesStorage\(\)/.test(source) && /\.(?:download|getSignedUrl)\(/.test(source),
  },
  {
    name: 'fabFileStorage.getSignedUrl()/.download()',
    test: source => /fabFileStorage\.(?:getSignedUrl|download)\(/.test(source),
  },
  {
    // Slack package's DI-injected storage adapter is conventionally named `filesStorage`.
    name: 'filesStorage.getSignedUrl()/.download() (slack DI)',
    test: source => /filesStorage\.(?:getSignedUrl|download)\(/.test(source),
  },
  {
    name: 'getCachedSignedUrl()',
    test: source => /getCachedSignedUrl\(/.test(source),
  },
  {
    // The LLM-tool `ToolContext.storage` accessor (`Pick<BaseStorage,
    // 'upload' | 'getSignedUrl' | 'getPublicUrl'>`, see llm/tools/base/types.ts) mints a
    // signed URL / downloads bytes for whatever FabFile a tool implementation hands it -
    // same shape of risk as `getFilesStorage()`/`fabFileStorage`/`filesStorage` above, just
    // a different DI convention. A new LLM tool that reads fabfile bytes via
    // `context.storage` without checking `isImageServeable` first would otherwise slip
    // past every other pattern here.
    name: 'context.storage.getSignedUrl()/.download()',
    test: source => /context\.storage\.(?:download|getSignedUrl)\(/.test(source),
  },
  {
    name: '.getFileContent() (fileStorageService adapter)',
    test: source => /\.getFileContent\(/.test(source),
  },
  {
    // The generic `getFileContent(fabFile, { storage, logger })` extractor
    // (`b4m-core/utils/src/fabfile.ts`) mints a signed URL and reads bytes for
    // whatever FabFile it's given. Detected via its named import rather than a bare
    // `getFileContent(` call, which would also match unrelated method definitions
    // (e.g. `githubService.getFileContent`) and produce noise.
    name: "getFileContent named import from '@bike4mind/utils'",
    test: source => /import\s*\{[^}]*\bgetFileContent\b[^}]*\}\s*from\s*['"]@bike4mind\/utils['"]/.test(source),
  },
];

const detectDangerPatterns = (source: string): string[] => DANGER_PATTERNS.filter(p => p.test(source)).map(p => p.name);

// Requires an actual call (`isImageServeable(` / `isImageServeable (`), not just the
// bare identifier - a file that imports it but never calls it (e.g. a guard call was
// deleted but the now-unused import was left behind) must NOT read as gated. Verified:
// removing a real call site while leaving its `import { isImageServeable }` in place
// used to slip past a bare-identifier check.
const referencesGate = (source: string): boolean => /isImageServeable\s*\(/.test(source);

/**
 * Files that match a DANGER_PATTERN but do not reference `isImageServeable`, along
 * with an honest, specific reason each is not a leak. Every entry was verified by
 * reading the call site, not just grepping. Keep this minimal: an entry here must
 * be provably safe, not merely inconvenient to fix.
 */
const ALLOWLIST: Record<string, string> = {
  // --- The moderation scanner itself: downloads bytes to RUN Rekognition and PRODUCE
  // moderationStatus in the first place. It cannot gate on isImageServeable (that
  // would be circular - the field it's about to set is exactly what the predicate
  // reads) and never returns the bytes/URL to a client. ---
  'apps/client/server/s3/objectCreated.ts':
    'the moderation scanner itself (objectCreated) — produces moderationStatus, does not consume it',

  // --- DI passthroughs: the file only wires a storage closure; the actual gate lives
  // in the shared service function the closure is handed to. ---
  'apps/client/pages/api/quests/[id]/files.ts':
    'DI passthrough — generateSignedUrl closure consumed by fabFileService.listFabFilesByQuest -> getFabFile, gated via the generateSignedUrl choke in fabFileService/get.ts',
  'apps/client/pages/api/sessions/[id]/files.ts':
    'DI passthrough — generateSignedUrl closure consumed by fabFileService.listFabFilesBySession -> getFabFile, gated via the generateSignedUrl choke in fabFileService/get.ts',
  'apps/client/pages/api/files/search.ts':
    'DI passthrough — generateSignedUrl closure consumed by fabFileService.search, gated via the generateSignedUrl choke in fabFileService/get.ts',
  'apps/client/pages/api/files/byIds.ts':
    'DI passthrough — generateSignedUrl closure consumed by fabFileService.listFabFiles, gated via the generateSignedUrl choke in fabFileService/get.ts',
  'apps/client/pages/api/files/index.ts':
    'gated via generateSignedUrl choke (search -> get.ts) for reads; the other match is a delete-only storage.delete call',
  'apps/client/pages/api/files/[id]/index.ts':
    'GET/PUT route through fabFileService.getFabFile/updateFabFile (both gated: get.ts via the generateSignedUrl choke, update.ts imports isImageServeable directly); DELETE branch only calls storage.delete (delete.ts is delete-only)',
  'apps/client/pages/api/data-lakes/[id]/articles.ts':
    'DI passthrough — generateSignedUrl closure consumed by fabFileService.search, gated via the generateSignedUrl choke in fabFileService/get.ts',
  'apps/client/pages/api/files/createFabFileURL.ts':
    'DI passthrough to fabFileService.createFabFileByUrl -> createFabFile (create.ts), which skips minting fileUrl for images at creation time (root-cause fix, commit 63cc8f9d3e)',
  'apps/client/pages/api/notebooks/export.ts':
    'DI passthrough — fileStorageService adapter consumed by already-gated notebookExportService.exportKnowledge/processImages (both import isImageServeable)',
  'apps/client/server/queueHandlers/researchEngineQueue.ts':
    'DI passthrough — storage adapter consumed by already-gated researchTaskService.process/downloadRelevantLinks (routes through findOrUpdateExistingResearchData, gated commit 63cc8f9d3e, and createFabFile)',
  'apps/client/server/queueHandlers/notebookCuration.ts':
    'DI passthrough — storage adapter consumed by NotebookCurationService.storeFile, which calls the already-gated fabFileService.createFabFile with a converter-produced mimeType that is always markdown/txt/html, never an image',
  'apps/client/server/events/sessionSummarization.ts':
    'text-only mime (session summary is always SupportedFabFileMimeTypes.TXT_PLAIN) — DI passthrough to already-gated fabFileService.update/create',
  'apps/client/server/emailIngestion/emailParser.ts':
    'DI passthrough — storage adapter consumed by the email-ingestion pipeline (processAttachments/processEmailBody), which creates FabFiles via the already-gated fabFileService.create',
  'apps/client/server/queueHandlers/slackQuestProcessor.ts':
    'DI passthrough — raw storage object handed to ChatCompletionProcess/LLM tool implementations that already gate on isImageServeable before touching it (imageEdit/editFile); the imageGenerateStorage.download call is the generated-images bucket, not fabFileBucket',

  // --- Never reaches an image (mime restricted or format is always text). ---
  'apps/client/pages/api/fabfiles/[id]/auto-rename.ts':
    'text-only mime, never an image — throws BadRequestError for any mimeType outside a fixed text/code allowlist before ever minting a signed URL',
  'apps/client/pages/api/notebooks/download.ts':
    'text-only mime, never an image — downloads/converts only the curated-notebook document (markdown/html/txt), identified via session.curatedNotebookFileId',
  'apps/client/pages/api/agents/create-from-context.ts':
    'images filtered out (mimeType.startsWith("image/")) before the shared getFileContent extractor is ever called on a file',

  // --- Upload-only / delete-only: no read path. ---
  'apps/client/pages/api/files/createFabFile.ts': 'upload-only presigned PUT (getSignedUrl mode "put"), no read',

  // --- Synchronous pre-persist moderation, not the stored-moderationStatus gate. ---
  'apps/client/pages/api/agents/[id]/generate-avatar.ts':
    'freshly generated avatar is moderated synchronously via moderateImageOrThrow/RekognitionImageModerationService before upload+mint (throws ImageModerationBlockedError first); not a stored-moderationStatus read path since no FabFile/moderationStatus exists yet',

  // --- Caller already gates before handing bytes to this module. ---
  'apps/client/server/utils/mailer/emailAttachments.ts':
    'sole caller (apps/client/pages/api/email/send.ts) already gates every file with isImageServeable before passing its bytes into sendEmailWithAttachments',

  // --- `.getFileContent(`/`getFileContent(` match is githubService's GitHub-content
  // fetcher (SRE agent code review), unrelated to FabFile/S3 storage. ---
  'apps/client/server/queueHandlers/sreRevision.ts':
    'githubService.getFileContent — GitHub repo content fetch for SRE code review, unrelated to FabFile storage',
  'apps/client/server/queueHandlers/sreAnalysis.ts':
    'githubService.getFileContent — GitHub repo content fetch for SRE code review, unrelated to FabFile storage',
  'apps/client/server/services/whatsNewDataCollector.ts':
    'githubService.getFileContent — GitHub repo content fetch (CHANGELOG.md), unrelated to FabFile storage',
  'b4m-core/services/src/sreAgentService/tools.ts':
    'toolContext.getFileContent is wired to githubService.getFileContent — GitHub repo content fetch, unrelated to FabFile storage',
  'b4m-core/services/src/sreAgentService/index.ts':
    'toolContext.getFileContent is wired to githubService.getFileContent — GitHub repo content fetch, unrelated to FabFile storage',
};

describe('detectDangerPatterns() / referencesGate()', () => {
  it('flags getFilesStorage() co-occurring with .getSignedUrl(', () => {
    const src = `const storage = getFilesStorage();\nawait storage.getSignedUrl(path, 'get', {});`;
    expect(detectDangerPatterns(src)).toContain('getFilesStorage() + .download()/.getSignedUrl()');
  });

  it('flags getFilesStorage() co-occurring with .download(', () => {
    const src = `await getFilesStorage().download(fabFile.filePath);`;
    expect(detectDangerPatterns(src)).toContain('getFilesStorage() + .download()/.getSignedUrl()');
  });

  it('does not flag getFilesStorage() used only for .upload()/.delete()', () => {
    const src = `await getFilesStorage().upload(content, path, {});\nawait getFilesStorage().delete(path);`;
    expect(detectDangerPatterns(src)).toEqual([]);
  });

  it('flags fabFileStorage.getSignedUrl(/.download(', () => {
    expect(detectDangerPatterns(`fabFileStorage.getSignedUrl(path)`)).toContain(
      'fabFileStorage.getSignedUrl()/.download()'
    );
    expect(detectDangerPatterns(`fabFileStorage.download(path)`)).toContain(
      'fabFileStorage.getSignedUrl()/.download()'
    );
  });

  it('flags the slack filesStorage.getSignedUrl(/.download( DI convention', () => {
    expect(detectDangerPatterns(`await filesStorage.download(fabFile.filePath)`)).toContain(
      'filesStorage.getSignedUrl()/.download() (slack DI)'
    );
  });

  it('does not confuse fabFileStorage/filesStorage with an unrelated "storage" receiver', () => {
    expect(detectDangerPatterns(`storage.getSignedUrl(path)`)).toEqual([]);
  });

  it('flags getCachedSignedUrl(', () => {
    expect(detectDangerPatterns(`await getCachedSignedUrl(fabFile)`)).toContain('getCachedSignedUrl()');
  });

  it('flags context.storage.getSignedUrl(/.download( (#9776 P3-2 LLM-tool storage accessor)', () => {
    expect(detectDangerPatterns(`const url = await context.storage.getSignedUrl(fabFile.filePath);`)).toContain(
      'context.storage.getSignedUrl()/.download()'
    );
    expect(detectDangerPatterns(`await context.storage.download(fabFile.filePath);`)).toContain(
      'context.storage.getSignedUrl()/.download()'
    );
  });

  it('does not confuse context.storage with imageGenerateStorage or an unrelated "storage" receiver', () => {
    expect(detectDangerPatterns(`await context.imageGenerateStorage.getSignedUrl(key);`)).toEqual([]);
    expect(detectDangerPatterns(`await storage.getSignedUrl(path);`)).toEqual([]);
  });

  it('flags a .getFileContent( method call', () => {
    expect(detectDangerPatterns(`await this.adapters.fileStorageService.getFileContent(path)`)).toContain(
      '.getFileContent() (fileStorageService adapter)'
    );
  });

  it('does not flag a getFileContent( method DEFINITION (no receiver dot)', () => {
    const src = `class GithubService {\n  async getFileContent(repo: string, path: string): Promise<string | null> {\n    return null;\n  }\n}`;
    expect(detectDangerPatterns(src)).toEqual([]);
  });

  it('flags a named getFileContent import from @bike4mind/utils', () => {
    const src = `import { getFileContent, BadRequestError } from '@bike4mind/utils';\nawait getFileContent(fabFile, { storage, logger });`;
    expect(detectDangerPatterns(src)).toContain("getFileContent named import from '@bike4mind/utils'");
  });

  it('does not flag an unrelated named import from @bike4mind/utils', () => {
    const src = `import { getSettingsByNames } from '@bike4mind/utils';\nconst x = githubService.getFileContent(repo, path);`;
    // githubService.getFileContent( is still caught by the dot-form method-call pattern,
    // just not by the utils-named-import pattern - assert the latter specifically.
    expect(detectDangerPatterns(src)).not.toContain("getFileContent named import from '@bike4mind/utils'");
  });

  it('referencesGate() is true only when isImageServeable is actually called', () => {
    expect(referencesGate(`if (!isImageServeable(fabFile)) throw new Error('nope');`)).toBe(true);
    expect(referencesGate(`await getFilesStorage().download(path);`)).toBe(false);
  });

  it('referencesGate() is false for an unused import with the call site deleted (regression guard)', () => {
    // A guard call can be deleted while its now-dead import lingers - a bare
    // identifier match would false-pass this. Reproduces the exact bug caught while
    // building this test: temporarily deleting the isImageServeable(...) call from
    // apps/client/pages/api/mcp/confirm.ts but leaving its import in place kept an
    // earlier, buggier version of this predicate green.
    const src = `import { isImageServeable } from '@bike4mind/common';\nawait getFilesStorage().download(fabFile.filePath);`;
    expect(referencesGate(src)).toBe(false);
  });
});

describe('#9776 Q2b — every FabFile serve/mint call site is gated or allowlisted', () => {
  const sourceFiles = SCAN_ROOTS.flatMap(root => collectSourceFiles(resolve(REPO_ROOT, root)));

  it('scans a non-trivial number of source files (guards against a broken walk)', () => {
    // Loose canary, not an exact count - catches a walk that silently returns nothing
    // (wrong roots, broken exclusion filter) rather than asserting a brittle total.
    expect(sourceFiles.length).toBeGreaterThan(200);
  });

  it('every ALLOWLIST entry points at a file that still exists', () => {
    const missing = Object.keys(ALLOWLIST).filter(relPath => {
      try {
        statSync(resolve(REPO_ROOT, relPath));
        return false;
      } catch {
        return true;
      }
    });

    expect(
      missing,
      missing.length === 0
        ? ''
        : `ALLOWLIST references file(s) that no longer exist — remove the stale entry:\n${missing
            .map(f => `  - ${f}`)
            .join('\n')}`
    ).toEqual([]);
  });

  it('flags a non-trivial number of dangerous call sites (guards against a broken pattern set)', () => {
    const matchedCount = sourceFiles.filter(f => detectDangerPatterns(readFileSync(f, 'utf8')).length > 0).length;
    // Current count is ~55 (30 gated directly + 25 allowlisted). Floor has headroom
    // but still catches a pattern set that's silently gone vacuous (e.g. a typo'd regex).
    expect(matchedCount).toBeGreaterThanOrEqual(20);
  });

  it('gates or allowlists every FabFile serve/mint call site', () => {
    const violations: string[] = [];

    for (const absPath of sourceFiles) {
      const source = readFileSync(absPath, 'utf8');
      const matches = detectDangerPatterns(source);
      if (matches.length === 0) continue;
      if (referencesGate(source)) continue;

      const relPath = toRepoRelative(absPath);
      if (Object.prototype.hasOwnProperty.call(ALLOWLIST, relPath)) continue;

      violations.push(
        `${relPath}\n      matched: ${matches.join(', ')}\n      fix: add "if (!isImageServeable(fabFile)) { ... }" ` +
          `before the serve/mint call, or add an ALLOWLIST entry in fabFileModerationGate.test.ts with an honest reason`
      );
    }

    expect(
      violations,
      violations.length === 0
        ? ''
        : `Found ${violations.length} FabFile serve/mint call site(s) not gated on isImageServeable and not ` +
            `allowlisted (#9776 Q2b):\n\n${violations.join('\n\n')}\n\n` +
            `See CLAUDE.md and b4m-core/common/src/utils/isImageServeable.ts.`
    ).toEqual([]);
  });
});
