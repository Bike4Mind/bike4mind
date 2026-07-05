import { IChatHistoryItem, ISessionDocument } from '@bike4mind/common';
import { formatSessionTitle } from '@client/app/utils/sessionTitle';
import Papa from 'papaparse';
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
 * Exportable session format combining session metadata with chat history
 */
export interface ExportableSession {
  id: string;
  name: string;
  summary?: string;
  tags?: { name: string; strength: number }[];
  createdAt: Date;
  updatedAt: Date;
  messages: ExportableMessage[];
}

export interface ExportableMessage {
  timestamp: Date;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  tokensUsed?: number;
  creditsUsed?: number;
}

/**
 * Convert session and chat history to exportable format
 */
export function toExportableSession(session: ISessionDocument, chatHistory: IChatHistoryItem[]): ExportableSession {
  const messages: ExportableMessage[] = [];

  for (const item of chatHistory) {
    if (item.deletedAt) continue;

    if (item.prompt) {
      messages.push({
        timestamp: new Date(item.timestamp),
        role: item.type === 'system' ? 'system' : 'user',
        content: item.prompt,
        model: item.promptMeta?.model?.name,
        tokensUsed: item.promptMeta?.tokenUsage?.inputTokens,
      });
    }

    const replies = item.replies || (item.reply ? [item.reply] : []);
    for (const reply of replies) {
      if (reply) {
        messages.push({
          timestamp: new Date(item.timestamp),
          role: 'assistant',
          content: reply,
          model: item.promptMeta?.model?.name,
          tokensUsed: item.promptMeta?.tokenUsage?.outputTokens,
          creditsUsed: item.creditsUsed,
        });
      }
    }
  }

  return {
    id: session.id,
    // Clean title once at the boundary so all exporters (md/xlsx/docx) inherit it.
    name: formatSessionTitle(session.name),
    summary: session.summary,
    tags: session.tags,
    createdAt: new Date(session.firstCreated),
    updatedAt: new Date(session.lastUpdated),
    messages,
  };
}

function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function getSessionExportFilename(sessionName: string): string {
  return `session-${slugifyName(formatSessionTitle(sessionName))}`;
}

export function sessionToMarkdown(session: ExportableSession): string {
  const dateStr = new Date().toISOString().split('T')[0];

  let md = `# ${session.name}\n\n`;
  md += `> Exported on ${dateStr}\n`;
  md += `> Created: ${session.createdAt.toLocaleDateString()} | Updated: ${session.updatedAt.toLocaleDateString()}\n`;
  md += `> Messages: ${session.messages.length}\n\n`;

  if (session.tags && session.tags.length > 0) {
    md += `> Tags: ${session.tags.map(t => t.name).join(', ')}\n\n`;
  }

  if (session.summary) {
    md += `## Summary\n\n${session.summary}\n\n`;
  }

  md += `---\n\n## Conversation\n\n`;

  for (const msg of session.messages) {
    const roleLabel = msg.role === 'user' ? '**User**' : msg.role === 'assistant' ? '**AI**' : '**System**';
    md += `${roleLabel}:\n\n${msg.content}\n\n---\n\n`;
  }

  return md;
}

export function sessionToJSON(session: ExportableSession): string {
  const exportData = {
    exportedAt: new Date().toISOString(),
    format: 'session-v1',
    session: {
      id: session.id,
      name: session.name,
      summary: session.summary,
      tags: session.tags?.map(t => t.name) || [],
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      messageCount: session.messages.length,
    },
    messages: session.messages.map(msg => ({
      timestamp: msg.timestamp.toISOString(),
      role: msg.role,
      content: msg.content,
      model: msg.model,
      tokensUsed: msg.tokensUsed,
      creditsUsed: msg.creditsUsed,
    })),
  };

  return JSON.stringify(exportData, null, 2);
}

interface CsvRow {
  Timestamp: string;
  Role: string;
  Content: string;
  Model: string;
  'Tokens Used': string;
  'Credits Used': string;
}

export function sessionToCSV(session: ExportableSession): string {
  const rows: CsvRow[] = session.messages.map(msg => ({
    Timestamp: msg.timestamp.toISOString(),
    Role: msg.role.charAt(0).toUpperCase() + msg.role.slice(1),
    Content: msg.content,
    Model: msg.model || '',
    'Tokens Used': msg.tokensUsed?.toString() || '',
    'Credits Used': msg.creditsUsed?.toString() || '',
  }));

  return Papa.unparse(rows);
}

