import { adminSettingsRepository, ccBridgeDeviceRepository, hearthRepository } from '@bike4mind/database';
import {
  DEFAULT_HEARTH_CHANNEL_NAME,
  HearthLog,
  PRESENCE_PAYLOAD_SCHEMA_NAME,
  sessionActorName,
  sessionSlug,
  type PresencePayload,
  type PresenceSurface,
} from '@bike4mind/hearth';
import { settingsMap, type ICcAgentSource, type ICcAgentStatus } from '@bike4mind/common';
import { getSettingByName } from '@bike4mind/utils';
import { isSettingEnabled } from '@server/middlewares/featureFlag';
import { toPresenceProjection, toWireHearthEvent } from '@server/utils/hearthWire';
import { sendToClient } from '@server/websocket/utils';

/**
 * cc-bridge as a Hearth gateway: the bridge WS write points additionally report
 * session presence into the Hearth event log and its roster projection, so ONE
 * roster covers both bridge sessions and Claude Code hook sessions
 * (bin/hearth-hook.mjs).
 *
 * This is a dual-write, not a migration. The Tavern keeps reading
 * ActiveCodeAgent; nothing here changes what the bridge already persists or
 * broadcasts.
 *
 * SCOPE / AUTHORITY. The bridge authenticates with `cc-bridge:connect`, not
 * `hearth:write`, and these writes deliberately do not require Hearth scope.
 * They are performed by our own trusted handler on the owning user's behalf
 * after that handler has already verified user identity, Tavern access, and
 * device binding - the caller's credential is never the authority for the
 * append. For the same reason this calls the repository directly instead of
 * POSTing /api/hearth/events, which would authorize against the caller's
 * scopes. It is not a scope bypass; it is a different actor doing the writing.
 *
 * CONTENT-FREE. The Hearth log is read by humans, other agents, and (later)
 * external gateways, so the forwarded field set is an explicit allowlist, the
 * same discipline bin/hearth-hook.mjs documents in its disclosure tiers. Only
 * the session id, its derived slug, the workspace BASENAME, the closed-set
 * status value, a constant reporter tag, the engine, and the Claude version
 * cross this boundary. Message bodies, status `text` summaries, tool
 * input/output, `lastSummary`, and
 * `workspacePath` (a full local path) never do. The human-readable line is
 * COMPOSED here from the closed reason set rather than passing an upstream
 * string through. ccAgentHearth.test.ts pins this with bait strings.
 */

/** Reporter tag written into the shared presence payload. Typed, so a value
 *  outside the known surface set is a compile error rather than a wire typo. */
const CC_BRIDGE_SURFACE: PresenceSurface = 'cc-bridge';

/**
 * Why a session was reported. Either a lifecycle edge the handler knows or a
 * CcAgentStatus value forwarded verbatim - both are closed sets, so no
 * caller-supplied string ever reaches the log.
 */
export type CcAgentPresenceReason = 'session_start' | 'disconnected' | ICcAgentStatus;

/**
 * Phrases for the closed reason set; anything unrecognized degrades generically.
 *
 * `satisfies` rather than an annotation: it keeps the runtime fallback for an
 * unknown reason while making a MISTYPED key a compile error. A plain
 * Record<string, string> would accept `awaiting_permision` and silently emit
 * the generic phrase forever.
 */
const REASON_PHRASES = {
  session_start: 'started a session',
  running: 'is working',
  idle: 'is idle',
  awaiting_input: 'is waiting for input',
  awaiting_permission: 'needs permission',
  disconnected: 'disconnected',
} satisfies Partial<Record<CcAgentPresenceReason, string>>;

interface BestEffortLogger {
  warn: (message: string, error?: Error) => void;
}

export interface CcAgentPresenceInput {
  userId: string;
  /** Bridge-generated session id; also the slug seed. */
  instanceId: string;
  /** Basename of the workspace. Never the full path. */
  workspaceName: string;
  reason: CcAgentPresenceReason;
  source?: ICcAgentSource;
  claudeVersion?: string;
  /** `_id` of the device, when the caller does not already hold the device doc. */
  deviceId?: string;
  /** Already-resolved per-device channel override; skips the device lookup. */
  hearthChannelId?: string;
  /** WS management endpoint, for the `hearth_event` push. */
  endpoint: string;
  logger: BestEffortLogger;
}

/**
 * Resolve the channel to report into: the device's override if it is set AND
 * still owned by this user, otherwise the shared default channel. Falling back
 * rather than failing keeps a stale override from silently dropping presence.
 */
async function resolveChannelId(
  userId: string,
  hearthChannelId: string | undefined,
  deviceId: string | undefined
): Promise<string> {
  let overrideId = hearthChannelId;
  if (!overrideId && deviceId) {
    overrideId = (await ccBridgeDeviceRepository.findById(deviceId))?.hearthChannelId;
  }
  if (overrideId) {
    const owned = await hearthRepository.getOwnedChannel(userId, overrideId);
    if (owned) return owned._id.toString();
  }
  const channel = await hearthRepository.ensureChannelByName(userId, DEFAULT_HEARTH_CHANNEL_NAME);
  return channel._id.toString();
}

