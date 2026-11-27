import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthorizedError } from '@bike4mind/server-utils/utils/errors';
import { refuseBlockedAccount } from './refuseBlockedAccount';

const run = (user: Record<string, unknown> | undefined) => {
  const next = vi.fn() as unknown as NextFunction & ReturnType<typeof vi.fn>;
  refuseBlockedAccount()({ user } as unknown as Request, {} as Response, next);
  return next.mock.calls[0]?.[0];
};

describe('refuseBlockedAccount', () => {
  it.each([
    ['banned', { isBanned: true }],
    ['dispute-pending', { disputePending: true }],
    ['suspended', { moderation: { status: 'suspended' } }],
  ])('refuses a %s account with a 403', (_label, state) => {
    expect(run({ id: 'u1', ...state })).toBeInstanceOf(ForbiddenError);
  });

  it('passes an active account, including one held for signup review', () => {
    expect(run({ id: 'u1', isBanned: false, disputePending: false })).toBeUndefined();
    expect(run({ id: 'u1', riskScore: { reviewState: 'pending' } })).toBeUndefined();
  });

  it('refuses an unauthenticated request', () => {
    expect(run(undefined)).toBeInstanceOf(UnauthorizedError);
  });
});

// Every route that takes money or raises a recurring charge refuses a blocked account itself.
describe('money-in route wiring', () => {
  const routes = [
    'stripe/start-payment.ts',
    'subscriptions/subscribe.ts',
    'subscriptions/change.ts',
    'subscriptions/pay-invoice.ts',
    'organizations/subscriptions/subscribe.ts',
    'organizations/subscriptions/update-seats.ts',
  ];

  it.each(routes)('%s mounts refuseBlockedAccount ahead of its handler', route => {
    const source = readFileSync(resolve(__dirname, '../../pages/api', route), 'utf8');
    const gate = source.indexOf('.use(refuseBlockedAccount())');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(source.search(/\n {2}\.(post|put)\b/));
  });
});
