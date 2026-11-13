import type { ReactNode } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { describe, expect, it, vi } from 'vitest';
import { getThemeConfig } from '@client/app/utils/themes';
import StudioChip from './StudioChip';
import StudioCostPill from './StudioCostPill';
import { StudioPanel, StudioSectionLabel } from './StudioPanel';
import StudioPrimaryAction from './StudioPrimaryAction';
import StudioSegmentedControl from './StudioSegmentedControl';
import { StudioTakeAction, StudioTakeTile } from './StudioTakeTile';
import StudioThemeScope from './StudioThemeScope';
import { STUDIO_PALETTES, studioColor, studioCssVariables } from './studioTokens';

const appTheme = extendTheme({ ...getThemeConfig() });

const renderInStudio = (ui: ReactNode, mode: 'light' | 'dark' = 'dark') =>
  render(
    <CssVarsProvider theme={appTheme} defaultMode={mode} modeStorageKey={`studio-test-${mode}`}>
      <StudioThemeScope>{ui}</StudioThemeScope>
    </CssVarsProvider>
  );

describe('studio tokens', () => {
  it('gives both modes the same roles, so a primitive never reads an undefined variable', () => {
    expect(Object.keys(STUDIO_PALETTES.light).sort()).toEqual(Object.keys(STUDIO_PALETTES.dark).sort());
  });

  it('declares every color, radius and font as a --studio- variable', () => {
    const variables = studioCssVariables('dark');
    expect(variables['--studio-canvas']).toBe('#0E1013');
    expect(variables['--studio-accent']).toBe('#0B6BCB');
    expect(variables['--studio-radius-xl']).toBe('14px');
    expect(variables['--studio-font-mono']).toContain('--font-reading-mono');
    expect(Object.keys(variables).every(name => name.startsWith('--studio-'))).toBe(true);
    expect(studioColor('canvas')).toBe('var(--studio-canvas)');
  });
});

describe('StudioThemeScope', () => {
  it.each(['dark', 'light'] as const)('follows the app color mode (%s)', mode => {
    renderInStudio(<span />, mode);
    expect(screen.getByTestId('studio-theme-scope')).toHaveAttribute('data-studio-mode', mode);
  });
});

describe('StudioPanel and StudioSectionLabel', () => {
  it('renders a named region with its tone', () => {
    renderInStudio(
      <StudioPanel aria-label="Describe" tone="sunken" testId="describe-panel">
        <StudioSectionLabel>Describe the image</StudioSectionLabel>
      </StudioPanel>
    );
    expect(screen.getByRole('region', { name: 'Describe' })).toHaveAttribute('data-tone', 'sunken');
    expect(screen.getByTestId('studio-section-label')).toHaveTextContent('Describe the image');
  });

  it('labels a control when given htmlFor', () => {
    renderInStudio(
      <>
        <StudioSectionLabel htmlFor="prompt">Prompt</StudioSectionLabel>
        <textarea id="prompt" />
      </>
    );
    expect(screen.getByLabelText('Prompt').tagName).toBe('TEXTAREA');
  });
});

