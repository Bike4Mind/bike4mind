/**
 * The Fleet activity integration, as it crosses the contextBridge.
 *
 * Credential-free like the rest of the bridge: the access key is written into main once, when
 * the user saves it, and never read back. The renderer only learns whether one is configured.
 */

/** Whether the OS keychain can hold the key across restarts. */
export type FleetKeyStorage = 'available' | 'unavailable';

/**
 * Where sending stands.
 *
 * - `not-configured`: no URL or no key, so nothing can be sent.
 * - `paused`: configured, but activity sharing is off. Nothing is recorded or sent.
 * - `active`: configured and sharing; batches go out as activity accrues.
 * - `reconnect-needed`: Fleet refused the key (401/403). Sending stops until the key changes.
 */
export type FleetSendStatus = 'not-configured' | 'paused' | 'active' | 'reconnect-needed';

/** What Fleet said about the key, from the status handshake. */
export type FleetConnectionCheck =
  | {
      ok: true;
      at: number;
      consumer: string;
      scopes: string[];
      capabilities: { status: boolean; activityIngest: boolean; summary: boolean };
    }
  /** `refused`: Fleet answered 401/403, so the key itself is the problem, not the network. */
  | { ok: false; at: number; error: string; refused: boolean };

export interface FleetState {
  url: string;
  /** What `url` falls back to when the user clears it. */
  defaultUrl: string;
  keyConfigured: boolean;
  keyStorage: FleetKeyStorage;
  consent: boolean;
  status: FleetSendStatus;
  /** Events waiting to be sent. */
  pending: number;
  lastSentAt: number | null;
  /** The last batch's outcome, for the settings card. Never carries activity content. */
  lastResult: { accepted: number; duplicates: number } | null;
  /** A short, user-facing reason the last send did not land. */
  lastError: string | null;
  lastCheck: FleetConnectionCheck | null;
}

/** Saved from the settings card. An absent `key` keeps the one already stored. */
export interface FleetSettingsInput {
  url: string;
  key?: string;
}
