/**
 * The auth vocabulary that crosses the contextBridge.
 *
 * Deliberately credential-free: the device flow and every token live in the main process,
 * so the renderer only ever receives derived state. A field added here that carries an
 * access token, refresh token or device code breaks that boundary - see src/shared/ipc.ts.
 */

export type EnvironmentPresetId = 'hosted' | 'local' | 'custom';

export interface EnvironmentSelection {
  preset: EnvironmentPresetId;
  /** Required by the `custom` preset, ignored by the others. */
  customUrl?: string;
}

export interface ResolvedEnvironment {
  preset: EnvironmentPresetId;
  url: string;
  /** Human label for the picker ("Production", "Local Dev", "Self-Hosted"). */
  label: string;
}

/**
 * Whether tokens can be written to the OS keychain. `unavailable` is the Linux-without-a-keyring
 * case: the app still works, but nothing is persisted, so the user re-authenticates next launch.
 * Reported rather than papered over, because the alternative is writing tokens in plaintext.
 */
export type TokenStorageStatus = 'available' | 'unavailable';

export type AuthStatus =
  /** Reading stored tokens; nothing decided yet. */
  | 'initializing'
  /** No endpoint resolves - an unbranded build with no custom URL chosen yet. */
  | 'unconfigured'
  | 'signed-out'
  | 'awaiting-approval'
  | 'signed-in'
  /** Authenticated, but the account has not accepted the AUP/ToS (403). Not a login failure. */
  | 'policy-acceptance-required'
  /** Authenticated, but the account owes a second factor (401 + mfaPending). Not a login failure. */
  | 'mfa-required';

export type AuthBusy = 'idle' | 'signing-in' | 'signing-out' | 'restoring';

export interface PendingApproval {
  /** Shown in-app so the user can type it if the browser did not open. */
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: string;
  /** False when shell.openExternal failed; the in-app code and URI are then the only route. */
  browserOpened: boolean;
}

/** The identity round-trip's result, narrowed to what a shell needs to render. */
export interface DesktopUser {
  id: string;
  email?: string;
  username?: string;
  nickname?: string;
  /**
   * The profile picture, as a `b4m-media://` URL served by the main process out of this app's
   * own media folder - never the backend's URL. The bytes are fetched once in main and written
   * to disk there, because the renderer runs under a CSP that admits no remote origin (see
   * src/renderer/index.html). Absent until it arrives, and for good if it never does: the
   * panel draws initials instead.
   */
  photoUrl?: string;
}

/**
 * What the UI should offer the user next. Carried as a tag rather than inferred from the
 * message, so copy changes cannot silently strip a state of its way forward.
 */
export type AuthRemedy = 'retry-sign-in' | 'retry' | 'accept-policy' | 'complete-mfa' | 'choose-environment';

export interface AuthError {
  message: string;
  remedy: AuthRemedy;
}

export interface AuthState {
  status: AuthStatus;
  environment: ResolvedEnvironment;
  /** False in an unbranded build with no baked default; the picker disables that option. */
  hostedAvailable: boolean;
  storage: TokenStorageStatus;
  busy: AuthBusy;
  pending?: PendingApproval;
  user?: DesktopUser;
  error?: AuthError;
}

/** External pages the renderer may ask main to open; main owns the base URL. */
export type AccountPage = 'verification' | 'policy' | 'mfa';

export type SetEnvironmentResult = { ok: true } | { ok: false; error: string };
