import type { Request } from 'express';
import type { IUserAcquisition, IUserAcquisitionTouch } from '@bike4mind/common';
import { User } from '@bike4mind/database';
import { resolveServerConsent } from '@bike4mind/server-utils/analytics/serverConsent';
import { emitSignupForSourceProducts } from '@bike4mind/server-utils/analytics/signupEvents';

/**
 * Credit for an account created to sign in to an OAuth client: a product that signs its users in
 * through this app sends them to /oauth/authorize, they create an account there, and the account's
 * first authorization code goes back to that product's client. The campaign touches miss them,
 * because the visitor arrives with the product's OAuth request, not with `utm_*` tags, so a client
 * registered with an `overwatchProductId` is credited here instead.
 *
 * The account is recorded with `acquisition.oauthTouch` (source: the client's product, medium:
 * `oauth`, content: its client_id) and the product is sent the `signup` the campaign touches would
 * have sent it. From then on emitBillingEvent credits the account's payments to it, like any
 * source product (signupEvents.ts, sourceProducts).
 */

/**
 * How long after an account is created its first code may come and still count as the reason the
 * account was made. An email-code signup inside an authorize flow takes minutes; an account
 * created to use this app directly and connected to a product later is outside it.
 */
export const OAUTH_SIGNUP_WINDOW_MS = 30 * 60 * 1000;

export const OAUTH_TOUCH_MEDIUM = 'oauth';

type CreditClient = { clientId: string; overwatchProductId?: string | null };

type CreditUser = {
  createdAt?: Date | string | null;
  acquisition?: IUserAcquisition | null;
  authProviders?: Array<{ strategy?: string | null }> | null;
  isSynthetic?: boolean | null;
  isInternal?: boolean | null;
  isAdmin?: boolean | null;
};

/**
 * Record the credit and send the product its signup, at most once per account. Gated on the same
 * consent as the campaign touches (readConsentedAcquisitionTouches), skipped for synthetic accounts
 * as signups skip them, and only for an account created within OAUTH_SIGNUP_WINDOW_MS. The write
 * is conditional, so an account is credited to one client however many codes it is issued. Never
 * throws: a code must not fail on analytics. Resolves to the products a signup was attempted for
 * (see emitSignupForSourceProducts).
 */
export async function creditOAuthSignup(opts: {
  req: Pick<Request, 'headers'>;
  userId: string;
  client: CreditClient;
  now?: Date;
}): Promise<string[]> {
  const productId = opts.client.overwatchProductId;
  if (!productId) return [];
  try {
    if (resolveServerConsent(opts.req) !== 'granted') return [];
    const now = opts.now ?? new Date();
    const windowStart = new Date(now.getTime() - OAUTH_SIGNUP_WINDOW_MS);

    const user = await User.findById(opts.userId)
      .select('createdAt acquisition authProviders isSynthetic isInternal isAdmin')
      .lean<CreditUser>();
    if (!user || user.isSynthetic) return [];
    const createdAt = user.createdAt ? new Date(user.createdAt) : undefined;
    if (!createdAt || !(createdAt.getTime() >= windowStart.getTime())) return [];

    const touch: IUserAcquisitionTouch = {
      source: productId,
      medium: OAUTH_TOUCH_MEDIUM,
      content: opts.client.clientId,
    };
    // signupMethod is required on a stored acquisition. An account with none had no touch to store at
    // signup, so its method is inferred from its first sign-in provider, as the admin users list does.
    const signupMethod = user.acquisition?.signupMethod ?? user.authProviders?.[0]?.strategy ?? 'otc';
    // Conditional on the touch not being there yet, so a second code, or a concurrent one for another
    // client, finds it written and credits nothing.
    const written = user.acquisition
      ? await User.updateOne(
          { _id: opts.userId, 'acquisition.oauthTouch': { $exists: false } },
          { $set: { 'acquisition.oauthTouch': touch } }
        )
      : await User.updateOne(
          { _id: opts.userId, acquisition: null },
          { $set: { acquisition: { oauthTouch: touch, signupMethod, capturedAt: now } } }
        );
    if (written.modifiedCount !== 1) return [];

    return await emitSignupForSourceProducts({
      userId: opts.userId,
      touches: { oauthTouch: touch },
      method: signupMethod,
      account: user,
    });
  } catch (err) {
    console.warn('[b4m-analytics] oauth signup credit not recorded', err instanceof Error ? err.message : err);
    return [];
  }
}
