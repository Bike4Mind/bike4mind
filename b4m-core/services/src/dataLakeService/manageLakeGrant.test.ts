import { describe, it, expect, vi } from 'vitest';
import { DATA_LAKES, type IDataLakeAccessGrantDocument, type IDataLakeDocument } from '@bike4mind/common';
import { grantLakeAccess, revokeLakeAccess } from './manageLakeGrant';
import type { ManageActor } from './manageRule';

const lake = (over: Partial<IDataLakeDocument> = {}): IDataLakeDocument =>
  ({ id: 'lake1', createdByUserId: 'creator', organizationId: 'org1', ...over }) as IDataLakeDocument;

const grantRow = (over: Partial<IDataLakeAccessGrantDocument>): IDataLakeAccessGrantDocument =>
  ({
    dataLakeId: 'lake1',
    principalType: 'user',
    principalId: 'x',
    role: 'reader',
    grantedByUserId: 'g',
    ...over,
  }) as IDataLakeAccessGrantDocument;

const makeAdapters = (
  over: {
    lakeDoc?: IDataLakeDocument | null;
    grants?: IDataLakeAccessGrantDocument[];
    existing?: IDataLakeAccessGrantDocument | null;
    userByEmail?: { id: string } | null;
    /** More than one account matching the typed address - the case-variant duplicate. */
    usersByEmail?: { id: string }[];
    removed?: boolean;
  } = {}
) => {
  const matchingUsers =
    over.usersByEmail ?? (over.userByEmail === undefined ? [{ id: 'u1' }] : over.userByEmail ? [over.userByEmail] : []);
  const upsertGrant = vi.fn(async (input: never) => grantRow(input));
  const removeGrant = vi.fn(async () => over.removed !== false);
  const record = vi.fn(async () => undefined);
  return {
    upsertGrant,
    removeGrant,
    record,
    adapters: {
      db: {
        dataLakes: { findById: vi.fn(async () => (over.lakeDoc === undefined ? lake() : over.lakeDoc)) },
        dataLakeAccessGrants: {
          listByLake: vi.fn(async () => over.grants ?? []),
          findGrant: vi.fn(async () => over.existing ?? null),
          upsertGrant,
          removeGrant,
        },
        users: { findAllByEmailsOrUsernames: vi.fn(async () => matchingUsers) },
        lakeConfigChangeEvents: { record },
      },
    } as never,
  };
};

const owner: ManageActor = { userId: 'creator', isAdmin: false };
const curator: ManageActor = { userId: 'cur', isAdmin: false };
const curatorGrants = [grantRow({ principalId: 'cur', role: 'curator' })];

