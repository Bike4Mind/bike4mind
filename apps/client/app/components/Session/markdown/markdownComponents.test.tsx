import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { getThemeConfig } from '@client/app/utils/themes';
import { createMarkdownComponents, NUM_CELL_CLASS, NUMTEXT_CELL_CLASS } from './markdownComponents';

const appTheme = extendTheme({ ...getThemeConfig() });

const components = createMarkdownComponents({ highlightText: node => node });

const Body = ({ markdown }: { markdown: string }) => (
  <CssVarsProvider theme={appTheme}>
    <div data-testid="md-root">
      <ReactMarkdown components={components} remarkPlugins={[remarkGfm]}>
        {markdown}
      </ReactMarkdown>
    </div>
  </CssVarsProvider>
);

const root = () => screen.getByTestId('md-root');

/** Body-row cells of the first rendered table, row-major. */
const bodyCells = () => Array.from(root().querySelectorAll('tbody td'));

/** Body cells of one zero-based column of the first rendered table. */
const column = (index: number) => {
  const rows = Array.from(root().querySelectorAll('tbody tr'));
  return rows.map(row => row.querySelectorAll('td')[index]);
};

describe('numeric-column detection', () => {
  it('marks a column whose every body cell is one number, over enough rows', () => {
    render(
      <Body
        markdown={['| Option | Hours |', '| --- | --- |', '| Alpha | 91 |', '| Bravo | 118 |', '| Charlie | 46 |'].join(
          '\n'
        )}
      />
    );

    const hours = column(1);
    expect(hours.map(cell => cell.className)).toEqual([NUM_CELL_CLASS, NUM_CELL_CLASS, NUM_CELL_CLASS]);
    // The label column stays prose.
    expect(column(0).every(cell => cell.className === '')).toBe(true);
  });

  it('scales the magnitude bar against the column maximum', () => {
    render(
      <Body
        markdown={['| Option | Hours |', '| --- | --- |', '| Alpha | 50 |', '| Bravo | 100 |', '| Charlie | 25 |'].join(
          '\n'
        )}
      />
    );

    expect(column(1).map(cell => cell.style.getPropertyValue('--b4m-md-bar'))).toEqual(['0.5000', '1.0000', '0.2500']);
  });

  it('reads thousands separators and decimals as one number', () => {
    render(
      <Body
        markdown={['| Rack | Draw |', '| --- | --- |', '| A | 1,200 |', '| B | 18.5 |', '| C | 940 |'].join('\n')}
      />
    );

    expect(column(1).every(cell => cell.className === NUM_CELL_CLASS)).toBe(true);
  });

  it('marks the header cell of a numeric column so it aligns with its body', () => {
    render(
      <Body markdown={['| Option | Hours |', '| --- | --- |', '| A | 91 |', '| B | 118 |', '| C | 46 |'].join('\n')} />
    );

    const headers = Array.from(root().querySelectorAll('thead th'));
    expect(headers[1].className).toBe(NUM_CELL_CLASS);
    expect(headers[0].className).toBe('');
  });

  it('leaves a two-row table alone: two values are not a comparison', () => {
    render(<Body markdown={['| Option | Hours |', '| --- | --- |', '| Alpha | 91 |', '| Bravo | 118 |'].join('\n')} />);

    expect(bodyCells().every(cell => cell.className === '')).toBe(true);
    expect(bodyCells().every(cell => !cell.style.getPropertyValue('--b4m-md-bar'))).toBe(true);
  });

  it('leaves a column alone when any cell holds more than one number', () => {
    render(
      <Body
        markdown={[
          '| Option | Range |',
          '| --- | --- |',
          '| Alpha | 91 |',
          '| Bravo | 100 to 118 |',
          '| Charlie | 46 |',
        ].join('\n')}
      />
    );

    expect(column(1).every(cell => cell.className === '')).toBe(true);
  });

  it('treats a numeric column with an over-long cell as prose, and draws no bar', () => {
    render(
      <Body
        markdown={[
          '| Option | Note |',
          '| --- | --- |',
          '| Alpha | 91 |',
          '| Bravo | 118 hours of sustained draw before the rig throttles |',
          '| Charlie | 46 |',
        ].join('\n')}
      />
    );

    const notes = column(1);
    expect(notes.every(cell => cell.className === NUMTEXT_CELL_CLASS)).toBe(true);
    expect(notes.every(cell => !cell.style.getPropertyValue('--b4m-md-bar'))).toBe(true);
  });

  it('marks a body row whose first cell is wholly bold as the total row', () => {
    render(
      <Body
        markdown={[
          '| Option | Hours |',
          '| --- | --- |',
          '| Alpha | 91 |',
          '| Bravo | 118 |',
          '| **Total** | 209 |',
        ].join('\n')}
      />
    );

    const rows = Array.from(root().querySelectorAll('tbody tr'));
    expect(rows.map(row => row.hasAttribute('data-b4m-md-total'))).toEqual([false, false, true]);
  });
});

describe('semantic tags', () => {
  it('renders h1 through h6 as their own heading tags', () => {
    render(<Body markdown={['# One', '## Two', '### Three', '#### Four', '##### Five', '###### Six'].join('\n\n')} />);

    ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag, index) => {
      const heading = screen.getByRole('heading', { level: index + 1 });
      expect(heading.tagName.toLowerCase()).toBe(tag);
    });
  });

  it('renders lists, list items, blockquote and rule as bare semantic tags', () => {
    render(<Body markdown={['- one', '- two', '', '1. first', '2. second', '', '> quoted', '', '---'].join('\n')} />);

    expect(root().querySelector('ul')).not.toBeNull();
    expect(root().querySelector('ol')).not.toBeNull();
    expect(root().querySelectorAll('li')).toHaveLength(4);
    expect(root().querySelector('blockquote')).not.toBeNull();
    expect(root().querySelector('hr')).not.toBeNull();
  });

  it('renders strikethrough and task-list checkboxes as bare tags', () => {
    render(<Body markdown={['~~gone~~', '', '- [x] done', '- [ ] pending'].join('\n')} />);

    expect(root().querySelector('del')).not.toBeNull();
    expect(root().querySelectorAll('input[type="checkbox"]')).toHaveLength(2);
  });

  it('renders a paragraph as a <p> carrying the reply test id', () => {
    render(<Body markdown="A plain sentence." />);

    const paragraph = screen.getByTestId('ai-response');
    expect(paragraph.tagName.toLowerCase()).toBe('p');
    expect(paragraph).toHaveTextContent('A plain sentence.');
  });

  it('wraps a table in its own overflow container', () => {
    render(<Body markdown={['| A | B |', '| --- | --- |', '| 1 | 2 |'].join('\n')} />);

    const table = root().querySelector('table');
    expect(table?.parentElement?.className).toBe('b4m-md-table-wrap');
  });
});
