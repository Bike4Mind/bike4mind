// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

// Each legacy path must re-export its nextRouteForContract handler and keep its inline config:
// Next reads page `config` statically and ignores a re-export.
const v1 = vi.hoisted(() => ({
  files: { handler: 'session-files' },
  search: { handler: 'session-semantic-search' },
  message: { handler: 'session-message' },
}));
vi.mock('@pages/api/v1/sessions/[id]/files', () => ({ default: v1.files }));
vi.mock('@pages/api/v1/sessions/semantic-search', () => ({ default: v1.search }));
vi.mock('@pages/api/v1/sessions/[id]/messages/[messageId]', () => ({ default: v1.message }));

const CONFIG = { api: { externalResolver: true } };

describe('session notebook legacy aliases', () => {
  it('GET /api/sessions/[id]/files serves the v1 handler', async () => {
    const legacy = await import('@pages/api/sessions/[id]/files');
    expect(legacy.default).toBe(v1.files);
    expect(legacy.config).toEqual(CONFIG);
  });

  it('POST /api/sessions/semantic-search serves the v1 handler', async () => {
    const legacy = await import('@pages/api/sessions/semantic-search');
    expect(legacy.default).toBe(v1.search);
    expect(legacy.config).toEqual(CONFIG);
  });

  it('/api/sessions/[id]/chat/[messageId] serves the v1 message handler', async () => {
    const legacy = await import('@pages/api/sessions/[id]/chat/[messageId]/index');
    expect(legacy.default).toBe(v1.message);
    expect(legacy.config).toEqual(CONFIG);
  });
});
