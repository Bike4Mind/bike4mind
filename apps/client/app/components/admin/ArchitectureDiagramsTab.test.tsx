import React from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import ArchitectureDiagramsTab from './ArchitectureDiagramsTab';

const appTheme = extendTheme({ ...getThemeConfig() });
const renderTab = (mode: 'light' | 'dark' = 'light') =>
  render(
    <CssVarsProvider theme={appTheme} defaultMode={mode} modeStorageKey={`arch-diagrams-test-${mode}`}>
      <ArchitectureDiagramsTab />
    </CssVarsProvider>
  );

const DIAGRAMS = ['prompt', 'infra', 'rag', 'security'] as const;
// The light canvas, the white panels and a few of the pale fills that glare on a dark page.
const LIGHT_FILLS = ['#F8FAFC', '#FFFFFF', '#FEF2F2', '#E0F2FE', '#FEF3C7', '#EDE9FE'];

/** Joy mounts only the active panel, so each diagram is opened before it is read. */
const openFrame = (id: (typeof DIAGRAMS)[number]) => {
  fireEvent.click(screen.getByTestId(`arch-diagram-${id}-tab`));
  return screen.getByTestId(`arch-diagram-${id}-frame`);
};
const background = (frame: HTMLElement) => frame.querySelector('svg > rect');
const rectFills = (frame: HTMLElement) =>
  Array.from(frame.querySelectorAll('rect')).map(rect => rect.getAttribute('fill'));

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

  it('switches to the dark palette under a dark theme, with no pale fills left', () => {
    renderTab('dark');
    for (const id of DIAGRAMS) {
      const frame = openFrame(id);
      expect(background(frame)).toHaveAttribute('fill', '#1A1A1E');
      const fills = rectFills(frame);
      for (const light of LIGHT_FILLS) {
        expect(fills).not.toContain(light);
      }
    }
  });
});