export async function sessionToExcel(session: ExportableSession, filename: string): Promise<void> {
  const { downloadData } = await import('@client/app/utils/download');

  const dateStr = new Date().toISOString().split('T')[0];

  const overviewData = [
    { Field: 'Session Name', Value: session.name },
    { Field: 'Session ID', Value: session.id },
    { Field: 'Created', Value: session.createdAt.toISOString() },
    { Field: 'Updated', Value: session.updatedAt.toISOString() },
    { Field: 'Message Count', Value: session.messages.length.toString() },
    { Field: 'Tags', Value: session.tags?.map(t => t.name).join(', ') || '' },
    { Field: 'Summary', Value: session.summary || '' },
    { Field: 'Exported', Value: dateStr },
  ];

  const messagesData = session.messages.map((msg, index) => ({
    '#': index + 1,
    Timestamp: msg.timestamp.toISOString(),
    Role: msg.role.charAt(0).toUpperCase() + msg.role.slice(1),
    Content: msg.content,
    Model: msg.model || '',
    'Tokens Used': msg.tokensUsed || '',
    'Credits Used': msg.creditsUsed || '',
  }));

  const workbook = XLSX.utils.book_new();

  const overviewSheet = XLSX.utils.json_to_sheet(overviewData);
  overviewSheet['!cols'] = [{ wch: 15 }, { wch: 80 }];
  XLSX.utils.book_append_sheet(workbook, overviewSheet, 'Overview');

  const messagesSheet = XLSX.utils.json_to_sheet(messagesData);
  messagesSheet['!cols'] = [
    { wch: 5 }, // #
    { wch: 22 }, // Timestamp
    { wch: 10 }, // Role
    { wch: 80 }, // Content
    { wch: 20 }, // Model
    { wch: 12 }, // Tokens Used
    { wch: 12 }, // Credits Used
  ];
  XLSX.utils.book_append_sheet(workbook, messagesSheet, 'Messages');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadData(blob, `${filename}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

export async function sessionToDocx(session: ExportableSession, filename: string): Promise<void> {
  const { downloadData } = await import('@client/app/utils/download');

  const dateStr = new Date().toISOString().split('T')[0];
  const children: Paragraph[] = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: session.name, bold: true, size: DocxFontSizes.title })],
      heading: HeadingLevel.TITLE,
      spacing: { after: DocxSpacing.afterTitle },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Exported on ${dateStr}  |  Created: ${session.createdAt.toLocaleDateString()}  |  Updated: ${session.updatedAt.toLocaleDateString()}`,
          italics: true,
          size: DocxFontSizes.small,
          color: DocxColors.metadata,
        }),
      ],
      spacing: { after: DocxSpacing.afterHeading },
    })
  );

  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Messages: ${session.messages.length}`,
          italics: true,
          size: DocxFontSizes.small,
          color: DocxColors.metadata,
        }),
      ],
      spacing: { after: DocxSpacing.afterHeading },
    })
  );

  if (session.tags && session.tags.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Tags: ${session.tags.map(t => t.name).join(', ')}`,
            italics: true,
            size: DocxFontSizes.small,
            color: DocxColors.metadata,
          }),
        ],
        spacing: { after: DocxSpacing.afterTitle },
      })
    );
  }

  if (session.summary) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: 'Summary', bold: true, size: DocxFontSizes.heading2 })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterHeading },
      })
    );

    children.push(
      new Paragraph({
        children: [new TextRun({ text: session.summary, size: DocxFontSizes.body })],
        spacing: { after: DocxSpacing.afterTitle },
      })
    );
  }

  // Horizontal rule using paragraph border
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

  children.push(
    new Paragraph({
      children: [new TextRun({ text: 'Conversation', bold: true, size: DocxFontSizes.heading2 })],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterTitle },
    })
  );

  for (const msg of session.messages) {
    const roleStyle = msg.role in DocxRoleStyles ? DocxRoleStyles[msg.role as MessageRole] : DocxRoleStyles.system;

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: roleStyle.label,
            bold: true,
            size: DocxFontSizes.heading3,
            color: roleStyle.textColor,
          }),
          new TextRun({
            text: `  (${msg.timestamp.toLocaleString()})`,
            size: DocxFontSizes.metadata,
            color: DocxColors.timestamp,
          }),
        ],
        spacing: { before: DocxSpacing.beforeRole, after: DocxSpacing.afterRole },
      })
    );

    children.push(
      new Paragraph({
        children: [new TextRun({ text: msg.content, size: DocxFontSizes.body })],
        shading: { fill: roleStyle.backgroundColor },
        border: {
          left: {
            color: roleStyle.borderColor,
            size: DocxBorderSizes.accent,
            style: BorderStyle.SINGLE,
          },
        },
        spacing: { after: DocxSpacing.messageGap },
      })
    );
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const docxBlob = await Packer.toBlob(doc);
  downloadData(docxBlob, `${filename}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
