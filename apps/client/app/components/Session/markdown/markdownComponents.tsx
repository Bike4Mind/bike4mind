import React, { ComponentProps, CSSProperties, ReactNode, createContext, useContext, useMemo } from 'react';
import type { Components, ExtraProps } from 'react-markdown';
import ImageContainer from '@client/app/components/Session/ImageContainer';

/**
 * The react-markdown override map for assistant replies.
 *
 * The governing choice: elements render as bare semantic HTML and
 * `observatory.css` styles them by descendant selector. An override earns its
 * place here only by doing work CSS cannot - search highlighting, invalid-
 * nesting repair, or the cross-row analysis a table needs before a cell can
 * know how to set itself.
 */

/* --------------------------------------------------------------------------
 * hast helpers
 *
 * react-markdown hands each component the same hast node object it built the
 * element from, which is what lets the table analyse its own rows once and
 * have every cell find its own verdict again by identity.
 * ------------------------------------------------------------------------ */

type HastNode = NonNullable<ExtraProps['node']>;
type HastChild = HastNode['children'][number];

const isElement = (node: HastChild | undefined, tagName?: string): node is HastNode =>
  !!node && node.type === 'element' && (tagName === undefined || node.tagName === tagName);

const textOf = (node: HastChild): string => {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
};

const childElements = (node: HastNode, tagName?: string): HastNode[] =>
  node.children.filter((child): child is HastNode => isElement(child, tagName));

/** Returns every <tr> under the table's <tbody> elements, in document order. */
const bodyRowsOf = (table: HastNode): HastNode[] =>
  childElements(table, 'tbody').flatMap(tbody => childElements(tbody, 'tr'));

/** Returns every <tr> under the table's <thead> elements, in document order. */
const headRowsOf = (table: HastNode): HastNode[] =>
  childElements(table, 'thead').flatMap(thead => childElements(thead, 'tr'));

const cellsOf = (row: HastNode): HastNode[] =>
  row.children.filter((c): c is HastNode => isElement(c, 'td') || isElement(c, 'th'));

/* --------------------------------------------------------------------------
 * numeric-column analysis
 * ------------------------------------------------------------------------ */

/** Matches a single quantity: digits, optional thousands separators, optional decimal. */
const NUMBER_RE = /\d[\d,]*(?:\.\d+)?/g;

/** A column is read as prose once any of its cells is this long, however numeric it looks. */
const PROSE_CELL_LENGTH = 24;

/** A comparison needs enough rows to be a comparison. */
const MIN_COMPARABLE_ROWS = 3;

export const NUM_CELL_CLASS = 'b4m-md-num';
export const NUMTEXT_CELL_CLASS = 'b4m-md-numtext';

interface CellMeta {
  className?: string;
  /** Value over column maximum, or undefined when the column draws no bar. */
  bar?: number;
}

interface TableMeta {
  cells: Map<HastNode, CellMeta>;
  totalRows: Set<HastNode>;
}

const EMPTY_TABLE_META: TableMeta = { cells: new Map(), totalRows: new Set() };

const TableMetaContext = createContext<TableMeta>(EMPTY_TABLE_META);

/**
 * Parses one column to numbers. Returns null unless the column is honestly
 * comparable: every body cell must yield exactly one number, there must be
 * enough rows to compare, and the maximum must be positive (a column of zeroes
 * has no magnitude to draw).
 */
const columnValues = (rows: HastNode[][], column: number): number[] | null => {
  if (rows.length < MIN_COMPARABLE_ROWS) return null;
  const values: number[] = [];
  for (const row of rows) {
    const cell = row[column];
    if (!cell) return null;
    const matches = textOf(cell).trim().match(NUMBER_RE);
    if (!matches || matches.length !== 1) return null;
    const value = Number(matches[0].replace(/,/g, ''));
    if (!Number.isFinite(value)) return null;
    values.push(value);
  }
  return Math.max(...values) > 0 ? values : null;
};

/**
 * Classifies every cell of a table and marks its total row, once per parse.
 *
 * A numeric column is right-aligned with tabular figures and gets a magnitude
 * bar; the same column is demoted to left-aligned mono the moment one of its
 * cells is long enough to wrap, because a laddered column of wrapped text
 * reads worse than plain prose.
 */
