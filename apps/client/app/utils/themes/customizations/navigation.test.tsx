import { render, screen } from '@testing-library/react';
import { Accordion, AccordionDetails, AccordionGroup, AccordionSummary, Button } from '@mui/joy';
import AppTheme from '../AppTheme';

const renderAccordion = (expanded: boolean) =>
  render(
    <AppTheme>
      <AccordionGroup>
        <Accordion expanded={expanded}>
          <AccordionSummary>Section</AccordionSummary>
          <AccordionDetails data-testid="accordion-panel">
            <Button data-testid="accordion-nav-btn">Nav item</Button>
          </AccordionDetails>
        </Accordion>
      </AccordionGroup>
    </AppTheme>
  );

describe('JoyAccordionDetails theme override', () => {
  // Joy marks a collapsed panel with the native `hidden` attribute but then sets
  // `display: grid` on the same element, which beats the user-agent `[hidden]` rule. The
  // attribute alone is therefore inert: the panel is clipped to a zero-height grid row
  // while its children keep full-size, hit-testable boxes that swallow clicks aimed at
  // whatever sits below them. Asserting on the computed visibility, not the attribute, is
  // what pins the override down.
  it('takes a collapsed panel out of hit-testing, not just out of view', () => {
    renderAccordion(false);

    const panel = screen.getByTestId('accordion-panel');
    expect(panel).toHaveAttribute('hidden');
    expect(getComputedStyle(panel).visibility).toBe('hidden');
  });

  it('leaves an expanded panel interactive', () => {
    renderAccordion(true);

    const panel = screen.getByTestId('accordion-panel');
    expect(panel).not.toHaveAttribute('hidden');
    expect(getComputedStyle(panel).visibility).not.toBe('hidden');
    expect(screen.getByTestId('accordion-nav-btn')).toBeVisible();
  });
});
