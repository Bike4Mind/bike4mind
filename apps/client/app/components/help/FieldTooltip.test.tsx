import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider } from '@mui/joy/styles';
import FieldTooltip from './FieldTooltip';

const TestWrapper = ({ children }: { children: React.ReactNode }) => <CssVarsProvider>{children}</CssVarsProvider>;

describe('FieldTooltip', () => {
  it('renders a help trigger with a default aria-label', () => {
    render(
      <TestWrapper>
        <FieldTooltip content="Some help text" />
      </TestWrapper>
    );

    const trigger = screen.getByTestId('field-tooltip-trigger');
    expect(trigger).toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', 'Help');
  });

  it('derives an aria-label from a string label', () => {
    render(
      <TestWrapper>
        <FieldTooltip label="Temperature" content="Controls randomness" />
      </TestWrapper>
    );

    expect(screen.getByText('Temperature')).toBeInTheDocument();
    expect(screen.getByTestId('field-tooltip-trigger')).toHaveAttribute('aria-label', 'Help: Temperature');
  });

  it('honors an explicit ariaLabel override', () => {
    render(
      <TestWrapper>
        <FieldTooltip ariaLabel="Help: Credits" content="Credits help" />
      </TestWrapper>
    );

    expect(screen.getByTestId('field-tooltip-trigger')).toHaveAttribute('aria-label', 'Help: Credits');
  });

  it('exposes the trigger as focusable to keyboard users', () => {
    render(
      <TestWrapper>
        <FieldTooltip content="Some help text" />
      </TestWrapper>
    );

    const trigger = screen.getByTestId('field-tooltip-trigger');
    expect(trigger).not.toHaveAttribute('role');
    expect(trigger).toHaveAttribute('tabindex', '0');

    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows the tooltip content on mouse hover', async () => {
    render(
      <TestWrapper>
        <FieldTooltip content="Higher values are more creative" />
      </TestWrapper>
    );

    const trigger = screen.getByTestId('field-tooltip-trigger');
    fireEvent.mouseOver(trigger);

    expect(await screen.findByText('Higher values are more creative')).toBeInTheDocument();
  });

  it('shows the tooltip content on keyboard focus', async () => {
    render(
      <TestWrapper>
        <FieldTooltip content="Revealed on focus" />
      </TestWrapper>
    );

    const trigger = screen.getByTestId('field-tooltip-trigger');
    // Mark the next focus as keyboard-driven so MUI's useIsFocusVisible reports
    // focus-visible (JSDOM doesn't natively support :focus-visible).
    fireEvent.keyDown(document.body, { key: 'Tab' });
    trigger.focus();
    fireEvent.focus(trigger);

    expect(await screen.findByText('Revealed on focus')).toBeInTheDocument();
  });

  it('falls back to a generic aria-label when label is a ReactNode', () => {
    render(
      <TestWrapper>
        <FieldTooltip label={<span>Custom</span>} content="Help body" />
      </TestWrapper>
    );

    expect(screen.getByTestId('field-tooltip-trigger')).toHaveAttribute('aria-label', 'Help');
  });

  it('applies a custom data-testid when provided', () => {
    render(
      <TestWrapper>
        <FieldTooltip content="Help" data-testid="field-tooltip-credits" />
      </TestWrapper>
    );

    expect(screen.getByTestId('field-tooltip-credits')).toBeInTheDocument();
  });
});
