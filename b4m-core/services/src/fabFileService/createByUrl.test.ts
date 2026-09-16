import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { DuplicateFabFileError, FabFileSourceType, KnowledgeType } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

/**
 * `createFabFileByUrl` had no tests. These cover the tag/provenance pass-through added for LINK
 * ingest, and - the load-bearing one - that neither can be supplied through the parsed request
 * body, only by a server-side caller that has already run the lake write gate.
 */

const fetchAndParseURL = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  fetchAndParseURL,
}));

import { createFabFileByUrl } from './createByUrl';

const URL_UNDER_TEST = 'https://example.com/article';

// Long enough to clear MIN_CONTENT_LENGTH_FOR_DEDUP, unlike the 'body text' default mock below.
const LONG_BODY_TEXT =
  'This article body has more than a hundred characters of genuine content, well past the ' +
  'boilerplate-remnant length that skips content-hash dedup.';
const LONG_BODY_TEXT_HASH = 'f2048f73c97722d6e40abe470e0563fed1ccf1f80a0a1ed6ce25e8ab72290a60';

let fabFilesCreate: Mock;
let storageUpload: Mock;

function adapters() {
  return {
    db: {
      fabFiles: { create: fabFilesCreate },
      adminSettings: {
        findAll: vi.fn().mockResolvedValue([]),
        findBySettingNames: vi.fn().mockResolvedValue([]),
      } as never,
      users: {
        findById: vi.fn().mockResolvedValue({ id: 'user-1', storageLimit: 1_000_000, currentStorageSize: 0 } as never),
      },
    },
    storage: {
      upload: storageUpload,
      generateSignedUrl: vi.fn().mockResolvedValue('https://s3.example.com/signed'),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fabFilesCreate = vi.fn().mockImplementation(async data => ({ id: 'fab-1', ...data }));
  storageUpload = vi.fn().mockResolvedValue(undefined);
  fetchAndParseURL.mockResolvedValue({
    title: 'An Article',
    textContent: 'body text',
    mimeType: 'text/plain',
    ext: 'txt',
  });
});

describe('createFabFileByUrl', () => {
  it('creates a URL-type file from the fetched content and uploads it', async () => {
    const result = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    expect(fetchAndParseURL).toHaveBeenCalledWith(URL_UNDER_TEST, expect.anything());
    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.fileName).toBe('An Article');
    expect(created.type).toBe(KnowledgeType.URL);
    expect(created.fileSize).toBe(Buffer.byteLength('body text'));
    // Uploaded to the path createFabFile allocated, so S3 ObjectCreated picks it up as usual.
    expect(storageUpload).toHaveBeenCalledWith(created.filePath, 'body text', { ContentType: 'text/plain' });
    expect(result.id).toBe('fab-1');
  });

  it('accepts a dotted page title and keeps it as the fileName', async () => {
    // Regression guard: `path.extname` treats any mid-string dot as an extension, so a title like
    // this used to be refused as an unresolvable extension. The door's mimeType comes from the
    // fetch response, not the title, so it must win.
    fetchAndParseURL.mockResolvedValue({
      title: 'Node.js Documentation',
      textContent: 'body text',
      mimeType: 'text/html',
    });

    const result = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.fileName).toBe('Node.js Documentation');
    expect(result.id).toBe('fab-1');
  });

  it('accepts another dotted title shape with no resolvable extension', async () => {
    fetchAndParseURL.mockResolvedValue({
      title: 'docs.python.org',
      textContent: 'body text',
      mimeType: 'text/html',
    });

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    expect(fabFilesCreate.mock.calls[0][0].fileName).toBe('docs.python.org');
  });

  it('creates normally when textContent is a non-empty Buffer (the PDF arm)', async () => {
    // The PDF arm of fetchAndParseURL returns raw bytes rather than a string; confirms the
    // zero-length guard does not reject a Buffer that legitimately carries content.
    fetchAndParseURL.mockResolvedValue({
      title: 'report.pdf',
      textContent: Buffer.from('%PDF-1.4 fake pdf bytes'),
      mimeType: 'application/pdf',
    });

    const result = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    expect(result.id).toBe('fab-1');
    expect(storageUpload).toHaveBeenCalledWith(expect.any(String), Buffer.from('%PDF-1.4 fake pdf bytes'), {
      ContentType: 'application/pdf',
    });
  });

  it('rejects a zero-length Buffer instead of creating a phantom 0-byte PDF file', async () => {
    // Inverted from a prior version of this test that pinned a zero-length Buffer as an accepted
    // create - that was the phantom-file bug: a PDF-typed response with an empty body must be
    // refused the same as an empty extracted string, not treated as "legitimately empty".
    fetchAndParseURL.mockResolvedValue({
      title: 'report.pdf',
      textContent: Buffer.alloc(0),
      mimeType: 'application/pdf',
    });

    const thrown: unknown = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters()).catch(e => e);

    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).message).toMatch(/no readable text/i);
    expect(fabFilesCreate).not.toHaveBeenCalled();
  });

  it('stamps adapter-supplied tags on the created file', async () => {
    const tags = [{ name: 'lake:demo', strength: 1 }];

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), tags });

    expect(fabFilesCreate.mock.calls[0][0].tags).toEqual(tags);
  });

  it('stamps adapter-supplied provenance on the created file', async () => {
    await createFabFileByUrl(
      'user-1',
      { url: URL_UNDER_TEST },
      {
        ...adapters(),
        provenance: {
          sourceType: FabFileSourceType.SLACK,
          sourceMetadata: { channel: 'C1', messageTs: '1700000000.0001', sourceUrl: URL_UNDER_TEST },
        },
      }
    );

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.sourceType).toBe(FabFileSourceType.SLACK);
    expect(created.sourceMetadata).toEqual({
      channel: 'C1',
      messageTs: '1700000000.0001',
      sourceUrl: URL_UNDER_TEST,
    });
  });

  it('sets no tags or provenance when the caller supplies none (the web URL door, unchanged)', async () => {
    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.tags).toBeUndefined();
    expect(created.sourceType).toBeUndefined();
    expect(created.sourceMetadata).toBeUndefined();
  });

  it('IGNORES tags and provenance smuggled through the request body', async () => {
    // The security property: `createFabFileByUrlSchema` is parsed from an HTTP body, so a caller
    // must not be able to put a file into a data lake by naming its meta-tag, nor forge a Slack
    // origin. Both are adapters precisely so this cannot work.
    await createFabFileByUrl(
      'user-1',
      {
        url: URL_UNDER_TEST,
        tags: [{ name: 'lake:private', strength: 1 }],
        provenance: { sourceType: FabFileSourceType.SLACK },
      } as never,
      adapters()
    );

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.tags).toBeUndefined();
    expect(created.sourceType).toBeUndefined();
  });

  it('rejects a Google Drive link before fetching anything', async () => {
    await expect(
      createFabFileByUrl('user-1', { url: 'https://drive.google.com/file/d/abcdefghij/view' }, adapters())
    ).rejects.toThrow();

    expect(fetchAndParseURL).not.toHaveBeenCalled();
  });

  it('stamps a contentHash of the fetched textContent when a caller opts into checkDuplicate', async () => {
    // #2027: URL-created files previously stored NO contentHash at all, which is why the link path
    // had nothing to dedupe against. Stamped only for a caller that opts into ingest-time dedup -
    // see the next test for why NOT stamping it for every caller matters.
    fetchAndParseURL.mockResolvedValue({ title: 'An Article', textContent: LONG_BODY_TEXT, mimeType: 'text/plain' });
    const checkDuplicate = vi.fn().mockResolvedValue(null);

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), checkDuplicate });

    const created = fabFilesCreate.mock.calls[0][0];
    // sha256(LONG_BODY_TEXT), computed independently rather than trusted from the implementation.
    expect(created.contentHash).toBe(LONG_BODY_TEXT_HASH);
  });

  it('does NOT stamp a contentHash when no caller opts into checkDuplicate (web upload, proposal admission)', async () => {
    // The stamp is deliberately coupled to opting into dedup, not stamped unconditionally:
    // `unarchiveDataLake`'s hard-delete dedup pass reads `contentHash` across every FabFile
    // regardless of door, and this door hashes extracted TEXT (not the URL) - two provenance-distinct
    // rows with identical body text would otherwise collide there too, for doors that never asked
    // for content-hash dedup at all.
    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.contentHash).toBeUndefined();
  });

  it('does not compute, check, or stamp a contentHash for HTML text below MIN_CONTENT_LENGTH_FOR_DEDUP', async () => {
    // A chrome-pruning rollback can leave a link-directory-style page with nothing but a short
    // boilerplate remnant. Hashing that remnant would let two UNRELATED pages that happen to reduce
    // to the same short text collide on content hash - the second would be rejected outright as a
    // duplicate of the first, instead of just being thinner than it should be.
    fetchAndParseURL.mockResolvedValue({ title: 'Thin Page', textContent: 'body text', mimeType: 'text/plain' });
    const checkDuplicate = vi.fn().mockResolvedValue(null);

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), checkDuplicate });

    expect(checkDuplicate).not.toHaveBeenCalled();
    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.contentHash).toBeUndefined();
  });

  it('does compute, check, and stamp a contentHash for PDF bytes shorter than MIN_CONTENT_LENGTH_FOR_DEDUP', async () => {
    // The dedup skip above is specific to HTML EXTRACTION's chrome-pruning floor - a short PDF is
    // just a short PDF, with no equivalent boilerplate-collision risk, so it is unaffected.
    const shortPdfBytes = Buffer.from('short pdf');
    fetchAndParseURL.mockResolvedValue({ title: 'Short.pdf', textContent: shortPdfBytes, mimeType: 'application/pdf' });
    const checkDuplicate = vi.fn().mockResolvedValue(null);

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), checkDuplicate });

    expect(checkDuplicate).toHaveBeenCalled();
    const created = fabFilesCreate.mock.calls[0][0];
    expect(created.contentHash).toBeDefined();
  });

  it('does not compute, check, or stamp a contentHash when the fetch returned no content', async () => {
    // Regression guard: computeContentHash('') would otherwise be a shared dedup key across every
    // JS-only/paywalled page that yields no extractable text, making unrelated empty fetches look
    // like duplicates of each other.
    fetchAndParseURL.mockResolvedValue({ textContent: '', mimeType: 'text/html', title: 'Empty Page' });
    const checkDuplicate = vi.fn().mockResolvedValue(null);

    const thrown: unknown = await createFabFileByUrl(
      'user-1',
      { url: URL_UNDER_TEST },
      { ...adapters(), checkDuplicate }
    ).catch(e => e);

    expect(thrown).toBeInstanceOf(BadRequestError);
    expect((thrown as BadRequestError).message).toMatch(/no readable text/i);
    expect(checkDuplicate).not.toHaveBeenCalled();
    expect(fabFilesCreate).not.toHaveBeenCalled();
  });
});

