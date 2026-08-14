import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@server/utils/config';
import { issueSessionForRequest } from '@server/auth/issueSession';
import { userRepository } from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { PREDEFINED_USER_TAGS, CURRENT_POLICY_VERSION } from '@bike4mind/common';
import { Resource } from 'sst';
import { Request } from 'express';

interface CreateTestUserBody {
  username: string;
  email: string;
  name: string;
  password: string;
  isAdmin?: boolean;
  emailVerified?: boolean;
  tags?: string[];
  // Whether to pre-record AUP/ToS acceptance so the user clears the consent gate and skips the
  // /accept-policies interstitial. Defaults to true - test users start fully onboarded like
  // `emailVerified`. Pass false to mint an un-consented user for testing the gate itself.
  acceptedPolicies?: boolean;
  // Starting credit balance. Defaults to a deliberately enormous grant so latency/tool suites
  // never run dry mid-run. Pass a small value to mint a low-balance user for the credit-gate spec.
  initialCredits?: number;
}

// Effectively unlimited for E2E: large enough that no realistic multi-prompt run can exhaust it,
// decoupling the latency/tool suites from model pricing. Credit enforcement stays ON, so the
// reservation/reconciliation path is still exercised - the user just never hits the gate.
const DEFAULT_E2E_INITIAL_CREDITS = 10_000_000;

const handler = baseApi({ auth: false }).post(
  asyncHandler(async (req: Request<unknown, unknown, CreateTestUserBody>, res) => {
    // Guard 1: Only allow on local dev and preview deployments
    if (!isE2EEnabled()) {
      return res.status(403).json({ error: 'Test user creation is only available in development/preview' });
    }

    // Guard 2: Require shared secret - read from SST secret (local/staging) or env var (preview deploys)
    const secret = req.headers['x-e2e-cleanup-secret'];
    const expectedSecret = Resource.E2E_CLEANUP_SECRET?.value || process.env.E2E_CLEANUP_SECRET;
    if (!expectedSecret || expectedSecret === 'not-configured' || secret !== expectedSecret) {
      return res.status(401).json({ error: 'Invalid cleanup secret' });
    }

    const { username, email, name, password, isAdmin, emailVerified, tags, acceptedPolicies, initialCredits } =
      req.body;

    // Guard 3: Only allow creating users with the E2E email pattern
    const E2E_EMAIL_PATTERN = /-e2e@test\.com$/i;
    if (!E2E_EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: 'Test users must use the -e2e@test.com email pattern' });
    }

    const newUser = await userService.createUser(
      {
        username,
        email,
        name,
        record: {
          password,
          // E2E harness supplies this password directly (not an auto-generated
          // placeholder), so it's a real, usable credential for this test account.
          hasUsablePassword: !!password,
          // Stamp AUP/ToS acceptance so the seeded user clears the consent gate and isn't bounced
          // to /accept-policies on first load. Defaults on; opt out to test the gate itself.
          ...((acceptedPolicies ?? true) ? { aupAcceptedVersion: CURRENT_POLICY_VERSION } : {}),
        },
        isAdmin: isAdmin ?? false,
        emailVerified: emailVerified ?? true,
        tags: [...PREDEFINED_USER_TAGS, ...(tags ?? [])],
        initialCredits: initialCredits ?? DEFAULT_E2E_INITIAL_CREDITS,
      },
      { db: { users: userRepository } }
    );

    const { accessToken, refreshToken } = await issueSessionForRequest(req, newUser.id, {
      createdVia: 'otc',
      tokenVersion: newUser.tokenVersion ?? 0,
    });
    return res.status(201).json({ user: newUser, accessToken, refreshToken });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
