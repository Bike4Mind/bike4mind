import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { parseArtifactsWithFallback } from '@client/app/utils/artifactParser';
import { groupReactArtifacts, type ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { getArtifactHandler, type ParsedArtifact } from '../registry';

// useReactArtifactSandbox reads the inert-render flag through react-query; flag off here.
vi.mock('@client/app/hooks/data/settings', () => ({
  useExperimentalFeatureSettings: () => ({ data: [] }),
}));

vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: null, setCurrentSession: vi.fn(), currentSessionId: 's1' }),
  useWorkBenchFiles: () => [],
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));

vi.mock('@client/app/hooks/useSessionLayout', () => {
  const hook = () => undefined;
  return {
    default: Object.assign(hook, { getState: () => ({ selectedArtifactId: null, artifactData: null }) }),
    setSessionLayout: vi.fn(),
    setSelectedArtifactVersion: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: { autoCollapseContent: true, maxVisibleLines: 25 } }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import './react';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const REPLY = [
  'The app is split in two.',
  '<artifact identifier="chrono-app" type="application/vnd.ant.react" title="Chrono App">',
  "import React from 'react';",
  "import Chronosphere from './Chronosphere';",
  'export default function App() { return <Chronosphere />; }',
  '</artifact>',
  '<artifact identifier="Chronosphere" type="application/vnd.ant.react" title="Chronosphere">',
  "import { motion } from 'framer-motion';",
  'export default function Chronosphere() { return <motion.div>sibling-source-marker</motion.div>; }',
  '</artifact>',
].join('\n');

function renderCard(artifact: ParsedArtifact, reactGroup?: ReactArtifactGroupRole) {
  const handler = getArtifactHandler('react');
  if (!handler) throw new Error('react handler not registered');
  return render(
    <TestWrapper>
      <handler.PreviewCard
        artifact={artifact}
        artifactId={`id-${artifact.identifier}`}
        index={0}
        reactGroup={reactGroup}
      />
    </TestWrapper>
  );
}

/** Answers the sandbox handshake and returns the render message the card posted. */
async function renderMessage(): Promise<Record<string, unknown>> {
  const iframe = screen.getByTestId('inline-artifact-iframe');
  const postMessage = vi.fn();
  const contentWindow = { postMessage };
  Object.defineProperty(iframe, 'contentWindow', { value: contentWindow, configurable: true });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'react-sandbox-ready' },
        source: contentWindow as unknown as Window,
      })
    );
  });
  expect(postMessage).toHaveBeenCalledTimes(1);
  return postMessage.mock.calls[0][0] as Record<string, unknown>;
}

afterEach(() => {
  vi.clearAllMocks();
});

/** Opens the card in the side panel and returns the artifactData it hands the viewer. */
function openInViewer(): Record<string, unknown> {
  fireEvent.click(screen.getByTestId('react-artifact-expand-btn'));
  expect(setSessionLayout).toHaveBeenCalledTimes(1);
  return vi.mocked(setSessionLayout).mock.calls[0][0] as Record<string, unknown>;
}

describe('react artifact handler in a multi-file reply', () => {
  const { artifacts } = parseArtifactsWithFallback(REPLY);
  const entry = artifacts.find(a => a.identifier === 'chrono-app') as ParsedArtifact;
  const sibling = artifacts.find(a => a.identifier === 'Chronosphere') as ParsedArtifact;
  const roles = groupReactArtifacts(artifacts);

  it('posts the sibling files and the unioned dependencies when the entry renders', async () => {
    renderCard(entry, roles.get(entry));

    expect(await renderMessage()).toEqual(
      expect.objectContaining({
        type: 'react-artifact-render',
        code: entry.content,
        files: { Chronosphere: sibling.content },
        dependencies: ['react', 'framer-motion'],
      })
    );
  });

  it('shows a sibling as code labelled with its entry, with no live preview', () => {
    renderCard(sibling, roles.get(sibling));

    expect(screen.getByTestId('react-artifact-used-by-label')).toHaveTextContent('Used by Chrono App');
    expect(screen.getByTestId('react-artifact-source')).toHaveTextContent('sibling-source-marker');
    expect(screen.queryByTestId('inline-artifact-iframe')).not.toBeInTheDocument();
    expect(screen.getByTestId('react-artifact-copy-btn')).toBeInTheDocument();
    expect(screen.getByTestId('react-artifact-expand-btn')).toBeInTheDocument();
  });

  it('renders a single-file artifact as before, posting no files', async () => {
    renderCard(entry);

    const message = await renderMessage();
    expect(message).toEqual(
      expect.objectContaining({ type: 'react-artifact-render', code: entry.content, dependencies: ['react'] })
    );
    expect(message).not.toHaveProperty('files');
    expect(screen.queryByTestId('react-artifact-used-by-label')).not.toBeInTheDocument();
  });

  it('opens the entry in the side panel with its group, so the viewer previews it with its files', () => {
    renderCard(entry, roles.get(entry));

    const layout = openInViewer();
    expect(layout).toMatchObject({ layout: 'vertical', selectedArtifactId: 'id-chrono-app' });
    expect(layout.artifactData).toMatchObject({
      type: 'react',
      id: 'id-chrono-app',
      reactGroup: {
        role: 'entry',
        files: { Chronosphere: sibling.content },
        dependencies: ['react', 'framer-motion'],
        siblings: [{ identifier: 'Chronosphere', title: 'Chronosphere' }],
      },
    });
  });

  it('opens a sibling in the side panel with its sibling role, so the viewer shows it as code', () => {
    renderCard(sibling, roles.get(sibling));

    expect(openInViewer().artifactData).toMatchObject({
      type: 'react',
      id: 'id-Chronosphere',
      reactGroup: { role: 'sibling', entryTitle: 'Chrono App' },
    });
  });

  it('opens a single-file artifact in the side panel without a group', () => {
    renderCard(entry);

    expect(openInViewer().artifactData).not.toHaveProperty('reactGroup');
  });
});

describe('react artifact handler when a relative import matches nothing in the reply', () => {
  const { artifacts } = parseArtifactsWithFallback(
    [
      '<artifact identifier="lonely-app" type="application/vnd.ant.react" title="Lonely App">',
      "import Missing from './Missing';",
      'export default function App() { return <Missing />; }',
      '</artifact>',
    ].join('\n')
  );
  const [entry] = artifacts;

  it('posts an empty files map, so the sandbox names the missing file instead of rejecting', async () => {
    renderCard(entry, groupReactArtifacts(artifacts).get(entry));

    expect(await renderMessage()).toEqual(expect.objectContaining({ code: entry.content, files: {} }));
  });
});
