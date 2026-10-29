// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CssVarsProvider } from '@mui/joy/styles';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModelServerProbeResult, ModelServerView } from '@shared/modelServers';
import { desktopTheme } from '../theme';
import { ModelServersSettings } from './ModelServersSettings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
window.matchMedia ??= ((query: string) => ({
  matches: false,
  media: query,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false,
})) as typeof window.matchMedia;

let root: Root | undefined;
let host: HTMLElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  host.remove();
});

const element = <T extends HTMLElement = HTMLElement>(id: string) => {
  const found = document.querySelector<T>(`[data-testid="${id}"]`);
  if (!found) throw new Error(`Missing ${id}`);
  return found;
};

async function type(id: string, value: string) {
  const input = element<HTMLInputElement>(id);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const click = (id: string) => act(async () => element(id).click());

const health = { state: 'online' as const, version: '0.12.0', latencyMs: 4, checkedAt: null, error: null };

function server(overrides: Partial<ModelServerView>): ModelServerView {
  return {
    id: 'aaa111',
    name: 'gpu box',
    local: false,
    kind: 'ollama',
    address: 'https://gpu.example.test',
    access: 'chat',
    auth: { type: 'none' },
    credentialsPersisted: true,
    credentialsMissing: false,
    unencrypted: false,
    health,
    models: [],
    ...overrides,
  };
}

function openServer(address: string, suggestedName: string): ModelServerProbeResult {
  return {
    ok: true,
    address,
    kind: 'ollama',
    version: '0.12.0',
    latencyMs: 4,
    models: 1,
    needsCredentials: false,
    unencrypted: false,
    openToAnyone: true,
    suggestedName,
    error: null,
  };
}

async function mount(servers: ModelServerView[], probe = vi.fn()) {
  const update = vi.fn(async () => ({ ok: true as const, servers }));
  (window as unknown as { b4m: unknown }).b4m = { modelServers: { probe, update } };
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () =>
    root?.render(
      <CssVarsProvider theme={desktopTheme}>
        <ModelServersSettings servers={servers} onServers={() => undefined} loadError={null} />
      </CssVarsProvider>
    )
  );
  return { probe, update };
}

describe('ModelServersSettings add form', () => {
  const checkbox = () => element<HTMLInputElement>('model-servers-add-accept-open-checkbox');
  const saveButton = () => element<HTMLButtonElement>('model-servers-add-save-btn');
  const nameInput = () => element<HTMLInputElement>('model-servers-add-name-input');

  it('asks again about an open server after the address changes, and renames it from the new test', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(openServer('https://a.example.test', 'a'))
      .mockResolvedValueOnce(openServer('https://b.example.test', 'b'));
    await mount([], probe);
    await type('model-servers-add-address-input', 'https://a.example.test');
    await click('model-servers-add-test-btn');
    expect(nameInput().value).toBe('a');
    await act(async () => checkbox().click());
    expect(saveButton().disabled).toBe(false);

    await type('model-servers-add-address-input', 'https://b.example.test');
    await click('model-servers-add-test-btn');
    expect(checkbox().checked).toBe(false);
    expect(saveButton().disabled).toBe(true);
    expect(nameInput().value).toBe('b');
  });

  it('keeps a name the user typed when the address is tested again', async () => {
    const probe = vi
      .fn()
      .mockResolvedValueOnce(openServer('https://a.example.test', 'a'))
      .mockResolvedValueOnce(openServer('https://b.example.test', 'b'));
    await mount([], probe);
    await type('model-servers-add-address-input', 'https://a.example.test');
    await click('model-servers-add-test-btn');
    await type('model-servers-add-name-input', 'my box');
    await type('model-servers-add-address-input', 'https://b.example.test');
    await click('model-servers-add-test-btn');
    expect(nameInput().value).toBe('my box');
  });

  it('ignores a test result that arrives after the address changed', async () => {
    let answer: (result: ModelServerProbeResult) => void = () => undefined;
    const probe = vi.fn(() => new Promise<ModelServerProbeResult>(resolve => (answer = resolve)));
    await mount([], probe);
    await type('model-servers-add-address-input', 'https://a.example.test');
    await click('model-servers-add-test-btn');
    await type('model-servers-add-address-input', 'https://b.example.test');
    await act(async () => answer(openServer('https://a.example.test', 'a')));
    expect(document.querySelector('[data-testid="model-servers-add-name-input"]')).toBeNull();
  });
});

describe('ModelServersSettings credentials form', () => {
  const saveButton = () => element<HTMLButtonElement>('model-servers-credentials-save-btn');

  it('opens on the kind of credential the server has and never saves a blank one over it', async () => {
    const { update } = await mount([server({ auth: { type: 'bearer' } })]);
    await click('model-servers-credentials-btn');
    expect(element('model-servers-edit-auth-select').textContent).toContain('Bearer token');
    expect(saveButton().textContent).toBe('Save credentials');
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(update).not.toHaveBeenCalled();

    await type('model-servers-edit-token-input', 'tok-new');
    expect(saveButton().disabled).toBe(false);
    await act(async () => saveButton().click());
    expect(update).toHaveBeenCalledWith('aaa111', { credential: { type: 'bearer', token: 'tok-new' } });
  });

  it('keeps the header name of a custom header credential', async () => {
    await mount([server({ auth: { type: 'header', headerName: 'X-Api-Key' } })]);
    await click('model-servers-credentials-btn');
    expect(element<HTMLInputElement>('model-servers-edit-header-name-input').value).toBe('X-Api-Key');
    expect(saveButton().disabled).toBe(true);
  });

  it('names removing the credential as such', async () => {
    const { update } = await mount([server({ auth: { type: 'bearer' } })]);
    await click('model-servers-credentials-btn');
    await click('model-servers-edit-auth-select');
    await click('model-servers-edit-auth-none');
    expect(saveButton().textContent).toBe('Remove credential');
    await act(async () => saveButton().click());
    expect(update).toHaveBeenCalledWith('aaa111', { credential: { type: 'none' } });
  });

  it('opens fresh from the saved credential each time', async () => {
    await mount([server({ auth: { type: 'bearer' } })]);
    await click('model-servers-credentials-btn');
    await type('model-servers-edit-token-input', 'tok-abandoned');
    await click('model-servers-credentials-btn');
    await click('model-servers-credentials-btn');
    expect(element<HTMLInputElement>('model-servers-edit-token-input').value).toBe('');
    expect(saveButton().disabled).toBe(true);
  });

  it('offers nothing to save for a server without a credential until one is chosen', async () => {
    await mount([server({})]);
    await click('model-servers-credentials-btn');
    expect(saveButton().disabled).toBe(true);
  });
});
