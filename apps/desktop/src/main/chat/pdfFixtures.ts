/** Test-only: builds tiny PDFs in memory so no binary fixture is committed. */

function escapeText(text: string): string {
  return text.replace(/[\\()]/g, char => `\\${char}`);
}

/**
 * A valid one-font PDF; an empty string makes a blank page. Newlines in a page start new lines,
 * set in 1pt type so a page can hold a few hundred of them without leaving the page.
 */
export function makePdf(pages: string[], options: { encrypted?: boolean } = {}): Buffer {
  const objects: string[] = [];
  const pageIds = pages.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((text, index) => {
    const pageId = pageIds[index];
    const lines = text ? text.split('\n').map(line => `(${escapeText(line)}) Tj T*`) : [];
    const stream = text ? `BT /F1 1 Tf 1 TL 20 780 Td ${lines.join(' ')} ET` : '';
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageId + 1} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';
    objects[pageId + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  const encryptId = objects.length;
  if (options.encrypted) {
    const key = '<' + '00'.repeat(32) + '>';
    objects[encryptId] = `<< /Filter /Standard /V 1 /R 2 /O ${key} /U ${key} /P -4 >>`;
  }

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  const encrypt = options.encrypted ? ` /Encrypt ${encryptId} 0 R /ID [<${'11'.repeat(16)}> <${'11'.repeat(16)}>]` : '';
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R${encrypt} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
