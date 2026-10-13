import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelInfo, ModelName } from '@bike4mind/common';
import { ModelBackend } from '@bike4mind/common';
import { AdminTab } from '@client/app/components/admin/adminSidebarConfig';
// The real store, not a stub: it must stay reachable from ModelSelection without
// dragging in AdminPage (the import cycle this module split exists to prevent).
import { useAdminModal } from '@client/app/components/admin/useAdminModal';
import { getThemeConfig } from '@client/app/utils/themes';
import { getModelProviderLabel } from './fallbackProviderLabel';
import ModelSelection, {
  BACKEND_PRIORITY,
  getModelBackend,
  SELF_HOSTED_BACKEND,
  sortBackendsByPriority,
} from './ModelSelection';

const { setLLM } = vi.hoisted(() => ({ setLLM: vi.fn() }));
const admin = vi.hoisted(() => ({ isAdmin: false, navigate: vi.fn() }));
// Text models appended to the accessible list per test; reset in afterEach below.
const extraTextModels = vi.hoisted(() => [] as ModelInfo[]);
const favoriteModelIds = vi.hoisted(() => new Set<string>());
const adminSettings = vi.hoisted(() => ({
  recommendedModelIds: [] as string[],
  DefaultAPIModel: undefined as string | undefined,
}));

const textModel = {
  id: 'gpt-text-model',
  name: 'GPT Text Model',
  description: 'Text model',
  type: 'text',
  contextWindow: 128000,
  max_tokens: 4096,
} as ModelInfo;

const imageModel = {
  id: 'gpt-image-model',
  name: 'GPT Image Model',
  description: 'Image model',
  type: 'image',
  contextWindow: 128000,
  max_tokens: 4096,
} as ModelInfo;

vi.mock('@client/app/hooks/data/useModelInfo', () => ({
  useModelInfo: () => ({ isLoading: false, error: null }),
}));

vi.mock('@client/app/hooks/useAccessibleModels', () => ({
  useAccessibleModels: () => ({
    accessibleModels: [textModel, imageModel, ...extraTextModels],
    accessibleTextModels: [textModel, ...extraTextModels],
    accessibleImageModels: [imageModel],
    accessibleVideoModels: [],
    isLoading: false,
  }),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: (selector: (state: { setLLM: typeof setLLM }) => unknown) => selector({ setLLM }),
}));

vi.mock('@client/app/contexts/UserContext', () => ({
  useUser: (selector: (state: { isAdmin: boolean }) => unknown) => selector({ isAdmin: admin.isAdmin }),
}));

vi.mock('@client/app/contexts/AdminSettingsContext', () => ({
  useAdminSettings: () => ({
    getSetting: (key: string, fallback = '') =>
      key === 'DefaultAPIModel' ? (adminSettings.DefaultAPIModel ?? fallback) : fallback,
    getSettingObject: (key: string, fallback: unknown) =>
      key === 'recommendedModelIds' ? adminSettings.recommendedModelIds : fallback,
  }),
}));

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => admin.navigate }));

vi.mock('@client/app/hooks/data/useModelStats', () => ({
  useModelStats: () => ({ data: { popularity: {}, avgResponseTime: {} }, isLoading: false }),
}));

vi.mock('@client/app/hooks/useFavoriteModels', () => ({
  useFavoriteModels: () => ({
    favoriteModelIds,
    isFavorite: (id: string) => favoriteModelIds.has(id),
    toggleFavorite: vi.fn(),
  }),
}));

vi.mock('@client/app/utils/modelRanking', () => ({
  sortModelsForPicker: (models: ModelInfo[]) => models,
}));

vi.mock('@client/app/utils/commands', () => ({
  isImageModel: (model: string) => model.includes('image'),
}));

vi.mock('@client/app/utils/aiSettingsUtils', () => ({
  getModelPriceTier: () => ({ tier: 'Low', variant: 'green' }),
  isOpenAIModel: (name: string) => name.toLowerCase().includes('gpt'),
  getModelSpeedVariant: () => 'green',
  getModelSpeedTooltip: () => '',
  getModelSpeedFromStats: () => null,
  getPriceTierTooltip: () => '',
  isNewModel: () => false,
}));

vi.mock('./AISettings/MetaDataChips', () => ({
  default: ({ label }: { label: string }) => <span>{label}</span>,
}));