/**
 * #2027: the link path had no dedup at all - `createFabFileByUrl` fetches and creates as one step,
 * so there is nowhere to check a hash unless the service itself is taught to. `checkDuplicate` is
 * the hook for that: optional, so the web URL door and the proposal-admission door (neither passes
 * it) are provably unaffected.
 */
describe('createFabFileByUrl per-content dedup (checkDuplicate)', () => {
  it('creates normally with no checkDuplicate adapter at all (every existing caller)', async () => {
    // Not a spy call assertion (there is nothing to spy on when the field is genuinely absent from
    // the adapters object) - this proves the OPTIONAL adapter's absence doesn't change create
    // behavior for the web URL door and the proposal-admission door, neither of which passes it.
    const result = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, adapters());

    expect(result.id).toBe('fab-1');
    expect(fabFilesCreate).toHaveBeenCalled();
  });

  it('creates normally when checkDuplicate finds nothing', async () => {
    fetchAndParseURL.mockResolvedValue({ title: 'An Article', textContent: LONG_BODY_TEXT, mimeType: 'text/plain' });
    const checkDuplicate = vi.fn().mockResolvedValue(null);

    const result = await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), checkDuplicate });

    // Pinned to the actual hash, not just "some string": proves checkDuplicate is keyed on the
    // real content hash rather than a placeholder that happens to also be a string.
    expect(checkDuplicate).toHaveBeenCalledWith(LONG_BODY_TEXT_HASH);
    expect(result.id).toBe('fab-1');
    expect(fabFilesCreate).toHaveBeenCalled();
  });

  it('throws DuplicateFabFileError carrying the match and the newly-fetched title, and creates nothing', async () => {
    fetchAndParseURL.mockResolvedValue({ title: 'An Article', textContent: LONG_BODY_TEXT, mimeType: 'text/plain' });
    const existing = { id: 'fab-existing', fileName: 'An Article (older)' };
    const checkDuplicate = vi.fn().mockResolvedValue(existing);

    const thrown: unknown = await createFabFileByUrl(
      'user-1',
      { url: URL_UNDER_TEST },
      { ...adapters(), checkDuplicate }
    ).catch(e => e);

    expect(thrown).toBeInstanceOf(DuplicateFabFileError);
    expect((thrown as DuplicateFabFileError).existing).toBe(existing);
    expect((thrown as DuplicateFabFileError).fetchedTitle).toBe('An Article');
    expect(fabFilesCreate).not.toHaveBeenCalled();
    expect(storageUpload).not.toHaveBeenCalled();
  });

  it('runs the fetch exactly once even when a duplicate is found - no re-fetch to re-check', async () => {
    const checkDuplicate = vi.fn().mockResolvedValue({ id: 'fab-existing' });

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), checkDuplicate }).catch(() => {});

    expect(fetchAndParseURL).toHaveBeenCalledTimes(1);
  });
});

