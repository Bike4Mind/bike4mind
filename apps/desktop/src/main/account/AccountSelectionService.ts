import { z } from 'zod';
import type { AuthenticatedApiClient } from '@bike4mind/client-auth';
import type { AccountProfile, AccountSelection, BillingAccount, BillingPayer } from '@shared/account';
import type { PreferenceFile } from '../preferenceFile';
import { PERSONAL_PAYER } from './billingPayer';

export const ACCOUNT_SELECTION_FILE_NAME = 'billing-account.json';

/** The remembered organization per user id. A user with no entry pays personally. */
export interface StoredAccountSelections {
  byUser: Record<string, string>;
}

const StoredAccountSelectionsSchema = z.object({ byUser: z.record(z.string(), z.string().min(1)) });

export function parseStoredAccountSelections(value: unknown): StoredAccountSelections {
  const parsed = StoredAccountSelectionsSchema.safeParse(value);
  return parsed.success ? parsed.data : { byUser: {} };
}

// The fields of a toSafeOrganization row a plain member receives that the switcher reads.
const WireOrganizationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  currentCredits: z.number().nullish(),
  seats: z.number().nullish(),
});
const WireOrganizationsSchema = z.object({ data: z.array(WireOrganizationSchema) });

/**
 * The same query the web switcher sends (useGetUserOrganizations). `filters[userId]` matters for a
 * site admin, whom the route otherwise answers with every tenant's organizations.
 */
export function organizationsPath(userId: string): string {
  const query = new URLSearchParams({
    'filters[userId]': userId,
    'pagination[page]': '1',
    'pagination[limit]': '100',
    'orderBy[by]': 'name',
    'orderBy[direction]': 'asc',
  });
  return `/api/organizations?${query}`;
}

export function parseOrganizations(wire: unknown): BillingAccount[] {
  return WireOrganizationsSchema.parse(wire).data.map(org => ({
    id: org.id,
    name: org.name,
    personal: false,
    credits: typeof org.currentCredits === 'number' && Number.isFinite(org.currentCredits) ? org.currentCredits : null,
    ...(typeof org.seats === 'number' ? { seats: org.seats } : {}),
  }));
}

export interface AccountSelectionDeps {
  getApiClient(): AuthenticatedApiClient | null;
  getUserId(): string | null;
  /** The personal balance; AccountService already shares concurrent reads of `/api/v1/me`. */
  profile(): Promise<AccountProfile>;
  store: PreferenceFile<StoredAccountSelections>;
  /** Resolves once `store` has loaded; reads and picks wait for it so a load never overwrites a pick. */
  ready: Promise<unknown>;
  logger: { warn(message: string): void };
  /**
   * Every change of payer: a pick (sent to every window, the picker's too, so each hook in it stays in
   * step), a fallback, a sign-in or out.
   */
  onChanged(selection: AccountSelection): void;
}

export const SIGNED_OUT_SELECTION: AccountSelection = { accounts: [], selected: null, droppedOrganizationId: null };

/**
 * Which account pays for the signed-in user's credit-spending calls: Personal, or one of their
 * organizations' pools. Remembered per user id across restarts.
 *
 * `payer()` is synchronous and cheap because every submit asks it. It never sends an organization
 * the last successful read of the user's organizations did not list; the server would refuse it
 * with a 403 anyway, but a known-stale id should not leave this app.
 */
export class AccountSelectionService {
  private organizations: { userId: string; accounts: BillingAccount[] } | null = null;
  private personalCredits: { userId: string; credits: number | null } | null = null;
  private dropped: { userId: string; organizationId: string } | null = null;
  private cached: { userId: string; selection: AccountSelection } | null = null;
  private inFlight: { userId: string; read: Promise<AccountSelection> } | null = null;
  /** The account the windows were last told about; undefined until the first auth state. */
  private announcedUserId: string | null | undefined = undefined;

  constructor(private readonly deps: AccountSelectionDeps) {}

  payer(): BillingPayer {
    const userId = this.deps.getUserId();
    if (!userId) return PERSONAL_PAYER;
    const stored = this.deps.store.current().byUser[userId];
    if (!stored || this.knownMissing(userId, stored)) return PERSONAL_PAYER;
    return { organization_id: stored };
  }

  /** `fresh` re-reads balances and organizations; otherwise the last answer for this user is reused. */
  selection(fresh = false): Promise<AccountSelection> {
    const userId = this.deps.getUserId();
    if (!userId) return Promise.resolve(SIGNED_OUT_SELECTION);
    if (!fresh && this.cached?.userId === userId) return Promise.resolve(this.cached.selection);
    if (this.inFlight?.userId === userId) return this.inFlight.read;
    const read = this.read(userId).finally(() => {
      if (this.inFlight?.read === read) this.inFlight = null;
    });
    this.inFlight = { userId, read };
    return read;
  }