// The app theme, not Joy's default: ModelSelection reads custom palette tokens
// (notebooklist.*) that only exist here.
const appTheme = extendTheme({ ...getThemeConfig() });

type SelectionProps = {
  model?: string;
  setModel?: (model: ModelName) => void;
  onSelectionComplete?: () => void;
  onSettingsClick?: (model: ModelInfo) => void;
};

const selectionTree = (props: SelectionProps) => (
  <CssVarsProvider theme={appTheme}>
    <ModelSelection
      model={props.model ?? textModel.id}
      setModel={props.setModel ?? vi.fn()}
      onSelectionComplete={props.onSelectionComplete}
      imageModel={false}
      showAllModels
      modelFilter="all"
      onSettingsClick={props.onSettingsClick}
    />
  </CssVarsProvider>
);

const renderSelection = (props: SelectionProps) => render(selectionTree(props));

describe('ModelSelection apply behavior', () => {
  beforeEach(() => {
    setLLM.mockClear();
  });

  // lastUsedTextModel / lastUsedImageModel now ride along in buildModelSelectionPatch, which the
  // setModel callback applies - covered in utils/__tests__/aiSettingsUtils.test.ts.
  it.each([
    ['text', textModel],
    ['image', imageModel],
  ] as const)('applies a %s model and completes the selection when its card is clicked', (_, model) => {
    const setModel = vi.fn();
    const onSelectionComplete = vi.fn();
    renderSelection({ setModel, onSelectionComplete });

    fireEvent.click(screen.getByTestId(`model-card-${model.id}`));

    expect(setModel).toHaveBeenCalledWith(model.id);
    expect(onSelectionComplete).toHaveBeenCalledOnce();
  });

  // The gear is a preview: it opens the per-model settings screen WITHOUT switching the session's
  // model, so the "Use this model" button on that screen is the only thing that commits. Selecting
  // here would make that button permanently read "Current model".
  it('opens View more without selecting the model or completing the selection', () => {
    const setModel = vi.fn();
    const onSelectionComplete = vi.fn();
    const onSettingsClick = vi.fn();
    renderSelection({ setModel, onSelectionComplete, onSettingsClick });

    fireEvent.click(screen.getByTestId(`model-view-more-${imageModel.id}`));

    expect(onSettingsClick).toHaveBeenCalledWith(imageModel);
    expect(setModel).not.toHaveBeenCalled();
    expect(onSelectionComplete).not.toHaveBeenCalled();
  });
});

describe('ModelSelection view mode', () => {
  it('defaults to list view and toggles to grid and back', () => {
    renderSelection({});

    const toggle = screen.getByTestId('model-view-mode-toggle');
    const card = () => screen.getByTestId(`model-card-${textModel.id}`);

    expect(card()).toHaveAttribute('data-view-mode', 'list');
    // The description is dropped in list view.
    expect(screen.queryByText(textModel.description)).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(card()).toHaveAttribute('data-view-mode', 'grid');
    expect(screen.getByText(textModel.description)).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(card()).toHaveAttribute('data-view-mode', 'list');
  });
});

describe('ModelSelection context summary', () => {
  it('shows the context window for text models only, with an explanatory tooltip', async () => {
    renderSelection({});

    // Both fixtures declare contextWindow: 128000, so exactly one "128K" proves the image
    // model's placeholder value is suppressed rather than both being rendered.
    expect(screen.getAllByText('128K')).toHaveLength(1);
    expect(screen.getByTestId(`model-card-${textModel.id}`)).toHaveTextContent('128K');
    expect(screen.getByTestId(`model-card-${imageModel.id}`)).not.toHaveTextContent('128K');

    // The number is unlabelled, so the tooltip is the only thing that explains it.
    fireEvent.mouseOver(screen.getByText('128K'));
    expect(await screen.findByText('128,000 token context window')).toBeInTheDocument();
  });
});

describe('ModelSelection admin quick link', () => {
  beforeEach(() => {
    admin.isAdmin = false;
    admin.navigate.mockClear();
    useAdminModal.setState({ activeTab: AdminTab.Users });
  });

  it('stays hidden for a non-admin user', () => {
    renderSelection({});

    expect(screen.queryByTestId('model-selection-manage-models-btn')).not.toBeInTheDocument();
  });

  it('sends an admin to the LLM Dashboard tab and closes the picker first', () => {
    admin.isAdmin = true;
    const onSelectionComplete = vi.fn();
    renderSelection({ onSelectionComplete });

    fireEvent.click(screen.getByTestId('model-selection-manage-models-btn'));

    expect(useAdminModal.getState().activeTab).toBe(AdminTab.LLMDashboard);
    expect(onSelectionComplete).toHaveBeenCalledOnce();
    expect(admin.navigate).toHaveBeenCalledWith({ to: '/admin' });
  });
});

