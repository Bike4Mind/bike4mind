import React from 'react';
import { Dropdown, MenuButton, Menu, MenuItem, IconButton, Tooltip } from '@mui/joy';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { toast } from 'react-hot-toast';
import { marked } from 'marked';
import { Document, Paragraph, TextRun, Packer, Table, TableRow, TableCell, WidthType } from 'docx';
import { renderMarkdownToStyledHtml } from '@client/app/utils/markdownToStyledHtml';

// Utility: Download a file
export const downloadFile = (content: string, fileName: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// Utility: Convert Markdown to DOCX
export const convertMarkdownToDocx = async (markdown: string): Promise<Blob> => {
  const html = await marked.parse(markdown, {
    gfm: true,
    breaks: true,
    pedantic: false,
  });
  if (typeof html !== 'string') {
    throw new Error('Failed to convert markdown to HTML');
  }
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const wordDoc = new Document({
    sections: [
      {
        properties: {},
        children: Array.from(doc.body.childNodes)
          .map(node => {
            if (node.nodeType === Node.ELEMENT_NODE) {
              const element = node as HTMLElement;
              if (element.tagName.match(/^H[1-6]$/)) {
                const level = parseInt(element.tagName[1]);
                return new Paragraph({
                  children: [
                    new TextRun({
                      text: element.textContent || '',
                      bold: true,
                      size: 36 - level * 2 * 2,
                    }),
                  ],
                  spacing: { after: 200, before: 200 },
                });
              }
              if (element.tagName === 'P') {
                return new Paragraph({
                  children: [new TextRun({ text: element.textContent || '', size: 24 })],
                  spacing: { after: 120 },
                });
              }
              if (element.tagName === 'UL' || element.tagName === 'OL') {
                return new Paragraph({
                  children: Array.from(element.childNodes).map((li: Node, index: number) => {
                    if (li.nodeType === Node.ELEMENT_NODE) {
                      const listItem = li as HTMLElement;
                      return new TextRun({
                        text: `${element.tagName === 'OL' ? index + 1 + '.' : '•'} ${listItem.textContent || ''}`,
                        size: 24,
                      });
                    }
                    return new TextRun({ text: '' });
                  }),
                  bullet: { level: 0 },
                  spacing: { after: 120 },
                });
              }
              if (element.tagName === 'PRE') {
                const code = element.querySelector('code');
                if (code) {
                  return new Paragraph({
                    children: [
                      new TextRun({
                        text: code.textContent || '',
                        font: { name: 'Courier New' },
                        size: 20,
                      }),
                    ],
                    spacing: { before: 120, after: 120 },
                    border: {
                      top: { style: 'single', size: 1, color: 'CCCCCC' },
                      bottom: { style: 'single', size: 1, color: 'CCCCCC' },
                      left: { style: 'single', size: 1, color: 'CCCCCC' },
                      right: { style: 'single', size: 1, color: 'CCCCCC' },
                    },
                    shading: { fill: 'F5F5F5' },
                  });
                }
              }
              if (element.tagName === 'CODE') {
                return new TextRun({
                  text: element.textContent || '',
                  font: { name: 'Courier New' },
                  size: 24,
                });
              }
              if (element.tagName === 'A') {
                return new TextRun({
                  text: element.textContent || '',
                  color: '0000FF',
                  underline: { type: 'single' },
                });
              }
              if (element.tagName === 'BLOCKQUOTE') {
                return new Paragraph({
                  children: [new TextRun({ text: element.textContent || '', italics: true, size: 24 })],
                  spacing: { before: 120, after: 120 },
                  border: { left: { style: 'single', size: 4, color: 'CCCCCC' } },
                });
              }
              if (element.tagName === 'TABLE') {
                const rows = Array.from(element.querySelectorAll('tr'));
                const totalTableWidth = 9360; // full page width in twips (6.5" * 1440)
                const numCols = rows[0] ? Array.from(rows[0].querySelectorAll('td, th')).length : 1;
                const colWidth = Math.floor(totalTableWidth / numCols);
                const columnWidths = Array(numCols).fill(colWidth);

                return new Table({
                  width: { size: totalTableWidth, type: WidthType.DXA },
                  columnWidths: columnWidths,
                  rows: rows.map((row, rowIndex) => {
                    const cells = Array.from(row.querySelectorAll('td, th'));
                    return new TableRow({
                      children: cells.map((cell, cellIndex) => {
                        const isHeader = cell.tagName === 'TH';
                        return new TableCell({
                          children: [
                            new Paragraph({
                              children: [
                                new TextRun({
                                  text: cell.textContent || '',
                                  bold: isHeader,
                                  size: 24,
                                }),
                              ],
                            }),
                          ],
                          width: { size: colWidth, type: WidthType.DXA },
                          shading: { fill: isHeader ? 'F5F5F5' : 'FFFFFF' },
                          margins: {
                            top: 80,
                            bottom: 80,
                            left: 120,
                            right: 120,
                          },
                        });
                      }),
                    });
                  }),
                });
              }
              if (element.tagName === 'IMG') {
                const img = element as HTMLImageElement;
                return new Paragraph({
                  children: [new TextRun({ text: img.alt || 'Image', size: 24 })],
                  spacing: { before: 120, after: 120 },
                });
              }
              if (element.tagName === 'HR') {
                return new Paragraph({
                  children: [new TextRun({ text: '―'.repeat(50), size: 24 })],
                  spacing: { before: 120, after: 120 },
                });
              }
              if (element.tagName === 'STRONG' || element.tagName === 'B') {
                return new TextRun({ text: element.textContent || '', bold: true, size: 24 });
              }
              if (element.tagName === 'EM' || element.tagName === 'I') {
                return new TextRun({ text: element.textContent || '', italics: true, size: 24 });
              }
              if (element.tagName === 'DEL' || element.tagName === 'S') {
                return new TextRun({ text: element.textContent || '', strike: true, size: 24 });
              }
            }
            if (node.nodeType === Node.TEXT_NODE) {
              return new Paragraph({
                children: [new TextRun({ text: node.textContent || '', size: 24 })],
              });
            }
            return new Paragraph({
              children: [new TextRun({ text: '' })],
            });
          })
          .filter((node): node is Paragraph | Table => node instanceof Paragraph || node instanceof Table),
      },
    ],
  });
  return await Packer.toBlob(wordDoc);
};

// Utility: Copy text to clipboard
export const copyToClipboard = async (content: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch (err) {
    console.error('Failed to copy text: ', err);
    return false;
  }
};

// DownloadMenu component
const DownloadMenu: React.FC<{
  content: string;
  fileName: string;
  onClose?: () => void;
}> = ({ content, fileName, onClose }) => {
  const handleClose = onClose || (() => {});
  const isMobile = useIsMobile();

  return (
    <Dropdown>
      <Tooltip title="Download">
        <MenuButton
          className="download-menu-button"
          slots={{ root: IconButton }}
          slotProps={{ root: { variant: 'outlined', color: 'neutral', size: 'sm' } }}
        >
          <SaveAltIcon className="download-menu-icon" />
        </MenuButton>
      </Tooltip>
      <Menu className="download-menu" placement={isMobile ? 'top' : 'bottom'}>
        <MenuItem
          className="download-menu-item-markdown"
          onClick={() => {
            downloadFile(content, fileName, 'text/markdown');
            handleClose();
          }}
        >
          Markdown
        </MenuItem>
        <MenuItem
          className="download-menu-item-docx"
          onClick={async () => {
            try {
              const docxBlob = await convertMarkdownToDocx(content);
              const url = URL.createObjectURL(docxBlob);
              const a = document.createElement('a');
              a.href = url;
              a.download = fileName.replace(/\.mdx?$/, '.docx');
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              URL.revokeObjectURL(url);
            } catch (error) {
              console.error('Error converting to DOCX:', error);
              toast.error('Failed to convert to DOCX');
            }
            handleClose();
          }}
        >
          DOCX
        </MenuItem>
        <MenuItem
          className="download-menu-item-html"
          onClick={async () => {
            try {
              const title = fileName.replace(/\.mdx?$/, '');
              const html = await renderMarkdownToStyledHtml(content, { title });
              downloadFile(html, fileName.replace(/\.mdx?$/, '.html'), 'text/html');
            } catch (error) {
              console.error('Error converting to HTML:', error);
              toast.error('Failed to convert to HTML');
            }
            handleClose();
          }}
        >
          HTML
        </MenuItem>
      </Menu>
    </Dropdown>
  );
};

export default DownloadMenu;
