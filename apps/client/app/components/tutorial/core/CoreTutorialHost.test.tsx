import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TutorialProgressEntry, TutorialRunModule } from '@bike4mind/common';

const post = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => ({ current: false }));
const runData = vi.hoisted(() => ({
  modules: [] as TutorialRunModule[],
  progress: {} as Record<string, TutorialProgressEntry>,
}));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post, get: vi.fn(), put: vi.fn() } }));
vi.mock('@client/app/hooks/data/tutorials', () => ({ useTutorialsEnabled: () => enabled.current }));
vi.mock('@client/app/contexts/SessionsContext', () => ({ useSessions: () => ({ currentSessionId: 's1' }) }));
vi.mock('@client/app/hooks/data/sessions', () => ({ useGetSessionQuests: () => ({ data: undefined }) }));
vi.mock('@client/app/hooks/tutorials/useTutorialRun', () => ({
  useTutorialRunModules: () => ({ data: runData.modules, isSuccess: true, isPending: false }),
  useTutorialProgress: () => ({ data: runData.progress, isPending: false }),
}));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../agentMode', () => ({ useTutorialAutoRouteOff: () => undefined }));
vi.mock('../TutorialRunner', () => ({
  OFF_NOTICE: 'off',
  TutorialRunner: () => <div data-testid="runner-stub" />,
}));
vi.mock('./TutorialPicker', () => ({ TutorialPicker: () => null }));
vi.mock('./useCoreTutorialLauncher', () => ({
  useCoreTutorialLauncher: () => ({ start: vi.fn(), resume: vi.fn() }),
}));

import { CORE_TUTORIALS_API_BASE } from '../hostBase';
import { resetTutorialStores, tutorialStoreFor } from '../useTutorialStore';
import { CoreTutorialHost } from './CoreTutorialHost';

const firstSteps: TutorialRunModule = {
  id: 'first-steps',
  title: 'First steps',
  pitch: '',
  version: 1,
  revision: 0,
  steps: [
    { id: 'a', type: 'point', title: 'A', body: '' },
    { id: 'b', type: 'bridge', title: 'B', body: '' },
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
});
