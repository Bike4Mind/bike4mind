import { describe, expect, it } from 'vitest';
import { GENERIC_MODAL_API_KEY_SCOPES, DEDICATED_FLOW_SCOPES } from '@client/app/constants/apiKeyScopes';
import { getApiReferenceContent, renderScopeTableRows } from './apiReferenceContent';

const API_REFERENCE_CONTENT = getApiReferenceContent('https://b4m.test');

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
      line.startsWith('**Required API-key scope:**')
    );
    const required = requiredLines.flatMap(line => [...line.matchAll(/`([^`]+)`/g)].map(match => match[1]));

    expect(required).toContain('me:read');
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

  it('escapes pipes so a description cannot split its table row', () => {
    for (const row of renderScopeTableRows().split('\n')) {
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
