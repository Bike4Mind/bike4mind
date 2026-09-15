import type { StructureItem } from './types';

/**
 * Sections displayed in the output, in order.
 * "simple" sections show just name; "exportable" sections show an "export" prefix when applicable.
 */
const SECTIONS: Array<{ title: string; kind: StructureItem['kind']; exportable: boolean }> = [
  { title: 'IMPORTS', kind: 'import', exportable: false },
  { title: 'EXPORTS', kind: 'export', exportable: false },
  { title: 'FUNCTIONS', kind: 'function', exportable: true },
  { title: 'CLASSES', kind: 'class', exportable: true },
  { title: 'INTERFACES', kind: 'interface', exportable: true },
  { title: 'TYPES', kind: 'type', exportable: true },
  { title: 'ENUMS', kind: 'enum', exportable: true },
];

/**
 * Format extracted structure items into a readable string output.
 */
export function formatStructureOutput(
  filePath: string,
  items: StructureItem[],
  fileSize: number,
  lineCount: number
): string {
  const sizeStr = fileSize < 1024 ? `${fileSize} B` : `${(fileSize / 1024).toFixed(1)} KB`;
  const lines: string[] = [`File: ${filePath} (${sizeStr}, ${lineCount} lines)`, ''];

  for (const section of SECTIONS) {
    const sectionItems = items.filter(i => i.kind === section.kind);
    formatSection(lines, section.title, sectionItems, item => {
      const prefix = section.exportable && item.exported ? 'export ' : '';
      return `L${item.line}: ${prefix}${item.name}`;
    });
  }

  return lines.join('\n').trimEnd();
}

function formatSection(
  lines: string[],
  title: string,
  items: StructureItem[],
  format: (item: StructureItem) => string
): void {
  lines.push(`${title} (${items.length}):`);
  if (items.length === 0) {
    lines.push('  (none)');
  } else {
    for (const item of items) {
      lines.push(`  ${format(item)}`);
    }
  }
  lines.push('');
}