/**
 * The row is created BEFORE its bytes are uploaded. An un-transactioned caller (the Slack link path)
 * therefore needs a compensating delete, or a failed upload strands a file that can never be indexed:
 * chunk/vectorize runs off the S3 ObjectCreated event, which never fires for an object that was never
 * written.
 */
describe('createFabFileByUrl upload failure', () => {
  it('deletes the created file and rethrows the upload error', async () => {
    storageUpload.mockRejectedValue(new Error('S3 unavailable'));
    const deleteCreatedFile = vi.fn().mockResolvedValue(undefined);

    await expect(
      createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), deleteCreatedFile } as never)
    ).rejects.toThrow(/S3 unavailable/);

    expect(deleteCreatedFile).toHaveBeenCalledWith('fab-1');
  });

  it('still surfaces the UPLOAD error when the compensating delete also fails', async () => {
    // The cleanup failure must not mask the real cause, or the caller reports the wrong thing.
    storageUpload.mockRejectedValue(new Error('S3 unavailable'));
    const deleteCreatedFile = vi.fn().mockRejectedValue(new Error('mongo unreachable'));

    await expect(
      createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), deleteCreatedFile } as never)
    ).rejects.toThrow(/S3 unavailable/);
  });

  it('does not attempt cleanup when the upload succeeds', async () => {
    const deleteCreatedFile = vi.fn();

    await createFabFileByUrl('user-1', { url: URL_UNDER_TEST }, { ...adapters(), deleteCreatedFile } as never);

    expect(deleteCreatedFile).not.toHaveBeenCalled();
  });
});