describe('StudioChip', () => {
  it('exposes selection as aria-pressed and reports clicks', () => {
    const onClick = vi.fn();
    renderInStudio(
      <StudioChip selected onClick={onClick} testId="look-photoreal">
        Photoreal
      </StudioChip>
    );
    const chip = screen.getByTestId('look-photoreal');
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('shows a swatch only when given one', () => {
    const { rerender } = renderInStudio(<StudioChip testId="scene">Dusk</StudioChip>);
    expect(screen.queryByTestId('scene-swatch')).not.toBeInTheDocument();
    rerender(
      <CssVarsProvider theme={appTheme}>
        <StudioThemeScope>
          <StudioChip testId="scene" swatch="#F5B83D">
            Dusk
          </StudioChip>
        </StudioThemeScope>
      </CssVarsProvider>
    );
    expect(screen.getByTestId('scene-swatch')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('StudioSegmentedControl', () => {
  const options = [
    { value: 'square', label: '1:1' },
    { value: 'portrait', label: '4:5' },
    { value: 'wide', label: '16:9' },
  ] as const;

  it('is a radio group by default, with one checked and focusable option', () => {
    renderInStudio(<StudioSegmentedControl aria-label="Shape" options={options} value="portrait" onChange={vi.fn()} />);
    expect(screen.getByRole('radiogroup', { name: 'Shape' })).toBeInTheDocument();
    const portrait = screen.getByTestId('studio-segmented-control-portrait');
    expect(portrait).toHaveAttribute('aria-checked', 'true');
    expect(portrait).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('studio-segmented-control-square')).toHaveAttribute('tabindex', '-1');
  });

  it('uses tab semantics when asked', () => {
    renderInStudio(
      <StudioSegmentedControl aria-label="Areas" semantics="tabs" options={options} value="wide" onChange={vi.fn()} />
    );
    expect(screen.getByRole('tablist', { name: 'Areas' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '16:9' })).toHaveAttribute('aria-selected', 'true');
  });

  it('changes on click, but not when the picked option is clicked again', () => {
    const onChange = vi.fn();
    renderInStudio(<StudioSegmentedControl aria-label="Shape" options={options} value="square" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('studio-segmented-control-square'));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('studio-segmented-control-wide'));
    expect(onChange).toHaveBeenCalledWith('wide');
  });

  it('moves with the arrow keys and wraps at the ends', () => {
    const onChange = vi.fn();
    renderInStudio(<StudioSegmentedControl aria-label="Shape" options={options} value="square" onChange={onChange} />);
    const group = screen.getByRole('radiogroup');
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('portrait');
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('wide');
    fireEvent.keyDown(group, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('as tabs, moves focus with the arrows and Home/End without activating', () => {
    const onChange = vi.fn();
    renderInStudio(
      <StudioSegmentedControl
        aria-label="Areas"
        semantics="tabs"
        options={options}
        value="square"
        onChange={onChange}
      />
    );
    const tablist = screen.getByRole('tablist');
    screen.getByTestId('studio-segmented-control-square').focus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByTestId('studio-segmented-control-portrait')).toHaveFocus();
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(screen.getByTestId('studio-segmented-control-wide')).toHaveFocus();
    fireEvent.keyDown(tablist, { key: 'Home' });
    expect(screen.getByTestId('studio-segmented-control-square')).toHaveFocus();
    fireEvent.keyDown(tablist, { key: 'End' });
    expect(screen.getByTestId('studio-segmented-control-wide')).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('studio-segmented-control-wide'));
    expect(onChange).toHaveBeenCalledWith('wide');
  });
});

describe('StudioPrimaryAction', () => {
  it('carries its cost in mono, rounded up so a price is never understated', () => {
    renderInStudio(<StudioPrimaryAction cost={47.2}>Make 4</StudioPrimaryAction>);
    expect(screen.getByTestId('studio-primary-action')).toHaveTextContent('Make 4');
    expect(screen.getByTestId('studio-primary-action-cost')).toHaveTextContent('48 cr');
  });

  it('omits the cost when none is given', () => {
    renderInStudio(<StudioPrimaryAction>Save</StudioPrimaryAction>);
    expect(screen.queryByTestId('studio-primary-action-cost')).not.toBeInTheDocument();
  });

  it('is busy and inert while loading', () => {
    const onClick = vi.fn();
    renderInStudio(
      <StudioPrimaryAction loading onClick={onClick}>
        Make 4
      </StudioPrimaryAction>
    );
    const action = screen.getByTestId('studio-primary-action');
    expect(action).toBeDisabled();
    expect(action).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(action);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('StudioCostPill', () => {
  it('groups digits and floors a balance', () => {
    renderInStudio(<StudioCostPill amount={2310.9} unit="credits" />);
    expect(screen.getByTestId('studio-cost-pill')).toHaveTextContent('2,310 credits');
  });

  it('never shows a negative figure and singularises one credit', () => {
    const { unmount } = renderInStudio(<StudioCostPill amount={-5} />);
    expect(screen.getByTestId('studio-cost-pill')).toHaveTextContent('0 cr');
    unmount();
    renderInStudio(<StudioCostPill amount={1} unit="credits" />);
    expect(screen.getByTestId('studio-cost-pill')).toHaveTextContent('1 credit');
  });

  it('marks a low balance', () => {
    renderInStudio(<StudioCostPill amount={12} tone="low" variant="pill" />);
    const pill = screen.getByTestId('studio-cost-pill');
    expect(pill).toHaveAttribute('data-tone', 'low');
    expect(pill).toHaveAttribute('data-variant', 'pill');
  });

  it('turns to the danger tone when nothing is left', () => {
    renderInStudio(<StudioCostPill amount={0} unit="credits" tone="empty" variant="pill" />);
    expect(screen.getByTestId('studio-cost-pill')).toHaveAttribute('data-tone', 'empty');
  });
});

describe('StudioTakeTile', () => {
  it('shows the media, title and mono meta, with actions in a labelled group', () => {
    const onStar = vi.fn();
    renderInStudio(
      <StudioTakeTile
        media={<img src="take.png" alt="Take 3" />}
        title="Take 3"
        meta="seed 1186"
        aspectRatio="4 / 5"
        selected
        actions={<StudioTakeAction label="Star" icon={<span />} pressed pushEnd onClick={onStar} testId="take-star" />}
      />
    );
    expect(screen.getByTestId('studio-take-tile')).toHaveAttribute('data-selected', 'true');
    expect(screen.getByTestId('studio-take-tile-media')).toHaveStyle({ aspectRatio: '4 / 5' });
    expect(screen.getByAltText('Take 3')).toBeInTheDocument();
    expect(screen.getByTestId('studio-take-tile-meta')).toHaveTextContent('seed 1186');
    expect(screen.getByRole('group', { name: 'Take actions' })).toBeInTheDocument();
    const star = screen.getByRole('button', { name: 'Star' });
    expect(star).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(star);
    expect(onStar).toHaveBeenCalledTimes(1);
  });

  it('has no action group when there are no actions', () => {
    renderInStudio(<StudioTakeTile media={<span>Developing</span>} title="Take 4" />);
    expect(screen.queryByRole('group')).not.toBeInTheDocument();
    expect(screen.queryByTestId('studio-take-tile-meta')).not.toBeInTheDocument();
  });
});