  /**
   * Tells every window who pays whenever the signed-in account changes: the empty selection on
   * sign-out, and the new user's on sign-in, which also re-checks a remembered organization.
   */
  async authChanged(userId: string | null): Promise<void> {
    if (userId === this.announcedUserId) return;
    this.announcedUserId = userId;
    if (!userId) {
      this.deps.onChanged(SIGNED_OUT_SELECTION);
      return;
    }
    const selection = await this.selection(true);
    if (this.announcedUserId === userId) this.deps.onChanged(selection);
  }

  async select(organizationId: unknown): Promise<AccountSelection> {
    if (organizationId !== null && (typeof organizationId !== 'string' || !organizationId)) {
      throw new Error('Choose Personal or one of your organizations.');
    }
    const userId = this.deps.getUserId();
    if (!userId) throw new Error('Sign in to choose who pays.');

    await this.deps.ready;
    if (organizationId !== null) {
      if (this.organizations?.userId !== userId) await this.selection(true);
      if (this.organizations?.userId !== userId) {
        throw new Error('Could not load your organizations, so the payer was not changed. Try again.');
      }
      if (this.knownMissing(userId, organizationId)) {
        throw new Error('That organization is not one of yours, so it cannot pay.');
      }
    }

    await this.remember(userId, organizationId);
    this.dropped = null;
    const selection = this.compose(userId, this.cached?.userId === userId ? this.cached.selection.error : undefined);
    this.deps.onChanged(selection);
    return selection;
  }

  private knownMissing(userId: string, organizationId: string): boolean {
    return this.organizations?.userId === userId && !this.organizations.accounts.some(org => org.id === organizationId);
  }

  private async read(userId: string): Promise<AccountSelection> {
    await this.deps.ready;
    const [profile, organizations] = await Promise.all([this.deps.profile(), this.readOrganizations(userId)]);
    // Signed out or switched while reading: this answer is for someone else, so answer for whoever is here now.
    if (this.deps.getUserId() !== userId) return this.selection(false);
    this.personalCredits = { userId, credits: profile.credits.balance };

    let error: string | undefined;
    if (organizations.ok) {
      this.organizations = { userId, accounts: organizations.accounts };
    } else {
      error = organizations.error;
    }

    const stored = this.deps.store.current().byUser[userId];
    const fellBack = !!stored && organizations.ok && this.knownMissing(userId, stored);
    if (fellBack) {
      this.deps.logger.warn('ACCOUNT: the remembered organization is no longer listed; paying personally');
      this.dropped = { userId, organizationId: stored };
      await this.remember(userId, null);
    }

    const selection = this.compose(userId, error);
    if (fellBack) this.deps.onChanged(selection);
    return selection;
  }

  private async readOrganizations(
    userId: string
  ): Promise<{ ok: true; accounts: BillingAccount[] } | { ok: false; error: string }> {
    const api = this.deps.getApiClient();
    if (!api) return { ok: false, error: 'Sign in to see your organizations.' };
    try {
      return { ok: true, accounts: parseOrganizations(await api.get<unknown>(organizationsPath(userId))) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn(`ACCOUNT: organization list failed: ${message}`);
      return { ok: false, error: 'Could not read your organizations from this server.' };
    }
  }

  private compose(userId: string, error: string | undefined): AccountSelection {
    const personal: BillingAccount = {
      id: userId,
      name: 'Personal',
      personal: true,
      credits: this.personalCredits?.userId === userId ? this.personalCredits.credits : null,
    };
    const organizations = this.organizations?.userId === userId ? this.organizations.accounts : [];
    const accounts = [personal, ...organizations];
    const payer = this.payer().organization_id;
    const selected =
      payer === null
        ? personal
        : (organizations.find(org => org.id === payer) ?? {
            // Remembered but not yet confirmed by a read: still the payer, named once a read lands.
            id: payer,
            name: 'Organization',
            personal: false,
            credits: null,
          });
    const selection: AccountSelection = {
      accounts,
      selected,
      droppedOrganizationId: this.dropped?.userId === userId ? this.dropped.organizationId : null,
      ...(error ? { error } : {}),
    };
    this.cached = { userId, selection };
    return selection;
  }

  private async remember(userId: string, organizationId: string | null): Promise<void> {
    const others = Object.fromEntries(Object.entries(this.deps.store.current().byUser).filter(([id]) => id !== userId));
    await this.deps.store.update({ byUser: organizationId ? { ...others, [userId]: organizationId } : others });
  }
}
