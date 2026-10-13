// Reads and rewrites the `overrides:` block of pnpm-workspace.yaml. The block is a flat
// map, so a line-based parser keeps comments elsewhere in the file and needs no YAML dependency.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const BLOCK_START = /^overrides:\s*$/;
const ENTRY = /^ {2}("(?:[^"\\]|\\.)*"|[^\s:"][^:]*?)\s*:\s*("(?:[^"\\]|\\.)*"|\S.*?)\s*$/;

function unquote(token) {
  return token.startsWith('"') ? JSON.parse(token) : token;
}

export function parseOverrides(text) {
  const overrides = {};
  let inBlock = false;
  for (const line of text.split('\n')) {
    if (BLOCK_START.test(line)) {
      inBlock = true;
      continue;
    }
    if (!inBlock) continue;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const m = line.match(ENTRY);
    if (!m) break;
    overrides[unquote(m[1])] = unquote(m[2]);
  }
  return overrides;
}

export function renderOverrides(text, overrides) {
  const block = [
    'overrides:',
    ...Object.entries(overrides).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`),
  ];
  const lines = text.split('\n');
  const start = lines.findIndex(l => BLOCK_START.test(l));
  if (start === -1) return text.replace(/\n*$/, '\n') + block.join('\n') + '\n';
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith(' ') || lines[end].trim() === '')) end++;
  const trailingBlank = lines[end - 1]?.trim() === '' ? [''] : [];
  return [...lines.slice(0, start), ...block, ...trailingBlank, ...lines.slice(end)].join('\n');
}

export function readOverrides(path) {
  return existsSync(path) ? parseOverrides(readFileSync(path, 'utf8')) : {};
}

export function writeOverrides(path, overrides) {
  writeFileSync(path, renderOverrides(readFileSync(path, 'utf8'), overrides));
}
