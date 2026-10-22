import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, cleanup } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import type { ReactArtifact } from '@bike4mind/common';
import { getThemeConfig } from '@client/app/utils/themes';
import type { ReactArtifactGroupRole } from '@client/app/utils/reactArtifactGroup';

vi.mock('@client/app/hooks/data/settings', () => ({
  useExperimentalFeatureSettings: () => ({ data: [{ settingName: 'EnableReactViewer', settingValue: 'true' }] }),
}));
vi.mock('@client/app/components/artifacts', () => ({ ArtifactVersionDropdown: () => null }));
vi.mock('@client/app/contexts/ApiContext', () => ({ api: { get: vi.fn() } }));
vi.mock('@client/app/utils/artifactPersistence', () => ({
  checkArtifactExists: vi.fn().mockResolvedValue(true),
  saveArtifactToLocalStorage: vi.fn(),
  getArtifactFromLocalStorage: () => null,
  saveArtifactVersionToLocalStorage: vi.fn(),
  getArtifactVersionFromLocalStorage: () => null,
  clearOldCachedArtifacts: vi.fn(),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import ReactArtifactViewer from './ReactArtifactViewer';

const appTheme = extendTheme({ ...getThemeConfig() });
const TestWrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const ENTRY_CODE = [
  "import React from 'react';",
  "import Chronosphere from './Chronosphere';",
  'export default function App() { return <Chronosphere />; }',
].join('\n');
const SIBLING_CODE = [
  "import { motion } from 'framer-motion';",
  'export default function Chronosphere() { return <motion.div>sibling-source-marker</motion.div>; }',
].join('\n');
const HELPERS_CODE = 'export const double = (n: number): number => n * 2; // helpers-source-marker';

const ENTRY_GROUP: ReactArtifactGroupRole = {
  role: 'entry',
  files: { Chronosphere: SIBLING_CODE, helpers: HELPERS_CODE },
  dependencies: ['react', 'framer-motion'],
  siblings: [
    { identifier: 'Chronosphere', title: 'Chronosphere Panel' },
    { identifier: 'helpers', title: 'Helpers' },
  ],
};

function reactArtifact(id: string, title: string, content: string, dependencies: string[]): ReactArtifact {
  return {
    id,
    type: 'react',
    title,
    content,
    metadata: { dependencies, hasDefaultExport: true, errorBoundary: true },
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as ReactArtifact;
}

const entry = reactArtifact('artifact_react_app_1_0', 'Chrono App', ENTRY_CODE, ['react']);

function renderViewer(artifact: ReactArtifact, group?: ReactArtifactGroupRole, onSave = vi.fn()) {
  render(
    <TestWrapper>
      <ReactArtifactViewer artifact={artifact} group={group} onSave={onSave} />
    </TestWrapper>
  );
  return { onSave };
}

/** Lets the preview debounce settle, answers the sandbox handshake, and returns the render message. */
async function postedRenderMessage(): Promise<Record<string, unknown>> {
  await act(async () => {
    vi.advanceTimersByTime(1000);
  });
  const iframe = document.querySelector('iframe');
  if (!iframe) throw new Error('no sandbox iframe');
  const postMessage = vi.fn();
  Object.defineProperty(iframe, 'contentWindow', { value: { postMessage }, configurable: true });
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'react-sandbox-ready' },
        source: iframe.contentWindow as unknown as Window,
      })
    );
  });
  expect(postMessage).toHaveBeenCalledTimes(1);
  return postMessage.mock.calls[0][0] as Record<string, unknown>;
}

const codePanel = () => screen.getByTestId('react-artifact-code-panel');

