import { settingsMap, type SettingKey } from '../schemas/settings';
import type { Integration } from './catalog';
import type { IntegrationCapability, IntegrationStage } from './types';

export type IntegrationStatus = 'connected' | 'available' | 'beta' | 'coming-soon';

export interface IntegrationStatusContext {
  /** Whether one admin flag reads on for this viewer. */
  isFlagOn: (key: SettingKey) => boolean;
  isAdmin: boolean;
}

export interface DerivedIntegrationStatus {
  status: IntegrationStatus;
  /** Connected won the status slot over an underlying Beta, which still deserves a tag. */
  betaTag: boolean;
  /** Visible as Beta only because the viewer is an admin: a flag behind it is off. */
  adminOnly: boolean;
}

export interface DerivedCapabilityStatus extends DerivedIntegrationStatus {
  capability: IntegrationCapability;
}

export interface DerivedIntegration extends DerivedIntegrationStatus {
  integration: Integration;
  capabilities: readonly DerivedCapabilityStatus[];
}

const dependsOnOf = (key: SettingKey): SettingKey | undefined =>
  (settingsMap as Record<string, { dependsOn?: SettingKey }>)[key]?.dependsOn;

/**
 * True when `key` and every setting up its `dependsOn` chain are on: a child flag is
 * meaningless under a parent that is off (EnableDataLakeGitHub under EnableDataLakes).
 */
export function isSettingChainOn(key: SettingKey, isFlagOn: (key: SettingKey) => boolean): boolean {
  const seen = new Set<SettingKey>();
  for (let current: SettingKey | undefined = key; current && !seen.has(current); current = dependsOnOf(current)) {
    seen.add(current);
    if (!isFlagOn(current)) return false;
  }
  return true;
}

/**
 * The status rules, for one capability or a whole entry:
 * - planned -> Coming soon
 * - a gating flag off -> Beta with the admin-only note for admins, Coming soon for everyone else
 * - otherwise ga -> Available, beta -> Beta
 * - connected (anything but planned) -> Connected, keeping a Beta tag when the rule above said Beta
 */
export function deriveStatus(
  subject: { stage: IntegrationStage; flags: readonly SettingKey[] },
  context: IntegrationStatusContext,
  connected = false
): DerivedIntegrationStatus {
  if (subject.stage === 'planned') return { status: 'coming-soon', betaTag: false, adminOnly: false };

  const flagsOn = subject.flags.every(flag => isSettingChainOn(flag, context.isFlagOn));
  const base: DerivedIntegrationStatus = !flagsOn
    ? context.isAdmin
      ? { status: 'beta', betaTag: false, adminOnly: true }
      : { status: 'coming-soon', betaTag: false, adminOnly: false }
    : { status: subject.stage === 'beta' ? 'beta' : 'available', betaTag: false, adminOnly: false };

  if (!connected) return base;
  return { status: 'connected', betaTag: base.status === 'beta', adminOnly: base.adminOnly };
}

// Lower is better. An admin-only preview ranks under a real Beta so the entry's note is
// shown only when nothing else about it is visible to everyone.
const rank = (s: DerivedIntegrationStatus): number =>
  s.status === 'available' ? 0 : s.status === 'beta' ? (s.adminOnly ? 2 : 1) : 3;

/**
 * An entry's status is the best of its capabilities' (each gated by the entry's flag and
 * its own); Connected then wins the slot. A capability's own status ignores the connection,
 * which belongs to the brand account rather than to any one capability.
 */
export function deriveIntegrationStatus(
  integration: Integration,
  context: IntegrationStatusContext,
  connected = false
): DerivedIntegration {
  const capabilities = integration.capabilities.map(capability => ({
    capability,
    ...deriveStatus(
      {
        stage: capability.stage,
        flags: [integration.flag, capability.flag].filter((f): f is SettingKey => !!f),
      },
      context
    ),
  }));

  if (integration.stage === 'planned' || capabilities.length === 0) {
    return { integration, capabilities, ...deriveStatus({ stage: 'planned', flags: [] }, context) };
  }

  const best = capabilities.reduce((a, b) => (rank(b) < rank(a) ? b : a));
  const summary: DerivedIntegrationStatus = { status: best.status, betaTag: false, adminOnly: best.adminOnly };
  if (!connected) return { integration, capabilities, ...summary };
  return {
    integration,
    capabilities,
    status: 'connected',
    betaTag: summary.status === 'beta',
    adminOnly: summary.adminOnly,
  };
}
