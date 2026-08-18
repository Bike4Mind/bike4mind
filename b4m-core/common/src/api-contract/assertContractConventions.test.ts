import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { assertContractConventions } from './assertContractConventions';
import { ApiErrorSchema } from '../schemas/chat';
import { CONTRACTS } from './contracts';
import { ApiKeyScope } from '../types/entities/UserApiKeyTypes';
import type { EndpointContract, ResponseSpec } from './types';

/** A conforming baseline; each test overrides only the field under assertion. */
function contract(overrides: Partial<EndpointContract> = {}): EndpointContract {
  return {
    method: 'post',
    path: '/api/v1/widgets',
    operationId: 'createWidget',
    summary: 'Create a widget',
    auth: 'apiKeyOrJwt',
    scopes: [ApiKeyScope.AI_GENERATE],
    responses: {
      200: { description: 'Created.', schema: z.object({ id: z.string() }) },
      422: { description: 'Invalid.', schema: ApiErrorSchema },
    },
    ...overrides,
  };
}

const errorResponse = (spec: Partial<ResponseSpec> = {}): ResponseSpec => ({
  description: 'Failed.',
  schema: ApiErrorSchema,
  ...spec,
});

describe('assertContractConventions', () => {
  it('accepts a contract that follows every convention', () => {
    expect(() => assertContractConventions([contract()])).not.toThrow();
  });

  it('accepts the real published surface', () => {
    expect(() => assertContractConventions(CONTRACTS)).not.toThrow();
  });

  describe('operationId', () => {
    it.each(['create_widget', 'CreateWidget', '2ndWidget', ''])('rejects %o', id => {
      expect(() => assertContractConventions([contract({ operationId: id })])).toThrow(/is not camelCase/);
    });

    it('accepts a camelCase id with digits', () => {
      expect(() => assertContractConventions([contract({ operationId: 'createWidgetV2' })])).not.toThrow();
    });
  });

  describe('exemptions', () => {
    it('lets a published endpoint keep an off-table status with a stated reason', () => {
      const responses = { ...contract().responses, 402: errorResponse() };
      expect(() =>
        assertContractConventions([
          contract({ responses, conventionExemptions: { 'status-table': { 402: 'live callers depend on 402' } } }),
        ])
      ).not.toThrow();
    });

    // The leak that a contract-wide exemption would have: excusing 402 must not
    // wave through an unrelated off-table status on the same endpoint.
    it('does not let an exempted status excuse a DIFFERENT unexcused status', () => {
      const responses = { ...contract().responses, 402: errorResponse(), 418: errorResponse() };
      expect(() =>
        assertContractConventions([
          contract({ responses, conventionExemptions: { 'status-table': { 402: 'live callers depend on 402' } } }),
        ])
      ).toThrow(/status 418/);
    });

    it('lets a published endpoint stay scope-less with a stated reason', () => {
      expect(() =>
        assertContractConventions([
          contract({ scopes: undefined, conventionExemptions: { 'scope-required': 'gating now would 403 live keys' } }),
        ])
      ).not.toThrow();
    });

    it('does not let an exemption for one rule excuse a different rule', () => {
      expect(() =>
        assertContractConventions([
          contract({ path: '/api/widgets', conventionExemptions: { 'status-table': 'unrelated' } }),
        ])
      ).toThrow(/version root/);
    });

    it('ignores an empty-string reason, so an exemption cannot be claimed without stating why', () => {
      expect(() =>
        assertContractConventions([contract({ scopes: undefined, conventionExemptions: { 'scope-required': '' } })])
      ).toThrow(/declares no scopes/);
    });

    it('ignores an empty-string reason on a status exemption too', () => {
      const responses = { ...contract().responses, 402: errorResponse() };
      expect(() =>
        assertContractConventions([contract({ responses, conventionExemptions: { 'status-table': { 402: '' } } })])
      ).toThrow(/status 402/);
    });
  });

  describe('emitsRateLimitHeaders', () => {
    // apiKeyRateLimit is mounted only on the api-key chain (baseApi), so any other
    // auth mode claiming the headers is publishing something it cannot send.
    it.each(['jwtOnly', 'public'] as const)('rejects the flag on a %s contract', auth => {
      expect(() =>
        assertContractConventions([contract({ auth, scopes: undefined, emitsRateLimitHeaders: true })])
      ).toThrow(/can never send them/);
    });

    it('accepts the flag on an apiKeyOrJwt contract', () => {
      expect(() => assertContractConventions([contract({ emitsRateLimitHeaders: true })])).not.toThrow();
    });
  });

  describe('version root', () => {
    it('rejects a new path outside /api/v1/', () => {
      expect(() => assertContractConventions([contract({ path: '/api/widgets' })])).toThrow(/version root/);
    });

    it('rejects a new path on a frozen non-canonical root', () => {
      expect(() => assertContractConventions([contract({ path: '/api/ai/v1/widgets' })])).toThrow(/version root/);
    });

    it.each(['/api/chat', '/api/ai/v1/tools', '/api/ai/v1/completions'])('grandfathers %s', path => {
      expect(() => assertContractConventions([contract({ path })])).not.toThrow();
    });

    // The /api/v1 prefix must not match a path that merely starts with those
    // characters (e.g. a hypothetical /api/v10 root).
    it('rejects a path that only prefix-matches the version root', () => {
      expect(() => assertContractConventions([contract({ path: '/api/v10/widgets' })])).toThrow(/version root/);
    });
  });

  describe('scopes', () => {
    it.each([undefined, []] as const)('rejects an apiKeyOrJwt contract with scopes %o', scopes => {
      expect(() => assertContractConventions([contract({ scopes })])).toThrow(/declares no scopes/);
    });

    it.each(['jwtOnly', 'public'] as const)('rejects scopes on a %s contract', auth => {
      expect(() => assertContractConventions([contract({ auth })])).toThrow(/never enforced for that auth mode/);
    });

    it.each(['jwtOnly', 'public'] as const)('accepts a %s contract with no scopes', auth => {
      expect(() => assertContractConventions([contract({ auth, scopes: undefined })])).not.toThrow();
    });
  });

  describe('status table', () => {
    it('rejects 402, so promoting an insufficient-credits endpoint is a conscious decision', () => {
      const responses = { ...contract().responses, 402: errorResponse() };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(
        /status 402 is not in the shared status table/
      );
    });

    it('rejects an off-table status', () => {
      const responses = { ...contract().responses, 418: errorResponse() };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(/status 418/);
    });

    it('accepts the documented shared conditions', () => {
      const responses = {
        202: { description: 'Accepted.', schema: z.object({ job_id: z.string() }) },
        413: errorResponse(),
        429: errorResponse(),
        503: errorResponse(),
      };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });
  });

  describe('error envelope', () => {
    it('rejects a body with no stated reason that drops the envelope', () => {
      const responses = {
        ...contract().responses,
        503: { description: 'Down.', schema: z.object({ oops: z.string() }) },
      };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(/does not carry the shared error/);
    });

    // The conventions tell authors to extend the envelope with typed members, so an
    // identity check against ApiErrorSchema would reject the very pattern we ask for.
    it('accepts a body that EXTENDS the envelope with typed members', () => {
      const responses = {
        ...contract().responses,
        503: {
          description: 'Down.',
          schema: z.object({
            error: z.string(),
            request_id: z.string().optional(),
            errorCode: z.literal('provider_unavailable').optional(),
            provider: z.string().optional(),
          }),
        },
      };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });

    it('accepts an extension that omits request_id entirely', () => {
      const responses = {
        ...contract().responses,
        413: { description: 'Too big.', schema: z.object({ error: z.string(), fileUrl: z.string().optional() }) },
      };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });

    it('rejects an optional error field - a client must always be able to read it', () => {
      const responses = {
        ...contract().responses,
        503: { description: 'Down.', schema: z.object({ error: z.string().optional() }) },
      };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(/does not carry the shared error/);
    });

    it('rejects a required non-string request_id', () => {
      const responses = {
        ...contract().responses,
        503: { description: 'Down.', schema: z.object({ error: z.string(), request_id: z.number() }) },
      };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(/does not carry the shared error/);
    });

    it('rejects a non-object body (a union has no envelope to read)', () => {
      const responses = {
        ...contract().responses,
        500: { description: 'Failed.', schema: z.union([z.object({ ok: z.boolean() }), ApiErrorSchema]) },
      };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(/does not carry the shared error/);
    });

    it('does not check a raw non-JSON body declared with an explicit contentType', () => {
      const responses = {
        ...contract().responses,
        413: { description: 'Audio too large.', contentType: 'audio/mpeg' },
      };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });

    // registerContract defaults a schema-less response to application/json carrying
    // an opaque binary schema, so "no schema" must not be read as "not JSON" - that
    // would let a forgotten schema bypass the envelope gate entirely.
    it('rejects a schema-less error response that defaults to JSON', () => {
      const responses = { ...contract().responses, 500: { description: 'Boom.' } };
      expect(() => assertContractConventions([contract({ responses })])).toThrow(/declares no schema/);
    });

    it('accepts a bespoke error schema that states its reason', () => {
      const responses = {
        ...contract().responses,
        503: { description: 'Down.', schema: z.object({ oops: z.string() }), bespokeErrorShape: 'legacy shape' },
      };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });

    it('does not envelope-check a success response', () => {
      const responses = { 200: { description: 'OK.', schema: z.object({ id: z.string() }) } };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });

    it('does not envelope-check a non-JSON error body', () => {
      const responses = {
        ...contract().responses,
        503: { description: 'Down.', schema: z.string(), contentType: 'text/event-stream' },
      };
      expect(() => assertContractConventions([contract({ responses })])).not.toThrow();
    });
  });

  it('names the offending contract and points at the conventions doc', () => {
    expect(() => assertContractConventions([contract({ path: '/api/widgets' })])).toThrow(
      /Contract "createWidget" \(POST \/api\/widgets\).+CONVENTIONS\.md/s
    );
  });

  it('checks every contract, not just the first', () => {
    expect(() => assertContractConventions([contract(), contract({ operationId: 'bad_id' })])).toThrow(
      /is not camelCase/
    );
  });
});
