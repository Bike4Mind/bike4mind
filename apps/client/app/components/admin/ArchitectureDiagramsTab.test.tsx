import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ArchitectureDiagramsTab from './ArchitectureDiagramsTab';
import { DARK_PALETTE, LIGHT_PALETTE } from './content/architectureDiagramPalettes';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = (mode: 'light' | 'dark' = 'light') =>
  render(
    <CssVarsProvider theme={appTheme} defaultMode={mode} modeStorageKey={`arch-diagrams-test-${mode}`}>
      <ArchitectureDiagramsTab />
    </CssVarsProvider>
  );

const DIAGRAMS = ['prompt', 'infra', 'rag', 'security'] as const;
const hexValues = (value: unknown): string[] =>
  typeof value === 'string' ? [value.toUpperCase()] : Object.values(value as object).flatMap(hexValues);
// Every light-only color; white stays in both (text on the filled pill), so it is not one of them.
const DARK_HEX = new Set(hexValues(DARK_PALETTE));
const LIGHT_ONLY_HEX = new Set(hexValues(LIGHT_PALETTE).filter(hex => !DARK_HEX.has(hex)));

/** Joy mounts only the active panel, so each diagram is opened before it is read. */
const openFrame = (id: (typeof DIAGRAMS)[number]) => {
  fireEvent.click(screen.getByTestId(`arch-diagram-${id}-tab`));
  return screen.getByTestId(`arch-diagram-${id}-frame`);
};
const background = (frame: HTMLElement) => frame.querySelector('svg > rect');
const rectFills = (frame: HTMLElement) =>
  Array.from(frame.querySelectorAll('rect')).map(rect => rect.getAttribute('fill'));
const paintedColors = (frame: HTMLElement) =>
  Array.from(frame.querySelectorAll('svg *')).flatMap(node =>
    ['fill', 'stroke'].map(attr => node.getAttribute(attr)?.toUpperCase()).filter(color => color?.startsWith('#'))
  );

describe('ArchitectureDiagramsTab', () => {
  it('opens with the page header', () => {
    renderTab();
    const header = screen.getByTestId('admin-page-header');
    expect(screen.getByTestId('admin-architecture-tab').firstElementChild).toBe(header);
    expect(within(header).getByRole('heading', { level: 1 })).toHaveTextContent(/^Architecture$/);
  });

  it('labels the diagram tabs in sentence case and switches between them', () => {
    renderTab();
    expect(screen.getByTestId('arch-diagram-rag-tab')).toHaveTextContent(/^RAG pipeline$/);
    expect(screen.getByTestId('arch-diagram-prompt-tab')).toHaveTextContent(/^User prompt journey$/);
    fireEvent.click(screen.getByTestId('arch-diagram-security-tab'));
    expect(screen.getByTestId('arch-diagram-security-tab')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('arch-diagram-security-frame')).toBeVisible();
    expect(screen.getByTestId('arch-diagram-security-frame')).toHaveTextContent('Security Architecture');
  });

  it('draws no emoji in any diagram', () => {
    renderTab();
    for (const id of DIAGRAMS) {
      expect(openFrame(id).textContent).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('sits each diagram in a bordered frame and keeps the light palette in light mode', () => {
    renderTab('light');
    for (const id of DIAGRAMS) {
      const frame = openFrame(id);
      expect(frame).toHaveClass('MuiSheet-variantOutlined');
      expect(background(frame)).toHaveAttribute('fill', '#F8FAFC');
    }
    expect(rectFills(openFrame('prompt'))).toContain('#FFFFFF');
    expect(rectFills(openFrame('security'))).toContain('#FEF2F2');
  });

  it('switches to the dark palette under a dark theme, with no light-only color left', () => {
    renderTab('dark');
    expect(LIGHT_ONLY_HEX.size).toBeGreaterThan(30);
    for (const id of DIAGRAMS) {
      const frame = openFrame(id);
      expect(background(frame)).toHaveAttribute('fill', '#1A1A1E');
      const painted = paintedColors(frame);
      expect(painted.length).toBeGreaterThan(10);
      expect(painted.filter(color => LIGHT_ONLY_HEX.has(color!))).toEqual([]);
      expect(painted.filter(color => !DARK_HEX.has(color!))).toEqual([]);
    }
  });

  it('names each diagram frame as a figure and caps its width', () => {
    renderTab();
    for (const id of DIAGRAMS) {
      const frame = openFrame(id);
      const label = screen.getByTestId(`arch-diagram-${id}-tab`).textContent;
      expect(screen.getByRole('figure', { name: `${label} diagram` })).toBe(frame);
      expect(frame).toHaveStyle({ maxWidth: '1280px' });
    }
  });

  it('prints the ampersand in the audit layer label, not its entity', () => {
    renderTab();
    const frame = openFrame('security');
    expect(frame).toHaveTextContent('Audit & Monitoring');
    expect(frame.textContent).not.toContain('&amp;');
  });
});
