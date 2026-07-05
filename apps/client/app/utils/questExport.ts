import { IQuestMasterPlanDocument, SubQuestStatus } from '@bike4mind/common';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import {
  Document,
  Paragraph,
  TextRun,
  Packer,
  Table,
  TableRow,
  TableCell,
  WidthType,
  HeadingLevel,
  BorderStyle,
  AlignmentType,
} from 'docx';
import { DocxColors, DocxFontSizes, DocxSpacing, DocxBorderSizes, type SubQuestStatusType } from './docxStyles';

const STATUS_ICONS: Record<SubQuestStatus, string> = {
  completed: ' ✓',
  in_progress: ' 🔄',
  not_started: ' ⏳',
  skipped: ' ⏭',
  deleted: ' ❌',
};

function getStatusIcon(status: SubQuestStatus): string {
  return STATUS_ICONS[status] ?? '';
}

const STATUS_LABELS: Record<SubQuestStatus, string> = {
  completed: 'Completed',
  in_progress: 'In Progress',
  not_started: 'Not Started',
  skipped: 'Skipped',
  deleted: 'Deleted',
};

function getStatusLabel(status: SubQuestStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function slugifyGoal(goal: string): string {
  return goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export function getExportFilename(goal: string): string {
  return `questmaster-${slugifyGoal(goal)}`;
}

export function questPlanToMarkdown(plan: IQuestMasterPlanDocument): string {
  const dateStr = new Date().toISOString().split('T')[0];
  const totalSubQuests = plan.quests.reduce((sum, q) => sum + q.subQuests.length, 0);
  const completedSubQuests = plan.quests.reduce(
    (sum, q) => sum + q.subQuests.filter(sq => sq.status === 'completed').length,
    0
  );

  let md = `# ${plan.goal}\n\n`;
  md += `> Exported from QuestMaster on ${dateStr}\n`;
  md += `> Status: ${plan.state || 'active'} | Progress: ${completedSubQuests}/${totalSubQuests} tasks`;
  if (plan.metrics?.completionRate !== undefined) {
    md += ` (${plan.metrics.completionRate}%)`;
  }
  md += `\n\n`;

  if (plan.tags && plan.tags.length > 0) {
    md += `> Tags: ${plan.tags.join(', ')}\n\n`;
  }

  md += `---\n\n`;

  md += `## Table of Contents\n\n`;
  plan.quests.forEach((quest, i) => {
    md += `${i + 1}. **${quest.title}** (${quest.complexity})\n`;
    quest.subQuests.forEach((sq, j) => {
      md += `   ${i + 1}.${j + 1}. ${sq.title}${getStatusIcon(sq.status)}\n`;
    });
  });
  md += `\n---\n\n`;

  plan.quests.forEach((quest, i) => {
    const completedInQuest = quest.subQuests.filter(sq => sq.status === 'completed').length;
    md += `## Quest ${i + 1}: ${quest.title}\n\n`;
    md += `**Complexity:** ${quest.complexity} | **Progress:** ${completedInQuest}/${quest.subQuests.length}\n\n`;
    md += `${quest.description}\n\n`;

    quest.subQuests.forEach((sq, j) => {
      const icon = getStatusIcon(sq.status);
      md += `### ${i + 1}.${j + 1}. ${sq.title}${icon}\n\n`;
      md += `- **Status:** ${getStatusLabel(sq.status)}\n`;
      if (sq.startedAt) {
        md += `- **Started:** ${new Date(sq.startedAt).toLocaleString()}\n`;
      }
      md += `\n`;
    });

    md += `---\n\n`;
  });

  return md;
}

export function questPlanToJSON(plan: IQuestMasterPlanDocument): string {
  const exportData = {
    exportedAt: new Date().toISOString(),
    format: 'questmaster-v1',
    goal: plan.goal,
    state: plan.state || 'active',
    priority: plan.priority,
    tags: plan.tags || [],
    metrics: plan.metrics
      ? {
          completionRate: plan.metrics.completionRate,
          subQuestsCompleted: plan.metrics.subQuestsCompleted,
          subQuestsTotal: plan.metrics.subQuestsTotal,
          totalTimeSpent: plan.metrics.totalTimeSpent,
        }
      : undefined,
    quests: plan.quests.map(q => ({
      id: q.id,
      title: q.title,
      description: q.description,
      complexity: q.complexity,
      subQuests: q.subQuests.map(sq => ({
        id: sq.id,
        title: sq.title,
        status: sq.status,
        startedAt: sq.startedAt ? new Date(sq.startedAt).toISOString() : undefined,
      })),
    })),
  };

  return JSON.stringify(exportData, null, 2);
}

interface CsvRow {
  'Quest #': number;
  'Quest Title': string;
  Complexity: string;
  'Sub-Quest #': number;
  'Sub-Quest Title': string;
  Status: string;
  'Started At': string;
}

export function questPlanToCSV(plan: IQuestMasterPlanDocument): string {
  const rows: CsvRow[] = plan.quests.flatMap((quest, i) =>
    quest.subQuests.map((sq, j) => ({
      'Quest #': i + 1,
      'Quest Title': quest.title,
      Complexity: quest.complexity,
      'Sub-Quest #': j + 1,
      'Sub-Quest Title': sq.title,
      Status: getStatusLabel(sq.status),
      'Started At': sq.startedAt ? new Date(sq.startedAt).toISOString() : '',
    }))
  );

  return Papa.unparse(rows);
}

// PDF layout constants (A4, mm units)
const PDF_MARGIN = 15;
const PDF_PAGE_WIDTH = 210;
const PDF_PAGE_HEIGHT = 297;
const PDF_CONTENT_WIDTH = PDF_PAGE_WIDTH - PDF_MARGIN * 2;
const PDF_LINE_HEIGHT = 1.4;

interface PdfCursor {
  y: number;
}

type JsPDFInstance = InstanceType<typeof import('jspdf').jsPDF>;

function ensureSpace(doc: JsPDFInstance, cursor: PdfCursor, needed: number): void {
  if (cursor.y + needed > PDF_PAGE_HEIGHT - PDF_MARGIN) {
    doc.addPage();
    cursor.y = PDF_MARGIN;
  }
}

function addWrappedText(
  doc: JsPDFInstance,
  cursor: PdfCursor,
  text: string,
  fontSize: number,
  opts?: { bold?: boolean; color?: [number, number, number] }
): void {
  doc.setFontSize(fontSize);
  doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
  if (opts?.color) {
    doc.setTextColor(...opts.color);
  } else {
    doc.setTextColor(51, 51, 51);
  }

  const lineHeight = fontSize * 0.3528 * PDF_LINE_HEIGHT; // pt -> mm with spacing
  const lines: string[] = doc.splitTextToSize(text, PDF_CONTENT_WIDTH);

  for (const line of lines) {
    ensureSpace(doc, cursor, lineHeight);
    doc.text(line, PDF_MARGIN, cursor.y);
    cursor.y += lineHeight;
  }
}

function addSeparator(doc: JsPDFInstance, cursor: PdfCursor): void {
  cursor.y += 2;
  ensureSpace(doc, cursor, 2);
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.3);
  doc.line(PDF_MARGIN, cursor.y, PDF_PAGE_WIDTH - PDF_MARGIN, cursor.y);
  cursor.y += 4;
}

export async function questPlanToPdf(plan: IQuestMasterPlanDocument, filename: string): Promise<void> {
  const { downloadData } = await import('@client/app/utils/download');
  const { jsPDF } = await import('jspdf');

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const cursor: PdfCursor = { y: PDF_MARGIN };

  const dateStr = new Date().toISOString().split('T')[0];
  const totalSubQuests = plan.quests.reduce((sum, q) => sum + q.subQuests.length, 0);
  const completedSubQuests = plan.quests.reduce(
    (sum, q) => sum + q.subQuests.filter(sq => sq.status === 'completed').length,
    0
  );

  addWrappedText(doc, cursor, plan.goal, 20, { bold: true });
  cursor.y += 3;

  let meta = `Exported from QuestMaster on ${dateStr}  |  Status: ${plan.state || 'active'}  |  Progress: ${completedSubQuests}/${totalSubQuests} tasks`;
  if (plan.metrics?.completionRate !== undefined) {
    meta += ` (${plan.metrics.completionRate}%)`;
  }
  addWrappedText(doc, cursor, meta, 9, { color: [120, 120, 120] });

  if (plan.tags && plan.tags.length > 0) {
    cursor.y += 1;
    addWrappedText(doc, cursor, `Tags: ${plan.tags.join(', ')}`, 9, { color: [120, 120, 120] });
  }

  addSeparator(doc, cursor);

  addWrappedText(doc, cursor, 'Table of Contents', 14, { bold: true });
  cursor.y += 2;

  plan.quests.forEach((quest, i) => {
    addWrappedText(doc, cursor, `${i + 1}. ${quest.title} (${quest.complexity})`, 10, { bold: true });
    quest.subQuests.forEach((sq, j) => {
      const statusLabel = getStatusLabel(sq.status);
      addWrappedText(doc, cursor, `    ${i + 1}.${j + 1}. ${sq.title} — ${statusLabel}`, 9);
    });
    cursor.y += 1;
  });

  addSeparator(doc, cursor);

  plan.quests.forEach((quest, i) => {
    const completedInQuest = quest.subQuests.filter(sq => sq.status === 'completed').length;

    ensureSpace(doc, cursor, 20);
    addWrappedText(doc, cursor, `Quest ${i + 1}: ${quest.title}`, 14, { bold: true });
    cursor.y += 1;
    addWrappedText(
      doc,
      cursor,
      `Complexity: ${quest.complexity}  |  Progress: ${completedInQuest}/${quest.subQuests.length}`,
      9,
      { color: [100, 100, 100] }
    );
    cursor.y += 1;
    addWrappedText(doc, cursor, quest.description, 10);
    cursor.y += 3;

    quest.subQuests.forEach((sq, j) => {
      ensureSpace(doc, cursor, 12);
      addWrappedText(doc, cursor, `${i + 1}.${j + 1}. ${sq.title}`, 11, { bold: true });
      addWrappedText(doc, cursor, `Status: ${getStatusLabel(sq.status)}`, 9, { color: [100, 100, 100] });
      if (sq.startedAt) {
        addWrappedText(doc, cursor, `Started: ${new Date(sq.startedAt).toLocaleString()}`, 9, {
          color: [100, 100, 100],
        });
      }
      cursor.y += 2;
    });

    addSeparator(doc, cursor);
  });

  const pdfBlob = doc.output('blob');
  downloadData(pdfBlob, `${filename}.pdf`, 'application/pdf');
}

export async function questPlanToExcel(plan: IQuestMasterPlanDocument, filename: string): Promise<void> {
  const { downloadData } = await import('@client/app/utils/download');

  const dateStr = new Date().toISOString().split('T')[0];
  const totalSubQuests = plan.quests.reduce((sum, q) => sum + q.subQuests.length, 0);
  const completedSubQuests = plan.quests.reduce(
    (sum, q) => sum + q.subQuests.filter(sq => sq.status === 'completed').length,
    0
  );

  const overviewData = [
    { Field: 'Goal', Value: plan.goal },
    { Field: 'Status', Value: plan.state || 'active' },
    { Field: 'Priority', Value: plan.priority || 'medium' },
    {
      Field: 'Progress',
      Value: `${completedSubQuests}/${totalSubQuests} tasks${plan.metrics?.completionRate !== undefined ? ` (${plan.metrics.completionRate}%)` : ''}`,
    },
    { Field: 'Tags', Value: plan.tags?.join(', ') || '' },
    { Field: 'Exported', Value: dateStr },
  ];

  const detailsData = plan.quests.flatMap((quest, i) =>
    quest.subQuests.map((sq, j) => ({
      'Quest #': i + 1,
      'Quest Title': quest.title,
      Complexity: quest.complexity,
      'SubQuest #': j + 1,
      'SubQuest Title': sq.title,
      Status: getStatusLabel(sq.status),
      'Started At': sq.startedAt ? new Date(sq.startedAt).toISOString() : '',
    }))
  );

  const workbook = XLSX.utils.book_new();

  const overviewSheet = XLSX.utils.json_to_sheet(overviewData);
  overviewSheet['!cols'] = [{ wch: 15 }, { wch: 60 }];
  XLSX.utils.book_append_sheet(workbook, overviewSheet, 'Overview');

  const detailsSheet = XLSX.utils.json_to_sheet(detailsData);
  detailsSheet['!cols'] = [{ wch: 8 }, { wch: 30 }, { wch: 12 }, { wch: 10 }, { wch: 35 }, { wch: 12 }, { wch: 22 }];
  XLSX.utils.book_append_sheet(workbook, detailsSheet, 'Quest Details');

  const excelBuffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([excelBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  downloadData(blob, `${filename}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
}

/**
 * Get background color for status-based cell shading.
 */
function getStatusCellShading(status: SubQuestStatus): { fill: string } {
  const fill =
    status in DocxColors.statusBackground
      ? DocxColors.statusBackground[status as SubQuestStatusType]
      : DocxColors.statusBackground.not_started;
  return { fill };
}

/**
 * Get text color for status-based text styling.
 */
function getStatusTextColor(status: SubQuestStatus): string {
  return status in DocxColors.status ? DocxColors.status[status as SubQuestStatusType] : DocxColors.status.not_started;
}

export async function questPlanToDocx(plan: IQuestMasterPlanDocument, filename: string): Promise<void> {
  const { downloadData } = await import('@client/app/utils/download');

  const dateStr = new Date().toISOString().split('T')[0];
  const totalSubQuests = plan.quests.reduce((sum, q) => sum + q.subQuests.length, 0);
  const completedSubQuests = plan.quests.reduce(
    (sum, q) => sum + q.subQuests.filter(sq => sq.status === 'completed').length,
    0
  );

  const children: (Paragraph | Table)[] = [];

  children.push(
    new Paragraph({
      children: [new TextRun({ text: plan.goal, bold: true, size: DocxFontSizes.title })],
      heading: HeadingLevel.TITLE,
      spacing: { after: DocxSpacing.afterTitle },
    })
  );

  let metaText = `Exported from QuestMaster on ${dateStr}  |  Status: ${plan.state || 'active'}  |  Progress: ${completedSubQuests}/${totalSubQuests} tasks`;
  if (plan.metrics?.completionRate !== undefined) {
    metaText += ` (${plan.metrics.completionRate}%)`;
  }
  children.push(
    new Paragraph({
      children: [new TextRun({ text: metaText, italics: true, size: DocxFontSizes.small, color: DocxColors.metadata })],
      spacing: { after: DocxSpacing.afterHeading },
    })
  );

  if (plan.tags && plan.tags.length > 0) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Tags: ${plan.tags.join(', ')}`,
            italics: true,
            size: DocxFontSizes.small,
            color: DocxColors.metadata,
          }),
        ],
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
      children: [new TextRun({ text: 'Table of Contents', bold: true, size: DocxFontSizes.heading2 })],
      heading: HeadingLevel.HEADING_2,
      spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterHeading },
    })
  );

  plan.quests.forEach((quest, i) => {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `${i + 1}. ${quest.title} (${quest.complexity})`, bold: true, size: DocxFontSizes.body }),
        ],
        spacing: { before: 80 },
      })
    );
    quest.subQuests.forEach((sq, j) => {
      const statusIcon = STATUS_ICONS[sq.status] || '';
      const statusColor = getStatusTextColor(sq.status);
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `    ${i + 1}.${j + 1}. ${sq.title}`, size: DocxFontSizes.small }),
            new TextRun({ text: statusIcon, size: DocxFontSizes.small, color: statusColor }),
          ],
        })
      );
    });
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

  plan.quests.forEach((quest, i) => {
    const completedInQuest = quest.subQuests.filter(sq => sq.status === 'completed').length;

    children.push(
      new Paragraph({
        children: [new TextRun({ text: `Quest ${i + 1}: ${quest.title}`, bold: true, size: DocxFontSizes.heading2 })],
        heading: HeadingLevel.HEADING_2,
        spacing: { before: DocxSpacing.afterTitle, after: DocxSpacing.afterHeading },
      })
    );

    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: `Complexity: ${quest.complexity}  |  Progress: ${completedInQuest}/${quest.subQuests.length}`,
            size: DocxFontSizes.small,
            color: DocxColors.metadata,
          }),
        ],
        spacing: { after: DocxSpacing.afterHeading },
      })
    );

    children.push(
      new Paragraph({
        children: [new TextRun({ text: quest.description, size: DocxFontSizes.body })],
        spacing: { after: DocxSpacing.afterTitle },
      })
    );

    const tableRows = [
      new TableRow({
        children: [
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: '#', bold: true, size: DocxFontSizes.small })] }),
            ],
            width: { size: 5, type: WidthType.PERCENTAGE },
            shading: { fill: DocxColors.tableHeader },
          }),
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'SubQuest', bold: true, size: DocxFontSizes.small })] }),
            ],
            width: { size: 50, type: WidthType.PERCENTAGE },
            shading: { fill: DocxColors.tableHeader },
          }),
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Status', bold: true, size: DocxFontSizes.small })] }),
            ],
            width: { size: 20, type: WidthType.PERCENTAGE },
            shading: { fill: DocxColors.tableHeader },
          }),
          new TableCell({
            children: [
              new Paragraph({ children: [new TextRun({ text: 'Started', bold: true, size: DocxFontSizes.small })] }),
            ],
            width: { size: 25, type: WidthType.PERCENTAGE },
            shading: { fill: DocxColors.tableHeader },
          }),
        ],
      }),
      ...quest.subQuests.map(
        (sq, j) =>
          new TableRow({
            children: [
              new TableCell({
                children: [
                  new Paragraph({
                    children: [new TextRun({ text: `${i + 1}.${j + 1}`, size: DocxFontSizes.small })],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
              }),
              new TableCell({
                children: [new Paragraph({ children: [new TextRun({ text: sq.title, size: DocxFontSizes.small })] })],
              }),
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: getStatusLabel(sq.status),
                        size: DocxFontSizes.small,
                        color: getStatusTextColor(sq.status),
                        bold: true,
                      }),
                    ],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
                shading: getStatusCellShading(sq.status),
              }),
              new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: sq.startedAt ? new Date(sq.startedAt).toLocaleDateString() : '-',
                        size: DocxFontSizes.small,
                      }),
                    ],
                    alignment: AlignmentType.CENTER,
                  }),
                ],
              }),
            ],
          })
      ),
    ];

    children.push(
      new Table({
        rows: tableRows,
        width: { size: 100, type: WidthType.PERCENTAGE },
        borders: {
          top: { style: BorderStyle.SINGLE, size: 1, color: DocxColors.tableBorder },
          bottom: { style: BorderStyle.SINGLE, size: 1, color: DocxColors.tableBorder },
          left: { style: BorderStyle.SINGLE, size: 1, color: DocxColors.tableBorder },
          right: { style: BorderStyle.SINGLE, size: 1, color: DocxColors.tableBorder },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 1, color: DocxColors.tableBorder },
          insideVertical: { style: BorderStyle.SINGLE, size: 1, color: DocxColors.tableBorder },
        },
      })
    );

    children.push(new Paragraph({ children: [], spacing: { after: DocxSpacing.sectionGap } }));
  });

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  const docxBlob = await Packer.toBlob(doc);
  downloadData(docxBlob, `${filename}.docx`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
}