const hearthLog = new HearthLog(hearthRepository.store);

/**
 * Same flag the HTTP routes enforce via requireFeatureEnabled, read directly
 * because this is a WebSocket handler with no middleware chain. Fails CLOSED:
 * if the setting cannot be read we write nothing, since the cost of skipping a
 * presence report is a missing roster row, while the cost of writing anyway is
 * a credit grant for a feature the deployment has switched off.
 */
async function isHearthEnabled(): Promise<boolean> {
  try {
    const value = await getSettingByName('EnableHearth', { adminSettings: adminSettingsRepository });
    return isSettingEnabled(value ?? settingsMap.EnableHearth?.defaultValue);
  } catch {
    return false;
  }
}

/**
 * Best-effort presence report. Never throws: the bridge WS path is a live
 * product surface, so a Hearth outage must degrade to a log warning rather than
 * failing a register, an event, or a disconnect sweep.
 */
export async function reportCcAgentPresence(input: CcAgentPresenceInput): Promise<void> {
  const { userId, instanceId, workspaceName, reason, source, claudeVersion, endpoint, logger } = input;
  try {
    // The four HTTP hearth routes all gate on this; the WS path did not, and
    // EnableHearth defaults to FALSE. Without the gate, a bridge register on a
    // deployment with Hearth off still created a channel - which is exactly the
    // predicate the `hearth` gear unlocks on (hasAnyChannelForUser). That gear
    // carries a 1000-credit reward and no rewardCheck, so a disabled feature
    // paid out real credits and advertised a CTA to routes that all return 403.
    // Writing nothing when the feature is off keeps the gear locked at its root.
    if (!(await isHearthEnabled())) return;

    const channelId = await resolveChannelId(userId, input.hearthChannelId, input.deviceId);
    const slug = sessionSlug(instanceId);
    // Shared convention, NOT a bridge-local one: the hook covering this same
    // session composes the identical name, so both reporters converge on one
    // actor, one roster row and one cursor. See sessionActorName.
    const displayName = sessionActorName(instanceId);
    const actor = await hearthRepository.ensureActor(userId, 'agent', displayName);

    const payload: PresencePayload = {
      session_id: instanceId,
      slug,
      workspace: workspaceName,
      surface: CC_BRIDGE_SURFACE,
      // `reason` is a CcAgentStatus value, which presenceStateForReason maps to
      // itself - that identity mapping is what lets one function serve both
      // reporters. It sits under `activity` because that is where the shared
      // contract puts it; writing it at the top level is what made every bridge
      // event replay to `running`.
      activity: { reason },
      ...(source ? { source } : {}),
      ...(claudeVersion ? { claude_version: claudeVersion } : {}),
    };

    const event = await hearthLog.append({
      channelId,
      actorId: actor._id.toString(),
      kind: 'presence',
      human: {
        text: `${displayName} in ${workspaceName} ${REASON_PHRASES[reason] ?? 'is active'}`,
        format: 'text',
      },
      machine: { schema: PRESENCE_PAYLOAD_SCHEMA_NAME, payload },
      refs: {},
    });

    // Roster projection through the SAME function the HTTP route uses, so the
    // live row and a row rebuilt from the log cannot diverge. Still in the
    // best-effort block: the log is the source of truth and the row is derived
    // state that the next presence event repairs.
    const projection = toPresenceProjection({ event, userId, payload });
    if (projection) await hearthRepository.upsertPresence(projection);

    // Live fanout, the same push POST /api/hearth/events makes. Without it the
    // roster held the current state in Mongo while an open panel rendered the
    // snapshot it last fetched - one roster in the data, two in the UI.
    //
    // AFTER the upsert on purpose: the push tells clients to refetch, so
    // emitting it first would race them onto the pre-update row. By the same
    // reasoning it is ordered after rather than before the row write - if that
    // write failed, nothing changed and there is nothing to announce.
    //
    // Caught separately so "wrote the row but could not notify open tabs" stays
    // distinguishable from "the write itself failed", matching the split the
    // HTTP route makes. A client that misses the push recovers via catchup.
    try {
      await sendToClient(userId, endpoint, {
        action: 'hearth_event',
        event: toWireHearthEvent(event, { displayName, kind: 'agent' }),
      });
    } catch (err) {
      logger.warn(`[CC_AGENT_HEARTH] hearth_event fanout failed for ${instanceId} (non-fatal):`, err as Error);
    }
  } catch (err) {
    logger.warn(`[CC_AGENT_HEARTH] Presence report failed for ${instanceId} (non-fatal):`, err as Error);
  }
}
