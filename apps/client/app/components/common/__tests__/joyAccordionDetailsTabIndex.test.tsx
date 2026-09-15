import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { Accordion, AccordionDetails, AccordionGroup, AccordionSummary, Button, ListItemButton } from '@mui/joy';
import { getThemeConfig } from '@client/app/utils/themes/themePrimitives';

// Guards patches/@mui__joy@5.0.0-beta.52.patch, which fixes two defects in Joy's
// AccordionDetails focus-management effect. On collapse Joy stashes each focusable
// descendant's tabindex in data-prev-tabindex and sets tabindex="-1"; on expand it is
// supposed to put them back.
//
//   1. Its restore branches required the stashed and current values to be BOTH truthy
//      or BOTH falsy, so a native <button> with no tabindex of its own (stashed as "")
//      paired with "-1" matched neither branch and kept the -1 forever.
//   2. The expand pass reused the collapse pass's focusable-element selector, which
//      cannot match what that pass untabbed: an element that is not natively focusable
//      matches none of the tag names, and its fresh tabindex="-1" is excluded by the
//      selector's own :not([tabindex="-1"]) clause. Joy's own ListItemButton renders a
//      div, so those were never even visited on expand.
//
// These assert against the real Joy component rather than a re-implementation, so they
// fail on an unpatched install. If this suite breaks after a dependency change, check
// that the patch still applies before touching the assertions.

const appTheme = extendTheme({ ...getThemeConfig() });

const Harness = () => (
  <CssVarsProvider theme={appTheme}>
    <AccordionGroup>
      <Accordion defaultExpanded>
        <AccordionSummary slotProps={{ button: { 'data-testid': 'section-toggle' } }}>Section</AccordionSummary>
        <AccordionDetails>
          {/* No tabindex of its own - the shape every nav item in the admin sidebar has. */}
          <Button data-testid="plain-item">Plain</Button>
          {/* An author-set tabindex must survive the collapse/expand round trip. */}
          <Button data-testid="explicit-item" tabIndex={5}>
            Explicit
          </Button>
          {/* Renders a div, so it is only reachable via its own tabindex - the case Joy's
              expand-pass selector could not match. */}
          <ListItemButton data-testid="list-item">List item</ListItemButton>
        </AccordionDetails>
      </Accordion>
    </AccordionGroup>
  </CssVarsProvider>
);

const plainItem = () => screen.getByTestId('plain-item');
const explicitItem = () => screen.getByTestId('explicit-item');
const listItem = () => screen.getByTestId('list-item');
const toggle = () => screen.getByTestId('section-toggle');

describe('Joy AccordionDetails tabindex restoration', () => {
  it('leaves an expanded panel tabbable on mount', () => {
    render(<Harness />);

    expect(plainItem().getAttribute('tabindex')).toBeNull();
    expect(plainItem().tabIndex).toBe(0);
  });

  it('untabs descendants while collapsed and restores them on expand', () => {
    render(<Harness />);

    fireEvent.click(toggle());
    expect(plainItem().getAttribute('tabindex')).toBe('-1');
    expect(plainItem().tabIndex).toBe(-1);

    fireEvent.click(toggle());
    // The reported bug: unpatched Joy leaves tabindex="-1" here, so the item is visible
    // and mouse-clickable but permanently skipped by Tab.
    expect(plainItem().getAttribute('tabindex')).toBeNull();
    expect(plainItem().tabIndex).toBe(0);
  });

  it('restores a focusable that is not a natively focusable element', () => {
    render(<Harness />);

    // Guards the selector half of the fix. ListItemButton is a div carrying its own
    // tabindex, which is what the original expand pass could not select.
    expect(listItem().tagName).toBe('DIV');
    expect(listItem().getAttribute('tabindex')).toBe('0');

    fireEvent.click(toggle());
    expect(listItem().getAttribute('tabindex')).toBe('-1');

    fireEvent.click(toggle());
    expect(listItem().getAttribute('tabindex')).toBe('0');
  });

  it('stays tabbable across repeated collapse/expand cycles', () => {
    render(<Harness />);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      fireEvent.click(toggle());
      expect(plainItem().tabIndex, `collapse cycle ${cycle}`).toBe(-1);
      expect(listItem().tabIndex, `collapse cycle ${cycle}`).toBe(-1);

      fireEvent.click(toggle());
      expect(plainItem().getAttribute('tabindex'), `expand cycle ${cycle}`).toBeNull();
      expect(plainItem().tabIndex, `expand cycle ${cycle}`).toBe(0);
      expect(listItem().getAttribute('tabindex'), `expand cycle ${cycle}`).toBe('0');
    }
  });

  it('preserves an author-set tabindex through a collapse/expand cycle', () => {
    render(<Harness />);

    expect(explicitItem().getAttribute('tabindex')).toBe('5');

    fireEvent.click(toggle());
    expect(explicitItem().getAttribute('tabindex')).toBe('-1');

    fireEvent.click(toggle());
    expect(explicitItem().getAttribute('tabindex')).toBe('5');
  });

  it('leaves no bookkeeping attribute behind once expanded', () => {
    const { container } = render(<Harness />);

    fireEvent.click(toggle());
    fireEvent.click(toggle());

    // A leftover marker is what let a second collapse overwrite the stashed value with
    // "-1", making the lost tab stop unrecoverable even by a later correct restore.
    expect(container.querySelectorAll('[data-prev-tabindex]')).toHaveLength(0);
  });
});
