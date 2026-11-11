import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignupGrantAssessment } from '@bike4mind/common';
import { createMocks } from 'node-mocks-http';

const mocks = vi.hoisted(() => ({
  handler: undefined as undefined | ((request: unknown, response: unknown) => Promise<unknown>),
  findById: vi.fn(),
  findMembershipOrgIds: vi.fn(),
  projectExists: vi.fn(),
  sessionExists: vi.fn(),
}));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({
    get: (handler: typeof mocks.handler) => {
      mocks.handler = handler;
      return {};
    },
  }),
}));
vi.mock('@bike4mind/database', () => ({
  User: { findById: mocks.findById },
  organizationRepository: { findMembershipOrgIds: mocks.findMembershipOrgIds },
  Project: { exists: mocks.projectExists },
  Session: { exists: mocks.sessionExists },
  readAccessArms: (user: { id: string }) => [{ userId: user.id }],
}));
await import('../index');

const assessment = {
  band: 'review',
  credits: 0,
  score: 3,
  reasons: ['datacenter'],
  missing: [],
  policyVersion: 'test',
  status: 'evaluated',
} satisfies SignupGrantAssessment;

describe('GET /api/users/:id signup assessment visibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMembershipOrgIds.mockResolvedValue([]);
    mocks.projectExists.mockResolvedValue(null);
    mocks.sessionExists.mockResolvedValue(null);
    mocks.findById.mockReturnValue({
      populate: () => ({
        select: async () => ({
          id: 'target',
          name: 'Target',
          username: 'target',
          photoUrl: '',
          level: 'DemoUser',
          role: '',
          team: '',
          signupGrantAssessment: assessment,
          userNotes: [{ timestamp: '2026-10-20', note: 'Synthetic internal context', userName: 'Test admin' }],
        }),
      }),
    });
  });

  it.each([
    ['admin', { id: 'support', isAdmin: true }, true],
    ['self', { id: 'target', isAdmin: false }, false],
    ['another user', { id: 'viewer', isAdmin: false }, false],
  ])('exposes the assessment to %s only when privileged', async (_label, viewer, allowed) => {
    const { req, res } = createMocks({ method: 'GET', query: { id: 'target' } });
    const request = Object.assign(req, { user: viewer });
    await mocks.handler!(request, res);
    const result = res._getJSONData() as Record<string, unknown>;
    expect(result.id).toBe('target');
    if (allowed) expect(result.signupGrantAssessment).toEqual(assessment);
    else expect(result).not.toHaveProperty('signupGrantAssessment');
    if (viewer.id === 'viewer') {
      expect(result).not.toHaveProperty('isOnline');
      expect(result).not.toHaveProperty('lastActiveAt');
      expect(result).not.toHaveProperty('level');
    }
    if (!allowed) {
      expect(result).not.toHaveProperty('userNotes');
      expect(result).not.toHaveProperty('history');
      expect(result).not.toHaveProperty('revisions');
      expect(JSON.stringify(result)).not.toContain('Synthetic internal context');
    }
  });
});
