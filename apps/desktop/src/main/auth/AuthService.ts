import {
  AuthenticatedApiClient,
  DeviceFlowClient,
  type AuthLogger,
  type AuthTokens,
  type TokenStore,
} from '@bike4mind/client-auth';
import type { OAuthDeviceClientId } from '@bike4mind/common';
import type {
  AccountPage,
  AuthState,
  DesktopUser,
  EnvironmentSelection,
  ResolvedEnvironment,
  SetEnvironmentResult,
} from '@shared/auth';
import { hostedAvailable, normalizeSelection, resolveEnvironment, validateSelection } from './environment';
import { classifyIdentifyFailure } from './identifyFailure';
import { msUntilProactiveRefresh, msUntilRefreshRetry } from './refreshSchedule';
import type { TokenVault } from './tokenVault';

/**
 * This app's RFC 8628 registration. Typed against the server's allowlist
 * (`OAUTH_DEVICE_CLIENT_IDS`) so a typo fails to compile rather than at the initiate call.
 *
 * The same id MUST reach both `/api/oauth/device/initiate` and `/api/oauth/device/token`:
 * the token endpoint rejects a device code whose stored `clientId` differs from the redeeming
 * `client_id` (RFC 8628 s3.4). Constructing one {@link DeviceFlowClient} with it is what
 * guarantees that.
 */
export const DESKTOP_OAUTH_CLIENT_ID: OAuthDeviceClientId = 'b4m-desktop';

/** Where each blocked state is resolved. MFA lives in a modal on the web app's root. */
const ACCOUNT_PAGE_PATHS: Record<Exclude<AccountPage, 'verification'>, string> = {
  policy: '/accept-policies',
  mfa: '/',
};

interface IdentifyResponse {
  user?: Record<string, unknown> | null;
}

export interface AuthServiceDeps {
  vault: TokenVault;
  logger: AuthLogger;
  openExternal(url: string): Promise<void>;
  /** `!app.isPackaged`: a source run falls back to the local dev server. */
  devFallback: boolean;
  userAgent: string;
  onStateChanged(state: AuthState): void;
  /** Overridable so tests can drive the flow without a network. */
  createDeviceFlowClient?: (baseUrl: string) => DeviceFlowClient;
  createApiClient?: (baseUrl: string, tokenStore: TokenStore) => AuthenticatedApiClient;
}

/**
 * Owns the whole device-authorization flow and every token, in the main process.
 *
 * Nothing here returns a credential to a caller: the only outward channel is
 * {@link AuthServiceDeps.onStateChanged}, which carries derived {@link AuthState}. Tokens are
 * read from the vault at the moment of use and handed straight to the shared HTTP layer.
 */
export class AuthService {
  private state: AuthState;
  private device: DeviceFlowClient | null = null;
  private api: AuthenticatedApiClient | null = null;
  private tokenStore: TokenStore | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private refreshAttempt = 0;

  /**
   * Bumped whenever an in-flight sign-in stops being the current one (cancelled, or the
   * environment changed under it). The shared poller has no cancellation of its own, so a
   * superseded attempt is identified on resolution and its result dropped. Its polling does
   * continue in the background until the 10-minute device code expires; that is bounded and
   * costs one request per 5 seconds, which the token endpoint's own rate limit tolerates.
   */
  private signInGeneration = 0;

  constructor(private readonly deps: AuthServiceDeps) {
    this.state = {
      status: 'initializing',
      environment: { preset: 'local', url: '', label: 'Unconfigured' },
      hostedAvailable: hostedAvailable(),
      storage: 'available',
      busy: 'restoring',
    };
  }

  getState(): AuthState {
    return this.state;
  }

  /**
   * The authenticated HTTP client for the current environment, or null when there is no usable
   * session. Main-process only, and deliberately not reachable over IPC: the instance injects
   * the access token into every request, so handing it across the contextBridge would hand the
   * renderer the credential this whole arrangement keeps out of it (see src/shared/ipc.ts).
   */
  getApiClient(): AuthenticatedApiClient | null {
    return this.state.status === 'signed-in' ? this.api : null;
  }

  /** Read the stored environment and session. Call after the app `ready` event. */
  async initialize(): Promise<void> {
    const selection = await this.deps.vault.getEnvironment();
    await this.applyEnvironment(selection);
  }

