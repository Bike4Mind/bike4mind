import { hasDeveloperUserTag } from './schemas/user';

/**
 * Client-safe product-surface name literals.
 *
 * The `session.surface` field (SessionTypes) scopes a session to a product
 * surface. These are the canonical values for OPEN surfaces whose names are not
 * guarded IP - currently just Opti (`/opti`, the datalake survivor). Both
 * client and server import from here, so the surface contract has one home with
 * zero bundle penalty (`@bike4mind/common` is already client-safe).
 *
 * NOTE: guarded product-surface tokens (the oncology module's surface, etc.)
 * deliberately do NOT live here. Their identity home stays inside the module's
 * owned namespace per the extraction boundary - shared core must never own a
 * guarded token, nor import from an owned namespace. The literal must not even
 * appear in this file (the boundary guard greps for it), which is why this note
 * names no token. See scripts/check-libonc-boundary.sh and the module's
 * EXTRACTION.md §4.
 */

/** Product-surface tag stamped on Opti / OptiHashi (`/opti`) sessions. */
export const OPTI_SURFACE = 'opti';

/** A session's home: `null` is the main notebook list, a string is a product surface. */
export type SurfaceId = string | null;

export type WorkspaceSurfaceIconKey = 'notebook' | 'opti';

/**
 * A workspace a session can be copied or moved into. Only OPEN surfaces are registered; a
 * private surface whose name stays out of this repo is, by construction, never a move/copy
 * target and never movable out (see `checkSurfaceTransition`).
 */
export interface WorkspaceSurface {
  id: SurfaceId;
  label: string;
  iconKey: WorkspaceSurfaceIconKey;
  /** Entitlement key required to use the workspace (admins and developers bypass); null = everyone. */
  requiredEntitlement: string | null;
  /** Whether sessions may be moved or copied into and out of this workspace. */
  movable: boolean;
  /** Route prefix of the workspace, so a client can hide one its build does not ship. */
  routePrefix: string;
  /** Client URL that opens `sessionId` in this workspace. */
  sessionHref: (sessionId: string) => string;
  /** Whether a user may hide this workspace from their own UI (`isSurfaceHidden`). The main list never is. */
  hideable: boolean;
  /** Name prefix of the LLM tools this workspace contributes, filtered while it is hidden (`isToolHiddenBySurface`). */
  toolNamePrefix?: string;
}

export const WORKSPACE_SURFACES: readonly WorkspaceSurface[] = [
  {
    id: null,
    label: 'Notebooks',
    iconKey: 'notebook',
    requiredEntitlement: null,
    movable: true,
    routePrefix: '/notebooks',
    sessionHref: sessionId => `/notebooks/${encodeURIComponent(sessionId)}`,
    hideable: false,
  },
  {
    id: OPTI_SURFACE,
    label: 'OptiHashi',
    iconKey: 'opti',
    // Must stay in sync with the server gate the surface's own routes enforce (admin || developer ||
    // `optihashi:pro`) and with the client predicate in apps/client/app/hooks/data/opti.ts.
    requiredEntitlement: 'optihashi:pro',
    movable: true,
    routePrefix: '/opti',
    sessionHref: sessionId => `/opti?mode=canvas&session=${encodeURIComponent(sessionId)}`,
    hideable: true,
    toolNamePrefix: 'optihashi_',
  },
];

/** Maps the stored representations of "no surface" (`undefined`, `null`, `''`) to `null`. */
export function normalizeSurfaceId(surface: string | null | undefined): SurfaceId {
  return surface ? surface : null;
}

/**
 * A contributed `{ surface id: tool names }` table of tools denied to sessions on that surface. The
 * one home for the shape, so the generated table and both the server and the client can name it
 * without reaching into `apps/client/app` (workers must not import the UI layer).
 */
export type WorkspaceDeniedToolsTable = Readonly<Record<string, readonly string[]>>;

/** Tools a contributed `WorkspaceDeniedToolsTable` denies to a session on `surface`. */
export function resolveWorkspaceDeniedTools(
  surface: string | null | undefined,
  table: WorkspaceDeniedToolsTable | null | undefined
): string[] {
  const id = normalizeSurfaceId(surface);
  if (id === null || !table || !Object.prototype.hasOwnProperty.call(table, id)) return [];
  return [...table[id]];
}

/** The registered workspace for `surface`, or undefined for a surface this repo does not know. */
export function getWorkspaceSurface(surface: string | null | undefined): WorkspaceSurface | undefined {
  const id = normalizeSurfaceId(surface);
  return WORKSPACE_SURFACES.find(entry => entry.id === id);
}

