import { ccBridgeDeviceRepository, hearthRepository } from '@bike4mind/database';
import { DEFAULT_HEARTH_CHANNEL_NAME, HearthLog, sessionSlug } from '@bike4mind/hearth';
import type { ICcAgentSource, ICcAgentStatus } from '@bike4mind/common';

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
 * status value, the engine, and the Claude version cross this boundary. Message
 * bodies, status `text` summaries, tool input/output, `lastSummary`, and
 * `workspacePath` (a full local path) never do. The human-readable line is
 * COMPOSED here from the closed reason set rather than passing an upstream
 * string through. ccAgentHearth.test.ts pins this with bait strings.
 */

/** Machine payload contract for bridge-sourced presence events. */
const CC_BRIDGE_MACHINE_SCHEMA = 'hearth.cc-bridge@1';

/**
 * Why a session was reported. Either a lifecycle edge the handler knows or a
 * CcAgentStatus value forwarded verbatim - both are closed sets, so no
 * caller-supplied string ever reaches the log.
 */
export type CcAgentPresenceReason = 'session_start' | 'disconnected' | ICcAgentStatus;

/** Phrases for the closed reason set; anything unrecognized degrades generically. */
const REASON_PHRASES: Record<string, string> = {
  session_start: 'started a session',
  running: 'is working',
  idle: 'is idle',
  awaiting_input: 'is waiting for input',
  awaiting_permission: 'needs permission',
  disconnected: 'disconnected',
};

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
 * Best-effort presence report. Never throws: the bridge WS path is a live
 * product surface, so a Hearth outage must degrade to a log warning rather than
 * failing a register, an event, or a disconnect sweep.
 */
export async function reportCcAgentPresence(input: CcAgentPresenceInput): Promise<void> {
  const { userId, instanceId, workspaceName, reason, source, claudeVersion, logger } = input;
  try {
    const channelId = await resolveChannelId(userId, input.hearthChannelId, input.deviceId);
    const slug = sessionSlug(instanceId);
    // Same one-actor-per-session convention as the hook's `Claude Code (slug)`:
    // per-session actors are what make roster rows distinguishable and give
    // each session its own cursor and stable color downstream.
    const displayName = `${workspaceName} (${slug})`;
    const actor = await hearthRepository.ensureActor(userId, 'agent', displayName);

    const event = await hearthLog.append({
      channelId,
      actorId: actor._id.toString(),
      kind: 'presence',
      human: { text: `${displayName} ${REASON_PHRASES[reason] ?? 'is active'}`, format: 'text' },
      machine: {
        schema: CC_BRIDGE_MACHINE_SCHEMA,
        payload: {
          instanceId,
          slug,
          workspace: workspaceName,
          reason,
          ...(source ? { source } : {}),
          ...(claudeVersion ? { claudeVersion } : {}),
        },
      },
      refs: {},
    });

    // Roster projection, in the same best-effort block: the log is the source of
    // truth and the row is derived state that the next presence event repairs.
    // `reason` is a CcAgentStatus value, which presenceStateForReason maps to
    // itself - that identity mapping is what lets one function serve both the
    // bridge and the hook.
    await hearthRepository.upsertPresence({
      channelId,
      actorId: actor._id.toString(),
      userId,
      // Event time, not write time, so a delayed report cannot outrank a newer one.
      lastSeen: event.createdAt,
      reason,
      workspace: workspaceName,
      sessionId: instanceId,
      slug,
    });
  } catch (err) {
    logger.warn(`[CC_AGENT_HEARTH] Presence report failed for ${instanceId} (non-fatal):`, err as Error);
  }
}
