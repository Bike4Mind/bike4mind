import { registerContract } from './registerContract';
import { assertUniqueOperations } from './assertUniqueOperations';
import { CONTRACTS } from '../api-contract';
import type { EndpointContract } from '../api-contract/types';
import { assertContractConventions } from '../api-contract/assertContractConventions';

const registered: EndpointContract[] = [];

/**
 * The contracts actually registered against the shared registry. document.ts
 * derives its per-operation metadata from this rather than from CONTRACTS: since
 * `registerContracts` takes an explicit array, the registry can hold a different
 * set than CONTRACTS, and a document must describe what was registered.
 */
export function registeredContracts(): readonly EndpointContract[] {
  return registered;
}

/**
 * Operation (path) registrations for the versioned public surface.
 *
 * Every public endpoint is a contract in CONTRACTS (../api-contract); registering
 * it here is the whole job. operationIds are stable camelCase - they become SDK
 * method names, so treat them as a public contract. Per-operation required scopes
 * and code samples are derived from each contract and attached as vendor
 * extensions (`x-required-scopes`, `x-codeSamples`) in document.ts after generation.
 *
 * Both guards run BEFORE registration, so a violating contract fails the spec
 * build instead of being published and then flagged. registerContract is the only
 * registerPath caller and REQUIRED_SCOPES is empty, so CONTRACTS is the complete
 * operation set - there are no hand-registered ops left to fold in.
 *
 * Exported (rather than inlined at module scope) so a test can prove the guards
 * actually run here: called with a violating array it must throw, having
 * registered nothing. Inline, deleting a guard line broke no test at all.
 */
export function registerContracts(contracts: readonly EndpointContract[] = CONTRACTS): void {
  assertUniqueOperations(contracts.map(c => ({ operationId: c.operationId, method: c.method, path: c.path })));
  assertContractConventions(contracts);

  for (const contract of contracts) {
    registerContract(contract);
    registered.push(contract);
  }
}

registerContracts();