describe('getModelBackend self-hosted grouping', () => {
  const savedSelfHost = process.env.B4M_SELF_HOST;
  afterEach(() => {
    if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
    else process.env.B4M_SELF_HOST = savedSelfHost;
  });

  const makeModel = (over: Partial<ModelInfo>): ModelInfo =>
    ({ id: 'x', name: 'X', description: '', type: 'image', contextWindow: 1, max_tokens: 1, ...over }) as ModelInfo;

  it('groups a local image model under "Local / Self-Hosted" (not "Other") in self-host', () => {
    process.env.B4M_SELF_HOST = 'true';
    const model = makeModel({
      id: 'local-image/v1-5-pruned-emaonly',
      name: 'v1-5-pruned-emaonly',
      backend: ModelBackend.LocalImage,
    });
    expect(getModelBackend(model)).toBe(SELF_HOSTED_BACKEND);
  });

  it('groups a local Ollama text model under the same heading in self-host', () => {
    process.env.B4M_SELF_HOST = 'true';
    const model = makeModel({
      id: 'qwen2.5-coder:7b',
      name: 'qwen2.5-coder:7b',
      backend: ModelBackend.Ollama,
      type: 'text',
    });
    expect(getModelBackend(model)).toBe(SELF_HOSTED_BACKEND);
  });

  it('does not force the heading outside self-host (falls through to name-based grouping)', () => {
    delete process.env.B4M_SELF_HOST;
    const model = makeModel({ id: 'local-image/foo', name: 'foo', backend: ModelBackend.LocalImage });
    expect(getModelBackend(model)).toBe('Other');
  });
});

describe('getModelBackend DeepSeek and Moonshot grouping', () => {
  const makeModel = (over: Partial<ModelInfo>): ModelInfo =>
    ({ id: 'x', name: 'X', description: '', type: 'text', contextWindow: 1, max_tokens: 1, ...over }) as ModelInfo;

  it.each([
    ['deepseek-flash', 'DeepSeek Flash', ModelBackend.DeepSeek],
    ['deepseek-v4-pro', 'DeepSeek V4 Pro', ModelBackend.DeepSeek],
    ['us.deepseek.r1-v1:0', 'DeepSeek R1', ModelBackend.Bedrock],
    ['deepseek.v3-v1:0', 'DeepSeek v3.1', ModelBackend.Bedrock],
  ] as const)('groups DeepSeek id %s under "DeepSeek"', (id, name, backend) => {
    expect(getModelBackend(makeModel({ id, name, backend }))).toBe('DeepSeek');
  });

  it('does not swallow the Ollama-hosted deepseek-r1:latest into "DeepSeek"', () => {
    const model = makeModel({ id: 'deepseek-r1:latest', name: 'deepseek-r1:latest', backend: ModelBackend.Ollama });
    expect(getModelBackend(model)).toBe('Other');
  });

  it('still routes the Ollama-hosted deepseek-r1:latest to the self-hosted section', () => {
    const savedSelfHost = process.env.B4M_SELF_HOST;
    process.env.B4M_SELF_HOST = 'true';
    try {
      const model = makeModel({ id: 'deepseek-r1:latest', name: 'deepseek-r1:latest', backend: ModelBackend.Ollama });
      expect(getModelBackend(model)).toBe(SELF_HOSTED_BACKEND);
    } finally {
      if (savedSelfHost === undefined) delete process.env.B4M_SELF_HOST;
      else process.env.B4M_SELF_HOST = savedSelfHost;
    }
  });

  it.each([
    ['kimi-k3', 'Kimi K3'],
    ['kimi-k2.7-code', 'Kimi K2.7 Code'],
    ['kimi-k2.7-code-highspeed', 'Kimi K2.7 Code Highspeed'],
    ['kimi-k2.6', 'Kimi K2.6'],
    ['moonshotai.kimi-k2.5', 'Kimi K2.5'],
    ['moonshot.kimi-k2-thinking', 'Kimi K2 Thinking'],
  ] as const)('groups Moonshot id %s under "Moonshot"', (id, name) => {
    expect(getModelBackend(makeModel({ id, name }))).toBe('Moonshot');
  });
});

