import { describe, it, expect, vi } from 'vitest';
import { resolveNoCardUnlockSettings } from '@bike4mind/common';
import { GithubApiError, githubValidator, phoneValidator, workEmailValidator, type GithubClient } from './noCardUnlock';

const NOW = new Date('2030-01-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();
const settings = (over: Record<string, unknown> = {}) =>
  resolveNoCardUnlockSettings({
    noCardUnlockEnabled: true,
    noCardUnlockGithubMinAgeDays: 30,
    noCardUnlockGithubMinRepos: 2,
    noCardUnlockWorkEmailDomainDailyCap: 3,
    ...over,
  });

const githubDeps = (client: Partial<GithubClient>, over: Record<string, unknown> = {}) => ({
  settings: settings(),
  github: {
    getUser: async () => ({ id: 7, login: 'octo', created_at: daysAgo(400), public_repos: 5 }),
    getEmails: async () => [{ email: 'a@b.test', verified: true, primary: true }],
    ...client,
  },
  getAccessToken: async () => 'token',
  claimGithubId: vi.fn(async () => ({ claimed: true })),
  releaseGithubId: vi.fn(async () => undefined),
  now: () => NOW,
  ...over,
});
const user = { id: 'u1', email: 'dev@acme-corp.test' };

describe('githubValidator', () => {
  it('accepts an old, active account with a verified email and claims its id', async () => {
    const deps = githubDeps({});
    const check = await githubValidator(deps)(user);
    expect(check).toMatchObject({ ok: true });
    expect(deps.claimGithubId).not.toHaveBeenCalled();
    const commit = check.ok ? await check.commit?.() : undefined;
    expect(commit).toMatchObject({ ok: true });
    expect(deps.claimGithubId).toHaveBeenCalledWith(7, 'u1');
    if (commit?.ok) await commit.release({ reasonGranted: true });
    expect(deps.releaseGithubId).not.toHaveBeenCalled();
    if (commit?.ok) await commit.release({ reasonGranted: false });
    expect(deps.releaseGithubId).toHaveBeenCalledWith(7, 'u1');
  });

  it('refuses when no token is linked', async () => {
    expect(await githubValidator(githubDeps({}, { getAccessToken: async () => null }))(user)).toEqual({
      ok: false,
      refusal: 'github_not_linked',
    });
  });

  it('refuses a young account at the boundary and accepts exactly the minimum age', async () => {
    const young = githubDeps({
      getUser: async () => ({ id: 7, login: 'o', created_at: daysAgo(29), public_repos: 5 }),
    });
    expect(await githubValidator(young)(user)).toEqual({ ok: false, refusal: 'github_too_new' });
    const exact = githubDeps({
      getUser: async () => ({ id: 7, login: 'o', created_at: daysAgo(30), public_repos: 5 }),
    });
    expect(await githubValidator(exact)(user)).toMatchObject({ ok: true });
  });

  it('refuses an unparseable creation date', async () => {
    const bad = githubDeps({ getUser: async () => ({ id: 7, login: 'o', created_at: 'nope', public_repos: 5 }) });
    expect(await githubValidator(bad)(user)).toEqual({ ok: false, refusal: 'github_too_new' });
  });

  it('refuses too few repos and a non-numeric id', async () => {
    const few = githubDeps({ getUser: async () => ({ id: 7, login: 'o', created_at: daysAgo(400), public_repos: 1 }) });
    expect(await githubValidator(few)(user)).toEqual({ ok: false, refusal: 'github_few_repos' });
    const strId = githubDeps({
      getUser: async () => ({ id: '7' as unknown as number, login: 'o', created_at: daysAgo(400), public_repos: 5 }),
    });
    expect(await githubValidator(strId)(user)).toEqual({ ok: false, refusal: 'github_not_linked' });
  });

  it('refuses when no GitHub email is verified', async () => {
    const deps = githubDeps({ getEmails: async () => [{ email: 'a@b.test', verified: false, primary: true }] });
    expect(await githubValidator(deps)(user)).toEqual({ ok: false, refusal: 'github_email_unverified' });
  });

  it('asks to reauthorize on a missing email scope instead of throwing', async () => {
    for (const status of [401, 403, 404]) {
      const deps = githubDeps({
        getEmails: async () => {
          throw new GithubApiError(status);
        },
      });
      expect(await githubValidator(deps)(user)).toEqual({ ok: false, refusal: 'github_reauthorize_required' });
    }
  });

  it('reports GitHub rate limiting separately from a missing scope', async () => {
    const deps = githubDeps({
      getUser: async () => {
        throw new GithubApiError(403, true);
      },
    });
    expect(await githubValidator(deps)(user)).toEqual({ ok: false, refusal: 'github_rate_limited' });
  });

  it('rethrows a transient GitHub failure', async () => {
    const deps = githubDeps({
      getUser: async () => {
        throw new GithubApiError(500);
      },
    });
    await expect(githubValidator(deps)(user)).rejects.toThrow('500');
  });

  it('refuses an id another user already claimed', async () => {
    const deps = githubDeps({}, { claimGithubId: async () => ({ claimed: false }) });
    const check = await githubValidator(deps)(user);
    expect(check.ok ? await check.commit?.() : null).toEqual({ ok: false, refusal: 'github_already_claimed' });
  });

  it('refuses while the age or repo minimum is unconfigured', async () => {
    for (const over of [{ noCardUnlockGithubMinAgeDays: 0 }, { noCardUnlockGithubMinRepos: 0 }]) {
      const deps = githubDeps({}, { settings: settings(over) });
      expect(await githubValidator(deps)(user)).toEqual({ ok: false, refusal: 'disabled' });
    }
  });

  it('does not claim the id when an earlier check refuses', async () => {
    const deps = githubDeps({ getUser: async () => ({ id: 7, login: 'o', created_at: daysAgo(1), public_repos: 5 }) });
    await githubValidator(deps)(user);
    expect(deps.claimGithubId).not.toHaveBeenCalled();
  });
});

describe('workEmailValidator', () => {
  const build = (over: Record<string, unknown> = {}, settingsOver: Record<string, unknown> = {}) => {
    const tryIncrement = vi.fn(async () => ({ success: true, count: 1, expiresAt: new Date(NOW.getTime() + 1000) }));
    const decrement = vi.fn(async () => 0);
    const deps = {
      settings: settings(settingsOver),
      cache: { tryIncrementWithinLimitFixedWindow: tryIncrement, decrementCounter: decrement },
      now: () => NOW,
      resolveMx: async () => [{ exchange: 'mx.acme-corp.test', priority: 10 }],
      catchAllProbe: async () => false as boolean | null,
      isDisposable: () => false,
      ...over,
    };
    return { run: workEmailValidator(deps), tryIncrement, decrement };
  };

  it('refunds the domain slot on release only while its window is still open', async () => {
    const open = build();
    const check = await open.run(user);
    const commit = check.ok ? await check.commit?.() : undefined;
    if (commit?.ok) await commit.release({ reasonGranted: false });
    expect(open.decrement).toHaveBeenCalledWith('no-card-unlock:domain:acme-corp.test');

    const rolled = build({ now: () => new Date(NOW.getTime() + 2000) });
    const late = await rolled.run(user);
    const lateCommit = late.ok ? await late.commit?.() : undefined;
    expect(lateCommit).toMatchObject({ ok: true });
    if (lateCommit?.ok) await lateCommit.release({ reasonGranted: false });
    expect(rolled.decrement).not.toHaveBeenCalled();
  });

  it('accepts a real work domain and spends the domain counter keyed on the lowercase domain', async () => {
    const { run, tryIncrement } = build();
    const check = await run({ id: 'u', email: 'Dev@ACME-Corp.test' });
    expect(check).toMatchObject({ ok: true });
    expect(tryIncrement).not.toHaveBeenCalled();
    if (check.ok) await check.commit?.();
    expect(tryIncrement).toHaveBeenCalledWith('no-card-unlock:domain:acme-corp.test', 3, 86_400_000);
  });

  it('refuses free providers, including a subdomain of one, and empty input', async () => {
    const { run } = build();
    expect(await run({ id: 'u', email: 'x@gmail.com' })).toEqual({ ok: false, refusal: 'work_email_free' });
    expect(await run({ id: 'u', email: 'x@mail.gmail.com' })).toEqual({ ok: false, refusal: 'work_email_free' });
    expect(await run({ id: 'u', email: '' })).toEqual({ ok: false, refusal: 'work_email_no_mx' });
  });

  it('refuses regional personal email providers', async () => {
    const { run } = build();
    expect(await run({ id: 'u', email: 'x@qq.com' })).toEqual({ ok: false, refusal: 'work_email_free' });
  });

  it('refuses disposable domains', async () => {
    const { run } = build({ isDisposable: () => true });
    expect(await run(user)).toEqual({ ok: false, refusal: 'work_email_disposable' });
  });

  it('refuses a domain with no MX, whether empty or a resolver error', async () => {
    expect(await build({ resolveMx: async () => [] }).run(user)).toEqual({ ok: false, refusal: 'work_email_no_mx' });
    const failing = build({
      resolveMx: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(await failing.run(user)).toEqual({ ok: false, refusal: 'work_email_no_mx' });
  });

  it('refuses a catch-all domain and never spends the counter', async () => {
    const { run, tryIncrement } = build({ catchAllProbe: async () => true });
    expect(await run(user)).toEqual({ ok: false, refusal: 'work_email_catch_all' });
    expect(tryIncrement).not.toHaveBeenCalled();
  });

  it('denies an inconclusive or throwing probe unless the setting allows it', async () => {
    for (const probe of [async () => null, async () => Promise.reject(new Error('timeout'))]) {
      expect(await build({ catchAllProbe: probe }).run(user)).toEqual({
        ok: false,
        refusal: 'work_email_probe_inconclusive',
      });
      expect(
        await build({ catchAllProbe: probe }, { noCardUnlockProbeInconclusiveAllows: true }).run(user)
      ).toMatchObject({
        ok: true,
      });
    }
  });

  it('denies at a zero cap without touching the counter, and when the counter is exhausted', async () => {
    const zero = build({}, { noCardUnlockWorkEmailDomainDailyCap: 0 });
    expect(await zero.run(user)).toEqual({ ok: false, refusal: 'domain_cap_reached' });
    expect(zero.tryIncrement).not.toHaveBeenCalled();
    const full = build({
      cache: {
        tryIncrementWithinLimitFixedWindow: async () => ({ success: false, count: 3, expiresAt: new Date() }),
        decrementCounter: async () => 0,
      },
    });
    const check = await full.run(user);
    expect(check.ok ? await check.commit?.() : null).toEqual({ ok: false, refusal: 'domain_cap_reached' });
  });
});

describe('phoneValidator', () => {
  const PHONE = '+14155552671';
  const phoneDeps = (over: Record<string, unknown> = {}) => ({
    settings: settings({ noCardUnlockPhoneEnabled: true, noCardUnlockPhoneCredits: 5 }),
    code: '123456',
    getPendingPhone: vi.fn(async () => PHONE),
    checkCode: vi.fn(async () => true),
    claimPhone: vi.fn(async () => ({ claimed: true })),
    releasePhone: vi.fn(async () => undefined),
    ...over,
  });

  it('accepts an approved code, then claims the number only on commit', async () => {
    const deps = phoneDeps();
    const check = await phoneValidator(deps)(user);
    expect(deps.checkCode).toHaveBeenCalledWith(PHONE, '123456');
    expect(deps.claimPhone).not.toHaveBeenCalled();
    const commit = check.ok ? await check.commit?.() : undefined;
    expect(commit).toMatchObject({ ok: true });
    expect(deps.claimPhone).toHaveBeenCalledWith(PHONE, 'u1');
    if (commit?.ok) await commit.release({ reasonGranted: true });
    expect(deps.releasePhone).not.toHaveBeenCalled();
    if (commit?.ok) await commit.release({ reasonGranted: false });
    expect(deps.releasePhone).toHaveBeenCalledWith(PHONE, 'u1');
  });

  it('refuses when no code was sent for this user', async () => {
    const deps = phoneDeps({ getPendingPhone: vi.fn(async () => null) });
    expect(await phoneValidator(deps)(user)).toEqual({ ok: false, refusal: 'phone_not_started' });
    expect(deps.checkCode).not.toHaveBeenCalled();
  });

  it('refuses a number blocked after the code was sent, without checking the code', async () => {
    const deps = phoneDeps({
      settings: settings({ noCardUnlockPhoneBlockedPrefixes: ['+1415'] }),
    });
    expect(await phoneValidator(deps)(user)).toEqual({ ok: false, refusal: 'phone_blocked' });
    expect(deps.checkCode).not.toHaveBeenCalled();
  });

  it('refuses a wrong code', async () => {
    const deps = phoneDeps({ checkCode: vi.fn(async () => false) });
    expect(await phoneValidator(deps)(user)).toEqual({ ok: false, refusal: 'phone_code_invalid' });
  });

  it('refuses a number another account already unlocked with', async () => {
    const deps = phoneDeps({ claimPhone: vi.fn(async () => ({ claimed: false })) });
    const check = await phoneValidator(deps)(user);
    expect(check.ok && (await check.commit?.())).toEqual({ ok: false, refusal: 'phone_already_claimed' });
  });
});
