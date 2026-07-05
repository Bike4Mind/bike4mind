import { asyncHandler } from '@server/middlewares/asyncHandler';
import { baseApi } from '@server/middlewares/baseApi';
import { isE2EEnabled } from '@server/utils/config';
import { authTokenGenerator } from '@server/auth/tokenGenerator';
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
}

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

    const { username, email, name, password, isAdmin, emailVerified, tags, acceptedPolicies } = req.body;

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
          // Stamp AUP/ToS acceptance so the seeded user clears the consent gate and isn't bounced
          // to /accept-policies on first load. Defaults on; opt out to test the gate itself.
          ...((acceptedPolicies ?? true) ? { aupAcceptedVersion: CURRENT_POLICY_VERSION } : {}),
        },
        isAdmin: isAdmin ?? false,
        emailVerified: emailVerified ?? true,
        tags: [...PREDEFINED_USER_TAGS, ...(tags ?? [])],
        initialCredits: 10_000,
      },
      { db: { users: userRepository } }
    );

    return res.status(201).json({
      user: newUser,
      ...authTokenGenerator.createAccessToken(newUser.id, newUser.tokenVersion ?? 0),
    });
  })
);

export const config = {
  api: {
    externalResolver: true,
  },
};

export default handler;
