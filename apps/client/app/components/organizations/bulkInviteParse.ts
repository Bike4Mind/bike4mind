import { MAX_ORG_BULK_INVITE_ROWS } from '@bike4mind/common';

export const MAX_BULK_INVITE_ROWS = MAX_ORG_BULK_INVITE_ROWS;

const stripBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

const isListSeparator = (ch: string) => ch === ',' || ch === ';' || ch === '\n' || ch === '\r';

/**
 * Addresses typed or pasted into the textarea, separated by whitespace, commas or semicolons.
 * A `Name <addr>` entry (mail-client copy format) yields just `addr`; the display name is dropped.
 * Single linear scan.
 */
export function parseEmailList(text: string): string[] {
  const s = stripBom(text);
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (isListSeparator(s[i])) {
      i++;
      continue;
    }
    let scan = i;
    if (s[i] === '"') {
      const close = s.indexOf('"', i + 1);
      if (close !== -1) scan = close + 1;
    }
    while (scan < s.length && !isListSeparator(s[scan])) scan++;
    const segment = s.slice(i, scan);
    i = scan;

    let pos = 0;
    while (pos < segment.length) {
      const lt = segment.indexOf('<', pos);
      const gt = lt === -1 ? -1 : segment.indexOf('>', lt + 1);
      if (gt === -1) {
        for (const token of segment.slice(pos).split(/\s+/)) if (token) out.push(token);
        break;
      }
      const addr = segment.slice(lt + 1, gt).trim();
      if (addr) out.push(addr);
      pos = gt + 1;
    }
  }
  return out;
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
