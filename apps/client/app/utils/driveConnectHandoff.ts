import { z } from 'zod';

/**
 * What a Drive connect started from a data-lake surface carries across the redirect to Google's
 * consent screen and back, in sessionStorage (same tab, survives the round-trip). The callback page
 * (routes/google-drive/callback.tsx) consumes it to put the user back where they were.
 *
 * Bound to the OAuth `state` of the authorize URL it was saved for, plus the user and account
 * scope: a draft left behind by an abandoned consent can never resume on a later connect started
 * elsewhere (Profile > Integrations) or under another account. Holds nothing secret, and never
 * picked files (File objects do not serialize), only the wizard's typed-in config.
 */
const baseSchema = {
  v: z.literal(1),
  userId: z.string().min(1),
  organizationId: z.string().nullable(),
  oauthState: z.string().min(1),
  savedAt: z.number(),
};

const DEFAULT_OPTIONAL_STEPS = { preview: false, taxonomy: false };

const handoffSchema = z.discriminatedUnion('kind', [
  z.object({
    ...baseSchema,
    kind: z.literal('createWizard'),
    config: z.object({
      name: z.string(),
      description: z.string(),
      tagPrefix: z.string(),
      requiredUserTag: z.string(),
      requiredEntitlement: z.string(),
      conflictResolution: z.enum(['skip', 'update', 'duplicate']),
    }),
    autoDerivedTagPrefix: z.string(),
    optionalSteps: z.object({ preview: z.boolean(), taxonomy: z.boolean() }).default(DEFAULT_OPTIONAL_STEPS),
  }),
  z.object({
    ...baseSchema,
    kind: z.literal('lake'),
    dataLakeId: z.string().min(1),
  }),
]);

export type DriveConnectHandoff = z.infer<typeof handoffSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type DriveConnectHandoffInput = DistributiveOmit<DriveConnectHandoff, 'v' | 'oauthState' | 'savedAt'>;

const STORAGE_KEY = 'b4m:drive-connect-handoff';

/** A consent round-trip that takes longer than this is treated as abandoned. */
export const DRIVE_CONNECT_HANDOFF_TTL_MS = 15 * 60 * 1000;

const readOAuthState = (authUrl: string): string | null => {
  try {
    return new URL(authUrl).searchParams.get('state') || null;
  } catch {
    return null;
  }
};

/**
 * Saves the handoff for the consent redirect to `authUrl`. Without a `state` on that URL there is
 * nothing to bind to, so nothing is saved. Never throws: the redirect must happen regardless.
 */
export function saveDriveConnectHandoff(handoff: DriveConnectHandoffInput, authUrl: string, now = Date.now()): void {
  const oauthState = readOAuthState(authUrl);
  try {
    if (!oauthState) {
      sessionStorage.removeItem(STORAGE_KEY);
      return;
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ...handoff, v: 1, oauthState, savedAt: now }));
  } catch {
    // storage blocked: the connect still completes, the user just is not returned to the wizard
  }
}

/**
 * Reads and clears the pending handoff in one step, so it is used at most once. Null when there is
 * none, it does not parse, it is older than the TTL, or it belongs to another user, account scope,
 * or OAuth attempt.
 */
export function consumeDriveConnectHandoff({
  userId,
  organizationId,
  oauthState,
  now = Date.now(),
}: {
  userId: string;
  organizationId: string | null;
  oauthState: string;
  now?: number;
}): DriveConnectHandoff | null {
  let raw: string | null;
  try {
    raw = sessionStorage.getItem(STORAGE_KEY);
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: ReturnType<typeof handoffSchema.safeParse>;
  try {
    parsed = handoffSchema.safeParse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (!parsed.success) return null;

  const handoff = parsed.data;
  const age = now - handoff.savedAt;
  if (age < 0 || age > DRIVE_CONNECT_HANDOFF_TTL_MS) return null;
  if (handoff.userId !== userId || handoff.organizationId !== organizationId) return null;
  if (handoff.oauthState !== oauthState) return null;
  return handoff;
}

/**
 * One-shot signal from the callback to DrivePendingConnectAction to open the folder picker once the
 * resumed wizard mounts. Cleared on read, so a StrictMode double-mount opens it once.
 */
let drivePickerResumePending = false;

export function requestDrivePickerResume(): void {
  drivePickerResumePending = true;
}

export function takeDrivePickerResume(): boolean {
  const pending = drivePickerResumePending;
  drivePickerResumePending = false;
  return pending;
}
