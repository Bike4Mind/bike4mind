import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';

/**
 * The image controls that left the composer row for the plus menu: images per prompt, the
 * template/cost readout and the prompt builder, which still follows the session denylist.
 */

const hoisted = vi.hoisted(() => ({
  adminFlags: {} as Record<string, boolean>,
  disabledTools: undefined as string[] | undefined,
  llm: { model: 'gpt-image-2', n: 1 },
  setState: vi.fn(),
  setPromptBuilderOpen: vi.fn(),
}));

vi.mock('@client/app/contexts/LLMContext', () => ({
  useLLM: Object.assign((select: (s: typeof hoisted.llm) => unknown) => select(hoisted.llm), {
    setState: hoisted.setState,
  }),
}));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ currentSession: hoisted.disabledTools ? { disabledTools: hoisted.disabledTools } : undefined }),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isAdminFeatureEnabled: (key: string) => hoisted.adminFlags[key] ?? false }),
}));
vi.mock('../ImageTemplates/ImageTemplateControls', () => ({
  ImageTemplateControls: () => <div data-testid="image-template-controls" />,
}));
vi.mock('../PromptBuilder/usePromptBuilderFirstRun', () => ({
  usePromptBuilderFirstRun: () => ({ showHint: false, markSeen: vi.fn() }),
}));
vi.mock('./useAdvancedAISettingsStore', () => ({
  useAdvancedAISettings: (select: (s: { setPromptBuilderOpen: typeof hoisted.setPromptBuilderOpen }) => unknown) =>
    select({ setPromptBuilderOpen: hoisted.setPromptBuilderOpen }),
}));

import ImageOptionsPanel from './ImageOptionsPanel';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderPanel = (onOpenPromptBuilder = vi.fn()) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <ImageOptionsPanel onOpenPromptBuilder={onOpenPromptBuilder} />
    </CssVarsProvider>
  );

describe('ImageOptionsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.adminFlags = {};
    hoisted.disabledTools = undefined;
    hoisted.llm = { model: 'gpt-image-2', n: 1 };
  });

  it('titles itself unless a header already names it', () => {
    const { unmount } = renderPanel();
    expect(screen.getByText('Image options')).toBeInTheDocument();
    unmount();
    render(
      <CssVarsProvider theme={appTheme}>
        <ImageOptionsPanel showTitle={false} />
      </CssVarsProvider>
    );
    expect(screen.queryByText('Image options')).toBeNull();
  });

  it('sets images per prompt within 1-4', () => {
    renderPanel();
    const input = screen.getByTestId('image-response-count-input').querySelector('input')!;
    fireEvent.change(input, { target: { value: '3' } });
    expect(hoisted.setState).toHaveBeenCalledWith({ n: 3 });
    fireEvent.change(input, { target: { value: '9' } });
    expect(hoisted.setState).toHaveBeenCalledTimes(1);
  });

  it('shows the template readout only behind its admin flag', () => {
    renderPanel();
    expect(screen.queryByTestId('image-template-controls')).toBeNull();
  });

  it('opens the prompt builder and lets the menu close itself', () => {
    hoisted.adminFlags = { EnablePromptBuilder: true };
    const onOpen = vi.fn();
    renderPanel(onOpen);
    fireEvent.click(screen.getByTestId('prompt-builder-open-btn'));
    expect(hoisted.setPromptBuilderOpen).toHaveBeenCalledWith(true);
    expect(onOpen).toHaveBeenCalled();
  });

  it('hides the prompt builder when the session denies image_generation', () => {
    hoisted.adminFlags = { EnablePromptBuilder: true };
    hoisted.disabledTools = ['image_generation'];
    renderPanel();
    expect(screen.queryByTestId('prompt-builder-open-btn')).toBeNull();
  });
});