describe('grantLakeAccess', () => {
  it('refuses a fallback (registry) lake before any write', async () => {
    const { adapters, upsertGrant } = makeAdapters({ lakeDoc: lake({ id: DATA_LAKES[0].id }) });
    await expect(
      grantLakeAccess(
        owner,
        DATA_LAKES[0].id,
        { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
        adapters
      )
    ).rejects.toThrow(/built into the platform/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a lake that does not exist', async () => {
    const { adapters } = makeAdapters({ lakeDoc: null });
    await expect(
      grantLakeAccess(owner, 'ghost', { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' }, adapters)
    ).rejects.toThrow(/not found/i);
  });

  it('refuses a plain reader before any write', async () => {
    const { adapters, upsertGrant } = makeAdapters({ grants: [grantRow({ principalId: 'rdr', role: 'reader' })] });
    await expect(
      grantLakeAccess(
        { userId: 'rdr', isAdmin: false },
        'lake1',
        { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
        adapters
      )
    ).rejects.toThrow(/do not have permission to manage access/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('lets a curator grant a reader, attributing the grant to the actor', async () => {
    const { adapters, upsertGrant, record } = makeAdapters({ grants: curatorGrants });
    const result = await grantLakeAccess(
      curator,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
      adapters
    );

    expect(upsertGrant).toHaveBeenCalledWith({
      dataLakeId: 'lake1',
      principalType: 'user',
      principalId: 'u1',
      role: 'reader',
      grantedByUserId: 'cur',
    });
    expect(result).toEqual({ principalType: 'user', principalId: 'u1', role: 'reader', previousRole: undefined });
    // The rung comes from the grants the gate itself used, so a curator's write is not mis-attributed
    // to the creator arm.
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'grant-access',
        manageRung: 'grant-curator',
        changes: [expect.objectContaining({ field: 'accessGrant', after: 'user:u1=reader' })],
      })
    );
  });

  it('refuses an owner grant, so a curator cannot escalate past the transfer gate', async () => {
    const { adapters, upsertGrant } = makeAdapters({ grants: curatorGrants });
    await expect(
      grantLakeAccess(curator, 'lake1', { principalType: 'user', principalEmail: 'cur@b.c', role: 'owner' }, adapters)
    ).rejects.toThrow(/transfer ownership/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses re-roling an existing owner grant down, which would un-transfer the lake', async () => {
    // The requested role is a legal 'curator', so only the check against the EXISTING row catches
    // this. Without it a curator could demote the owner through the routine sharing door.
    const { adapters, upsertGrant } = makeAdapters({
      grants: curatorGrants,
      existing: grantRow({ principalId: 'theOwner', role: 'owner' }),
      userByEmail: { id: 'theOwner' },
    });
    await expect(
      grantLakeAccess(
        curator,
        'lake1',
        { principalType: 'user', principalEmail: 'owner@b.c', role: 'curator' },
        adapters
      )
    ).rejects.toThrow(/transfer ownership/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses naming a user by id, which the door cannot resolve to an account', async () => {
    // An id is taken at face value, so a typo becomes a permanent unresolvable row and a padded or
    // recased variant a second row for the same person. Email is the only checkable input.
    const { adapters, upsertGrant } = makeAdapters();
    await expect(
      grantLakeAccess(owner, 'lake1', { principalType: 'user', principalId: 'u1', role: 'reader' }, adapters)
    ).rejects.toThrow(/by email address/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses an org curator grant, which could confer management on nobody', async () => {
    const { adapters, upsertGrant } = makeAdapters();
    await expect(
      grantLakeAccess(owner, 'lake1', { principalType: 'organization', principalId: 'org1', role: 'curator' }, adapters)
    ).rejects.toThrow(/only be granted reader access/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('clears a lapsed expiry on re-grant, and audits the restore as a fresh grant', async () => {
    // Without the clear, upsertGrant leaves the past date alone: the write lands, the caller is told
    // access was granted, and loadActiveLakeGrants still filters the row out.
    const { adapters, upsertGrant, record } = makeAdapters({
      existing: grantRow({ principalId: 'u1', role: 'reader', expiresAt: new Date(Date.now() - 86_400_000) }),
    });
    const result = await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' },
      adapters
    );

    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
    // The lapsed role is not the honest `before`: it conferred nothing, so this restored access
    // rather than downgrading it.
    expect(result.previousRole).toBeUndefined();
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: 'accessGrant', kind: 'literal', after: 'user:u1=curator' }],
      })
    );
  });

  it('audits a SAME-role re-grant over a lapsed row, which restores access', async () => {
    // The role did not move, so this is the one case where an unchanged role is still a change -
    // treating the lapsed row as `before` would make grantChange return null and lose the event.
    const { adapters, record } = makeAdapters({
      existing: grantRow({ principalId: 'u1', role: 'reader', expiresAt: new Date(Date.now() - 1000) }),
    });
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
      adapters
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: 'accessGrant', kind: 'literal', after: 'user:u1=reader' }],
      })
    );
  });

  it('leaves a still-current expiry alone', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      existing: grantRow({ principalId: 'u1', role: 'reader', expiresAt: new Date(Date.now() + 86_400_000) }),
    });
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' },
      adapters
    );
    expect(upsertGrant.mock.calls[0]![0]).not.toHaveProperty('expiresAt');
  });

  it('refuses re-roling a LAPSED owner grant: an expiry says nothing about who owns the lake', async () => {
    const { adapters, upsertGrant } = makeAdapters({
      grants: curatorGrants,
      existing: grantRow({ principalId: 'theOwner', role: 'owner', expiresAt: new Date(Date.now() - 1000) }),
      userByEmail: { id: 'theOwner' },
    });
    await expect(
      grantLakeAccess(
        curator,
        'lake1',
        { principalType: 'user', principalEmail: 'owner@b.c', role: 'curator' },
        adapters
      )
    ).rejects.toThrow(/transfer ownership/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses an org grant naming another org', async () => {
    const { adapters, upsertGrant } = makeAdapters();
    await expect(
      grantLakeAccess(owner, 'lake1', { principalType: 'organization', principalId: 'org2', role: 'reader' }, adapters)
    ).rejects.toThrow(/organization that owns it/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('records nothing when the principal already holds that role', async () => {
    const { adapters, upsertGrant, record } = makeAdapters({
      existing: grantRow({ principalId: 'u1', role: 'reader' }),
    });
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
      adapters
    );
    // The write is still made (idempotent, and it re-stamps grantedBy/expiry); the AUDIT is not,
    // because nothing moved.
    expect(upsertGrant).toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records a re-role as before -> after', async () => {
    const { adapters, record } = makeAdapters({ existing: grantRow({ principalId: 'u1', role: 'reader' }) });
    const result = await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' },
      adapters
    );
    expect(result.previousRole).toBe('reader');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: 'accessGrant', kind: 'literal', before: 'user:u1=reader', after: 'user:u1=curator' }],
      })
    );
  });

  it('resolves a user principal by exact email', async () => {
    const { adapters, upsertGrant } = makeAdapters({ userByEmail: { id: 'u9' } });
    await grantLakeAccess(owner, 'lake1', { principalType: 'user', principalEmail: 'a@b.c', role: 'reader' }, adapters);
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ principalId: 'u9' }));
  });

  it('refuses an unknown email without writing', async () => {
    const { adapters, upsertGrant } = makeAdapters({ userByEmail: null });
    await expect(
      grantLakeAccess(owner, 'lake1', { principalType: 'user', principalEmail: 'ghost@b.c', role: 'reader' }, adapters)
    ).rejects.toThrow(/no account was found/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses an AMBIGUOUS email rather than granting to an arbitrary one of the matches', async () => {
    // Email uniqueness is case-SENSITIVE while the lookup collates case-insensitively, so `a@b.c`
    // and `A@b.c` are two real accounts one typed address matches. Picking one silently is how a
    // grant lands on the wrong person; a findOne-shaped lookup cannot even see the second match.
    const { adapters, upsertGrant } = makeAdapters({ usersByEmail: [{ id: 'u1' }, { id: 'u2' }] });
    await expect(
      grantLakeAccess(owner, 'lake1', { principalType: 'user', principalEmail: 'a@b.c', role: 'reader' }, adapters)
    ).rejects.toThrow(/more than one account/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('refuses a CURATOR granting curator, so curatorship cannot propagate itself', async () => {
    const { adapters, upsertGrant } = makeAdapters({ grants: curatorGrants });
    await expect(
      grantLakeAccess(curator, 'lake1', { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' }, adapters)
    ).rejects.toThrow(/curators cannot grant curator access/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  /**
   * The refusal is "a curator grant is your ONLY authority here", not "you hold a curator grant".
   * The earlier form compared `resolveLakeManageRung` to `grant-curator`, and that function orders
   * rungs for AUDIT DISPLAY - `grant-curator` before `org-admin`, with `platform-admin` reported
   * last on purpose - so an admin who also held a curator grant on the lake was refused and told to
   * "ask an owner or an organization admin", which they were. It failed closed, so nothing leaked;
   * these two are the reason nobody would have noticed.
   */
  it.each([
    { who: 'an ORG ADMIN of the lake own org', actor: { userId: 'cur', isAdmin: false, administeredOrgIds: ['org1'] } },
    { who: 'a PLATFORM ADMIN', actor: { userId: 'cur', isAdmin: true } },
  ])('lets $who who ALSO holds a curator grant grant curator', async ({ actor }) => {
    const { adapters, upsertGrant } = makeAdapters({ grants: curatorGrants });
    await grantLakeAccess(
      actor as ManageActor,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' },
      adapters
    );
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ role: 'curator' }));
  });

  it('still refuses an org admin of some OTHER org who holds only a curator grant here', async () => {
    // The anti-cheat for the pair above: exempting on "has administeredOrgIds at all" would pass
    // them. The org rung has to actually apply to THIS lake.
    const { adapters, upsertGrant } = makeAdapters({ grants: curatorGrants });
    await expect(
      grantLakeAccess(
        { userId: 'cur', isAdmin: false, administeredOrgIds: ['org-other'] },
        'lake1',
        { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' },
        adapters
      )
    ).rejects.toThrow(/curators cannot grant curator access/i);
    expect(upsertGrant).not.toHaveBeenCalled();
  });

  it('lets an OWNER grant curator - the refusal is the rung, not the role', async () => {
    // The anti-cheat for the test above: a blanket refusal of `curator` would pass it too.
    const { adapters, upsertGrant } = makeAdapters();
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'curator' },
      adapters
    );
    expect(upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ role: 'curator' }));
  });

  it('audits an EXPIRY-ONLY change, which moves the role not at all', async () => {
    // The expiry is part of what the grant confers: shortening one is an access change, and with the
    // role alone in the audited value it landed as a write nothing recorded.
    const expiresAt = new Date(Date.now() + 86_400_000);
    const { adapters, record } = makeAdapters({ existing: grantRow({ principalId: 'u1', role: 'reader' }) });
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader', expiresAt },
      adapters
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [
          {
            field: 'accessGrant',
            kind: 'literal',
            before: 'user:u1=reader',
            after: `user:u1=reader until ${expiresAt.toISOString()}`,
          },
        ],
      })
    );
  });

  it('records nothing when an omitted expiry leaves the row exactly as it stood', async () => {
    // The anti-cheat for the test above: `expiresAt` omitted means "leave it alone", so the audit
    // has to resolve the after side against the ROW - reading the omission as a clear would record
    // a phantom "expiry removed" on every routine same-role re-grant of an expiring row.
    const { adapters, record } = makeAdapters({
      existing: grantRow({ principalId: 'u1', role: 'reader', expiresAt: new Date(Date.now() + 86_400_000) }),
    });
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
      adapters
    );
    expect(record).not.toHaveBeenCalled();
  });

  it('forwards an explicit expiry and omits the key when unset', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000);
    const withExpiry = makeAdapters();
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader', expiresAt },
      withExpiry.adapters
    );
    expect(withExpiry.upsertGrant).toHaveBeenCalledWith(expect.objectContaining({ expiresAt }));

    // Omitted, not `undefined`: upsertGrant leaves an existing expiry alone only when the key is
    // absent, so passing it through unconditionally would clear nothing but read as if it might.
    const without = makeAdapters();
    await grantLakeAccess(
      owner,
      'lake1',
      { principalType: 'user', principalEmail: 'u1@b.c', role: 'reader' },
      without.adapters
    );
    expect(without.upsertGrant.mock.calls[0]![0]).not.toHaveProperty('expiresAt');
  });
});

