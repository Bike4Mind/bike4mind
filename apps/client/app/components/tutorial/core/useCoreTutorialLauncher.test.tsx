import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TutorialProgressEntry, TutorialRunModule } from '@bike4mind/common';

const transport = vi.hoisted(() => ({
  start: vi.fn(),
  resume: vi.fn(),
  progress: vi.fn(),
}));
const navigate = vi.hoisted(() => vi.fn(async () => undefined));
const toast = vi.hoisted(() => vi.fn());

vi.mock('../hostBase', async importOriginal => ({
  ...(await importOriginal<typeof import('../hostBase')>()),
  useTutorialHost: () => ({ apiBase: '/api/tutorials', transport }),
  useTutorialHostBase: () => '/api/tutorials',
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('sonner', () => ({ toast }));
vi.mock('@client/app/hooks/useChatInput', () => ({
  useChatInput: { getState: () => ({ setDraft: vi.fn(), setChatInputValue: vi.fn(), requestFocus: vi.fn() }) },
}));

import { CORE_TUTORIALS_API_BASE } from '../hostBase';
import { resetTutorialStores, tutorialStoreFor } from '../useTutorialStore';
import { useTutorialPicker } from './tutorialPickerStore';
import {
  RESUME_FAILED_NOTICE,
  RESUME_FELL_BACK_NOTICE,
  START_FAILED_NOTICE,
  openingPromptOf,
  useCoreTutorialLauncher,
} from './useCoreTutorialLauncher';

const firstSteps = {
  id: 'first-steps',
  title: 'First steps',
  pitch: '',
  version: 1,
  revision: 0,
  steps: [
    { id: 'send', type: 'prompt', turn: 0, prompt: 'Hello?', title: 'Send', body: '' },
    { id: 'done', type: 'bridge', title: 'Done', body: '' },
  ],
} as unknown as TutorialRunModule;

const savedWalk = {
  status: 'in_progress',
  sessionId: 'old',
  stepId: 'done',
  moduleVersion: 1,
  moduleRevision: 0,
} as unknown as TutorialProgressEntry;

const started = { sessionId: 'new', version: 1, revision: 0 };
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });

const renderLauncher = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useCoreTutorialLauncher([firstSteps]), { wrapper }).result;
};

beforeEach(() => {
  transport.start.mockResolvedValue(started);
  transport.progress.mockResolvedValue({ 'first-steps': savedWalk });
});

afterEach(() => {
  vi.clearAllMocks();
  resetTutorialStores();
});

describe('useCoreTutorialLauncher', () => {
  it('opens one tutorial notebook when start is pressed twice in a row', async () => {
    const launcher = renderLauncher();
    await act(async () => {
      await Promise.all([launcher.current.start('first-steps'), launcher.current.start('first-steps')]);
    });
    expect(transport.start).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({ to: '/notebooks/$id', params: { id: 'new' } });
  });

  it('marks a walk as launching from the click until the notebook opens', async () => {
    let launchingDuringStart: boolean | undefined;
    transport.start.mockImplementation(async () => {
      launchingDuringStart = useTutorialPicker.getState().launching;
      return started;
    });
    const launcher = renderLauncher();
    await act(() => launcher.current.start('first-steps'));
    expect(launchingDuringStart).toBe(true);
    expect(useTutorialPicker.getState().launching).toBe(false);
  });

  it('clears launching when the start fails', async () => {
    transport.start.mockRejectedValue(new Error('Network Error'));
    const launcher = renderLauncher();
    await act(() => launcher.current.start('first-steps'));
    expect(useTutorialPicker.getState().launching).toBe(false);
  });

  it('tells the user when the tutorial cannot be started, and goes nowhere', async () => {
    transport.start.mockRejectedValue(new Error('Network Error'));
    const launcher = renderLauncher();
    await act(() => launcher.current.start('first-steps'));
    expect(toast).toHaveBeenCalledWith(START_FAILED_NOTICE);
    expect(navigate).not.toHaveBeenCalled();
    expect(tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active).toBeNull();
  });

  it('starts over with a notice when the server refuses the resume', async () => {
    transport.resume.mockRejectedValue(httpError(409));
    const launcher = renderLauncher();
    await act(() => launcher.current.resume('first-steps'));
    expect(toast).toHaveBeenCalledWith(RESUME_FELL_BACK_NOTICE);
    expect(transport.start).toHaveBeenCalledTimes(1);
  });

  it('keeps the saved walk when the resume fails for another reason', async () => {
    transport.resume.mockRejectedValue(new Error('Network Error'));
    const launcher = renderLauncher();
    await act(() => launcher.current.resume('first-steps'));
    expect(toast).toHaveBeenCalledWith(RESUME_FAILED_NOTICE);
    expect(transport.start).not.toHaveBeenCalled();
  });

  it('keeps the saved walk when progress cannot be read', async () => {
    transport.progress.mockRejectedValue(new Error('Network Error'));
    const launcher = renderLauncher();
    await act(() => launcher.current.resume('first-steps'));
    expect(toast).toHaveBeenCalledWith(RESUME_FAILED_NOTICE);
    expect(transport.start).not.toHaveBeenCalled();
    expect(transport.resume).not.toHaveBeenCalled();
  });

  it('resumes at the saved step on the saved notebook', async () => {
    transport.resume.mockResolvedValue({ sessionId: 'old', version: 1, revision: 0 });
    const launcher = renderLauncher();
    await act(() => launcher.current.resume('first-steps'));
    expect(transport.start).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith({ to: '/notebooks/$id', params: { id: 'old' } });
  });
});

describe('openingPromptOf', () => {
  const stepsOf = (steps: unknown[]) => ({ steps }) as unknown as Pick<TutorialRunModule, 'steps'>;
  const attach = { id: 'attach', type: 'attach', title: 'Add', body: '' };
  const ask = { id: 'ask', type: 'prompt', turn: 0, prompt: 'Hello?', title: 'Ask', body: '' };

  it('returns the prompt of a first step that sends turn 0', () => {
    expect(openingPromptOf(stepsOf([ask, { id: 'done', type: 'bridge' }]))).toBe('Hello?');
  });

  it('returns nothing when an attach step comes first, even if a later step sends turn 0', () => {
    expect(openingPromptOf(stepsOf([attach, ask]))).toBeUndefined();
  });

  it('returns nothing for a first prompt step that is not turn 0', () => {
    expect(openingPromptOf(stepsOf([{ ...ask, turn: 1 }]))).toBeUndefined();
  });

  it('returns nothing for a tutorial with no steps', () => {
    expect(openingPromptOf(stepsOf([]))).toBeUndefined();
  });
});
