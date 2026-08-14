import { describe, it, expect, vi, beforeEach } from 'vitest';

const { assertLakeWriteAccess, assertCanWriteDataLakeTags, reconcileDataLakeFallbackTags } = vi.hoisted(() => ({
  assertLakeWriteAccess: vi.fn(),
  assertCanWriteDataLakeTags: vi.fn(),
  reconcileDataLakeFallbackTags: vi.fn(),
}));

vi.mock('@bike4mind/services', () => ({
  dataLakeService: { assertLakeWriteAccess, assertCanWriteDataLakeTags, reconcileDataLakeFallbackTags },
}));

import { FabFileSourceType } from '@bike4mind/common';
import { BadRequestError, NotFoundError } from '@bike4mind/utils';
import { SLACK_MOCK_USER_ID } from '@bike4mind/slack';
import { ingestSlackLinkIntoLake, type SlackLinkIngestDeps } from './dataLakeLinkIngest';

const actor = {
  id: 'user-1',
  isAdmin: false,
  tags: ['beta'],
  organizationId: 'org-1',
  email: 'a@example.com',
  emailVerified: true,
};

const lake = {
  id: 'lake-1',
  name: 'Sales',
  slug: 'sales',
  status: 'active',
  datalakeTag: 'datalake:sales',
  createdByUserId: 'user-1',
};

const LINK = 'https://example.com/article';

let deps: SlackLinkIngestDeps;
let createLakeFileFromUrl: ReturnType<typeof vi.fn>;
let resolveEntitlementKeys: ReturnType<typeof vi.fn>;
let resolveMembershipOrgIds: ReturnType<typeof vi.fn>;
let listByLake: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();

  listByLake = vi.fn().mockResolvedValue([]);
  createLakeFileFromUrl = vi.fn().mockResolvedValue({ id: 'fab-1', fileName: 'An Article' });
  resolveEntitlementKeys = vi.fn().mockResolvedValue(['ent-a']);
  resolveMembershipOrgIds = vi.fn().mockResolvedValue(['org-1']);

  assertLakeWriteAccess.mockResolvedValue(lake);
  assertCanWriteDataLakeTags.mockResolvedValue(undefined);
  reconcileDataLakeFallbackTags.mockImplementation(async (tags: unknown[]) => [
    ...tags,
    { name: 'sales:uncategorized', strength: 1 },
  ]);

  deps = {
    dataLakes: {} as never,
    // Required by the write gate so a curator or transferred owner can ingest, not only the creator.
    // Supplied as a real object rather than left off: `apps/client/tsconfig.json` excludes
    // `**/*.test.ts`, so a missing adapter here is invisible to typecheck AND to a mocked runtime -
    // which is exactly how this went unguarded after the merge that made the field required.
    dataLakeAccessGrants: { listByLake } as never,
    createLakeFileFromUrl,
    resolveEntitlementKeys,
    resolveMembershipOrgIds,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

const run = (overrides: Record<string, unknown> = {}) =>
  ingestSlackLinkIntoLake(
    {
      actor,
      lakeSlug: 'sales',
      link: LINK,
      channel: 'C123',
      messageTs: '1700000000.0001',
      ...overrides,
    } as never,
    deps
  );

describe('authorization comes before any fetch', () => {
  it('refuses the SLACK_BYPASS_USER_LOOKUP mock user without touching the lake or the URL', async () => {
    const outcome = await run({ actor: { ...actor, id: SLACK_MOCK_USER_ID } });

    expect(outcome).toMatchObject({ ok: false, reason: 'unlinked_actor' });
    expect(assertLakeWriteAccess).not.toHaveBeenCalled();
    expect(createLakeFileFromUrl).not.toHaveBeenCalled();
  });

  it('does NOT fetch anything when the write gate denies', async () => {
    assertLakeWriteAccess.mockRejectedValue(new BadRequestError('Only the creator can add files to this data lake'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'not_authorized' });
    // The point of authorize-first for links: an unauthorized user must not be able to make the
    // server issue an outbound HTTP request at all.
    expect(createLakeFileFromUrl).not.toHaveBeenCalled();
  });

  it('does NOT fetch when the meta-tag gate denies', async () => {
    assertCanWriteDataLakeTags.mockRejectedValue(new BadRequestError('nope'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(createLakeFileFromUrl).not.toHaveBeenCalled();
  });

  it('maps an unreadable lake to not-found so existence is not leaked', async () => {
    assertLakeWriteAccess.mockRejectedValue(new NotFoundError('Data lake not found'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'lake_not_found' });
  });

  it('surfaces a built-in lake refusal rather than impossible "ask an admin" advice', async () => {
    assertLakeWriteAccess.mockRejectedValue(
      new BadRequestError('This data lake is built into the platform and is read-only')
    );

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'not_authorized' });
    expect(outcome.ok === false && outcome.message).toContain('built into the platform');
  });

  it('RETHROWS an infrastructure error instead of reporting a permission denial', async () => {
    assertLakeWriteAccess.mockRejectedValue(new Error('connection timed out'));

    await expect(run()).rejects.toThrow(/connection timed out/);
  });

  it('refuses a lake that is not draft or active', async () => {
    assertLakeWriteAccess.mockResolvedValue({ ...lake, status: 'archived' });

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'lake_not_writable' });
    expect(createLakeFileFromUrl).not.toHaveBeenCalled();
  });
});

