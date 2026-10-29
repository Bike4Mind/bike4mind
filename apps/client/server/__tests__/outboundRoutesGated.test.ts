// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

/**
 * Invariant: outbound and abuse-prone routes reject untrusted and moderated accounts.
 *
 * Gated methods must start with `outboundActionGate()`; the agent helpers call
 * `assertOutboundActionAllowed` inline. Read from outside pages/ for the reason given in
 * aiRoutesGateModeratedUsers.test.ts.
 */
const ROUTES_DIR = path.join(__dirname, '..', '..', 'pages', 'api');

const MIDDLEWARE_GATED: Array<[route: string, method: 'post']> = [
  ['email/send.ts', 'post'],
  ['projects/[id]/invites.ts', 'post'],
  ['[type]/[id]/invites/index.ts', 'post'],
  ['reg-invites/refer.ts', 'post'],
  ['reg-invites/create.ts', 'post'],
  ['organizations/[id]/members/index.ts', 'post'],
  ['friends/index.ts', 'post'],
  ['tools/weather.ts', 'post'],
  ['tools/web-fetch.ts', 'post'],
  ['tools/web-search.ts', 'post'],
  ['publish/artifact/upload-url.ts', 'post'],
  ['publish/artifact/finalize.ts', 'post'],
  ['publish/[publicId]/share-token.ts', 'post'],
  ['publish/[publicId]/revise.ts', 'post'],
  ['publish/[publicId]/restore.ts', 'post'],
  ['publish/reply.ts', 'post'],
  ['publish/fabfile.ts', 'post'],
];

const INLINE_GATED = [
  'agents/[id]/generate-description.ts',
  'publish/artifacts/[id].ts',
  'agents/[id]/generate-avatar.ts',
  'agents/[id]/generate-system-prompt.ts',
  'agents/[id]/enhance-field.ts',
  'agents/create-from-context.ts',
  'v1/agents/[id]/generate-description.ts',
  'v1/agents/[id]/generate-avatar.ts',
  'v1/agents/[id]/generate-system-prompt.ts',
  'v1/agents/[id]/enhance-field.ts',
];

const source = (route: string) => readFileSync(path.join(ROUTES_DIR, route), 'utf8').replace(/^\s*\/\/[^\n]*/gm, '');

describe('outbound routes gate untrusted and moderated accounts', () => {
  it.each(MIDDLEWARE_GATED)('%s runs outboundActionGate() first on .%s', (route, method) => {
    expect(source(route)).toMatch(new RegExp(`\\.${method}\\(\\s*outboundActionGate\\(\\)`));
  });

  it.each(INLINE_GATED)('%s calls assertOutboundActionAllowed', route => {
    const src = source(route);
    expect(src).toMatch(/\bawait assertOutboundActionAllowed\(req\.user, req\)/);
    expect(src).not.toMatch(/\bassertAiAccessAllowed\(/);
  });
});
