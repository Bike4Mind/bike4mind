import { CreditHolderType } from './CreditHolderTypes';
import { IBaseRepository } from './BaseTypes';
import { type IMongoDocument } from './common';
import { SettingKey } from '../../schemas';

/**
 * Scoped-settings resolver (epic #1658, lane 0 / #1660).
 *
 * The epic's governing principle: "every operational value is a lever an operator can see and
 * change, resolved platform -> org -> owner -> lake, with the narrower scope winning." This module
 * is the type foundation for that mechanism. Platform values keep living in the flat `AdminSettings`
 * collection; org/owner/lake OVERRIDES live in a separate overlay (`ScopedSetting`), so every
 * existing platform-only consumer is byte-for-byte unchanged and a setting is scoped only when it
 * opts in via {@link SettingScopeConfig}.
 */

/**
 * The rungs of the scope chain, widest to narrowest. `Platform` is the base (the `AdminSettings`
 * row); the other three are override altitudes stored in the `ScopedSetting` overlay.
 */
export enum SettingScopeLevel {
  Platform = 'platform',
  Organization = 'organization',
  Owner = 'owner',
  Lake = 'lake',
}

/**
 * The override altitudes, narrowest-first. Resolution walks this order and returns the value from
 * the narrowest rung that both carries an override AND is one the setting is `settableAt` - falling
 * through to the platform base otherwise. Exported so the resolver and its tests share one order of
 * truth rather than re-encoding "narrower wins" in two places.
 */
export const SETTING_SCOPE_PRECEDENCE = [
  SettingScopeLevel.Lake,
  SettingScopeLevel.Owner,
  SettingScopeLevel.Organization,
] as const;

/**
 * The owning principal of a resource, mirroring the codebase's canonical `{ id, type }` owner pair
 * (see `CreditHolderType` / `UsageOwnerType`). An owner is a User or an Organization - never an
 * Agent, which does not own lakes or files - so this narrows {@link CreditHolderType} deliberately.
 *
 * Neither `DataLake` nor `FabFile` stores an owner *type*; it is derived (an `organizationId` on the
 * resource means an Organization owner, its absence means the individual `createdByUserId`/`userId`).
 * The {@link scopeForLake} / {@link scopeForFileOwner} builders are the single place that derivation
 * lives, so callers never re-implement it.
 */
export type SettingOwnerType = CreditHolderType.User | CreditHolderType.Organization;

export interface SettingOwner {
  id: string;
  type: SettingOwnerType;
}

/**
 * The context a value is resolved against. Every rung is optional at the type level so a bare
 * platform read (`{}`) stays legal - but the epic mandates the owner rung is a first-class altitude,
 * not folded into org (#1660: "the owner rung is required, not optional"). The builders below always
 * populate `owner`, and the resolver fails loud if a setting `settableAt` owner/lake is resolved with
 * no owner in scope, so the mandate is enforced where it matters instead of blocking platform reads.
 */
export interface SettingScope {
  /** The organization boundary the resource lives under, if any. */
  organizationId?: string;
  /** The owning principal (individual user or organization) of the resource. */
  owner?: SettingOwner;
  /** The specific data lake, when resolving a lake-scoped value. */
  lakeId?: string;
}

/**
 * Per-setting scope metadata, declared once next to the setting definition. Absent on a setting
 * means platform-only - exactly today's behavior - which is why adding this field breaks no existing
 * consumer. Present, it declares which override rungs the setting honors and an optional safety-rail
 * clamp applied to every resolved value.
 */
export interface SettingScopeConfig {
  /**
   * Which override rungs may hold a value for this setting (platform is always the base). This is
   * what encodes epic decision 7 without a special resolver mode: a setting that resolves at
   * file-owner altitude with the lake as a *constraint* (chunk policy) is registered
   * `settableAt: ['owner']`, so the lake structurally cannot override it - the lake's REQUIRED policy
   * is a separate concern the consumer reads on its own, never a narrower-wins override here.
   */
  settableAt: readonly Exclude<SettingScopeLevel, SettingScopeLevel.Platform>[];
  /**
   * Optional hard safety rail applied to every resolved numeric value at every altitude, including
   * the platform default (epic: "adjustable does not mean unbounded"). The canonical use is clamping
   * a configured chunk size down to the embedding model's context window (#1662) so an over-large
   * lever cannot break vectorization downstream. Only meaningful for number settings.
   */
  clamp?: (value: number, scope: SettingScope) => number;
}

/**
 * A single override row in the overlay collection. Platform values are NOT stored here (they remain
 * in `AdminSettings`); only org/owner/lake overrides are. `ownerType` is persisted alongside the id
 * for owner-scoped rows so an owner override can be attributed and audited as individual-vs-org
 * without re-deriving it (this is the distinction #1675's cost tiers turn on).
 */
export interface IScopedSetting extends IMongoDocument {
  scopeLevel: Exclude<SettingScopeLevel, SettingScopeLevel.Platform>;
  scopeId: string;
  /**
   * Present only when `scopeLevel` is `Owner`: attribution of an individual vs org owner for audit
   * and #1675's cost tiers. NOT part of the row's identity - the unique key is `(scopeLevel, scopeId,
   * settingName)` and `scopeId` alone addresses the rung, so a writer must never treat `ownerType` as
   * disambiguating two rows at the same `scopeId`. Written by a future scoped-override writer.
   */
  ownerType?: SettingOwnerType;
  settingName: SettingKey;
  settingValue: string;
}

/** A (level, id) address of one override rung, used to batch-read overrides for a scope. */
export interface ScopeRef {
  scopeLevel: Exclude<SettingScopeLevel, SettingScopeLevel.Platform>;
  scopeId: string;
}

export interface IScopedSettingsRepository extends IBaseRepository<IScopedSetting> {
  /**
   * Batch-read overrides for a set of (level, id) rungs and setting names in a single query. Returns
   * every matching override row; the caller (the resolver) picks the narrowest per name. Only the
   * rungs actually present in a scope are ever queried, so a platform-altitude read passes no refs
   * and touches this collection zero times.
   */
  findOverrides: (scopes: ScopeRef[], settingNames: SettingKey[]) => Promise<IScopedSetting[]>;
}