  async signIn(): Promise<void> {
    if (!this.device || !this.endpointUrl()) {
      this.patch({ error: { message: 'Choose a server before signing in.', remedy: 'choose-environment' } });
      return;
    }
    if (this.state.busy === 'signing-in') return;

    const generation = ++this.signInGeneration;
    const device = this.device;
    this.patch({ busy: 'signing-in', error: undefined, pending: undefined });

    try {
      const flow = await device.initiateDeviceFlow();
      if (generation !== this.signInGeneration) return;

      this.patch({
        status: 'awaiting-approval',
        pending: {
          userCode: flow.user_code,
          verificationUri: flow.verification_uri,
          verificationUriComplete: flow.verification_uri_complete,
          expiresAt: new Date(Date.now() + flow.expires_in * 1000).toISOString(),
          browserOpened: false,
        },
      });

      const browserOpened = await this.tryOpenExternal(flow.verification_uri_complete);
      if (generation !== this.signInGeneration) return;
      if (this.state.pending) {
        this.patch({ pending: { ...this.state.pending, browserOpened } });
      }

      const token = await device.waitForAuthorization(flow.device_code, flow.interval);
      if (generation !== this.signInGeneration) return;

      await this.persistGrant(token.access_token, token.refresh_token, token.expires_in);
      // Approval is done but identity is not yet confirmed. Leaving the status on
      // `awaiting-approval` here would publish a state that still claims to be waiting while
      // carrying no code to display.
      this.patch({ status: 'initializing', pending: undefined, busy: 'restoring' });
      await this.identify();
    } catch (err) {
      if (generation !== this.signInGeneration) return;
      this.patch({
        status: 'signed-out',
        busy: 'idle',
        pending: undefined,
        error: { message: signInErrorMessage(err), remedy: 'retry-sign-in' },
      });
    }
  }

  async cancelSignIn(): Promise<void> {
    this.signInGeneration++;
    this.patch({ status: 'signed-out', busy: 'idle', pending: undefined, error: undefined });
  }

  async signOut(): Promise<void> {
    this.signInGeneration++;
    this.clearRefreshTimer();
    this.patch({ busy: 'signing-out' });

    const url = this.endpointUrl();
    try {
      // Revokes this session server-side. Best effort: a failure here must not leave the app
      // holding credentials it has already told the user it discarded.
      await this.api?.get('/api/logout');
    } catch (err) {
      this.deps.logger.warn(`AUTH: logout request failed: ${err instanceof Error ? err.message : 'unknown'}`);
    }

    if (url) await this.deps.vault.clearTokens(url);
    this.patch({ status: 'signed-out', busy: 'idle', user: undefined, pending: undefined, error: undefined });
  }

  async setEnvironment(selection: EnvironmentSelection): Promise<SetEnvironmentResult> {
    const validation = validateSelection(selection);
    if (!validation.ok) return { ok: false, error: validation.error };

    const normalized = normalizeSelection(selection);
    this.signInGeneration++;
    this.clearRefreshTimer();
    await this.deps.vault.setEnvironment(normalized);
    await this.applyEnvironment(normalized);
    return { ok: true };
  }

  /** Re-run the identity round-trip once the user has cleared a policy or MFA block. */
  async retryIdentity(): Promise<void> {
    if (!this.api) return;
    this.patch({ busy: 'restoring', error: undefined });
    await this.identify();
  }

  async openAccountPage(page: AccountPage): Promise<void> {
    if (page === 'verification') {
      const target = this.state.pending?.verificationUriComplete;
      if (target) await this.tryOpenExternal(target);
      return;
    }

    const base = this.endpointUrl();
    if (base) await this.tryOpenExternal(`${base}${ACCOUNT_PAGE_PATHS[page]}`);
  }

  dispose(): void {
    this.signInGeneration++;
    this.clearRefreshTimer();
  }

  private endpointUrl(): string {
    return this.state.environment.url;
  }

