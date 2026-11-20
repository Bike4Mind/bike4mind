// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TutorialRequest } from '../routes/types';

const found = vi.hoisted(() => ({ session: undefined as Record<string, unknown> | undefined }));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sessionRepository: { findByIdAndUserId: async () => found.session, update: vi.fn() },
}));
vi.mock('@bike4mind/services', () => ({ sessionService: {} }));
vi.mock('../../managers/sessionCrud', () => ({ getOrCreateSession: vi.fn() }));
vi.mock('../sheet', () => ({ tutorialSheets: () => ({}) }));

import { coreTutorialDepsFor } from '../coreDeps';

const ownsSession = coreTutorialDepsFor({} as unknown as TutorialRequest).ownsSession;

describe('ownsSession', () => {
  it('owns a main-surface session of the user', async () => {
    found.session = { id: 's1', name: 'Tutorial: x' };
    expect(await ownsSession('s1', 'u1')).toBe(true);
  });

  it('does not own a session the user lacks', async () => {
    found.session = undefined;
    expect(await ownsSession('s1', 'u1')).toBe(false);
  });

  it('does not own a session moved into a workspace', async () => {
    found.session = { id: 's1', name: 'Tutorial: x', surface: 'quest' };
    expect(await ownsSession('s1', 'u1')).toBe(false);
  });
});
