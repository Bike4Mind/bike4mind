import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import { ATTACH_SCOPE_MODES } from '@bike4mind/common';

/**
 * The attach-scope control: three Joy `Chip`s each wrapping a `disableIcon`/`overlay` `Radio`.
 *
 * The assertions that matter here are about the variant/color reaching the inner `Radio`. Joy's
 * `Radio` reads `RadioGroupContext` and `FormControlContext` but never `ChipContext`, so it does NOT
 * inherit the Chip's variant/color - it falls back to its own `outlined` default. Under `disableIcon`
 * that default repaints the label colour AND the action's background, and the action is absolutely
 * positioned over the chip, so an outlined Radio inside a solid Chip renders a blue label on a blue
 * pill (1.08:1) that inverts to near-white on hover. Passing them down explicitly is the fix.
 *
 * jsdom does not resolve CSS custom properties, so the resolved contrast cannot be asserted directly.
 * Joy's variant/color classes are the durable proxy: they are exactly what selects the palette tokens
 * the contrast falls out of, so `variantSolid`/`colorPrimary` on the selected Radio is the guard, and
 * it fails the moment someone drops those props again.
 */

const hoisted = vi.hoisted(() => ({ isFeatureEnabled: vi.fn(() => false) }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: {} }));
vi.mock('@client/app/hooks/data/settings', () => ({ useConfig: () => ({ data: {} }) }));
vi.mock('@client/app/contexts/UserContext', () => ({ useUser: () => undefined }));
vi.mock('@client/app/hooks/data/googleDrive', () => ({ useConnectGoogleDrive: () => vi.fn() }));
vi.mock('@client/app/hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('@client/app/utils/filesAPICalls', () => ({ createFabFileOnServerWithUpload: vi.fn() }));
vi.mock('react-google-drive-picker', () => ({ default: () => [vi.fn()] }));
vi.mock('@client/app/hooks/data/analytics', () => ({ useLogEvent: () => vi.fn() }));
vi.mock('@client/app/hooks/data/sessions', () => ({
  useCreateNewSession: () => vi.fn(),
  useUpdateSession: () => vi.fn(),
}));
vi.mock('@tanstack/react-query', () => ({ useQueryClient: () => ({}) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('@client/app/contexts/SessionsContext', () => ({
  useSessions: () => ({ workBenchAgents: [], currentSessionId: undefined }),
  useWorkBenchActions: () => ({ setWorkBenchFiles: vi.fn() }),
}));
vi.mock('@client/app/hooks/useSessionLayout', () => ({ setSessionLayout: vi.fn() }));
vi.mock('@client/app/hooks/data/agents', () => ({ useGetSessionAgents: () => ({ data: [] }) }));
vi.mock('@client/app/contexts/LLMContext', () => ({ useLLM: () => [[]] }));
vi.mock('@client/app/components/Session/AdvancedAISettings', () => ({
  useAdvancedAISettings: () => vi.fn(),
}));
vi.mock('@client/app/hooks/useFeatureEnabled', () => ({
  useFeatureEnabled: () => ({ isFeatureEnabled: hoisted.isFeatureEnabled }),
}));
vi.mock('@client/app/contexts/UserSettingsContext', () => ({
  useUserSettings: () => ({ settings: {} }),
}));
vi.mock('@client/app/components/commands/RollCommand', () => ({ handleRollCommand: vi.fn() }));
vi.mock('@client/app/components/common/CountBadge', () => ({ default: () => null }));
vi.mock('@client/app/utils/googleDrivePickerStyles', () => ({ ensureGoogleDrivePickerStyles: vi.fn() }));

import AttachFileButton from './AttachFileButton';

const appTheme = extendTheme({ ...getThemeConfig() });
const Wrapper = ({ children }: { children: React.ReactNode }) => (
  <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
);

const renderControl = (attachScopeMode: (typeof ATTACH_SCOPE_MODES)[number] = 'auto') => {
  const onAttachScopeModeChange = vi.fn();
  render(
    <Wrapper>
      <AttachFileButton
        onUploadFromComputer={vi.fn()}
        onAddFromGoogleDrive={vi.fn()}
        onAddFromFileBrowser={vi.fn()}
        attachScopeMode={attachScopeMode}
        onAttachScopeModeChange={onAttachScopeModeChange}
      />
    </Wrapper>
  );
  // The control lives inside the attach dropdown, which is mounted only while open.
  fireEvent.click(screen.getByTestId('attach-files-btn'));
  return { onAttachScopeModeChange };
};

/** The Joy Radio root, which is where variant/color classes land (the <input> is a descendant). */
const radioRoot = (mode: string) =>
  screen.getByTestId(`attach-file-scope-${mode}-radio`).closest('.MuiRadio-root') as HTMLElement;

describe('AttachFileButton attach-scope control', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders one labelled option per mode, so a new mode cannot ship unlabelled', () => {
    renderControl();
    expect(screen.getByTestId('attach-file-scope-radiogroup')).toBeInTheDocument();
    for (const mode of ATTACH_SCOPE_MODES) {
      expect(screen.getByTestId(`attach-file-scope-${mode}-radio`)).toBeInTheDocument();
    }
    expect(screen.getByText('Smart')).toBeInTheDocument();
    expect(screen.getByText('Whole notebook')).toBeInTheDocument();
    expect(screen.getByText('Just this message')).toBeInTheDocument();
  });

  it('gives the SELECTED radio the chip variant/color, not its own outlined default', () => {
    // The #2084 review defect: without these props the Radio resolves outlined/primary and paints
    // primary.outlinedColor on the chip's primary.solidBg - 1.08:1, on first render, before any
    // interaction. `auto` is the mount-time default, so the control shipped looking broken.
    renderControl('auto');
    const selected = radioRoot('auto');
    expect(selected).toHaveClass('MuiRadio-variantSolid');
    expect(selected).toHaveClass('MuiRadio-colorPrimary');
    expect(selected).not.toHaveClass('MuiRadio-variantOutlined');
  });

  it('leaves the UNSELECTED radios outlined/neutral, matching their chips', () => {
    renderControl('auto');
    for (const mode of ['notebook', 'message']) {
      const unselected = radioRoot(mode);
      expect(unselected).toHaveClass('MuiRadio-variantOutlined');
      expect(unselected).toHaveClass('MuiRadio-colorNeutral');
    }
  });

  it('moves the solid treatment with the selection', () => {
    renderControl('message');
    expect(radioRoot('message')).toHaveClass('MuiRadio-variantSolid');
    expect(radioRoot('auto')).toHaveClass('MuiRadio-variantOutlined');
  });

  it('reports a change when an option is chosen', () => {
    // By role, not by test id: the id lands on the Radio ROOT, and clicking a div toggles nothing.
    // The role query also asserts the label is the radio's accessible name, which is what a
    // screen-reader user hears and what makes the pill a real radio rather than a styled div.
    const { onAttachScopeModeChange } = renderControl('auto');
    fireEvent.click(screen.getByRole('radio', { name: 'Whole notebook' }));
    expect(onAttachScopeModeChange).toHaveBeenCalledWith('notebook');
  });

  it('describes the selected mode beneath the control', () => {
    renderControl('message');
    expect(screen.getByText('Nothing is kept - files attach to one message only.')).toBeInTheDocument();
  });
});
