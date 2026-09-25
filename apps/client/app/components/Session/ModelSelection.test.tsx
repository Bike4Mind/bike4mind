import React from 'react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { fireEvent, render, screen } from '@testing-library/react';
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
    accessibleModels: [textModel, imageModel],
    accessibleTextModels: [textModel],
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

vi.mock('@tanstack/react-router', () => ({ useNavigate: () => admin.navigate }));

vi.mock('@client/app/hooks/data/useModelStats', () => ({
  useModelStats: () => ({ data: { popularity: {}, avgResponseTime: {} }, isLoading: false }),
}));

vi.mock('@client/app/hooks/useFavoriteModels', () => ({
  useFavoriteModels: () => ({ isFavorite: () => false, toggleFavorite: vi.fn() }),
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

const renderSelection = (props: {
  setModel?: (model: ModelName) => void;
  onSelectionComplete?: () => void;
  onSettingsClick?: (model: ModelInfo) => void;
}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ModelSelection
        model={textModel.id}
        setModel={props.setModel ?? vi.fn()}
        onSelectionComplete={props.onSelectionComplete}
        imageModel={false}
        showAllModels
        modelFilter="all"
        onSettingsClick={props.onSettingsClick}
      />
    </CssVarsProvider>
  );

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
