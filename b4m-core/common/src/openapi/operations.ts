import { registerContract } from './registerContract';
import { CONTRACTS } from '../api-contract';

/**
 * Operation (path) registrations for the versioned public surface.
 *
 * Every public endpoint is a contract in CONTRACTS (../api-contract); registering
 * it here is the whole job. operationIds are stable camelCase - they become SDK
 * method names, so treat them as a public contract. Per-operation required scopes
 * and code samples are derived from each contract and attached as vendor
 * extensions (`x-required-scopes`, `x-codeSamples`) in document.ts after generation.
 */
for (const contract of CONTRACTS) {
  registerContract(contract);
}
