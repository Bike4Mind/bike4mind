import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { NOTEBOOK_EXPORT_IMPORTER_KEY, TIMEOUTS } from './constants';
import { apiCreateSession } from './helpers/api';
import { getTestUsers } from './helpers/test-users';

/**
 * Byte fidelity of the notebook export, end to end through the browser.
 *
 * The unit suite mocks the storage read, so it cannot see the adapter that actually reads S3 -
 * which is where a UTF-8 decode silently replaced every unrepresentable byte with U+FFFD before
 * the base64 encode. The only trustworthy check is a hash: these tests upload a fixture whose
 * sha256 is known outside the system, export it, and compare the sha256 of the decoded base64
 * against that reference. A single mangled byte fails.
 *
 * Serial and stateful on purpose: the round-trip test imports the very payload the first test
 * exported, and the manifest is a read-modify-write.
 */
test.describe.configure({ mode: 'serial' });

const UPLOADS = 'e2e/fixtures/uploads';

/**
 * Reused rather than newly generated: sample.pdf and cat.png both fail a UTF-8 decode (verified),
 * which is the whole point, and both sit under the 3MB client-side image-resize threshold and the
 * 10MB export embed cap, so the bytes the browser sends are the bytes on disk.
 */
const FIXTURES = [
  { file: 'sample.pdf', mime: 'application/pdf', role: 'binary, non-UTF-8 - the defect case' },
  { file: 'cat.png', mime: 'image/png', role: 'binary, and gated by the image moderation scan' },
  { file: 'recipe.txt', mime: 'text/plain', role: 'the UTF-8 control - it survived the old decode too' },
] as const;

/** The file the round trip carries. Its hash is the strongest single claim in the suite. */
const ROUND_TRIP_FILE = 'sample.pdf';

interface ExportedKnowledge {
  id: string;
  name: string;
  size: number;
  content?: string;
  contentUrl?: string;
}

interface ExportPayload {
  notebooks: { id: string; name: string; knowledge?: ExportedKnowledge[] }[];
}

function localSha256(file: string): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.resolve(process.cwd(), UPLOADS, file)))
    .digest('hex');
}

function localBytes(file: string): number {
  return fs.statSync(path.resolve(process.cwd(), UPLOADS, file)).size;
}

function sha256OfBase64(content: string): string {
  return crypto.createHash('sha256').update(Buffer.from(content, 'base64')).digest('hex');
}

/**
 * Knowledge entries across every exported notebook, keyed by fabFile id.
 *
 * By id, not by name: the name the upload stores is not guaranteed to be the local basename, and
 * keying on it made a fully correct export look like a moderation timeout. The id comes straight
 * off the createFabFile response, so it cannot drift.
 */
function knowledgeById(payload: ExportPayload): Map<string, ExportedKnowledge> {
  const byId = new Map<string, ExportedKnowledge>();
  for (const notebook of payload.notebooks ?? []) {
    for (const file of notebook.knowledge ?? []) byId.set(file.id, file);
  }
  return byId;
}

/** Every knowledge entry, for a failure message that says what WAS there. */
function allKnowledge(payload: ExportPayload): ExportedKnowledge[] {
  return (payload.notebooks ?? []).flatMap(notebook => notebook.knowledge ?? []);
}

/**
 * Export for use inside a poll: returns null instead of failing when the account has nothing to
 * export yet.
 *
 * Separate from exportViaApi on purpose. A failed `expect()` inside an `expect.poll` predicate
 * ABORTS the poll rather than counting as one falsy attempt, so asserting `response.ok()` in
 * there turns a transient 404 (`NO_NOTEBOOKS`, before a background import has landed) into a
 * dead poll that never asks again - and then reports the timeout instead of the 404.
 */
async function tryExportViaApi(request: APIRequestContext, token: string): Promise<{ downloadUrl?: string } | null> {
  const response = await request.post('/api/notebooks/export', {
    headers: { Authorization: `Bearer ${token}` },
    data: { includeKnowledge: true, includeImages: true, format: 'json' },
  });
  if (!response.ok()) return null;
  const body = await response.json();
  return body.success ? body.data : null;
}

