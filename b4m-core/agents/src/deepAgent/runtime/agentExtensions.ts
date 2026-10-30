/**
 * Agent-extension registry: lets a host or a mounted package contribute per-surface
 * orchestration profiles and tool-map guards to the agent executor without the executor
 * naming them.
 *
 * A host registers its own entries as built-ins, then folds in contributions, then freezes the
 * registry so nothing can mutate it after module load. Built-ins fail loudly on a duplicate
 * (that is a programming error in the host); a contribution that collides or is malformed is
 * dropped with a warning, and a contributed profile or guard that throws at run time is skipped
 * with a warning, so one bad package cannot take the executor down.
 */

import { z } from 'zod';
import type { ToolbeltProfile } from './toolbelts';

/**
 * Subset of the orchestration fields the executor consumes when deciding the top-level tool
 * whitelist and iteration ceiling. Intentionally narrower than a persisted agent document.
 */
export interface ResolvedOrchestrationProfile {
  /** Stable id for logs / billing attribution. Persisted agent id, or `synthetic:*`. */
  id: string;
  /** Human-readable label for logs. */
  name: string;
  /** Tool whitelist sourced from agent OR admin defaults. */
  allowedTools: string[];
  /** Tool denylist sourced from agent OR admin defaults. */
  deniedTools: string[];
  /** Per-thoroughness iteration ceiling. */
  maxIterations: { quick: number; medium: number; very_thorough: number };
  /** Thoroughness selected when the caller does not override. */
  defaultThoroughness: 'quick' | 'medium' | 'very_thorough';
  /** Whether this profile was synthesized from admin defaults (vs sourced from a persisted agent). */
  isSynthetic: boolean;
  /**
   * Whether `allowedTools` fell back to admin defaults instead of being the agent's own
   * curation. `isSynthetic` does NOT answer this: a persisted agent with no whitelist of its
   * own gets the org defaults and is still non-synthetic. Callers deciding whether a belt may
   * be widened must read provenance, not doc-loaded-ness (see `pickEffectiveEnabledTools`).
   * True for synthetic profiles, which are built from admin defaults by construction.
   */
  allowedToolsFromDefaults?: boolean;
  /**
   * Whether `allowedTools` IS the run's toolbelt rather than a default the payload may replace.
   *
   * A surface that authors its own profile is picking the toolset deliberately -- the loop only
   * works if every tool in the walk is present -- and the client already tells the user as much
   * ("your tool selection was replaced by the agent toolset") when the router upgrades a chat
   * send. Left false for admin-default and persisted-agent profiles, where the caller's payload
   * (a briefcase override, a quest node's scoped toolset) legitimately takes precedence.
   */
  toolsetIsExclusive?: boolean;
  /**
   * Persona system prompt for the agent, built from a persisted agent's `systemPrompt` /
   * `personality`. `undefined` for synthetic (agentless) profiles, which have no persona.
   */
  systemPrompt?: string;
  /**
   * Per-profile confidence-gate threshold. The executor pauses for human review when consecutive
   * iterations' confidence falls below this. Omitted => the executor's global default. Set to 0 to
   * effectively disable the gate for a profile whose tools are sandboxed and whose loop is meant
   * to run unattended; maxIterations remains the runaway backstop.
   */
  confidenceGateThreshold?: number;
}

export interface AgentExtensionLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface SurfaceProfileContext {
  executionId: string;
  logger: AgentExtensionLogger;
  /** Names of the tools contributed to this deployment, so a profile can offer them without a hand-kept list. */
  contributedToolNames: readonly string[];
}

export interface SurfaceProfileEntry {
  id: string;
  /** Session surface this profile applies to. At most one profile per surface. */
  surface: string;
  build(ctx: SurfaceProfileContext): ResolvedOrchestrationProfile;
}

/**
 * `runState` is ONE mutable object shared by every guard in one invocation, so guards cooperate
 * through it: a guard may read what an inner guard recorded. Only fields the host's own state
 * schema declares survive a continuation; a field a guard adds is gone on the next invocation.
 * A guard must never replace it, only mutate the fields it owns.
 */
export interface ToolMapGuardContext<TState> {
  executionId: string;
  logger: AgentExtensionLogger;
  /** Session surface of the run; `null` for a main-notebook chat. Set on every invocation, continuations included. */
  surface?: string | null;
  runState: TState;
}

/**
 * A guard runs on EVERY execution -- every surface, pinned-agent runs and plain chats alike -- so
 * one meant for a single surface must check `ctx.surface` (or the tool names it wraps) itself.
 */
export interface ToolMapGuardEntry<TTools, TState> {
  id: string;
  /** Lower wraps first (innermost). Contributions take 1-99; the host's built-ins sit at 100 and above. */
  priority: number;
  /**
   * Returns a new map; must not mutate `tools`. The host copies only the map, not its entries, and
   * the entries may be shared across invocations, so wrap a tool into a NEW entry rather than
   * reassigning a field (e.g. `execute`) on the one passed in.
   */
  apply(tools: TTools, ctx: ToolMapGuardContext<TState>): TTools;
}