  private async applyEnvironment(selection: EnvironmentSelection | undefined): Promise<void> {
    const resolved = resolveEnvironment(selection, this.deps.devFallback);
    const storage = this.deps.vault.storageStatus();

    if (resolved.status === 'unconfigured') {
      this.device = null;
      this.api = null;
      this.tokenStore = null;
      this.setState({
        status: 'unconfigured',
        environment: { preset: selection?.preset ?? 'custom', url: '', label: 'Unconfigured' },
        hostedAvailable: hostedAvailable(),
        storage,
        busy: 'idle',
        error: { message: 'No server is configured. Pick one to continue.', remedy: 'choose-environment' },
      });
      return;
    }

    const environment: ResolvedEnvironment = resolved.environment;
    this.tokenStore = this.deps.vault.storeFor(environment.url);
    this.device = this.buildDeviceFlowClient(environment.url);
    this.api = this.buildApiClient(environment.url, this.tokenStore);

    this.setState({
      status: 'initializing',
      environment,
      hostedAvailable: hostedAvailable(),
      storage,
      busy: 'restoring',
      user: undefined,
      pending: undefined,
      error: undefined,
    });

    await this.restoreSession();
  }

  /**
   * Adopt whatever the vault already holds for this environment. Tokens are cached per
   * normalized API URL, so switching to a backend the user signed in to before restores that
   * session instead of forcing a fresh device flow.
   */
  private async restoreSession(): Promise<void> {
    const url = this.endpointUrl();
    const tokens = url ? await this.deps.vault.getTokens(url) : null;

    if (!tokens) {
      this.patch({ status: 'signed-out', busy: 'idle' });
      return;
    }

    // An expired stored token is still worth adopting: the shared client refreshes on the
    // first 401, and the proactive timer below fires immediately for an already-elapsed expiry.
    await this.identify(tokens);
  }

  private async identify(knownTokens?: AuthTokens): Promise<void> {
    const api = this.api;
    if (!api) return;

    try {
      const response = await api.get<IdentifyResponse>('/api/identify');
      const tokens = knownTokens ?? (await this.currentTokens());
      this.patch({
        status: 'signed-in',
        busy: 'idle',
        error: undefined,
        user: toDesktopUser(response.user, tokens?.userId ?? ''),
      });
      this.refreshAttempt = 0;
      await this.scheduleProactiveRefresh();
    } catch (err) {
      const failure = classifyIdentifyFailure(err);

      if (failure.outcome === 'transient') {
        // Credentials are fine, the backend is not reachable. Keep the session and name the
        // account from the stored token rather than pretending the user is signed out.
        const tokens = knownTokens ?? (await this.currentTokens());
        this.patch({
          status: 'signed-in',
          busy: 'idle',
          user: this.state.user ?? (tokens ? { id: tokens.userId } : undefined),
          error: failure.error,
        });
        await this.scheduleProactiveRefresh();
        return;
      }

      if (failure.outcome === 'signed-out') {
        this.clearRefreshTimer();
        this.patch({ status: 'signed-out', busy: 'idle', user: undefined, error: failure.error });
        return;
      }

      // Policy acceptance and MFA are authenticated states, not login failures: the token is
      // good and must be kept, so that once the user clears the block in the browser a retry
      // succeeds without a second device flow.
      this.patch({ status: failure.outcome, busy: 'idle', error: failure.error });
      await this.scheduleProactiveRefresh();
    }
  }

  private async currentTokens(): Promise<AuthTokens | null> {
    return this.tokenStore ? this.tokenStore.getAuthTokens() : null;
  }

