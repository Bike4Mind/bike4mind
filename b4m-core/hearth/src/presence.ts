import { z } from 'zod';

/**
 * The ONE machine payload contract for `presence` events, shared by every
 * reporter: the Claude Code hook (packages/cli/bin/hearth-hook.mjs) and the
 * cc-bridge WS handlers (apps/client/server/websocket/ccAgentHearth.ts).
 *
 * It used to be two contracts - 'hearth.claude-code-hook@1' and
 * 'hearth.cc-bridge@1' - and that is what let the bridge write `reason` at the
 * top level while the projection read `activity.reason`. The live roster hid it
 * (the bridge upserted its row directly) but every bridge event replayed to
 * `running`, so the projection was not rebuildable from the log for half its
 * writers. One shape, parsed by one schema, is what makes that class of drift a
 * compile-or-test failure instead of a silent projection bug.
 *
 * Provenance moved from the schema name into the `surface` field, which is
 * strictly more correct: `machine.schema` is supposed to name the SHAPE, and
 * both reporters write the same shape.
 */

/** Reporters that exist today. Not an enum on the wire - see `surface` below. */
export const PRESENCE_SURFACES = ['claude-code-hook', 'cc-bridge'] as const;
export type PresenceSurface = (typeof PRESENCE_SURFACES)[number];

/**
 * Value written to `machine.schema`. A fresh name, so it starts at @1; the
 * superseded 'hearth.claude-code-hook@1' and 'hearth.cc-bridge@1' still sit in
 * the log and still project, because the projection reads the payload and never
 * the schema string.
 *
 * BUMP THIS whenever the field set below changes. Neither predecessor did - the
 * hook grew `duration_ms` while still claiming to be `@1` - which left the
 * schema string unable to discriminate the shape it names. presence.test.ts
 * pins the literal copy in the hook to this constant.
 */
export const PRESENCE_PAYLOAD_SCHEMA_NAME = 'hearth.presence@1';

/**
 * Every field optional and unknown keys dropped: a low-disclosure hook tier
 * forwards no activity block at all, and a hand-posted presence event should
 * still refresh lastSeen rather than being rejected. No length caps here on
 * purpose - the projection truncates, because losing a whole presence update
 * over a long workspace name is the worse failure.
 */
export const presencePayloadSchema = z.object({
  /** Claude Code lifecycle event name; the reason fallback for tiers 0 and 1. */
  hook_event_name: z.string().nullish(),
  session_id: z.string().nullish(),
  slug: z.string().nullish(),
  /** Workspace BASENAME. Never a full path - that is content. */
  workspace: z.string().nullish(),
  /**
   * Which reporter wrote this. A LOOSE string, not an enum: a fourth surface
   * posting an unrecognized value must land on the roster with its detail
   * intact, and a strict enum would fail the whole parse and drop the row - the
   * exact "a third reporter is expensive" cost this contract exists to remove.
   */
  surface: z.string().nullish(),
  /** Engine driving the session, where the reporter knows it. */
  source: z.string().nullish(),
  claude_version: z.string().nullish(),
  activity: z
    .object({
      reason: z.string().nullish(),
      tool: z.string().nullish(),
      permission_mode: z.string().nullish(),
      effort: z.string().nullish(),
      duration_ms: z.number().nullish(),
      subagent: z.string().nullish(),
      background_tasks: z.number().int().min(0).nullish(),
    })
    .nullish(),
});

export type PresencePayload = z.infer<typeof presencePayloadSchema>;