export interface AgentExtensionContribution<TTools = Record<string, unknown>, TState = unknown> {
  surfaceProfiles?: readonly SurfaceProfileEntry[];
  toolMapGuards?: readonly ToolMapGuardEntry<TTools, TState>[];
  /** Wake-cycle toolbelts for new roles; the host passes them to `registerToolbelts`, not to this registry. */
  toolbelts?: readonly ToolbeltProfile[];
}

export type AgentExtensionSource = 'builtin' | 'contribution';

export interface AgentExtensionListing {
  surfaceProfiles: Array<{ id: string; surface: string; source: AgentExtensionSource }>;
  toolMapGuards: Array<{ id: string; priority: number; source: AgentExtensionSource }>;
}

export interface AgentExtensionRegistry<TTools, TState> {
  registerSurfaceProfile(entry: SurfaceProfileEntry, source?: AgentExtensionSource): void;
  registerToolMapGuard(entry: ToolMapGuardEntry<TTools, TState>, source?: AgentExtensionSource): void;
  registerContribution(contribution: AgentExtensionContribution<TTools, TState>): void;
  /** Stops further registration; a later register call throws. */
  freeze(): void;
  /** `undefined` when no profile is registered for the surface (or no surface was given). */
  resolveSurfaceProfile(
    surface: string | undefined | null,
    ctx: SurfaceProfileContext
  ): ResolvedOrchestrationProfile | undefined;
  applyToolMapGuards(tools: TTools, ctx: ToolMapGuardContext<TState>): TTools;
  list(): AgentExtensionListing;
}

export const CONTRIBUTED_GUARD_PRIORITY_MIN = 1;
export const CONTRIBUTED_GUARD_PRIORITY_MAX = 99;

interface Stored<T> {
  entry: T;
  source: AgentExtensionSource;
}

const surfaceProfileEntrySchema = z.object({
  id: z.string().min(1),
  surface: z.string().min(1),
  build: z.custom<SurfaceProfileEntry['build']>(value => typeof value === 'function'),
});

const toolMapGuardEntrySchema = z.object({
  id: z.string().min(1),
  priority: z.number().int(),
  apply: z.custom<(tools: unknown, context: unknown) => unknown>(value => typeof value === 'function'),
});

const toolMapSchema = z.record(z.string(), z.unknown());

const THOROUGHNESS_LEVELS = ['quick', 'medium', 'very_thorough'] as const;

const orchestrationProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  allowedTools: z.array(z.string()),
  deniedTools: z.array(z.string()),
  maxIterations: z.object({
    quick: z.number().int().positive(),
    medium: z.number().int().positive(),
    very_thorough: z.number().int().positive(),
  }),
  defaultThoroughness: z.enum(THOROUGHNESS_LEVELS),
  isSynthetic: z.boolean(),
  allowedToolsFromDefaults: z.boolean().optional(),
  toolsetIsExclusive: z.boolean().optional(),
  systemPrompt: z.string().optional(),
  confidenceGateThreshold: z.number().min(0).max(1).optional(),
});

