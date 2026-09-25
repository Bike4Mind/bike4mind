import { describe, expect, it, vi } from 'vitest';
import type { IDataLakeAccessGrantDocument, IDataLakeDocument } from '@bike4mind/common';
import {
  notifyKeptPersonalLakeShares,
  renderKeptPersonalLakeSharesEmail,
  type KeptPersonalLakeSharesNotifyDeps,
} from './notifyKeptPersonalLakeShares';
import { reportKeptPersonalLakeShares } from './reportKeptPersonalLakeShares';

describe('renderKeptPersonalLakeSharesEmail', () => {
  it('names the member, the org and every lake, and links to the app', () => {
    const { subject, html } = renderKeptPersonalLakeSharesEmail({
      memberName: 'Dana',
      organizationName: 'Acme',
      lakes: [
        { id: 'l1', name: 'Research' },
        { id: 'l2', name: 'Notes' },
      ],
      appUrl: 'https://app.example.test',
    });

    expect(subject).toBe('Dana has left Acme and still has shares on 2 of your data lakes');
    expect(html).toContain('Dana has left Acme and still has shares on');
    expect(html).toContain('<li>Research</li>');
    expect(html).toContain('<li>Notes</li>');
    expect(html).toContain('href="https://app.example.test"');
  });

  it('names a single lake in the subject', () => {
    const { subject } = renderKeptPersonalLakeSharesEmail({
      memberName: 'Dana',
      organizationName: 'Acme',
      lakes: [{ id: 'l1', name: 'Research' }],
    });
    expect(subject).toBe('Dana has left Acme and still has a share on "Research"');
  });

  it('escapes user-supplied names in the body and strips newlines from the subject', () => {
    const { subject, html } = renderKeptPersonalLakeSharesEmail({
      memberName: '<b>Dana</b>',
      organizationName: 'Acme\r\nBcc: x@example.test',
      lakes: [{ id: 'l1', name: '<script>' }],
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&lt;b&gt;Dana&lt;/b&gt;');
    expect(subject).not.toMatch(/[\r\n]/);
  });
});

// EnforceLakeReadGrants (resolveLakeReadAccess.ts) can be OFF - at an unwired call site or on a
// thrown settings read, not only when an operator flips it - and a reader-only grant then admits
// nobody. The report and the email describe a retained GRANT rather than usable access, so neither
// the count nor the wording may vary with the grant's role. Deliberately reads no flag: so does the
// report.
describe('a reader-only grant', () => {
  it('is counted and worded as a retained share', async () => {
    const lakeId = '0'.repeat(23) + '1';
    const grant = {
      dataLakeId: lakeId,
      principalType: 'user',
      principalId: 'dana',
      role: 'reader',
      grantedByUserId: 'owner-1',
      expiresAt: null,
    } as IDataLakeAccessGrantDocument;
    const lake = { id: lakeId, name: 'Research', createdByUserId: 'alice' } as IDataLakeDocument;
    const adapters = {
      db: {
        dataLakes: { findByIds: vi.fn().mockResolvedValue([lake]) },
        dataLakeAccessGrants: {
          listByPrincipal: vi.fn().mockResolvedValue([grant]),
          listActiveByLakes: vi.fn().mockResolvedValue([]),
        },
      },
    };

    const shares = await reportKeptPersonalLakeShares('dana', ['alice'], adapters);
    expect(shares).toEqual({
      lakeCount: 1,
      byOwner: [{ ownerUserId: 'alice', lakes: [{ id: lakeId, name: 'Research' }] }],
    });

    const { subject } = renderKeptPersonalLakeSharesEmail({
      memberName: 'Dana',
      organizationName: 'Acme',
      lakes: shares.byOwner[0].lakes,
    });
    expect(subject).toBe('Dana has left Acme and still has a share on "Research"');
  });
});

describe('notifyKeptPersonalLakeShares', () => {
  const deps = (sendEmail: KeptPersonalLakeSharesNotifyDeps['mailer']['sendEmail']) => {
    const warn = vi.fn();
    return {
      warn,
      deps: {
        db: {
          users: {
            findByIds: vi.fn().mockResolvedValue([{ id: 'dana', name: 'Dana', email: 'dana@example.test' }]),
            findActiveEmailsByIds: vi.fn().mockResolvedValue([
              { id: 'alice', email: 'alice@example.test' },
              { id: 'bob', email: 'bob@example.test' },
            ]),
          },
        },
        mailer: { sendEmail },
        logger: { warn },
      } as unknown as KeptPersonalLakeSharesNotifyDeps,
    };
  };
  const shares = {
    lakeCount: 3,
    byOwner: [
      {
        ownerUserId: 'alice',
        lakes: [
          { id: 'l1', name: 'One' },
          { id: 'l2', name: 'Two' },
        ],
      },
      { ownerUserId: 'bob', lakes: [{ id: 'l3', name: 'Three' }] },
    ],
  };
  const context = { departedUserId: 'dana', organizationName: 'Acme' };

  it("sends one email per owner, listing that owner's lakes only", async () => {
    const sendEmail = vi.fn().mockResolvedValue(true);
    const { deps: d } = deps(sendEmail);

    await notifyKeptPersonalLakeShares(shares, context, d);

    expect(sendEmail).toHaveBeenCalledTimes(2);
    const [[toAlice, alice], [toBob, bob]] = sendEmail.mock.calls;
    expect(toAlice).toBe('alice@example.test');
    expect(alice.html).toContain('<li>One</li>');
    expect(alice.html).toContain('<li>Two</li>');
    expect(alice.html).not.toContain('Three');
    expect(toBob).toBe('bob@example.test');
    expect(bob.html).toContain('<li>Three</li>');
  });

  it('never throws when the mailer does, and logs instead', async () => {
    const sendEmail = vi.fn().mockRejectedValue(new Error('smtp down'));
    const { deps: d, warn } = deps(sendEmail);

    await expect(notifyKeptPersonalLakeShares(shares, context, d)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  // MailService resolves `false` on a send failure instead of rejecting, so this branch is the only
  // thing that tells a half-delivered run from a clean one.
  it('counts a send that resolves false as failed, and still resolves', async () => {
    const sendEmail = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { deps: d, warn } = deps(sendEmail);

    await expect(notifyKeptPersonalLakeShares(shares, context, d)).resolves.toBeUndefined();

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.any(String), { failed: 1 });
  });

  it('never throws when the user lookup does', async () => {
    const { deps: d, warn } = deps(vi.fn());
    vi.mocked(d.db.users.findActiveEmailsByIds).mockRejectedValue(new Error('db down'));

    await expect(notifyKeptPersonalLakeShares(shares, context, d)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('warns once naming an owner skipped for having no emailed account, and mails the rest', async () => {
    const sendEmail = vi.fn().mockResolvedValue(true);
    const { deps: d, warn } = deps(sendEmail);
    vi.mocked(d.db.users.findActiveEmailsByIds).mockResolvedValue([{ id: 'alice', email: 'alice@example.test' }]);

    await expect(notifyKeptPersonalLakeShares(shares, context, d)).resolves.toBeUndefined();

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith('alice@example.test', expect.anything());
    expect(warn).toHaveBeenCalledWith(expect.any(String), { departedUserId: 'dana', skippedOwnerIds: ['bob'] });
  });

  it('does nothing when there is nothing to report', async () => {
    const sendEmail = vi.fn();
    const { deps: d } = deps(sendEmail);

    await notifyKeptPersonalLakeShares({ lakeCount: 0, byOwner: [] }, context, d);

    expect(d.db.users.findByIds).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