describe('link validation', () => {
  it('refuses an empty link before authorizing', async () => {
    const outcome = await run({ link: '' });

    expect(outcome).toMatchObject({ ok: false, reason: 'no_link' });
    expect(assertLakeWriteAccess).not.toHaveBeenCalled();
  });

  it('refuses a non-HTTP scheme without fetching', async () => {
    const outcome = await run({ link: 'file:///etc/passwd' });

    expect(outcome).toMatchObject({ ok: false, reason: 'link_rejected' });
    expect(createLakeFileFromUrl).not.toHaveBeenCalled();
  });
});

describe('successful ingest', () => {
  it('passes the access-grant repo to the write gate, so a curator is not refused', async () => {
    // The gate resolves the lake's grants to decide whether a CURATOR or a transferred owner may
    // ingest. Nothing else guards that wiring: the field is only structurally required, and
    // `apps/client/tsconfig.json` excludes test files, so unwiring it would pass typecheck and pass a
    // mocked runtime while silently narrowing authorization back to the creator alone.
    await run();

    expect(assertLakeWriteAccess).toHaveBeenCalledWith(
      'sales',
      expect.anything(),
      expect.objectContaining({
        db: expect.objectContaining({ dataLakeAccessGrants: expect.objectContaining({ listByLake }) }),
      })
    );
  });

  it('stamps the lake tag, the fallback tag and the Slack + URL provenance', async () => {
    const outcome = await run();

    expect(createLakeFileFromUrl).toHaveBeenCalledWith('user-1', {
      url: LINK,
      tags: [
        { name: 'datalake:sales', strength: 1 },
        { name: 'sales:uncategorized', strength: 1 },
      ],
      provenance: {
        sourceType: FabFileSourceType.SLACK,
        sourceMetadata: { channel: 'C123', messageTs: '1700000000.0001', sourceUrl: LINK },
      },
    });
    expect(outcome).toEqual({ ok: true, lakeName: 'Sales', fileName: 'An Article', sourceUrl: LINK });
  });
});

describe('URL credentials are never recorded', () => {
  const WITH_CREDS = 'https://alice:s3cret@example.com/article';

  it('strips credentials from the persisted provenance but still FETCHES the original URL', async () => {
    await run({ link: WITH_CREDS });

    const params = createLakeFileFromUrl.mock.calls[0][1];
    // The fetch needs the credentials to succeed...
    expect(params.url).toBe(WITH_CREDS);
    // ...but sourceMetadata outlives the message and every lake editor can read it.
    expect(params.provenance.sourceMetadata.sourceUrl).toBe('https://example.com/article');
    expect(JSON.stringify(params.provenance)).not.toContain('s3cret');
  });

  it('strips credentials from the failure log too', async () => {
    createLakeFileFromUrl.mockRejectedValue(new Error('ETIMEDOUT'));

    await run({ link: WITH_CREDS });

    const logged = JSON.stringify((deps.logger.error as ReturnType<typeof vi.fn>).mock.calls);
    expect(logged).not.toContain('s3cret');
    expect(logged).toContain('https://example.com/article');
  });

  it('leaves a credential-free URL untouched', async () => {
    const outcome = await run();

    expect(createLakeFileFromUrl.mock.calls[0][1].provenance.sourceMetadata.sourceUrl).toBe(LINK);
    expect(outcome).toMatchObject({ ok: true, sourceUrl: LINK });
  });
});

describe('fetch failures', () => {
  it('NEVER echoes an SSRF refusal back to the user', async () => {
    // validateUrlForFetch reports the resolved address ("Hostname resolves to private IP address
    // (10.1.2.3)"). Repeating that in Slack would make `@datalake add` an internal-network scanner
    // for anyone who can type in the channel, so the reply must be fixed and detail-free.
    createLakeFileFromUrl.mockRejectedValue(
      new Error('URL blocked for security reasons: Hostname resolves to private IP address (10.1.2.3)')
    );

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'link_fetch_failed' });
    const message = outcome.ok === false ? outcome.message : '';
    expect(message).not.toContain('10.1.2.3');
    expect(message).not.toMatch(/private ip/i);
    expect(message).not.toMatch(/blocked for security/i);
    // The operator still gets the detail.
    expect(deps.logger.error).toHaveBeenCalled();
  });

  it('gives one fixed sentence for any network failure', async () => {
    createLakeFileFromUrl.mockRejectedValue(new Error('ETIMEDOUT'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'link_fetch_failed' });
    expect(outcome.ok === false && outcome.message).toMatch(/could not fetch that link/i);
  });

  it('DOES surface content-level validation, which leaks nothing', async () => {
    // A BadRequestError here is createFabFile's own check - unsupported type, over MaxFileSize -
    // and is about the fetched content rather than about our network, so it is useful to repeat.
    createLakeFileFromUrl.mockRejectedValue(new BadRequestError('File size exceeds maximum file size'));

    const outcome = await run();

    expect(outcome).toMatchObject({ ok: false, reason: 'link_rejected' });
    expect(outcome.ok === false && outcome.message).toContain('File size exceeds maximum file size');
  });
});