export const analyseTable = (table: HastNode): TableMeta => {
  const bodyRows = bodyRowsOf(table).map(cellsOf);
  const headRows = headRowsOf(table).map(cellsOf);
  const columnCount = Math.max(0, ...bodyRows.map(row => row.length), ...headRows.map(row => row.length));

  const cells = new Map<HastNode, CellMeta>();

  for (let column = 0; column < columnCount; column += 1) {
    const values = columnValues(bodyRows, column);
    if (!values) continue;

    const longest = Math.max(...bodyRows.map(row => (row[column] ? textOf(row[column]).trim().length : 0)));
    const isProse = longest > PROSE_CELL_LENGTH;
    const className = isProse ? NUMTEXT_CELL_CLASS : NUM_CELL_CLASS;
    const max = Math.max(...values);

    headRows.forEach(row => {
      if (row[column]) cells.set(row[column], { className });
    });
    bodyRows.forEach((row, rowIndex) => {
      if (!row[column]) return;
      cells.set(row[column], { className, bar: isProse ? undefined : values[rowIndex] / max });
    });
  }

  // A body row whose first cell is wholly bold is a total: the model writes it
  // as `**Total**`, and it wants a rule above it rather than a fill behind it.
  const totalRows = new Set<HastNode>();
  for (const row of bodyRowsOf(table)) {
    const first = cellsOf(row)[0];
    if (!first) continue;
    const meaningful = first.children.filter(child => !(child.type === 'text' && child.value.trim() === ''));
    if (meaningful.length === 1 && isElement(meaningful[0], 'strong')) totalRows.add(row);
  }

  return { cells, totalRows };
};

/* --------------------------------------------------------------------------
 * component map
 * ------------------------------------------------------------------------ */

export interface MarkdownComponentsOptions {
  /** Wraps matching runs of a search term in <mark>; identity when no search is active. */
  highlightText: (node: ReactNode[] | string) => ReactNode;
}

const highlightStrings = (children: ReactNode, highlightText: MarkdownComponentsOptions['highlightText']): ReactNode =>
  React.Children.map(children, child => (typeof child === 'string' ? highlightText(child) : child));

/**
 * Builds the components map for one reply. A factory rather than a constant
 * because `highlightText` closes over the session's current search term.
 */
export const createMarkdownComponents = ({ highlightText }: MarkdownComponentsOptions): Components => {
  const Paragraph: Components['p'] = ({ node, children, color, ...props }) => {
    const childArray = React.Children.toArray(children);
    // An image-only paragraph is unwrapped: ImageContainer renders a <div>, and
    // a <div> inside a <p> is invalid nesting the browser silently repairs by
    // closing the paragraph early, which breaks the reply's flow.
    const hasOnlyImage =
      childArray.length === 1 &&
      React.isValidElement(childArray[0]) &&
      (childArray[0].type === ImageContainer ||
        (typeof childArray[0].type === 'function' && childArray[0].type.name === 'img'));

    if (hasOnlyImage) {
      return <div className="b4m-md-figure">{children}</div>;
    }

    return (
      <p {...props} data-testid="ai-response">
        {highlightStrings(children, highlightText)}
      </p>
    );
  };

  // Wide tables scroll horizontally inside their own wrapper. The reply body is
  // not a scroll container (that made Android snap text selection to whole-block
  // boundaries), so each element that can exceed the width owns its own overflow.
  const Table = ({ node, children, ref, ...props }: ComponentProps<'table'> & ExtraProps) => {
    const meta = useMemo(() => (node ? analyseTable(node) : EMPTY_TABLE_META), [node]);
    return (
      <TableMetaContext.Provider value={meta}>
        <div className="b4m-md-table-wrap">
          <table {...props}>{children}</table>
        </div>
      </TableMetaContext.Provider>
    );
  };

  const Row = ({ node, children, ref, ...props }: ComponentProps<'tr'> & ExtraProps) => {
    const { totalRows } = useContext(TableMetaContext);
    const isTotal = !!node && totalRows.has(node);
    return (
      <tr {...props} {...(isTotal ? { 'data-b4m-md-total': '' } : {})}>
        {children}
      </tr>
    );
  };

  const useCellMeta = (node: HastNode | undefined): CellMeta => {
    const { cells } = useContext(TableMetaContext);
    return (node && cells.get(node)) || {};
  };

  const HeaderCell = ({ node, children, ref, ...props }: ComponentProps<'th'> & ExtraProps) => {
    const { className } = useCellMeta(node);
    return (
      <th {...props} className={className}>
        {highlightStrings(children, highlightText)}
      </th>
    );
  };

  const Cell = ({ node, children, ref, ...props }: ComponentProps<'td'> & ExtraProps) => {
    const { className, bar } = useCellMeta(node);
    // The bar width is data, so it has to reach CSS as a value rather than a
    // class; a custom property is the only channel for that.
    const style = bar === undefined ? undefined : ({ '--b4m-md-bar': bar.toFixed(4) } as CSSProperties);
    return (
      <td {...props} className={className} style={style}>
        {highlightStrings(children, highlightText)}
      </td>
    );
  };

  return {
    p: Paragraph,
    table: Table,
    tr: Row,
    th: HeaderCell,
    td: Cell,
  };
};
