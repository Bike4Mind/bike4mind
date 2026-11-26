import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TutorialProgressEntry, TutorialRunModule } from '@bike4mind/common';

const post = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => ({ current: false }));
const runData = vi.hoisted(() => ({
  modules: [] as TutorialRunModule[],
  progress: {} as Record<string, TutorialProgressEntry>,
  failed: false,
  session: 's1',
}));
const launcher = vi.hoisted(() => ({ start: vi.fn(), resume: vi.fn() }));
const toast = vi.hoisted(() => vi.fn());

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post, get: vi.fn(), put: vi.fn() } }));
vi.mock('@client/app/hooks/data/tutorials', () => ({ useTutorialsEnabled: () => enabled.current }));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useSessions: () => ({ currentSessionId: runData.session }) }));
vi.mock('@client/app/hooks/data/sessions', () => ({ useGetSessionQuests: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/tutorials/useTutorialRun', () => ({
  useTutorialRunModules: () => ({
    data: runData.modules,
    isSuccess: !runData.failed,
    isError: runData.failed,
    isPending: false,
  }),
  useTutorialProgress: () => ({ data: runData.progress, isError: false, isPending: false }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../agentMode', () => ({ useTutorialAutoRouteOff: () => undefined }));
vi.mock('../TutorialRunner', () => ({
  OFF_NOTICE: 'off',
  TutorialRunner: () => <div data-testid="runner-stub" />,
}));
vi.mock('sonner', () => ({ toast }));
vi.mock('./TutorialPicker', () => ({ TutorialPicker: () => null }));
vi.mock('./useCoreTutorialLauncher', () => ({ useCoreTutorialLauncher: () => launcher }));

import { CORE_TUTORIALS_API_BASE } from '../hostBase';
import { resetTutorialStores, tutorialStoreFor } from '../useTutorialStore';
import { CoreTutorialHost } from './CoreTutorialHost';
import { useTutorialPicker } from './tutorialPickerStore';

const firstSteps: TutorialRunModule = {
  id: 'first-steps',
  title: 'First steps',
  pitch: '',
  version: 1,
  revision: 0,
  track: 'basics',
  steps: [
    { id: 'a', type: 'point', title: 'A', body: '' },
    { id: 'b', type: 'bridge', title: 'B', body: '' },
  ],
} as unknown as TutorialRunModule;

const promptModule: TutorialRunModule = {
  ...firstSteps,
  id: 'prompt-module',
  steps: [
    { id: 'p', type: 'prompt', turn: 0, prompt: 'Hello?' },
    { id: 'a', type: 'point', title: 'A', body: '' },
  ],
} as unknown as TutorialRunModule;

const inProgressOnS1: TutorialProgressEntry = {
  status: 'in_progress',
  sessionId: 's1',
  stepId: 'b',
  moduleVersion: 1,
} as unknown as TutorialProgressEntry;

const renderHost = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CoreTutorialHost />
    </QueryClientProvider>
  );

afterEach(() => {
  resetTutorialStores();
  runData.modules = [];
  runData.progress = {};
  runData.failed = false;
  runData.session = 's1';
  vi.clearAllMocks();
  useTutorialPicker.setState({ open: false, requestedTrack: null, walkOnScreen: false, walkPrompt: null });
});

describe('CoreTutorialHost', () => {
  it('renders nothing and asks the server nothing while core tutorials are switched off', () => {
    enabled.current = false;
    const { container } = renderHost();
    expect(container).toBeEmptyDOMElement();
    expect(post).not.toHaveBeenCalled();
  });

  it('picks a saved walk up on its own notebook', () => {
    enabled.current = true;
    runData.modules = [firstSteps];
    runData.progress = { 'first-steps': inProgressOnS1 };
    renderHost();
    expect(screen.getByTestId('runner-stub')).toBeInTheDocument();
    expect(tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active?.stepId).toBe('b');
  });

  it('picks up a walk still on its first step, which has no saved position yet', () => {
    enabled.current = true;
    runData.modules = [firstSteps];
    runData.progress = { 'first-steps': { ...inProgressOnS1, stepId: undefined } };
    renderHost();
    expect(tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active?.stepId).toBe('a');
  });

  it('does not restart a walk the user just left on the same notebook', () => {
    enabled.current = true;
    runData.modules = [firstSteps];
    runData.progress = { 'first-steps': inProgressOnS1 };
    const store = tutorialStoreFor(CORE_TUTORIALS_API_BASE);
    store.getState().begin({ moduleId: 'first-steps', sessionId: 's1', stepId: 'a', version: 1 });
    renderHost();
    expect(screen.getByTestId('runner-stub')).toBeInTheDocument();

    act(() => store.getState().end());

    expect(store.getState().active).toBeNull();
    expect(screen.queryByTestId('runner-stub')).not.toBeInTheDocument();
  });

  describe('a track an entry point asks for', () => {
    it('starts the first tutorial of a track that is not started', () => {
      enabled.current = true;
      runData.modules = [firstSteps];
      renderHost();
      act(() => useTutorialPicker.getState().requestTrack('basics'));
      expect(launcher.start).toHaveBeenCalledWith('first-steps');
      expect(useTutorialPicker.getState().requestedTrack).toBeNull();
    });

    it('resumes a tutorial of the track that is in progress', () => {
      enabled.current = true;
      runData.modules = [firstSteps];
      runData.progress = { 'first-steps': { ...inProgressOnS1, sessionId: 'other' } };
      renderHost();
      act(() => useTutorialPicker.getState().requestTrack('basics'));
      expect(launcher.resume).toHaveBeenCalledWith('first-steps');
      expect(launcher.start).not.toHaveBeenCalled();
    });

    it('opens the picker, and drops the request, when the lists cannot be read', () => {
      enabled.current = true;
      runData.failed = true;
      renderHost();
      act(() => useTutorialPicker.getState().requestTrack('basics'));
      expect(useTutorialPicker.getState().open).toBe(true);
      expect(useTutorialPicker.getState().requestedTrack).toBeNull();
      expect(launcher.start).not.toHaveBeenCalled();
    });
  });

  it('ends the walk with a notice when its tutorial is switched off', () => {
    enabled.current = true;
    runData.modules = [firstSteps];
    runData.progress = { 'first-steps': inProgressOnS1 };
    const { rerender } = renderHost();
    expect(tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active).not.toBeNull();

    runData.modules = [];
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <CoreTutorialHost />
      </QueryClientProvider>
    );

    expect(tutorialStoreFor(CORE_TUTORIALS_API_BASE).getState().active).toBeNull();
    expect(toast).toHaveBeenCalledWith('off');
  });

  it("picks up this notebook's saved walk once a walk on another notebook ends", () => {
    enabled.current = true;
    runData.modules = [firstSteps];
    runData.progress = { 'first-steps': { ...inProgressOnS1, sessionId: 's2' } };
    runData.session = 's2';
    const store = tutorialStoreFor(CORE_TUTORIALS_API_BASE);
    store.getState().begin({ moduleId: 'first-steps', sessionId: 's9', stepId: 'a', version: 1 });
    renderHost();
    expect(store.getState().active?.sessionId).toBe('s9');

    act(() => store.getState().end());

    expect(store.getState().active?.sessionId).toBe('s2');
  });

  describe('the recorded prompt it publishes', () => {
    const walkAt = (stepId: string) => {
      enabled.current = true;
      runData.modules = [promptModule];
      runData.progress = {
        'prompt-module': { ...inProgressOnS1, stepId },
      };
      renderHost();
    };

    it('publishes the prompt of a prompt step', () => {
      walkAt('p');
      expect(useTutorialPicker.getState().walkOnScreen).toBe(true);
      expect(useTutorialPicker.getState().walkPrompt).toBe('Hello?');
    });

    it('publishes none on any other step', () => {
      walkAt('a');
      expect(useTutorialPicker.getState().walkOnScreen).toBe(true);
      expect(useTutorialPicker.getState().walkPrompt).toBeNull();
    });
  });
});
