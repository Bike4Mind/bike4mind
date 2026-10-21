import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  user: { currentUser: { isAdmin: true }, isDeveloper: false } as {
    currentUser: { isAdmin: boolean };
    isDeveloper: boolean;
  },
}));

vi.mock('@client/app/hooks/data/settings', () => ({
  useGetSettingsValue: (key: string) => hoisted.settings[key],
}));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => hoisted.user }));
vi.mock('@client/app/contexts/WebsocketContext', () => ({
  useWebsocket: () => ({ subscribeToAction: () => () => {} }),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/components/Session/VoiceSessionModal/useVoiceSessionEngine', () => ({
  useVoiceSessionEngine: () => ({ isActive: false }),
}));

import { useVoiceState } from './useVoiceState';

const voiceSessionEnabled = () =>
  renderHook(() => useVoiceState({ currentSessionId: null })).result.current.isVoiceSessionEnabled;

describe('useVoiceState', () => {
  beforeEach(() => {
    hoisted.settings = {};
    hoisted.user = { currentUser: { isAdmin: true }, isDeveloper: false };
  });

  it('offers the v1 voice session to admins when it is switched on', () => {
    hoisted.settings = { enableVoiceSession: true };
    expect(voiceSessionEnabled()).toBe(true);
  });

  it('keeps it from everyone else', () => {
    hoisted.settings = { enableVoiceSession: true };
    hoisted.user = { currentUser: { isAdmin: false }, isDeveloper: false };
    expect(voiceSessionEnabled()).toBe(false);
  });

  it('gives way to Voice v2, so the composer shows one voice-session button', () => {
    hoisted.settings = { enableVoiceSession: true, voiceV2Enabled: true };
    expect(voiceSessionEnabled()).toBe(false);
  });
});