  private async persistGrant(accessToken: string, refreshToken: string, expiresInSeconds: number): Promise<void> {
    const url = this.endpointUrl();
    if (!url) return;

    await this.deps.vault.setTokens(url, {
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000).toISOString(),
      userId: readUserIdClaim(accessToken),
    });
  }

  /**
   * Refresh ahead of expiry rather than on a 401. A 30-minute access token that lapses
   * mid-session would break a WebSocket whose connect ticket was minted from it, and a socket
   * already open never produces the 401 that a lazy refresh waits for.
   */
  private async scheduleProactiveRefresh(): Promise<void> {
    this.clearRefreshTimer();

    const tokens = await this.currentTokens();
    if (!tokens) return;

    const delay = msUntilProactiveRefresh(tokens.expiresAt, Date.now());
    this.refreshTimer = setTimeout(() => {
      void this.refreshNow();
    }, delay);
  }

  private async refreshNow(): Promise<void> {
    this.refreshTimer = null;
    const device = this.device;
    const tokens = await this.currentTokens();
    if (!device || !tokens) return;

    try {
      const refreshed = await device.refreshToken(tokens.refreshToken);
      const url = this.endpointUrl();
      if (!url) return;

      await this.deps.vault.setTokens(url, {
        accessToken: refreshed.access_token,
        // Absent means the server did not rotate the chain (RFC 6749 s6); keep the one we
        // presented rather than erasing the credential.
        refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
        expiresAt: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
        userId: tokens.userId,
      });

      this.refreshAttempt = 0;
      await this.scheduleProactiveRefresh();
    } catch (err) {
      const status = httpStatus(err);
      if (status === 400 || status === 401) {
        // The refresh token itself was rejected: genuinely revoked, not a blip.
        await this.deps.vault.clearTokens(this.endpointUrl());
        this.patch({
          status: 'signed-out',
          user: undefined,
          error: { message: 'This session has expired. Sign in again.', remedy: 'retry-sign-in' },
        });
        return;
      }

      this.refreshAttempt += 1;
      this.deps.logger.warn(`AUTH: proactive refresh failed (attempt ${this.refreshAttempt})`);
      this.refreshTimer = setTimeout(() => {
        void this.refreshNow();
      }, msUntilRefreshRetry(this.refreshAttempt));
    }
  }

  private clearRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async tryOpenExternal(url: string): Promise<boolean> {
    try {
      await this.deps.openExternal(url);
      return true;
    } catch (err) {
      this.deps.logger.warn(`AUTH: could not open the browser: ${err instanceof Error ? err.message : 'unknown'}`);
      return false;
    }
  }

  private buildDeviceFlowClient(baseUrl: string): DeviceFlowClient {
    return (
      this.deps.createDeviceFlowClient?.(baseUrl) ??
      new DeviceFlowClient({ baseUrl, clientId: DESKTOP_OAUTH_CLIENT_ID })
    );
  }

  private buildApiClient(baseUrl: string, tokenStore: TokenStore): AuthenticatedApiClient {
    if (this.deps.createApiClient) return this.deps.createApiClient(baseUrl, tokenStore);

    return new AuthenticatedApiClient({
      baseUrl,
      tokenStore,
      oauthClient: this.buildDeviceFlowClient(baseUrl),
      logger: this.deps.logger,
      timeoutMs: 30_000,
      headers: { 'User-Agent': this.deps.userAgent, 'X-B4M-Client': this.deps.userAgent },
      reauthMessages: {
        refreshFailed: 'Your session expired. Sign in again.',
        stillUnauthorized: 'Your session is no longer valid. Sign in again.',
      },
    });
  }

  private patch(changes: Partial<AuthState>): void {
    this.setState({ ...this.state, ...changes });
  }

  private setState(next: AuthState): void {
    this.state = next;
    this.deps.onStateChanged(next);
  }
}

/**
 * Read the `id` claim from our own access token. Not a security decision: `userId` is only
 * the label the vault caches tokens under, so an unreadable payload simply yields no label.
 * The claim is never logged.
 */
function readUserIdClaim(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) return '';

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { id?: unknown };
    return typeof claims.id === 'string' ? claims.id : '';
  } catch {
    return '';
  }
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' && value ? value : undefined;
}

function toDesktopUser(raw: Record<string, unknown> | null | undefined, fallbackId: string): DesktopUser {
  if (!raw) return { id: fallbackId };

  return {
    id: readString(raw, 'id') ?? readString(raw, '_id') ?? fallbackId,
    email: readString(raw, 'email'),
    username: readString(raw, 'username'),
    nickname: readString(raw, 'nickname'),
  };
}

/** The device grant's error codes are opaque slugs; translate the ones a user can act on. */
function signInErrorMessage(err: unknown): string {
  const status = httpStatus(err);

  // `client_id` is validated against a server-side allowlist, so a schema rejection at initiate
  // means that backend does not know this client - in practice one older than desktop support,
  // not anything the user did. The raw axios "status code 422" gives them nothing to act on.
  if (status === 400 || status === 422) {
    return 'This server did not accept the desktop client. It may be running a version that predates desktop support.';
  }

  if (status === 429) return 'Too many sign-in attempts. Wait a few minutes and try again.';

  const message = err instanceof Error ? err.message : '';
  if (message === 'User denied the authorization request') return 'The sign-in request was denied in the browser.';
  if (message === 'Authorization code has expired') return 'The sign-in code expired. Start again.';
  return message || 'Sign-in failed. Try again.';
}

function httpStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const response = (err as { response?: { status?: number } }).response;
  return typeof response?.status === 'number' ? response.status : undefined;
}
