import React, { useState } from 'react';
import { Dropdown, MenuButton, Menu, MenuItem, ListDivider, IconButton, Tooltip } from '@mui/joy';
import type { SxProps } from '@mui/joy/styles/types';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import SaveAltIcon from '@mui/icons-material/SaveAlt';
import { toast } from 'sonner';
import { marked } from 'marked';
import { Document, Paragraph, TextRun, Packer, Table, TableRow, TableCell, WidthType } from 'docx';
import { renderMarkdownToStyledHtml } from '@client/app/utils/markdownToStyledHtml';
import { buildReplyDownloads, type ReplyDownload } from '@client/app/utils/replyDownloads';
import { stripSearchResultCardFences } from '@bike4mind/common';

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

/**
 * The download formats for a reply, as menu items: formats found in the reply first (code files,
 * tables), then Markdown, DOCX and HTML. Works inside a Menu (DownloadMenu) or a MenuList (the
 * phone actions sheet). Formats are scanned on mount, which a menu does on open: this mounts once
 * per message, and a reply still streaming would otherwise cache a list built from a partial body.
 */
export const ReplyDownloadMenuItems: React.FC<{ content: string; fileName: string; onDone?: () => void }> = ({
  content: rawContent,
  fileName,
  onDone,
}) => {
  // The Markdown/DOCX/HTML paths below have no way to render a b4m_cards fence, so they'd
  // otherwise download raw model-authored card JSON as if it were reply text.
  const content = stripSearchResultCardFences(rawContent);
  const done = onDone || (() => {});
  const [detected] = useState<ReplyDownload[]>(() => buildReplyDownloads(content, fileName.replace(/\.[^./]+$/, '')));

  return (
    <>
      {detected.map(item => (
        <MenuItem
          key={item.key}
          className="download-menu-item-detected"
          data-testid={`download-menu-detected-${item.key}`}
          onClick={() => {
            downloadFile(item.content, item.fileName, item.mimeType);
            done();
          }}
        >
          {item.label}
        </MenuItem>
      ))}
      {detected.length > 0 && <ListDivider />}
      <MenuItem
        className="download-menu-item-markdown"
        onClick={() => {
          downloadFile(content, fileName, 'text/markdown');
          done();
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
          done();
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
          done();
        }}
      >
        HTML
      </MenuItem>
    </>
  );
};

// DownloadMenu component
const DownloadMenu: React.FC<{
  content: string;
  fileName: string;
  onClose?: () => void;
  /** Trigger variant. The chat action rows use 'plain'; toolbars keep the outline. */
  variant?: 'outlined' | 'plain';
  /** Extra styles for the trigger, so a row can size it with its siblings. */
  triggerSx?: SxProps;
}> = ({ content, fileName, onClose, variant = 'outlined', triggerSx }) => {
  const isMobile = useIsMobile();

  return (
    <Dropdown>
      <Tooltip title="Download">
        <MenuButton
          className="download-menu-button"
          slots={{ root: IconButton }}
          slotProps={{ root: { variant, color: 'neutral', size: 'sm', sx: triggerSx } }}
        >
          <SaveAltIcon className="download-menu-icon" />
        </MenuButton>
      </Tooltip>
      <Menu className="download-menu" placement={isMobile ? 'top' : 'bottom'}>
        <ReplyDownloadMenuItems content={content} fileName={fileName} onDone={onClose} />
      </Menu>
    </Dropdown>
  );
};

export default DownloadMenu;