function isProfileShaped(value: unknown): value is ResolvedOrchestrationProfile {
  return orchestrationProfileSchema.safeParse(value).success;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

// Callbacks are synchronous, but a malformed async contribution still needs its rejection handled.
function observeDiscardedResult(value: unknown, logger: AgentExtensionLogger, id: string): boolean {
  if (!isPromiseLike(value)) return false;
  void Promise.resolve(value).catch((error: unknown) => {
    logger.warn(`[agent-extensions] discarded asynchronous result from "${id}" rejected`, {
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return true;
}

export function createAgentExtensionRegistry<TTools, TState>(
  options: {
    logger?: Pick<AgentExtensionLogger, 'warn'>;
    /** Host-specific validation of contributed tool entries; built-ins remain fail-fast. */
    validateToolMap?: (tools: unknown) => boolean;
  } = {}
): AgentExtensionRegistry<TTools, TState> {
  const warn = (message: string, meta: Record<string, unknown>) => options.logger?.warn(message, meta);
  const profilesBySurface = new Map<string, Stored<SurfaceProfileEntry>>();
  const guards = new Map<string, Stored<ToolMapGuardEntry<TTools, TState>>>();
  let frozen = false;

  const assertOpen = (id: string) => {
    if (frozen) throw new Error(`agent-extension registry is frozen; cannot register "${id}"`);
  };

  // A built-in conflict is a host bug and throws; a contribution conflict is dropped so a bad
  // package degrades to "its extension is missing" instead of failing every run.
  const reject = (source: AgentExtensionSource, message: string, meta: Record<string, unknown>): void => {
    if (source === 'builtin') throw new Error(message);
    warn(`[agent-extensions] dropped contribution: ${message}`, meta);
  };

  const registerSurfaceProfile = (entry: SurfaceProfileEntry, source: AgentExtensionSource = 'contribution') => {
    assertOpen(entry?.id);
    if (!surfaceProfileEntrySchema.safeParse(entry).success) {
      return reject(source, `surface profile "${String(entry?.id)}" is malformed`, { id: entry?.id });
    }
    const bySurface = profilesBySurface.get(entry.surface);
    const byId = [...profilesBySurface.values()].find(p => p.entry.id === entry.id);
    if (bySurface || byId) {
      return reject(source, `surface profile "${entry.id}" collides with "${(bySurface ?? byId)!.entry.id}"`, {
        id: entry.id,
        surface: entry.surface,
      });
    }
    profilesBySurface.set(entry.surface, {
      entry: { id: entry.id, surface: entry.surface, build: entry.build },
      source,
    });
  };

  const registerToolMapGuard = (
    entry: ToolMapGuardEntry<TTools, TState>,
    source: AgentExtensionSource = 'contribution'
  ) => {
    assertOpen(entry?.id);
    if (!toolMapGuardEntrySchema.safeParse(entry).success) {
      return reject(source, `tool-map guard "${String(entry?.id)}" is malformed`, { id: entry?.id });
    }
    if (
      source === 'contribution' &&
      (entry.priority < CONTRIBUTED_GUARD_PRIORITY_MIN || entry.priority > CONTRIBUTED_GUARD_PRIORITY_MAX)
    ) {
      return reject(source, `tool-map guard "${entry.id}" priority ${entry.priority} is outside 1-99`, {
        id: entry.id,
        priority: entry.priority,
      });
    }
    if (guards.has(entry.id)) {
      return reject(source, `tool-map guard "${entry.id}" is already registered`, { id: entry.id });
    }
    guards.set(entry.id, {
      entry: { id: entry.id, priority: entry.priority, apply: entry.apply },
      source,
    });
  };

  const sortedGuards = () =>
    [...guards.values()].sort(
      (a, b) => a.entry.priority - b.entry.priority || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0)
    );

  return {
    registerSurfaceProfile,
    registerToolMapGuard,
    registerContribution(contribution) {
      assertOpen('contribution');
      const surfaceProfiles = contribution?.surfaceProfiles ?? [];
      const toolMapGuards = contribution?.toolMapGuards ?? [];
      if (!contribution || !Array.isArray(surfaceProfiles) || !Array.isArray(toolMapGuards)) {
        return reject('contribution', 'contribution is malformed', {});
      }
      for (const profile of surfaceProfiles) registerSurfaceProfile(profile, 'contribution');
      for (const guard of toolMapGuards) registerToolMapGuard(guard, 'contribution');
    },
    freeze() {
      frozen = true;
    },
    resolveSurfaceProfile(surface, ctx) {
      if (!surface) return undefined;
      const stored = profilesBySurface.get(surface);
      if (!stored) return undefined;
      if (stored.source === 'builtin') return stored.entry.build(ctx);
      try {
        const built = stored.entry.build(ctx);
        const asynchronous = observeDiscardedResult(built, ctx.logger, stored.entry.id);
        if (asynchronous || !isProfileShaped(built)) {
          ctx.logger.warn(
            `[agent-extensions] skipped surface profile "${stored.entry.id}": build returned no profile`,
            {
              id: stored.entry.id,
            }
          );
          return undefined;
        }
        return built;
      } catch (err) {
        ctx.logger.warn(`[agent-extensions] skipped surface profile "${stored.entry.id}": build threw`, {
          id: stored.entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
        return undefined;
      }
    },
    applyToolMapGuards(tools, ctx) {
      return sortedGuards().reduce((acc, { entry, source }) => {
        if (source === 'builtin') return entry.apply(acc, ctx);
        let next: TTools;
        let valid: boolean;
        try {
          next = entry.apply({ ...acc }, ctx);
          const asynchronous = observeDiscardedResult(next, ctx.logger, entry.id);
          valid = !asynchronous && toolMapSchema.safeParse(next).success && (options.validateToolMap?.(next) ?? true);
        } catch (err) {
          ctx.logger.warn(`[agent-extensions] skipped tool-map guard "${entry.id}": apply threw`, {
            id: entry.id,
            error: err instanceof Error ? err.message : String(err),
          });
          return acc;
        }
        if (!valid) {
          ctx.logger.warn(`[agent-extensions] skipped tool-map guard "${entry.id}": apply returned no tool map`, {
            id: entry.id,
          });
          return acc;
        }
        return next;
      }, tools);
    },
    list() {
      return {
        surfaceProfiles: [...profilesBySurface.values()]
          .map(({ entry, source }) => ({ id: entry.id, surface: entry.surface, source }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
        toolMapGuards: sortedGuards().map(({ entry, source }) => ({ id: entry.id, priority: entry.priority, source })),
      };
    },
  };
}
