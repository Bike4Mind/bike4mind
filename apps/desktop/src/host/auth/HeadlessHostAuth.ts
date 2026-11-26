import { join } from 'node:path';
import { HOST_DEVICE_CLIENT_ID } from '@bike4mind/common';
import type { AuthenticatedApiClient, AuthLogger } from '@bike4mind/client-auth';
import type { AuthState, EnvironmentSelection, PendingApproval } from '@shared/auth';
import type { HostResult } from '@shared/hostProtocol';
import { AuthService, type AuthServiceDeps } from '../../main/auth/AuthService';
import { normalizeSelection, validateSelection } from '../../main/auth/environment';
import { TokenVault, type VaultFile } from '../../main/auth/tokenVault';
import { createVaultFile } from '../../main/auth/vaultFile';
import { accountOf } from './hostAccount';
import { createPermissionProtectedCipher } from './permissionProtectedCipher';
import { ensurePrivateDirectory, restrictMode } from './privateDirectory';

const VAULT_FILE_NAME = 'auth-vault.json';
const OWNER_ONLY_FILE = 0o600;

export type HostSignInStart = HostResult<'host/auth/start'>;
export type HostAuthStatus = HostResult<'host/auth/status'>;

export type HeadlessHostAuthOptions = {
  /** Holds the vault; created 0700, and tightened to it if it exists looser. */
  dataDirectory: string;
  logger: AuthLogger;
  userAgent: string;
  onStateChanged?(state: AuthState): void;
  /** The endpoint to use in place of the build's baked default; applied on every initialize. */
  defaultApiUrl?: string;
  createDeviceFlowClient?: AuthServiceDeps['createDeviceFlowClient'];
  createApiClient?: AuthServiceDeps['createApiClient'];
};

export type HeadlessHostAuth = Pick<AuthService, 'getApiClient' | 'getState'> & {
  /** Prepare the data directory and adopt a stored session, so a restarted host stays signed in. */
  initialize(): Promise<void>;
  /**
   * Start the device flow and resolve once the code is ready, without waiting for approval.
   * Concurrent and repeated calls share the pending flow. The outcome arrives through state.
   */
  startSignIn(): Promise<HostSignInStart>;
  status(): HostAuthStatus;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<void>;
  dispose(): void;
};

/**
 * Sign-in and token storage for a host with no Electron: the desktop app's {@link AuthService}
 * and {@link TokenVault}, over a vault file kept owner-only under `dataDirectory`. Tokens never
 * leave this object; callers get the device code, derived state and the authenticated client.
 */
export function createHeadlessHostAuth(options: HeadlessHostAuthOptions): HeadlessHostAuth {
  return new HeadlessHostAuthService(options);
}

class HeadlessHostAuthService implements HeadlessHostAuth {
  private readonly vault: TokenVault;
  private readonly service: AuthService;
  private readonly listeners = new Set<(state: AuthState) => void>();
  private starting: Promise<HostSignInStart> | null = null;

  constructor(private readonly options: HeadlessHostAuthOptions) {
    this.vault = new TokenVault(createPermissionProtectedCipher(), this.privateVaultFile(), options.logger);
    this.service = new AuthService({
      vault: this.vault,
      logger: options.logger,
      // Rejecting is how AuthService records `browserOpened: false`, which tells the client to
      // show the URL and code itself. It logs this at warn level.
      openExternal: () => Promise.reject(new Error('a headless host opens no browser; the client shows the code')),
      devFallback: false,
      userAgent: options.userAgent,
      clientId: HOST_DEVICE_CLIENT_ID,
      onStateChanged: state => this.publish(state),
      createDeviceFlowClient: options.createDeviceFlowClient,
      createApiClient: options.createApiClient,
    });
  }

  getState(): AuthState {
    return this.service.getState();
  }

  getApiClient(): AuthenticatedApiClient | null {
    return this.service.getApiClient();
  }

