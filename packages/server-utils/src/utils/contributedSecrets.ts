import {
  describeDroppedContributions,
  partitionContributed,
  type ContributedSecretSpec,
  type PartitionedContributions,
} from '@bike4mind/infra';
import { Resource } from 'sst';
import {
  contributedInfraResources,
  coreEnvNames,
  coreResourceNames,
} from '../premium-generated/infraResources.generated';

const registeredSecrets = new Set<string>();
let loaded = false;

/**
 * Register overlay-declared secrets so readContributedSecret will resolve them. Applies
 * the same drop rules as infra/secrets.ts: core names win, the first duplicate wins.
 * Registers nothing when codegen could not read the core names.
 */
export function registerContributedSecrets(
  specs: readonly ContributedSecretSpec[]
): PartitionedContributions<ContributedSecretSpec> {
  if (coreResourceNames === null || coreEnvNames === null) {
    console.warn('[config] core resource names unknown (codegen ran without infra/); no contributed secret registered');
    return { registered: [], coreCollisions: [], duplicates: [], rejected: specs.map(spec => String(spec.name)) };
  }
  const result = partitionContributed(specs, spec => spec.name, new Set([...coreResourceNames, ...coreEnvNames]));
  const fresh = result.registered.filter(spec => !registeredSecrets.has(spec.name));
  result.duplicates.push(...result.registered.filter(spec => registeredSecrets.has(spec.name)).map(spec => spec.name));
  result.registered = fresh;
  for (const spec of fresh) registeredSecrets.add(spec.name);
  for (const line of describeDroppedContributions('contributed secret', result)) console.warn(`[config] ${line}`);
  return result;
}

// Loaded on first use rather than by a side-effect import, so every handler that reads a
// contributed secret sees the registry without having to import anything first.
export function ensureContributedSecretsLoaded(): void {
  if (loaded) return;
  loaded = true;
  registerContributedSecrets(contributedInfraResources.secrets);
}

export function isContributedSecret(name: string): boolean {
  ensureContributedSecretsLoaded();
  return registeredSecrets.has(name);
}

/**
 * Value of a registered contributed secret, or undefined when the name is not registered
 * or the secret is not linked. The self-host Resource shim only knows its own manifest,
 * so an unlinked read falls back to the env var of the same name: registered names are
 * upper snake case, which is also what infra/secrets.ts writes and what toEnvKey maps to.
 */
export function readContributedSecret(name: string): string | undefined {
  if (!isContributedSecret(name)) return undefined;
  try {
    // Untyped on purpose: sst-env.d.ts only declares the secrets linked on the stage that
    // generated it, and the committed copies are generated without any overlay mounted.
    const value = (Resource as unknown as Record<string, { value?: string } | undefined>)[name]?.value;
    if (value !== undefined) return value;
  } catch {
    // Unlinked: the real SST runtime and the self-host shim both throw in the getter.
  }
  return process.env[name];
}

export function resetContributedSecretsForTests(): void {
  registeredSecrets.clear();
  loaded = false;
}
