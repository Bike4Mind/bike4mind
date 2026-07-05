import * as XLSX from 'xlsx';
import { Document, Paragraph, TextRun, Packer, HeadingLevel, BorderStyle } from 'docx';
import {
  DocxColors,
  DocxFontSizes,
  DocxSpacing,
  DocxBorderSizes,
  DocxRoleStyles,
  type MessageRole,
} from './docxStyles';

/**
 * Structure of exported notebook data from the API
 */
export interface ExportedNotebook {
  id: string;
  name: string;
  firstCreated: string;
  lastUpdated: string;
  language?: string;
  summary?: string;
  tags?: { name: string; strength: number }[];
  chatHistory: ExportedChatMessage[];
}

export interface ExportedChatMessage {
  id: string;
  timestamp: string;
  type: string;
  prompt: string;
  replies?: string[];
  promptMeta?: {
    model?: { name: string };
    tokenUsage?: {
      inputTokens?: number;
      outputTokens?: number;
    };
  };
}

export interface BulkExportData {
  exportVersion: string;
  exportedAt: string;
  notebooks: ExportedNotebook[];
}

/**
 * Convert bulk notebook export data to Excel format
 */
export async function notebooksToExcel(data: BulkExportData): Promise<Blob> {
  const dateStr = new Date().toISOString().split('T')[0];

  // Summary sheet data
  const summaryData = data.notebooks.map((nb, index) => ({
    '#': index + 1,
    'Notebook Name': nb.name,
    Created: nb.firstCreated ? new Date(nb.firstCreated).toLocaleDateString() : '',
    Updated: nb.lastUpdated ? new Date(nb.lastUpdated).toLocaleDateString() : '',
    Messages: nb.chatHistory?.length || 0,
    Summary: nb.summary || '',
    Tags: nb.tags?.map(t => t.name).join(', ') || '',
  }));

  // Messages sheet data - flatten all messages from all notebooks
  const messagesData: Array<Record<string, string | number>> = [];
  for (const nb of data.notebooks) {
    if (!nb.chatHistory) continue;

    for (const msg of nb.chatHistory) {
      // User message
      if (msg.prompt) {
        messagesData.push({
          Notebook: nb.name,
          Timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : '',
          Role: msg.type === 'system' ? 'System' : 'User',
          Content: msg.prompt,
          Model: msg.promptMeta?.model?.name || '',
          Tokens: msg.promptMeta?.tokenUsage?.inputTokens || '',
        });
      }

      // Assistant replies
      const replies = msg.replies || [];
      for (const reply of replies) {
        if (reply) {
          messagesData.push({
            Notebook: nb.name,
            Timestamp: msg.timestamp ? new Date(msg.timestamp).toISOString() : '',
            Role: 'Assistant',
            Content: reply,
            Model: msg.promptMeta?.model?.name || '',
            Tokens: msg.promptMeta?.tokenUsage?.outputTokens || '',
          });
        }
      }
    }
  }

  // Create workbook
  const workbook = XLSX.utils.book_new();

  // Add summary sheet
  const summarySheet = XLSX.utils.json_to_sheet(summaryData);
  summarySheet['!cols'] = [
    { wch: 5 }, // #
    { wch: 40 }, // Name
    { wch: 12 }, // Created
    { wch: 12 }, // Updated
    { wch: 10 }, // Messages
    { wch: 60 }, // Summary
    { wch: 30 }, // Tags
  ];
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Notebooks');

  // Add messages sheet
  const messagesSheet = XLSX.utils.json_to_sheet(messagesData);
  messagesSheet['!cols'] = [
    { wch: 30 }, // Notebook
    { wch: 22 }, // Timestamp
    { wch: 10 }, // Role
    { wch: 80 }, // Content
    { wch: 25 }, // Model
    { wch: 10 }, // Tokens
  ];
  XLSX.utils.book_append_sheet(workbook, messagesSheet, 'Messages');

  // Add export metadata sheet
  const metaData = [
    { Field: 'Export Version', Value: data.exportVersion },
    { Field: 'Exported At', Value: data.exportedAt },
    { Field: 'Total Notebooks', Value: data.notebooks.length.toString() },
    { Field: 'Total Messages', Value: messagesData.length.toString() },
    { Field: 'Download Date', Value: dateStr },
  ];
  const metaSheet = XLSX.utils.json_to_sheet(metaData);
  metaSheet['!cols'] = [{ wch: 20 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(workbook, metaSheet, 'Export Info');

  // Generate blob
  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  return new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

/**
 * Convert bulk notebook export data to Word format
 */
export async function notebooksToDocx(data: BulkExportData): Promise<Blob> {
  const dateStr = new Date().toISOString().split('T')[0];
  const children: Paragraph[] = [];

  // Title
  children.push(
    new Paragraph({
      children: [new TextRun({ text: 'Notebook Export', bold: true, size: DocxFontSizes.title })],
      heading: HeadingLevel.TITLE,
      spacing: { after: DocxSpacing.afterTitle },
    })
  );

  // Export metadata
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Exported on ${dateStr}  |  ${data.notebooks.length} notebooks  |  Version ${data.exportVersion}`,
          italics: true,
          size: DocxFontSizes.small,
          color: DocxColors.metadata,
        }),
      ],
      spacing: { after: DocxSpacing.sectionGap },
    })
  );

  // Table of contents
  children.push(
    new Paragraph({
      children: [new TextRun({ text: 'Table of Contents', bold: true, size: DocxFontSizes.heading2 })],
      heading: HeadingLevel.HEADING_1,
      spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterTitle },
    })
  );

  data.notebooks.forEach((nb, index) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `${index + 1}. ${nb.name}`, size: DocxFontSizes.body })],
        spacing: { after: DocxSpacing.afterRole },
      })
    );
  });

  // Separator using paragraph border
  children.push(
    new Paragraph({
      children: [],
      border: {
        bottom: {
          color: DocxColors.divider,
          size: DocxBorderSizes.normal,
          style: BorderStyle.SINGLE,
        },
      },
      spacing: { before: DocxSpacing.sectionGap, after: DocxSpacing.sectionGap },
    })
  );

  // Each notebook
  for (const nb of data.notebooks) {
    // Notebook title
    children.push(
      new Paragraph({
        children: [new TextRun({ text: nb.name, bold: true, size: DocxFontSizes.heading1 })],
        heading: HeadingLevel.HEADING_1,
        spacing: { before: DocxSpacing.sectionGap, after: DocxSpacing.afterHeading },
      })
    );

    // Notebook metadata
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Created: ${nb.firstCreated ? new Date(nb.firstCreated).toLocaleDateString() : 'N/A'}  |  Updated: ${nb.lastUpdated ? new Date(nb.lastUpdated).toLocaleDateString() : 'N/A'}`,
            size: DocxFontSizes.metadata,
            color: DocxColors.metadata,
          }),
        ],
        spacing: { after: DocxSpacing.afterHeading },
      })
    );

    if (nb.tags && nb.tags.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `Tags: ${nb.tags.map(t => t.name).join(', ')}`,
              size: DocxFontSizes.metadata,
              color: DocxColors.metadata,
            }),
          ],
          spacing: { after: DocxSpacing.afterHeading },
        })
      );
    }

    if (nb.summary) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: 'Summary', bold: true, size: DocxFontSizes.heading3 })],
          spacing: { before: DocxSpacing.beforeRole, after: DocxSpacing.afterRole },
        })
      );
      children.push(
        new Paragraph({
          children: [new TextRun({ text: nb.summary, size: DocxFontSizes.small })],
          spacing: { after: DocxSpacing.afterParagraph },
        })
      );
    }

    // Conversation
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Conversation', bold: true, size: DocxFontSizes.heading3 })],
        spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterHeading },
      })
    );

    if (nb.chatHistory) {
      for (const msg of nb.chatHistory) {
        // User message
        if (msg.prompt) {
          const roleKey: MessageRole = msg.type === 'system' ? 'system' : 'user';
          const roleStyle = DocxRoleStyles[roleKey];

          // Role header
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: roleStyle.label,
                  bold: true,
                  size: DocxFontSizes.body,
                  color: roleStyle.textColor,
                }),
                new TextRun({ text: ':', size: DocxFontSizes.body }),
              ],
              spacing: { before: DocxSpacing.afterHeading },
            })
          );

          // Message content with background shading and left border
          children.push(
            new Paragraph({
              children: [new TextRun({ text: msg.prompt, size: DocxFontSizes.small })],
              shading: { fill: roleStyle.backgroundColor },
              border: {
                left: {
                  color: roleStyle.borderColor,
                  size: DocxBorderSizes.accent,
                  style: BorderStyle.SINGLE,
                },
              },
              spacing: { after: DocxSpacing.afterHeading },
            })
          );
        }

        // Assistant replies
        const replies = msg.replies || [];
        for (const reply of replies) {
          if (reply) {
            const roleStyle = DocxRoleStyles.assistant;

            // Role header
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: roleStyle.label,
                    bold: true,
                    size: DocxFontSizes.body,
                    color: roleStyle.textColor,
                  }),
                  new TextRun({ text: ':', size: DocxFontSizes.body }),
                ],
                spacing: { before: DocxSpacing.afterRole },
              })
            );

            // Message content with background shading and left border
            children.push(
              new Paragraph({
                children: [new TextRun({ text: reply, size: DocxFontSizes.small })],
                shading: { fill: roleStyle.backgroundColor },
                border: {
                  left: {
                    color: roleStyle.borderColor,
                    size: DocxBorderSizes.accent,
                    style: BorderStyle.SINGLE,
                  },
                },
                spacing: { after: DocxSpacing.afterHeading },
              })
            );
          }
        }
      }
    }

    // Separator between notebooks using paragraph border
    children.push(
      new Paragraph({
        children: [],
        border: {
          bottom: {
            color: DocxColors.divider,
            size: DocxBorderSizes.normal,
            style: BorderStyle.SINGLE,
          },
        },
        spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterTitle },
      })
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return await Packer.toBlob(doc);
}