describe('BACKEND_PRIORITY section order', () => {
  it('sorts known backends in the intended order, with the rest alphabetical after', () => {
    const shuffled = [
      'Cohere',
      'Mistral',
      'DeepSeek',
      'Zephyr',
      'Moonshot',
      'xAI',
      SELF_HOSTED_BACKEND,
      'Anthropic',
      'OpenAI',
      'Google',
      'Meta',
      'Black Forest Labs',
    ];

    expect(sortBackendsByPriority(shuffled)).toEqual([
      SELF_HOSTED_BACKEND,
      'OpenAI',
      'Anthropic',
      'Google',
      'Meta',
      'xAI',
      'DeepSeek',
      'Moonshot',
      'Mistral',
      'Black Forest Labs',
      'Cohere',
      'Zephyr',
    ]);
  });
});

/**
 * getModelBackend (picker section, by maker) and getModelProviderLabel (fallback
 * tooltip, by hosting path) are two id-sniffing classifiers with deliberately
 * different rules: Bedrock Claude is "Anthropic" in the picker but "Bedrock" in the
 * tooltip, which is the distinction the tooltip exists to draw. What must not
 * happen is a provider landing in one and not the other, so every ModelBackend
 * needs a representative here. Checked at runtime: client tests are outside tsc.
 */
