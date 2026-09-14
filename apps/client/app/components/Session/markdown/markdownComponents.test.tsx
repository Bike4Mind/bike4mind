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

describe('signed numeric columns', () => {
  it('keeps numeric alignment but draws no bar when a column holds negatives', () => {
    render(
      <Body
        markdown={['| Rack | Delta |', '| --- | --- |', '| A | -100 |', '| B | -200 |', '| C | -300 |'].join('\n')}
      />
    );

    const delta = column(1);
    expect(delta.every(cell => cell.className === NUM_CELL_CLASS)).toBe(true);
    // Sign-blind scaling drew the longest bar for the most negative value.
    expect(delta.every(cell => !cell.style.getPropertyValue('--b4m-md-bar'))).toBe(true);
  });

  it('draws no bar for a mixed-sign column, where a large negative would outrank a positive', () => {
    render(
      <Body markdown={['| Rack | Delta |', '| --- | --- |', '| A | -300 |', '| B | 100 |', '| C | 200 |'].join('\n')} />
    );

    const delta = column(1);
    expect(delta.every(cell => cell.className === NUM_CELL_CLASS)).toBe(true);
    expect(delta.every(cell => !cell.style.getPropertyValue('--b4m-md-bar'))).toBe(true);
  });

  it('reads accounting parentheses as a negative', () => {
    render(
      <Body markdown={['| Rack | Draw |', '| --- | --- |', '| A | (120) |', '| B | 340 |', '| C | 260 |'].join('\n')} />
    );

    expect(column(1).every(cell => !cell.style.getPropertyValue('--b4m-md-bar'))).toBe(true);
  });

  it('draws no bar for an all-zero column rather than dividing by its maximum', () => {
    render(<Body markdown={['| Rack | Draw |', '| --- | --- |', '| A | 0 |', '| B | 0 |', '| C | 0 |'].join('\n')} />);

    const draw = column(1);
    expect(draw.every(cell => cell.className === NUM_CELL_CLASS)).toBe(true);
    expect(draw.every(cell => !cell.style.getPropertyValue('--b4m-md-bar'))).toBe(true);
  });

  it('still scales a wholly positive column', () => {
    render(
      <Body markdown={['| Rack | Draw |', '| --- | --- |', '| A | 25 |', '| B | 100 |', '| C | 50 |'].join('\n')} />
    );

    expect(column(1).map(cell => cell.style.getPropertyValue('--b4m-md-bar'))).toEqual(['0.2500', '1.0000', '0.5000']);
  });
});

describe('GFM column alignment', () => {
  it('preserves the alignment react-markdown puts on a cell alongside the bar', () => {
    render(
      <Body
        markdown={[
          '| Option | Hours |',
          '| :--- | ---: |',
          '| Alpha | 50 |',
          '| Bravo | 100 |',
          '| Charlie | 25 |',
        ].join('\n')}
      />
    );

    const hours = column(1);
    expect(hours.every(cell => cell.style.textAlign === 'right')).toBe(true);
    // The bar still reaches CSS on the same style object.
    expect(hours[1].style.getPropertyValue('--b4m-md-bar')).toBe('1.0000');
    expect(column(0).every(cell => cell.style.textAlign === 'left')).toBe(true);
  });

  it('preserves alignment on a cell that carries no bar', () => {
    render(<Body markdown={['| Option | Note |', '| :--- | ---: |', '| Alpha | many |'].join('\n')} />);

    expect(column(1)[0].style.textAlign).toBe('right');
  });

  it('preserves alignment on header cells', () => {
    render(
      <Body
        markdown={['| Option | Hours |', '| :--- | ---: |', '| A | 91 |', '| B | 118 |', '| C | 46 |'].join('\n')}
      />
    );

    const headers = Array.from(root().querySelectorAll('thead th')) as HTMLElement[];
    expect(headers[1].style.textAlign).toBe('right');
    // ...without losing the numeric class the analysis put there.
    expect(headers[1].className).toBe(NUM_CELL_CLASS);
  });
});

describe('column classification boundaries', () => {
  it('compares at exactly MIN_COMPARABLE_ROWS rows', () => {
    render(<Body markdown={['| A | B |', '| --- | --- |', '| x | 1 |', '| y | 2 |', '| z | 4 |'].join('\n')} />);

    expect(column(1).every(cell => cell.className === NUM_CELL_CLASS)).toBe(true);
  });

  it('stays numeric at exactly PROSE_CELL_LENGTH characters', () => {
    render(
      <Body
        markdown={[
          '| Rack | Draw |',
          '| --- | --- |',
          '| A | 1,234,567,890,123,456.50 |',
          '| B | 340 |',
          '| C | 260 |',
        ].join('\n')}
      />
    );

    expect(column(1).every(cell => cell.className === NUM_CELL_CLASS)).toBe(true);
  });

  it('demotes to prose one character past PROSE_CELL_LENGTH', () => {
    render(
      <Body
        markdown={[
          '| Rack | Draw |',
          '| --- | --- |',
          '| A | 12,345,678,901,234,567.50 |',
          '| B | 340 |',
          '| C | 260 |',
        ].join('\n')}
      />
    );

    expect(column(1).every(cell => cell.className === NUMTEXT_CELL_CLASS)).toBe(true);
  });
});

describe('search highlighting', () => {
  const marking = createMarkdownComponents({
    highlightText: node => (typeof node === 'string' && node.includes('rig') ? <mark>{node}</mark> : node),
  });

  const Marked = ({ markdown }: { markdown: string }) => (
    <CssVarsProvider theme={appTheme}>
      <div data-testid="md-root">
        <ReactMarkdown components={marking} remarkPlugins={[remarkGfm]}>
          {markdown}
        </ReactMarkdown>
      </div>
    </CssVarsProvider>
  );

  it('runs the highlighter over paragraph, header and body-cell text', () => {
    render(
      <Marked markdown={['the rig holds', '', '| rig | Hours |', '| --- | --- |', '| rig a | 91 |'].join('\n')} />
    );

    expect(root().querySelectorAll('mark').length).toBeGreaterThanOrEqual(3);
    expect(root().querySelector('p mark')).not.toBeNull();
    expect(root().querySelector('th mark')).not.toBeNull();
    expect(root().querySelector('td mark')).not.toBeNull();
  });
});