/** The download URL is presigned, so an unauthenticated GET is correct here. */
async function fetchExportPayload(request: APIRequestContext, downloadUrl?: string): Promise<ExportPayload> {
  expect(downloadUrl, 'export produced no downloadUrl').toBeTruthy();
  const response = await request.get(downloadUrl!);
  expect(response.ok(), `export download ${response.status()}`).toBeTruthy();
  return (await response.json()) as ExportPayload;
}

/**
 * Assert the uploads actually became notebook knowledge, before waiting on anything slow.
 *
 * Without this, an attachment that never entered `session.knowledgeIds` surfaces three minutes
 * later as a moderation timeout - the wrong diagnosis for the wrong subsystem. Polled rather than
 * read once: the id is added by a follow-up mutation after the bytes are PUT, so it lags the
 * createFabFile response by a moment.
 */
async function expectSessionKnowledgeCount(
  request: APIRequestContext,
  token: string,
  sessionId: string,
  expected: number
) {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/sessions/${sessionId}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok()) return -1;
        return ((await response.json()).knowledgeIds ?? []).length;
      },
      {
        timeout: 60_000,
        intervals: [2_000],
        message: `not every upload became notebook knowledge - expected ${expected} knowledgeIds. A file attached at message scope instead of notebook scope lands in fabFileIds and never reaches the export`,
      }
    )
    .toBe(expected);
}

/**
 * Every uploaded file is withheld from the export until moderationStatus reaches 'clean' (see
 * isImageServeable - non-images are gated too), and that is set asynchronously off the S3 event.
 * Poll the export API rather than the UI so the wait costs no clicks, then let the caller do one
 * real UI export to assert against.
 */
async function waitForKnowledgeToEmbed(
  request: APIRequestContext,
  token: string,
  fileIds: readonly string[]
): Promise<ExportPayload> {
  let latest: ExportPayload | undefined;
  let present = '';

  await expect
    .poll(
      async () => {
        try {
          const exported = await tryExportViaApi(request, token);
          if (!exported) return -1;
          latest = await fetchExportPayload(request, exported.downloadUrl);
          const byId = knowledgeById(latest);
          // Recorded for the failure message: which entries the export DID carry, and in what
          // state. Without it a lookup that misses reads exactly like content that never arrived.
          present = allKnowledge(latest)
            .map(
              f => `${f.id}/${f.name}=${typeof f.content === 'string' ? 'content' : f.contentUrl ? 'url' : 'neither'}`
            )
            .join(' ');
          return fileIds.filter(id => typeof byId.get(id)?.content === 'string').length;
        } catch (error) {
          // A socket hang up against a cold preview lambda must cost one attempt, not the poll.
          present = `last attempt threw: ${String(error).slice(0, 120)}`;
          return -1;
        }
      },
      {
        timeout: 3 * 60_000,
        intervals: [10_000],
        message: `not every upload reached the export with embedded content. Expected ids [${fileIds.join(', ')}]; the export carried: ${present || '<nothing>'}`,
      }
    )
    .toBe(fileIds.length);

  return latest!;
}

/** The first test's payload, replayed by the round-trip test (describe runs serial). */
let roundTripPayload: ExportPayload | undefined;

