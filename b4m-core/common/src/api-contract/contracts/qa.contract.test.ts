import { describe, it, expect } from 'vitest';
import { ApiKeyScope } from '../../types/entities/UserApiKeyTypes';
import { assertContractConventions } from '../assertContractConventions';
import { CONTRACTS } from './index';
import { ingestQaRunContract, requestQaUploadsContract } from './qa.contract';

describe('qa contracts', () => {
  it('scope-gate both endpoints on qa:ingest only', () => {
    expect(ingestQaRunContract.scopes).toEqual([ApiKeyScope.QA_INGEST]);
    expect(requestQaUploadsContract.scopes).toEqual([ApiKeyScope.QA_INGEST]);
  });
  it('are registered in CONTRACTS', () => {
    expect(CONTRACTS).toContain(ingestQaRunContract);
    expect(CONTRACTS).toContain(requestQaUploadsContract);
  });
  it('validate with the shared request schemas', () => {
    expect(ingestQaRunContract.request.safeParse({}).success).toBe(false);
    expect(ingestQaRunContract.request.safeParse(ingestQaRunContract.requestExample).success).toBe(true);
    expect(requestQaUploadsContract.request.safeParse(requestQaUploadsContract.requestExample).success).toBe(true);
  });
  it('satisfy the public API conventions', () => {
    expect(() => assertContractConventions([ingestQaRunContract, requestQaUploadsContract])).not.toThrow();
  });
});
