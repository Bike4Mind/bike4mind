import { describe, expect, it } from 'vitest';
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
    expect(requiredLines).toHaveLength(4);
    expect(requiredLines.some(line => line.includes('for `refineText`'))).toBe(true);
    expect(required).toContain('notebooks:read');
    expect(required).toContain('projects:read');
    expect(required).toContain('projects:write');
    expect(required).toContain('agents:read');
    expect(required).toContain('agents:write');
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