test.describe('Notebook export byte fidelity', () => {
  test('exports binary and UTF-8 knowledge files byte-identically', async ({
    page,
    request,
    basePage,
    profilePage,
  }) => {
    // Three uploads of up to 1MB, a moderation wait, and an export - well past the 60s default.
    test.setTimeout(8 * 60_000);

    const exporter = getTestUsers().specUsers.notebookExportBytes;
    const notebookName = `byte-fidelity-${Date.now()}`;
    const sessionId = await apiCreateSession(request, exporter.accessToken, notebookName);

    const fileIds = await test.step('attach each fixture as notebook knowledge', async () => {
      await page.goto(`/notebooks/${sessionId}`);
      await page.waitForLoadState('domcontentloaded');
      await basePage.dismissModals();

      const ids: Record<string, string> = {};
      for (const { file } of FIXTURES) {
        ids[file] = await attachAsNotebookKnowledge(page, `${UPLOADS}/${file}`);
      }
      return ids;
    });

    await expectSessionKnowledgeCount(request, exporter.accessToken, sessionId, FIXTURES.length);
    await waitForKnowledgeToEmbed(request, exporter.accessToken, Object.values(fileIds));

    const payload = await test.step('export through the modal a user would use', async () => {
      await openExportModal(page, profilePage);
      await expect(page.getByTestId('notebook-export-knowledge-switch')).toBeChecked();
      await expect(page.getByTestId('notebook-export-images-switch')).toBeChecked();
      await expect(page.getByTestId('notebook-export-size-input')).toHaveValue('10');

      const downloadUrl = await submitExport(page);
      return await fetchExportPayload(request, downloadUrl);
    });

    const byId = knowledgeById(payload);
    const recorded: Record<string, unknown>[] = [];

    for (const { file, mime, role } of FIXTURES) {
      const entry = byId.get(fileIds[file]);
      expect(
        entry,
        `${file} (${role}) is missing from the export. It carried: ${allKnowledge(payload)
          .map(f => `${f.id}/${f.name}`)
          .join(' ')}`
      ).toBeTruthy();
      expect(entry!.contentUrl, `${file} fell back to a URL reference instead of embedding`).toBeUndefined();
      expect(typeof entry!.content, `${file} carries no embedded content`).toBe('string');

      // The assertion the whole suite exists for. A UTF-8 round trip inflates every
      // unrepresentable byte to the three bytes of U+FFFD, so the length check localises a
      // failure to "decoded" rather than "truncated" before the hash is even read.
      expect(Buffer.from(entry!.content!, 'base64').length, `${file} decoded to the wrong byte count`).toBe(
        localBytes(file)
      );
      expect(sha256OfBase64(entry!.content!), `${file} (${mime}) did not survive the export byte-identically`).toBe(
        localSha256(file)
      );

      recorded.push({
        fileId: entry!.id,
        localName: file,
        // Recorded separately: the stored name is not guaranteed to equal the local basename.
        exportedName: entry!.name,
        mime,
        bytes: localBytes(file),
        sha256: localSha256(file),
      });
    }

    roundTripPayload = payload;
  });

  test('withholds a zero-byte knowledge file from the export entirely', async ({
    page,
    request,
    basePage,
    profilePage,
  }) => {
    test.setTimeout(6 * 60_000);

    const exporter = getTestUsers().specUsers.notebookExportBytes;
    // Not a committed fixture: an empty file in the tree is easy to "fix" by accident, and its
    // whole purpose is to be zero bytes.
    // .txt, not .bin: isStorableFabFileMimeType rejects an unsupported extension before the size
    // is ever looked at, so a zero-byte .bin 400s as "File type .bin is not supported" - which
    // says nothing about the zero-byte branch this test exists to record.
    const emptyPath = path.join(os.tmpdir(), 'zero-byte-knowledge.txt');
    fs.writeFileSync(emptyPath, '');

    const sessionId = await apiCreateSession(request, exporter.accessToken, `byte-fidelity-empty-${Date.now()}`);

    await page.goto(`/notebooks/${sessionId}`);
    await page.waitForLoadState('domcontentloaded');
    await basePage.dismissModals();
    const emptyFileId = await attachAsNotebookKnowledge(page, emptyPath);
    await expectSessionKnowledgeCount(request, exporter.accessToken, sessionId, 1);

    // Characterization, and the behaviour is not the one this scenario was written to expect.
    //
    // A zero-byte upload IS accepted - createFabFileSchema puts no floor on fileSize - and then
    // its moderationStatus sits at `scanning` indefinitely. Verified on a preview: two separate
    // zero-byte files stayed `scanning` across a full 3-minute poll each, logging
    // `export.knowledge.skip reason=not-serveable moderationStatus=scanning` on every export.
    // isImageServeable gates non-images identically to images, so the export emits the listing
    // entry with NEITHER content nor contentUrl.
    //
    // That makes the zero-byte content branch (`content !== null`, which replaced a truthiness
    // check that an empty Buffer would have passed) unreachable through the product: the
    // moderation gate returns before getFileContent is ever called.
    //
    // If someone fixes the moderation pipeline for empty objects, this test fails - which is the
    // point. It is pinning a defect, not blessing it.
    await openExportModal(page, profilePage);
    const payload = await fetchExportPayload(request, await submitExport(page));
    const entry = knowledgeById(payload).get(emptyFileId);

    expect(
      entry,
      `the zero-byte file is missing from the export listing entirely. It carried: ${allKnowledge(payload)
        .map(f => f.id)
        .join(' ')}`
    ).toBeTruthy();
    expect(
      entry!.content,
      'a zero-byte file now embeds content - the moderation gate that withheld it has changed, so re-check the zero-byte branch'
    ).toBeUndefined();
    expect(entry!.contentUrl, 'a zero-byte file now falls back to a URL rather than being withheld').toBeUndefined();
  });

  test('a second account imports the same bytes it was sent', async ({
    page,
    request,
    basePage,
    profilePage,
    loginAsUser,
  }) => {
    test.setTimeout(8 * 60_000);
    expect(roundTripPayload, 'the byte-fidelity export did not run').toBeTruthy();

    const importer = getTestUsers().specUsers[NOTEBOOK_EXPORT_IMPORTER_KEY];
    const exportFile = path.join(os.tmpdir(), `notebook-export-${Date.now()}.json`);
    fs.writeFileSync(exportFile, JSON.stringify(roundTripPayload));

    await test.step('import as the second account', async () => {
      await loginAsUser({ accessToken: importer.accessToken, userId: importer.userId });
      await profilePage.gotoProfile();
      await profilePage.clickTab('settings');
      await page.getByTestId('notebook-import-open-btn').click();
      await expect(page.getByTestId('notebook-import-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });

      await page.getByTestId('notebook-import-file-input').setInputFiles(exportFile);
      await expect(page.getByTestId('notebook-import-knowledge-switch')).toBeChecked();
      await page.getByTestId('notebook-import-submit-btn').click();
      await basePage.waitForToast('Import started');
    });

    // The import runs in the background off an S3 event, and the file it writes then has to clear
    // moderation in the new account before the export will embed it - so poll the importer's own
    // export until the bytes appear.
    //
    // Matched by HASH, not by id or name: the importing account mints its own fabFile ids, so the
    // exporter's ids are meaningless here, and the stored name is not something to rely on either.
    // The hash is the claim anyway - that the bytes A stored are the bytes B stored.
    const expected = localSha256(ROUND_TRIP_FILE);
    let seen = '';

    await expect
      .poll(
        async () => {
          try {
            // Null while the importing account still has no notebook: the import is a background
            // S3-event job, so its export 404s with NO_NOTEBOOKS until that lands. "Not yet",
            // not a failure - see tryExportViaApi.
            const exported = await tryExportViaApi(request, importer.accessToken);
            if (!exported) {
              seen = 'the importing account has no notebooks yet';
              return false;
            }
            const imported = allKnowledge(await fetchExportPayload(request, exported.downloadUrl));
            seen = imported
              .map(
                f =>
                  `${f.name}=${typeof f.content === 'string' ? sha256OfBase64(f.content).slice(0, 16) : 'no-content'}`
              )
              .join(' ');
            return imported.some(f => typeof f.content === 'string' && sha256OfBase64(f.content) === expected);
          } catch (error) {
            seen = `last attempt threw: ${String(error).slice(0, 120)}`;
            return false;
          }
        },
        {
          timeout: 4 * 60_000,
          intervals: [10_000],
          message: `no file in the importing account decodes to ${expected.slice(0, 16)} (${ROUND_TRIP_FILE}). Either the import did not finish, or the bytes changed in transit. The account held: ${seen || '<nothing>'}`,
        }
      )
      .toBe(true);
  });
});

/**
 * Upload one file at "Whole notebook" scope, which is what puts it in session.knowledgeIds, and
 * return its fabFile id. The default "Smart" scope attaches images to a single message instead,
 * and a message attachment is not knowledge - so the PNG would silently never reach the export.
 *
 * The id is the return value because every later assertion keys on it. Keying on the file name
 * instead made a byte-perfect export of all three fixtures report as a moderation timeout.
 */
async function attachAsNotebookKnowledge(page: Page, filePath: string): Promise<string> {
  await page.getByTestId('attach-files-btn').click();
  await expect(page.getByTestId('upload-from-device-btn')).toBeVisible({ timeout: TIMEOUTS.ELEMENT_STATE });

  // The testid lands on Joy's Radio ROOT span, not the input - useSlot merges forwarded props into
  // the root slot only - and that root's `overlay` action is absolutely positioned over the Chip,
  // so clicking the testid itself resolves to another element and leaves the mode alone without
  // erroring. Descend to the input, which is where the state actually lives: it needs no
  // accessible-name computation and `toBeChecked` works on it.
  //
  // The assertion is the point. A silently-unset mode falls back to "Smart", where
  // resolveAttachScope routes images to a single message, and an image that never enters
  // session.knowledgeIds is dropped from the export with no error anywhere.
  const notebookScope = page.getByTestId('attach-file-scope-notebook-radio').locator('input[type="radio"]');
  await notebookScope.check();
  await expect(notebookScope).toBeChecked();

  const created = page.waitForResponse(
    response => response.url().includes('createFabFile') && response.request().method() === 'POST',
    { timeout: TIMEOUTS.ACTION }
  );
  const fileChooser = page.waitForEvent('filechooser');
  await page.getByTestId('upload-from-device-btn').click();
  await (await fileChooser).setFiles(path.resolve(process.cwd(), filePath));

  const response = await created;
  expect(response.ok(), `createFabFile ${response.status()} for ${filePath}`).toBeTruthy();
  // createFabFile only reserves the row and a presigned URL; the bytes go up in a separate PUT.
  // waitForKnowledgeToEmbed is what waits for those to land, so nothing about them is asserted here.
  const body = await response.json();
  const fileId = (body.id ?? body._id) as string | undefined;
  expect(fileId, `createFabFile returned no id for ${filePath}`).toBeTruthy();
  return fileId!;
}

async function openExportModal(
  page: Page,
  profilePage: { gotoProfile: () => Promise<void>; clickTab: (name: string) => Promise<void> }
): Promise<void> {
  await profilePage.gotoProfile();
  await profilePage.clickTab('settings');
  await page.getByTestId('notebook-export-open-btn').click();
  await expect(page.getByTestId('notebook-export-modal')).toBeVisible({ timeout: TIMEOUTS.MODAL });
}

/** Click Export and return the payload's download URL, taken off the response the modal reads. */
async function submitExport(page: Page): Promise<string | undefined> {
  const exported = page.waitForResponse(
    response => response.url().includes('/api/notebooks/export') && response.request().method() === 'POST',
    { timeout: TIMEOUTS.ACTION }
  );
  await page.getByTestId('notebook-export-submit-btn').click();
  const body = await (await exported).json();
  expect(body.success, `export failed: ${JSON.stringify(body).slice(0, 400)}`).toBe(true);
  await expect(page.getByTestId('notebook-export-result')).toBeVisible({ timeout: TIMEOUTS.VISIBLE });
  return body.data?.downloadUrl;
}
