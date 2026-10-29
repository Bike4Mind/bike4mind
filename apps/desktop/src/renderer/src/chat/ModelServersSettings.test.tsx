// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModelServerAccess, ModelServerKind, ModelServerView } from '@shared/modelServers';
import { desktopTheme } from '../theme';
import { ModelServersSettings } from './ModelServersSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener: () => {},
  removeListener: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

function saved(kind: ModelServerKind, access: ModelServerAccess): ModelServerView {
  return {
    id: 'gpu',
    name: 'gpu box',
    local: false,
    kind,
    address: 'http://192.168.1.20:11434',
    access,
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: true,
    health: { state: 'online', version: '0.12.0', latencyMs: 12, checkedAt: null, error: null },
    models: ['qwen2.5:0.5b'],
  };
}

let root: Root;
let host: HTMLElement;
const note = () => document.querySelector<HTMLElement>('[data-testid="model-servers-access-note"]');

async function show(server: ModelServerView) {
  await act(async () =>
    root.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelServersSettings servers={[server]} onServers={() => {}} loadError={null} />
      </CssVarsProvider>
    )
  );
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe('ModelServersSettings access note', () => {
  it('points an Ollama server set to Chat and manage at the Models screen', async () => {
    await show(saved('ollama', 'manage'));
    expect(note()?.textContent).toMatch(/Download and remove models on this server from the Models screen/);
    expect(document.body.textContent).not.toMatch(/not available yet/);
  });

  it('says only Ollama servers can be managed for an OpenAI-compatible server set to Chat and manage', async () => {
    await show(saved('openai-compatible', 'manage'));
    expect(note()?.textContent).toMatch(/works only on Ollama servers/);
    expect(document.body.textContent).not.toMatch(/not available yet/);
  });

  it('shows no note for a server set to Chat only', async () => {
    await show(saved('ollama', 'chat'));
    expect(note()).toBeNull();
  });
});
