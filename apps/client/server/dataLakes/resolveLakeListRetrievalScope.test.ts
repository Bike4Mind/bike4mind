// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBaseScope, mockFindSession, mockAdmission } = vi.hoisted(() => ({
  mockBaseScope: vi.fn(),
  mockFindSession: vi.fn(),
  mockAdmission: vi.fn(),
}));

vi.mock('./resolveRetrievalLakeScope', () => ({ resolveRetrievalLakeScope: mockBaseScope }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: {},
  dataLakeAccessGrantRepository: {},
  organizationRepository: {},
  sessionRepository: { findByIdAndUserId: mockFindSession },
}));
vi.mock('@bike4mind/services', async () => {
  const actual = await vi.importActual<typeof import('@bike4mind/services')>('@bike4mind/services');
  return {
    dataLakeService: {
      resolveSessionLakeAdmission: mockAdmission,
      vetPreauthorizedLakeIds: actual.dataLakeService.vetPreauthorizedLakeIds,
    },
  };
});

import { resolveLakeListRetrievalScope } from './resolveLakeListRetrievalScope';

const SID = '507f1f77bcf86cd799439011';
const BASE = { lakes: [{ datalakeTag: 'datalake:base' }] };
const ADMITTED = { lakes: [{ datalakeTag: 'datalake:base' }, { datalakeTag: 'datalake:preauth' }] };
const req = { user: { id: 'u1' } } as Parameters<typeof resolveLakeListRetrievalScope>[0];

beforeEach(() => {
  mockBaseScope.mockReset().mockResolvedValue(BASE);
  mockFindSession.mockReset().mockResolvedValue(null);
  mockAdmission.mockReset().mockResolvedValue({ admitted: ADMITTED, searched: BASE });
});

describe('resolveLakeListRetrievalScope', () => {
  it('resolves the chat retrieval scope without the static-registry bypass', async () => {
    expect(await resolveLakeListRetrievalScope(req, undefined)).toBe(BASE);
    expect(mockBaseScope).toHaveBeenCalledWith(req, { staticRegistryBypass: false });
    expect(mockFindSession).not.toHaveBeenCalled();
  });

  it("applies the shared admission to the caller's own session, with its fields read off the DB document", async () => {
    mockFindSession.mockResolvedValue({
      userId: 'u1',
      retrievalTags: ['datalake:x'],
      lakeScopeExplicit: true,
      preauthorizedLakeIds: ['L'],
    });
    expect(await resolveLakeListRetrievalScope(req, SID)).toBe(ADMITTED);
    expect(mockFindSession).toHaveBeenCalledWith(SID, 'u1');
    expect(mockAdmission).toHaveBeenCalledWith(
      BASE,
      { retrievalTags: ['datalake:x'], lakeScopeExplicit: true, preauthorizedLakeIds: ['L'] },
      'u1',
      expect.objectContaining({ dataLakes: expect.anything(), organizations: expect.anything() })
    );
  });

  it.each([
    ['unknown or foreign', SID],
    ['malformed', 'nope'],
    ['repeated', [SID, SID]],
  ])('treats a %s session id as no session', async (_label, raw) => {
    expect(await resolveLakeListRetrievalScope(req, raw)).toBe(BASE);
    expect(mockAdmission).not.toHaveBeenCalled();
  });
});
