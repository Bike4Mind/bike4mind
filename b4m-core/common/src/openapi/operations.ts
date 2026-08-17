import { registerContract } from './registerContract';
import { assertUniqueOperations } from './assertUniqueOperations';
import { CONTRACTS } from '../api-contract';
import { assertContractConventions } from '../api-contract/assertContractConventions';

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
 */
assertUniqueOperations(CONTRACTS.map(c => ({ operationId: c.operationId, method: c.method, path: c.path })));
assertContractConventions(CONTRACTS);

for (const contract of CONTRACTS) {
  registerContract(contract);
}