describe('provider classifiers cover every backend', () => {
  // section null = never grouped by maker (speech-to-text, embeddings, and
  // self-host-only images, covered by the self-hosted grouping tests above).
  // label null = not a chat model, so never in a text fallback.
  const REPRESENTATIVE: Record<
    ModelBackend,
    { id: string; name: string; section: string | null; label: string | null }
  > = {
    [ModelBackend.OpenAI]: { id: 'gpt-5', name: 'GPT-5', section: 'OpenAI', label: 'OpenAI' },
    [ModelBackend.Anthropic]: {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      section: 'Anthropic',
      label: 'Anthropic direct',
    },
    [ModelBackend.Bedrock]: {
      id: 'us.anthropic.claude-sonnet-5',
      name: 'Claude Sonnet 5',
      section: 'Anthropic',
      label: 'Bedrock',
    },
    [ModelBackend.Gemini]: { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', section: 'Google', label: 'Google' },
    [ModelBackend.XAI]: { id: 'grok-4', name: 'Grok 4', section: 'xAI', label: 'xAI' },
    [ModelBackend.Kimi]: { id: 'kimi-k3', name: 'Kimi K3', section: 'Moonshot', label: 'Moonshot direct' },
    [ModelBackend.DeepSeek]: { id: 'deepseek-flash', name: 'DeepSeek Flash', section: 'DeepSeek', label: 'DeepSeek' },
    [ModelBackend.Ollama]: { id: 'llama3.3', name: 'llama3.3', section: 'Meta', label: 'Ollama' },
    [ModelBackend.BFL]: { id: 'flux-pro-1.1', name: 'FLUX 1.1 [pro]', section: 'Black Forest Labs', label: null },
    [ModelBackend.AWS]: { id: 'aws-transcribe', name: 'Amazon Transcribe', section: null, label: null },
    [ModelBackend.VoyageAI]: { id: 'voyage-3', name: 'Voyage 3', section: null, label: null },
    [ModelBackend.LocalImage]: { id: 'local-image/sd15', name: 'sd15', section: null, label: null },
  };
  const makeModel = (backend: ModelBackend): ModelInfo =>
    ({ ...REPRESENTATIVE[backend], backend, description: '', type: 'text' }) as unknown as ModelInfo;
  const PICKER_BACKENDS = Object.values(ModelBackend).filter(b => REPRESENTATIVE[b]?.section);

  it.each(Object.values(ModelBackend))('%s has a representative model', backend => {
    expect(REPRESENTATIVE).toHaveProperty(backend);
  });

  it.each(PICKER_BACKENDS)('%s groups under its expected, ordered picker section', backend => {
    const section = getModelBackend(makeModel(backend));
    expect(section).toBe(REPRESENTATIVE[backend].section);
    expect(BACKEND_PRIORITY).toContain(section);
  });

  it.each(Object.values(ModelBackend))('%s gets the expected fallback tooltip label', backend => {
    expect(getModelProviderLabel(REPRESENTATIVE[backend].id, backend)).toBe(REPRESENTATIVE[backend].label ?? undefined);
  });
});

describe('ModelSelection recommended group', () => {
  afterEach(() => {
    adminSettings.recommendedModelIds = [];
    adminSettings.DefaultAPIModel = undefined;
  });

  it('recommends the admin-set default model when the list is empty', () => {
    adminSettings.DefaultAPIModel = imageModel.id;
    renderSelection({});
    const cards = within(screen.getByTestId('recommended-section')).getAllByTestId(/^model-card-/);
    expect(cards.map(c => c.getAttribute('data-testid'))).toEqual([`model-card-${imageModel.id}`]);
  });

  it('renders no Recommended group when the list is empty and the compiled default is not available', () => {
    renderSelection({});
    expect(screen.queryByTestId('recommended-section')).not.toBeInTheDocument();
  });

  it('pins configured models above the full list and keeps them in the full list', () => {
    adminSettings.recommendedModelIds = [textModel.id];
    renderSelection({});
    const section = screen.getByTestId('recommended-section');
    expect(section).toHaveTextContent('Recommended');
    expect(section).toHaveTextContent(textModel.name);
    expect(screen.getAllByTestId(`model-card-${textModel.id}`).length).toBeGreaterThan(1);
  });

  it('keeps the configured order, not the provider sort, and shows a repeated id once', () => {
    adminSettings.recommendedModelIds = [imageModel.id, textModel.id, imageModel.id];
    renderSelection({});
    const cards = within(screen.getByTestId('recommended-section')).getAllByTestId(/^model-card-/);
    expect(cards.map(c => c.getAttribute('data-testid'))).toEqual([
      `model-card-${imageModel.id}`,
      `model-card-${textModel.id}`,
    ]);
  });

  it('skips ids that are unknown or inaccessible', () => {
    adminSettings.recommendedModelIds = ['no-such-model'];
    renderSelection({});
    expect(screen.queryByTestId('recommended-section')).not.toBeInTheDocument();
  });
});

describe('ModelSelection duplicate and unavailable rows', () => {
  afterEach(() => {
    extraTextModels.length = 0;
    favoriteModelIds.clear();
    adminSettings.recommendedModelIds = [];
  });

  it('shows a Bedrock model once and hides its unavailable foundation-id twin', () => {
    extraTextModels.push(
      {
        ...textModel,
        id: 'global.anthropic.claude-opus-5-5',
        name: 'Claude Opus 5.5',
        backend: ModelBackend.Bedrock,
      } as ModelInfo,
      {
        ...textModel,
        id: 'anthropic.claude-opus-5-5',
        name: 'Claude Opus 5.5',
        backend: ModelBackend.Bedrock,
        disabled: true,
      } as ModelInfo
    );
    renderSelection({});

    expect(screen.getByTestId('model-card-global.anthropic.claude-opus-5-5')).toBeInTheDocument();
    expect(screen.queryByTestId('model-card-anthropic.claude-opus-5-5')).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('hides disabled favorites and recommendations when they are not active', () => {
    const unavailableId = 'anthropic.claude-opus-5-5';
    extraTextModels.push({ ...textModel, id: unavailableId, backend: ModelBackend.Bedrock, disabled: true });
    favoriteModelIds.add(unavailableId);
    adminSettings.recommendedModelIds = [unavailableId];
    renderSelection({});

    expect(screen.queryByTestId(`model-card-${unavailableId}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId('recommended-section')).not.toBeInTheDocument();
  });

  it('shows an unavailable active model and its enabled profile twin', () => {
    const activeId = 'anthropic.claude-opus-5-5';
    const enabledId = 'global.anthropic.claude-opus-5-5';
    extraTextModels.push(
      { ...textModel, id: activeId, backend: ModelBackend.Bedrock, disabled: true },
      { ...textModel, id: enabledId, backend: ModelBackend.Bedrock }
    );
    renderSelection({ model: activeId });

    expect(screen.getByTestId(`model-card-${activeId}`)).toHaveAttribute('data-disabled');
    expect(screen.getByTestId(`model-card-${enabledId}`)).toBeInTheDocument();
  });

  it('keeps pinned twin ids in their sections when the active alias wins the provider row', () => {
    const activeId = 'gpt-4.1';
    const pinnedId = 'gpt-4.1-2025-04-14';
    extraTextModels.push(
      { ...textModel, id: activeId, backend: ModelBackend.OpenAI },
      { ...textModel, id: pinnedId, backend: ModelBackend.OpenAI }
    );
    favoriteModelIds.add(pinnedId);
    adminSettings.recommendedModelIds = [pinnedId];
    renderSelection({ model: activeId });

    expect(within(screen.getByTestId('recommended-section')).getByTestId(`model-card-${pinnedId}`)).toBeInTheDocument();
    expect(within(screen.getByTestId('favorites-section')).getByTestId(`model-card-${pinnedId}`)).toBeInTheDocument();
  });

  it('keeps a Favorites card mounted and focused when selecting it flips the provider-row winner', () => {
    const aliasId = 'gpt-4.1';
    const pinnedId = 'gpt-4.1-2025-04-14';
    const laterFavoriteId = 'gpt-later-favorite';
    extraTextModels.push(
      { ...textModel, id: aliasId, backend: ModelBackend.OpenAI },
      { ...textModel, id: pinnedId, backend: ModelBackend.OpenAI },
      { ...textModel, id: laterFavoriteId, backend: ModelBackend.OpenAI }
    );
    favoriteModelIds.add(pinnedId);
    favoriteModelIds.add(laterFavoriteId);
    const { rerender } = renderSelection({ model: aliasId });

    const favorites = screen.getByTestId('favorites-section');
    const selectButton = within(favorites).getByTestId(`model-select-btn-${pinnedId}`);
    selectButton.focus();
    expect(selectButton).toHaveFocus();

    rerender(selectionTree({ model: pinnedId }));

    const afterSelect = within(screen.getByTestId('favorites-section')).getByTestId(`model-select-btn-${pinnedId}`);
    expect(afterSelect).toBe(selectButton);
    expect(afterSelect).toHaveFocus();
    expect(afterSelect).toHaveAttribute('aria-pressed', 'true');
  });

  describe('search over pinned twins', () => {
    const aliasId = 'gpt-4.1';
    const pinnedId = 'gpt-4.1-2025-04-14';
    const searchFor = async (term: string) => {
      fireEvent.change(screen.getByTestId('model-search-input').querySelector('input') as HTMLInputElement, {
        target: { value: term },
      });
      await waitFor(() => expect(screen.getByTestId('model-search-input').querySelector('input')).toHaveValue(term));
    };

    beforeEach(() => {
      extraTextModels.push(
        { ...textModel, id: aliasId, name: 'Alpha Active', description: '', backend: ModelBackend.OpenAI },
        { ...textModel, id: pinnedId, name: 'Beta Pinned', description: '', backend: ModelBackend.OpenAI }
      );
      favoriteModelIds.add(pinnedId);
    });

    it('leaves a pinned twin out of Favorites when the search matches only the active winner', async () => {
      renderSelection({ model: aliasId });
      expect(within(screen.getByTestId('favorites-section')).getByTestId(`model-card-${pinnedId}`)).toBeInTheDocument();

      await searchFor('alpha');

      await waitFor(() => expect(screen.queryByTestId(`model-card-${pinnedId}`)).not.toBeInTheDocument());
      expect(screen.queryByTestId('favorites-section')).not.toBeInTheDocument();
      expect(screen.getByTestId(`model-card-${aliasId}`)).toBeInTheDocument();
    });

    it('still lists a pinned twin in Favorites when the search matches only that twin', async () => {
      renderSelection({ model: aliasId });

      await searchFor('beta');

      await waitFor(() => expect(screen.queryByTestId(`model-card-${aliasId}`)).not.toBeInTheDocument());
      const favorites = screen.getByTestId('favorites-section');
      expect(within(favorites).getByTestId(`model-card-${pinnedId}`)).toBeInTheDocument();
      expect(screen.queryByText(/No models found/)).not.toBeInTheDocument();
    });
  });

  it('keeps the unavailable active model unselectable by click and by keyboard target', () => {
    const activeId = 'anthropic.claude-opus-5-5';
    extraTextModels.push({ ...textModel, id: activeId, backend: ModelBackend.Bedrock, disabled: true });
    const setModel = vi.fn();
    const onSelectionComplete = vi.fn();
    renderSelection({ model: activeId, setModel, onSelectionComplete });

    expect(screen.getByTestId(`model-select-btn-${activeId}`)).toBeDisabled();
    fireEvent.click(screen.getByTestId(`model-card-${activeId}`));
    fireEvent.click(screen.getByTestId(`model-select-btn-${activeId}`));

    expect(setModel).not.toHaveBeenCalled();
    expect(onSelectionComplete).not.toHaveBeenCalled();
  });
});

describe('ModelSelection direct and Bedrock routes', () => {
  afterEach(() => {
    extraTextModels.length = 0;
  });

  const directHaiku = {
    ...textModel,
    id: 'claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    backend: ModelBackend.Anthropic,
  } as ModelInfo;
  const bedrockHaiku = {
    ...textModel,
    id: 'global.anthropic.claude-haiku-5-5',
    name: 'Claude Haiku 5.5',
    backend: ModelBackend.Bedrock,
  } as ModelInfo;

  it('lists the Bedrock route under its own labelled heading, after the direct row', () => {
    extraTextModels.push(bedrockHaiku, directHaiku);
    renderSelection({});

    const bedrockSection = screen.getByTestId('bedrock-route-section-Anthropic-text');
    expect(within(bedrockSection).getByText('Via AWS Bedrock')).toBeInTheDocument();
    expect(within(bedrockSection).getByTestId(`model-card-${bedrockHaiku.id}`)).toBeInTheDocument();
    expect(within(bedrockSection).queryByTestId(`model-card-${directHaiku.id}`)).not.toBeInTheDocument();

    const directCard = screen.getByTestId(`model-card-${directHaiku.id}`);
    expect(directCard.compareDocumentPosition(bedrockSection) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  // The catch-all "Other" group mixes makers, so the explanation must not name the group or claim
  // the Bedrock rows are copies of the direct ones above them.
  it('explains the Bedrock heading without naming the group', async () => {
    extraTextModels.push(
      { ...textModel, id: 'remote-mistral', name: 'Remote Mistral', backend: ModelBackend.Ollama } as ModelInfo,
      {
        ...textModel,
        id: 'mistral.mistral-large-2407-v1:0',
        name: 'Mistral Large',
        backend: ModelBackend.Bedrock,
      } as ModelInfo
    );
    renderSelection({});
    // "Other" starts collapsed; a search expands every group.
    fireEvent.change(screen.getByTestId('model-search-input').querySelector('input') as HTMLInputElement, {
      target: { value: 'mistral' },
    });

    const bedrockSection = await screen.findByTestId('bedrock-route-section-Other-text');
    expect(
      within(bedrockSection).getByText("Served through AWS Bedrock instead of the provider's own API.")
    ).toBeInTheDocument();
    expect(within(bedrockSection).queryByText(/Other's/)).not.toBeInTheDocument();
  });

  it('adds no route heading when a maker is served by one route only', () => {
    extraTextModels.push(bedrockHaiku);
    renderSelection({});

    expect(screen.getByTestId(`model-card-${bedrockHaiku.id}`)).toBeInTheDocument();
    expect(screen.queryByText('Via AWS Bedrock')).not.toBeInTheDocument();
  });
});

describe('ModelSelection keyboard access', () => {
  afterEach(() => {
    extraTextModels.length = 0;
  });

  it.each(['{Enter}', ' '])('selects a model with %s on its focusable button', async key => {
    const user = userEvent.setup();
    const setModel = vi.fn();
    const onSelectionComplete = vi.fn();
    renderSelection({ setModel, onSelectionComplete });

    const selectButton = screen.getByTestId(`model-select-btn-${imageModel.id}`);
    expect(selectButton.tagName).toBe('BUTTON');
    expect(selectButton).toHaveAccessibleName(imageModel.name);
    expect(screen.getByTestId(`model-select-btn-${textModel.id}`)).toHaveAttribute('aria-pressed', 'true');

    selectButton.focus();
    await user.keyboard(key);

    expect(setModel).toHaveBeenCalledWith(imageModel.id);
    expect(onSelectionComplete).toHaveBeenCalledOnce();
  });

  it('names the star and settings buttons after their model', () => {
    renderSelection({ onSettingsClick: vi.fn() });

    expect(screen.getByTestId(`favorite-toggle-${textModel.id}`)).toHaveAccessibleName(
      `Add ${textModel.name} to favorites`
    );
    expect(screen.getByTestId(`model-view-more-${textModel.id}`)).toHaveAccessibleName(
      `View ${textModel.name} details and settings`
    );
  });
});