/**
 * True when the user's `hiddenSurfaces` display preference hides `id`. Hiding is display-only: it
 * never changes access, so route gates and `canUseSurface` deliberately ignore it. The main list
 * and any unregistered or non-hideable id are never hidden.
 */
export function isSurfaceHidden(hiddenSurfaces: readonly string[] | undefined | null, id: SurfaceId): boolean {
  if (!id || !hiddenSurfaces?.includes(id)) return false;
  return getWorkspaceSurface(id)?.hideable === true;
}

/**
 * True when `toolName` belongs to a workspace the user has hidden and the active session is not in
 * that workspace. Inside the workspace's own sessions its tools stay available.
 */
export function isToolHiddenBySurface(
  toolName: string,
  hiddenSurfaces: readonly string[] | undefined | null,
  activeSurface: string | null | undefined
): boolean {
  if (!hiddenSurfaces?.length) return false;
  const active = normalizeSurfaceId(activeSurface);
  return WORKSPACE_SURFACES.some(
    surface =>
      !!surface.toolNamePrefix &&
      surface.id !== active &&
      toolName.startsWith(surface.toolNamePrefix) &&
      isSurfaceHidden(hiddenSurfaces, surface.id)
  );
}

/** What `canUseSurface` reads off a user: no DB access, so the caller resolves entitlements first. */
export interface SurfaceAccessUser {
  isAdmin?: boolean | null;
  tags?: readonly string[] | null;
  /** The user's resolved entitlement keys (subscriptions, tag grants, domain grants). */
  entitlements?: readonly string[] | null;
  /**
   * Extra entitlement keys per workspace id whose holders may keep a fork, snip or clone of a session
   * in that workspace (see `canCopyWithinSurface`). Host-supplied from what the build's premium
   * overlays declare (apps/client `PremiumWorkspaceCopyEntitlements`); this repo registers none.
   */
  copyEntitlements?: Readonly<Record<string, readonly string[]>> | null;
}

/** True when `surface` is registered and the user may use it. */
export function canUseSurface(user: SurfaceAccessUser | null | undefined, surface: string | null | undefined): boolean {
  const entry = getWorkspaceSurface(surface);
  if (!entry || !user) return false;
  if (!entry.requiredEntitlement) return true;
  if (user.isAdmin || hasDeveloperUserTag(user.tags)) return true;
  const required = entry.requiredEntitlement.trim().toLowerCase();
  return (user.entitlements ?? []).some(key => key.trim().toLowerCase() === required);
}

/**
 * True when `user` may fork, snip or clone a session that lives in `surface` and keep the copy there:
 * anyone `canUseSurface` admits, plus holders of a key `user.copyEntitlements` lists for that
 * workspace. A copy grant is deliberately weaker than use: creating a session in the workspace,
 * moving one into it, or naming it as an explicit copy target all still go through `canUseSurface`.
 */
export function canCopyWithinSurface(
  user: SurfaceAccessUser | null | undefined,
  surface: string | null | undefined
): boolean {
  if (canUseSurface(user, surface)) return true;
  const entry = getWorkspaceSurface(surface);
  // A null id is the main list, which is ungated, so canUseSurface has already answered for it.
  if (!entry?.id || !user?.copyEntitlements) return false;
  const granted = user.copyEntitlements[entry.id];
  if (!Array.isArray(granted) || granted.length === 0) return false;
  const held = new Set((user.entitlements ?? []).map(key => key.trim().toLowerCase()));
  return granted.some(key => held.has(key.trim().toLowerCase()));
}

export type SurfaceTransitionDenial = {
  ok: false;
  /** 400 for a request no caller could make succeed, 403 for one this caller is not entitled to. */
  status: 400 | 403;
  message: string;
};

/**
 * Whether a session living in `from` may be copied or moved into `to` by `user`. Both ends must be
 * registered and movable, and the user must be able to use the destination.
 */
export function checkSurfaceTransition(
  user: SurfaceAccessUser | null | undefined,
  from: string | null | undefined,
  to: string | null | undefined
): { ok: true; target: SurfaceId } | SurfaceTransitionDenial {
  const source = getWorkspaceSurface(from);
  if (!source || !source.movable) {
    return { ok: false, status: 400, message: 'This notebook cannot leave its workspace' };
  }
  const target = getWorkspaceSurface(to);
  if (!target || !target.movable) {
    return { ok: false, status: 400, message: 'Unknown workspace' };
  }
  if (!canUseSurface(user, target.id)) {
    return { ok: false, status: 403, message: 'You do not have access to that workspace' };
  }
  return { ok: true, target: target.id };
}

