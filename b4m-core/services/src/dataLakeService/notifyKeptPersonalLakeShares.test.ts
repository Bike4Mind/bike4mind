import { describe, expect, it, vi } from 'vitest';
import {
  notifyKeptPersonalLakeShares,
  renderKeptPersonalLakeSharesEmail,
  type KeptPersonalLakeSharesNotifyDeps,
} from './notifyKeptPersonalLakeShares';

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

    expect(subject).toBe('Dana has left Acme and still has access to 2 of your data lakes');
    expect(html).toContain('Dana has left Acme and still has access to');
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
    expect(subject).toBe('Dana has left Acme and still has access to "Research"');
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