describe('revokeLakeAccess', () => {
  it('refuses a plain reader before any write', async () => {
    const { adapters, removeGrant } = makeAdapters({ grants: [grantRow({ principalId: 'rdr', role: 'reader' })] });
    await expect(
      revokeLakeAccess(
        { userId: 'rdr', isAdmin: false },
        'lake1',
        { principalType: 'user', principalId: 'u1' },
        adapters
      )
    ).rejects.toThrow(/do not have permission to manage access/i);
    expect(removeGrant).not.toHaveBeenCalled();
  });

  it('refuses revoking an ownership grant', async () => {
    const { adapters, removeGrant } = makeAdapters({ existing: grantRow({ principalId: 'u1', role: 'owner' }) });
    await expect(
      revokeLakeAccess(owner, 'lake1', { principalType: 'user', principalId: 'u1' }, adapters)
    ).rejects.toThrow(/transfer ownership/i);
    expect(removeGrant).not.toHaveBeenCalled();
  });

  it('revokes a reader and records one audit row', async () => {
    const { adapters, removeGrant, record } = makeAdapters({
      existing: grantRow({ principalId: 'u1', role: 'reader' }),
    });
    const result = await revokeLakeAccess(owner, 'lake1', { principalType: 'user', principalId: 'u1' }, adapters);

    expect(result).toEqual({ revoked: true });
    expect(removeGrant).toHaveBeenCalledWith('lake1', 'user', 'u1');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'revoke-access',
        changes: [{ field: 'accessGrant', kind: 'literal', before: 'user:u1=reader' }],
      })
    );
  });

  it('carries the dead expiry of a LAPSED row into the audited `before`', async () => {
    // Otherwise the history reads as though live access was taken away, when the row had already
    // conferred nothing. The role cannot simply be dropped the way the grant door drops a lapsed
    // `previousRole`: with no `after` side that returns null and loses the event entirely.
    const expiresAt = new Date(Date.now() - 86_400_000);
    const { adapters, record } = makeAdapters({ existing: grantRow({ principalId: 'u1', role: 'reader', expiresAt }) });
    await revokeLakeAccess(owner, 'lake1', { principalType: 'user', principalId: 'u1' }, adapters);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        changes: [{ field: 'accessGrant', kind: 'literal', before: `user:u1=reader until ${expiresAt.toISOString()}` }],
      })
    );
  });

  it('is a no-op for a principal with no grant', async () => {
    const { adapters, removeGrant, record } = makeAdapters({ existing: null });
    await expect(
      revokeLakeAccess(owner, 'lake1', { principalType: 'user', principalId: 'u1' }, adapters)
    ).resolves.toEqual({ revoked: false });
    expect(removeGrant).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });
});
