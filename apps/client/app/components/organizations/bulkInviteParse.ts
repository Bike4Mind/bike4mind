export const MAX_BULK_INVITE_ROWS = 100;

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Addresses typed or pasted into the textarea, separated by whitespace, commas or semicolons. */
export function parseEmailList(text: string): string[] {
  return stripBom(text)
    .split(/[\s,;]+/)
    .filter(Boolean);
}

function firstCell(line: string): string {
  if (!line.startsWith('"')) return line.split(/[,;\t]/)[0].trim();
  let cell = '';
  for (let i = 1; i < line.length; i++) {
    if (line[i] !== '"') {
      cell += line[i];
    } else if (line[i + 1] === '"') {
      cell += '"';
      i++;
    } else {
      break;
    }
  }
  return cell.trim();
}

/**
 * First column of each non-blank line of a CSV or plain-text file. A first line whose first cell has
 * no '@' is treated as a header and skipped.
 */
export function parseCsvFirstColumn(text: string): string[] {
  const cells = stripBom(text)
    .split(/\r?\n|\r/)
    .filter(line => line.trim() !== '')
    .map(line => firstCell(line.trim()));
  if (cells.length > 0 && !cells[0].includes('@')) cells.shift();
  return cells.filter(Boolean);
}