/**
 * Convert bulk notebook export data to Markdown format
 */
export function notebooksToMarkdown(data: BulkExportData): string {
  const dateStr = new Date().toISOString().split('T')[0];

  let md = `# Notebook Export\n\n`;
  md += `> Exported on ${dateStr}\n`;
  md += `> Total notebooks: ${data.notebooks.length}\n`;
  md += `> Export version: ${data.exportVersion}\n\n`;

  // Table of contents
  md += `## Table of Contents\n\n`;
  data.notebooks.forEach((nb, index) => {
    md += `${index + 1}. ${nb.name}\n`;
  });
  md += `\n---\n\n`;

  // Each notebook
  for (const nb of data.notebooks) {
    md += `# ${nb.name}\n\n`;
    md += `> Created: ${nb.firstCreated ? new Date(nb.firstCreated).toLocaleDateString() : 'N/A'}\n`;
    md += `> Updated: ${nb.lastUpdated ? new Date(nb.lastUpdated).toLocaleDateString() : 'N/A'}\n`;

    if (nb.tags && nb.tags.length > 0) {
      md += `> Tags: ${nb.tags.map(t => t.name).join(', ')}\n`;
    }
    md += `\n`;

    if (nb.summary) {
      md += `## Summary\n\n${nb.summary}\n\n`;
    }

    md += `## Conversation\n\n`;

    if (nb.chatHistory) {
      for (const msg of nb.chatHistory) {
        // User message
        if (msg.prompt) {
          const roleLabel = msg.type === 'system' ? '**System**' : '**User**';
          md += `${roleLabel}:\n\n${msg.prompt}\n\n`;
        }

        // Assistant replies
        const replies = msg.replies || [];
        for (const reply of replies) {
          if (reply) {
            md += `**AI**:\n\n${reply}\n\n`;
          }
        }
      }
    }

    md += `---\n\n`;
  }

  return md;
}

/**
 * Download blob as a file
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
