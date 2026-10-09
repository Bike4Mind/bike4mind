import { describe, expect, it } from 'vitest';
import { API_KEY_RATE_LIMIT_DEFAULTS, API_KEY_RATE_LIMIT_HEADER_NAMES, MAX_REQUEST_ID_LENGTH } from '@bike4mind/common';
import {
  GENERIC_MODAL_API_KEY_SCOPES,
  DEDICATED_FLOW_SCOPES,
  genericApiKeyScopesFor,
} from '@client/app/constants/apiKeyScopes';
import { getApiReferenceContent, renderScopeTableRows } from './apiReferenceContent';

const API_REFERENCE_CONTENT = getApiReferenceContent('https://b4m.test', GENERIC_MODAL_API_KEY_SCOPES);

const scopesSection = (): string => {
  const start = API_REFERENCE_CONTENT.indexOf('### Scopes');
  const end = API_REFERENCE_CONTENT.indexOf('\n### ', start + 1);
  return API_REFERENCE_CONTENT.slice(start, end);
};

const tableScopes = (): Set<string> =>
  new Set([...scopesSection().matchAll(/^\| `([^`]+)` \|/gm)].map(match => match[1]));

describe('API reference scopes table', () => {
  it('lists every scope a user can select when creating a key', () => {
    const listed = tableScopes();
    for (const scope of GENERIC_MODAL_API_KEY_SCOPES) {
      expect(listed).toContain(scope.value);
    }
  });

  it('documents every scope an endpoint section says it requires', () => {
    const listed = tableScopes();
    const requiredLines = API_REFERENCE_CONTENT.split('\n').filter(line =>
      /^\*\*Required API-key scope\b[^*]*:\*\*/.test(line)
    );
    // Only the tokens after the label: the "scope for refineText" form names an endpoint, not a scope.
    const required = requiredLines.flatMap(line =>
      [...line.slice(line.indexOf(':**')).matchAll(/`([^`]+)`/g)].map(match => match[1])
    );

    // Pin both label forms (plain and "scope for X"); the tokens alone would not catch a dropped line.
    expect(requiredLines).toHaveLength(3);
    expect(requiredLines.some(line => line.includes('for `refineText`'))).toBe(true);
    expect(required).toContain('notebooks:read');
    expect(required).toContain('projects:read');
    expect(required).toContain('projects:write');
    for (const scope of required) {
      expect(listed).toContain(scope);
    }
  });

  it('leaves dedicated-flow scopes out of the table', () => {
    const listed = tableScopes();
    for (const scope of DEDICATED_FLOW_SCOPES) {
      expect(listed).not.toContain(scope);
    }
  });

  it('names no premium scope when built from the list offered without Opti access', () => {
    expect(getApiReferenceContent('https://b4m.test', genericApiKeyScopesFor(false))).not.toContain('optihashi:');
  });

  it('escapes pipes so a description cannot split its table row', () => {
    for (const row of renderScopeTableRows(GENERIC_MODAL_API_KEY_SCOPES).split('\n')) {
      expect(row.replaceAll('\\|', '').split('|')).toHaveLength(4);
    }
  });
});

describe('API reference base URL', () => {
  it('uses the given origin in place of a placeholder host', () => {
    expect(API_REFERENCE_CONTENT).toContain('served from `https://b4m.test`');
    expect(API_REFERENCE_CONTENT).toContain('curl -i -X POST https://b4m.test/api/chat');
    expect(API_REFERENCE_CONTENT).not.toContain('https://your-deployment.example.com');
  });
});

const section = (heading: string): string => {
  const start = API_REFERENCE_CONTENT.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = API_REFERENCE_CONTENT.indexOf('\n---', start);
  return API_REFERENCE_CONTENT.slice(start, end);
};

describe('API reference facts shared with the generated docs', () => {
  // Hardcoded rather than read from the constant, so a header renamed or dropped there
  // cannot vanish from both sides of the comparison at once.
  const EXPECTED_HEADERS = [
    'X-RateLimit-Limit-Minute',
    'X-RateLimit-Remaining-Minute',
    'X-RateLimit-Reset-Minute',
    'X-RateLimit-Limit-Day',
    'X-RateLimit-Remaining-Day',
    'X-RateLimit-Reset-Day',
  ];

  it('quotes the enforced rate-limit defaults', () => {
    const rates = section('### Rate Limits');
    const { requestsPerMinute, requestsPerDay } = API_KEY_RATE_LIMIT_DEFAULTS;
    expect(rates).toContain(`| Requests per minute | ${requestsPerMinute.toLocaleString('en-US')} |`);
    expect(rates).toContain(`| Requests per day | ${requestsPerDay.toLocaleString('en-US')} |`);
  });

  it('lists exactly the rate-limit headers the middleware sets', () => {
    const listed = [...section('### Rate Limits').matchAll(/`(X-RateLimit-[A-Za-z-]+)`/g)].map(m => m[1]);
    expect(new Set(listed)).toEqual(new Set(EXPECTED_HEADERS));
    expect(new Set(API_KEY_RATE_LIMIT_HEADER_NAMES)).toEqual(new Set(EXPECTED_HEADERS));
  });

  it('names no rate-limit header the middleware does not set, anywhere on the page', () => {
    const mentioned = [...API_REFERENCE_CONTENT.matchAll(/X-RateLimit-[A-Za-z-]*[A-Za-z]/g)].map(m => m[0]);
    expect(mentioned.length).toBeGreaterThan(0);
    for (const header of mentioned) {
      expect(EXPECTED_HEADERS).toContain(header);
    }
  });

  it('does not claim the rate-limit headers are on every response', () => {
    const rates = section('### Rate Limits');
    expect(rates).not.toMatch(/every response/i);
    expect(rates).toContain('Retry-After');
  });

  it('quotes the real request-id length cap', () => {
    expect(API_REFERENCE_CONTENT).toContain(`capped at ${MAX_REQUEST_ID_LENGTH} characters`);
  });

  it('links the generated docs for the error envelope and async polling instead of restating them', () => {
    const errors = section('## Error Handling');
    expect(errors).toContain('[generated API docs](/api/v1/docs)');
    expect(errors).not.toContain('CONVENTIONS.md');
    expect(errors).not.toMatch(/malformed JSON is 400/);
    expect(errors).toContain('POST /api/auth/refreshToken');
    const publicSection = section('## Public endpoints (generated docs)');
    expect(publicSection).toContain('Async jobs');
    expect(publicSection).not.toContain('(or the job resource) until it is terminal');
  });

  it('points at the generated docs for the reads exempt from the per-day ceiling', () => {
    const rateLimits = section('### Rate Limits');
    expect(rateLimits).toMatch(/exempt from the per-day ceiling/);
    expect(rateLimits).toContain('[generated API docs](/api/v1/docs)');
  });
});