/** Session fields a contributed workspace may own (see `WorkspaceSessionSettingsTable`). */
export const SURFACE_OWNABLE_SESSION_FIELDS = [
  'systemPromptText',
  'enabledTools',
  'disableUserIntegrations',
  'temperature',
  'maxToolCalls',
] as const;

export type SurfaceOwnableSessionField = (typeof SURFACE_OWNABLE_SESSION_FIELDS)[number];

export interface SurfaceOwnableSessionSettings {
  systemPromptText?: string;
  enabledTools?: string[];
  disableUserIntegrations?: boolean;
  temperature?: number;
  maxToolCalls?: number;
}

/** The slice of a session the workspace-settings helpers read. */
export type SurfaceSettingsSession = SurfaceOwnableSessionSettings & {
  surface?: string | null;
  /** Owned fields the user set explicitly; the workspace neither overrides nor strips them. */
  userSetFields?: readonly string[] | null;
};

export interface WorkspaceSessionSettingsContext<TSession extends SurfaceSettingsSession = SurfaceSettingsSession> {
  user: unknown;
  session: TSession;
  logger?: { warn: (...args: unknown[]) => void };
}

export interface WorkspaceSessionSettingsEntry {
  ownedFields: readonly SurfaceOwnableSessionField[];
  resolve: (ctx: WorkspaceSessionSettingsContext) => Promise<Partial<SurfaceOwnableSessionSettings>>;
}

/**
 * A contributed `{ surface id: settings }` table: the session fields each workspace owns, resolved at
 * read time instead of being written onto its sessions. Generated by apps/client
 * scripts/generate-premium-glue.mjs (`premiumWorkspaceSessionSettings`).
 */
export type WorkspaceSessionSettingsTable = Readonly<Record<string, WorkspaceSessionSettingsEntry>>;

const OWNABLE_FIELD_SET: ReadonlySet<string> = new Set(SURFACE_OWNABLE_SESSION_FIELDS);

function ownedFieldsFor(session: SurfaceSettingsSession, table: WorkspaceSessionSettingsTable | null | undefined) {
  const id = normalizeSurfaceId(session.surface);
  if (id === null || !table || !Object.prototype.hasOwnProperty.call(table, id)) return null;
  const entry = table[id];
  const userSet = new Set(session.userSetFields ?? []);
  const fields = entry.ownedFields.filter(field => OWNABLE_FIELD_SET.has(field) && !userSet.has(field));
  return { entry, fields };
}

/**
 * The session as its workspace sees it: each owned field takes the resolver's value, or is cleared when
 * the resolver yields none. Returns a shallow copy, so pass a plain object rather than a live document.
 */
export async function applyWorkspaceSessionSettings<TSession extends SurfaceSettingsSession>(
  session: TSession,
  ctx: Omit<WorkspaceSessionSettingsContext<TSession>, 'session'>,
  table: WorkspaceSessionSettingsTable | null | undefined
): Promise<TSession> {
  const owned = ownedFieldsFor(session, table);
  if (!owned || owned.fields.length === 0) return session;
  const resolved = await owned.entry.resolve({ ...ctx, session });
  const effective = { ...session } as Record<string, unknown>;
  for (const field of owned.fields) {
    const value = resolved && Object.prototype.hasOwnProperty.call(resolved, field) ? resolved[field] : undefined;
    if (value === undefined) delete effective[field];
    else effective[field] = value;
  }
  return effective as TSession;
}

/**
 * A shallow copy of `copy` without the fields `source`'s workspace owns, for a copy that must not
 * inherit them. `source` defaults to `copy`; pass the original session when `copy` is a new record
 * built from it (its surface may differ, and a live document must not be spread).
 */
export function stripSurfaceOwnedFields<TCopy extends object>(
  copy: TCopy,
  table: WorkspaceSessionSettingsTable | null | undefined,
  source: SurfaceSettingsSession = copy as SurfaceSettingsSession
): TCopy {
  const fields = surfaceOwnedFields(source, table);
  if (fields.length === 0) return copy;
  const stripped = { ...copy } as Record<string, unknown>;
  for (const field of fields) delete stripped[field];
  return stripped as TCopy;
}

/** The fields `session`'s workspace owns, minus those the user set; what a move off it unsets. */
export function surfaceOwnedFields(
  session: SurfaceSettingsSession,
  table: WorkspaceSessionSettingsTable | null | undefined
): SurfaceOwnableSessionField[] {
  return ownedFieldsFor(session, table)?.fields ?? [];
}