async function enableEditMode() {
  fireEvent.click(screen.getByRole('button', { name: /Enable Edit Mode/ }));
  fireEvent.click(screen.getByRole('button', { name: /I Understand, Enable Editing/ }));
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('ReactArtifactViewer for a multi-file entry', () => {
  it('previews the entry with its sibling files and the unioned dependencies', async () => {
    renderViewer(entry, ENTRY_GROUP);

    const message = await postedRenderMessage();
    expect(message).toMatchObject({ type: 'react-artifact-render', code: ENTRY_CODE, files: ENTRY_GROUP.files });
    expect(message.dependencies).toEqual(expect.arrayContaining(['react', 'framer-motion']));
  });

  it('lists the siblings as file tabs on the code view and shows the selected one read-only', async () => {
    renderViewer(entry, ENTRY_GROUP);
    expect(screen.queryByTestId('react-artifact-file-tabs')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('react-artifact-code-tab'));
    expect(screen.getByTestId('react-artifact-file-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('react-artifact-entry-file-tab')).toHaveTextContent('Chrono App');
    expect(screen.getByTestId('react-artifact-sibling-file-tab-helpers')).toHaveTextContent('Helpers');
    expect(codePanel()).toHaveTextContent("import Chronosphere from './Chronosphere'");

    fireEvent.click(screen.getByTestId('react-artifact-sibling-file-tab-Chronosphere'));
    expect(codePanel()).toHaveTextContent('sibling-source-marker');

    // Even in edit mode a sibling stays read-only; only the entry gets the editor.
    await enableEditMode();
    expect(codePanel().querySelector('textarea')).toBeNull();
    fireEvent.click(screen.getByTestId('react-artifact-entry-file-tab'));
    expect(codePanel().querySelector('textarea')).not.toBeNull();
  });

  it('saves edits to the entry only and keeps previewing them with the unchanged siblings', async () => {
    const { onSave } = renderViewer(entry, ENTRY_GROUP);
    await act(async () => {});

    fireEvent.click(screen.getByTestId('react-artifact-code-tab'));
    await enableEditMode();
    const edited = ENTRY_CODE.replace('<Chronosphere />', '<main><Chronosphere /></main>');
    fireEvent.change(codePanel().querySelector('textarea') as HTMLTextAreaElement, { target: { value: edited } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith(edited);

    fireEvent.click(screen.getByTestId('react-artifact-sibling-file-tab-Chronosphere'));
    expect(codePanel()).toHaveTextContent('sibling-source-marker');

    fireEvent.click(screen.getByTestId('react-artifact-preview-tab'));
    const message = await postedRenderMessage();
    expect(message).toMatchObject({ code: edited, files: ENTRY_GROUP.files });
  });
});

describe('ReactArtifactViewer for a sibling', () => {
  const sibling = reactArtifact('artifact_react_helpers_1_1', 'Helpers', HELPERS_CODE, []);

  it('shows its source read-only, labelled with its entry, and never renders it alone', async () => {
    renderViewer(sibling, { role: 'sibling', entryTitle: 'Chrono App' });
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });

    expect(screen.getByTestId('react-artifact-viewer-used-by-label')).toHaveTextContent('Used by Chrono App');
    expect(codePanel()).toHaveTextContent('helpers-source-marker');
    expect(screen.queryByTestId('react-artifact-preview-tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Enable Edit Mode/ })).not.toBeInTheDocument();
    // A module with no default export is a valid sibling, not an invalid component.
    expect(screen.queryByText('Invalid React Component')).not.toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });
});

describe('ReactArtifactViewer for a single-file artifact', () => {
  const single = reactArtifact(
    'artifact_react_solo_1_0',
    'Solo',
    "import { LineChart } from 'recharts';\nexport default function Solo() { return <LineChart />; }",
    ['react']
  );

  it('posts no files and offers no file tabs or sibling label', async () => {
    renderViewer(single);

    const message = await postedRenderMessage();
    expect(message).not.toHaveProperty('files');
    expect(message.dependencies).toEqual(['react', 'recharts']);

    fireEvent.click(screen.getByTestId('react-artifact-code-tab'));
    expect(screen.queryByTestId('react-artifact-file-tabs')).not.toBeInTheDocument();
    expect(screen.queryByTestId('react-artifact-viewer-used-by-label')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Enable Edit Mode/ })).toBeInTheDocument();
  });
});
