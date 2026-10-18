/**
 * The Fleet activity integration, as it crosses the contextBridge.
 *
 * Desktop reads its Fleet connection from the file Fleet's installer writes, and the key in it
 * stays in main: the renderer learns only whether the file is there and usable, and for whom.
 */

/**
 * What the installer file says.
 *
 * - `not-installed`: no file. The Fleet installer has not run here, or ran before Desktop was installed.
 * - `insecure`: the file is readable by other users, so it is ignored.
 * - `invalid`: the file is there but not one this app can use.
 * - `no-email`: usable, but names nobody, so Fleet could not attribute the activity.
 * - `connected`: usable.
 */
export type FleetConnection = 'not-installed' | 'insecure' | 'invalid' | 'no-email' | 'connected';

/**
 * Where sending stands.
 *
 * - `not-configured`: no usable installer file, so nothing is recorded or sent.
 * - `paused`: connected, but activity sharing is off. Nothing is recorded or sent.
 * - `active`: connected and sharing; batches go out as activity accrues.
 * - `reconnect-needed`: Fleet refused the key (401/403). Sending stops until the file's key changes.
 */
export type FleetSendStatus = 'not-configured' | 'paused' | 'active' | 'reconnect-needed';

export interface FleetState {
  connection: FleetConnection;
  /** Where the installer file is looked for, with the home directory as `~`. */
  configPath: string;
  /** The Fleet origin from the file, when it has a usable one. */
  fleetUrl: string | null;
  /** Who the file says this machine's activity belongs to. */
  email: string | null;
  consent: boolean;
  status: FleetSendStatus;
  /** Events waiting to be sent. */
  pending: number;
  lastSentAt: number | null;
  /** How many events the last batch carried. Never carries activity content. */
  lastResult: { sent: number } | null;
  /** A short, user-facing reason the last send did not land. */
  lastError: string | null;
}