  async initialize(): Promise<void> {
    await ensurePrivateDirectory(this.options.dataDirectory);
    await restrictMode(this.vaultPath(), OWNER_ONLY_FILE);
    if (this.options.defaultApiUrl !== undefined) await this.pinEnvironment(this.options.defaultApiUrl);
    await this.service.initialize();
  }

  startSignIn(): Promise<HostSignInStart> {
    if (this.starting) return this.starting;

    const state = this.service.getState();
    if (state.status === 'signed-in') return Promise.reject(new Error(alreadySignedInMessage()));
    if (state.status === 'awaiting-approval' && state.pending) {
      try {
        return Promise.resolve(toSignInStart(state.pending));
      } catch (err) {
        return Promise.reject(err);
      }
    }
    if (state.busy !== 'idle') {
      return Promise.reject(new Error(`Cannot start sign-in while authentication is ${state.busy}.`));
    }

    this.starting = this.beginSignIn().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  status(): HostAuthStatus {
    return { account: accountOf(this.service.getState()) };
  }

  cancelSignIn(): Promise<void> {
    return this.service.cancelSignIn();
  }

  signOut(): Promise<void> {
    return this.service.signOut();
  }

  dispose(): void {
    this.service.dispose();
    this.listeners.clear();
  }

  /**
   * Resolve on the first published pending approval. AuthService.signIn keeps running in the
   * background until approval, denial or expiry; its outcome is visible only through state.
   */
  private beginSignIn(): Promise<HostSignInStart> {
    return new Promise<HostSignInStart>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => HostSignInStart) => {
        if (settled) return;
        settled = true;
        this.listeners.delete(onState);
        try {
          resolve(outcome());
        } catch (err) {
          reject(err);
        }
      };
      const onState = (state: AuthState) => {
        const pending = state.pending;
        if (pending) finish(() => toSignInStart(pending));
      };
      this.listeners.add(onState);

      this.service.signIn().then(
        () =>
          finish(() => {
            throw new Error(this.signInNotStartedMessage());
          }),
        (err: unknown) => {
          this.options.logger.warn(
            `AUTH: host sign-in ended unexpectedly (${err instanceof Error ? err.name : 'unknown'})`
          );
          finish(() => {
            throw new Error('Sign-in failed unexpectedly.');
          });
        }
      );
    });
  }

  /** Why AuthService.signIn returned without publishing a code. */
  private signInNotStartedMessage(): string {
    const state = this.service.getState();
    if (state.status === 'signed-in') return alreadySignedInMessage();
    return state.error?.message ?? 'Sign-in did not start.';
  }

  /** Store the given endpoint as the selection, so AuthService resolves it instead of the baked default. */
  private async pinEnvironment(apiUrl: string): Promise<void> {
    const selection: EnvironmentSelection = { preset: 'custom', customUrl: apiUrl };
    const validation = validateSelection(selection);
    if (!validation.ok) throw new Error(`Invalid API URL for the host: ${validation.error}`);

    const normalized = normalizeSelection(selection);
    const stored = await this.vault.getEnvironment();
    if (stored?.preset === normalized.preset && stored.customUrl === normalized.customUrl) return;
    await this.vault.setEnvironment(normalized);
  }

  private publish(state: AuthState): void {
    for (const listener of this.listeners) listener(state);
    this.options.onStateChanged?.(state);
  }

  private vaultPath(): string {
    return join(this.options.dataDirectory, VAULT_FILE_NAME);
  }

  /** The shared vault file, with the data directory re-checked before every write. */
  private privateVaultFile(): VaultFile {
    const file = createVaultFile(this.vaultPath());
    return {
      read: () => file.read(),
      write: async contents => {
        await ensurePrivateDirectory(this.options.dataDirectory);
        await file.write(contents);
      },
    };
  }
}

function alreadySignedInMessage(): string {
  return 'Already signed in; sign out before signing in again.';
}

function toSignInStart(pending: PendingApproval): HostSignInStart {
  const expiresAt = Date.parse(pending.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error('Sign-in returned an unreadable expiry.');
  return { verificationUrl: pending.verificationUriComplete, userCode: pending.userCode, expiresAt };
}
