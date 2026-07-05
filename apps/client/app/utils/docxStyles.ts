/**
 * Centralized DOCX styling constants for consistent document exports.
 * Used by sessionExport, questExport, and bulkNotebookExport.
 */

/**
 * Color palette for DOCX exports (hex without #).
 * Half-point sizes: multiply desired pt by 2 (e.g., 12pt = 24).
 */
export const DocxColors = {
  // Role-based message colors (text + background)
  userMessage: { text: '2E7D32', background: 'E8F5E9' },
  assistantMessage: { text: '1565C0', background: 'E3F2FD' },
  systemMessage: { text: '757575', background: 'F5F5F5' },

  // Status colors for quest tables
  status: {
    completed: '4CAF50',
    in_progress: 'FF9800',
    not_started: '9E9E9E',
    skipped: '607D8B',
    deleted: 'F44336',
  },

  // Status background colors (lighter versions for cell shading)
  statusBackground: {
    completed: 'E8F5E9',
    in_progress: 'FFF3E0',
    not_started: 'FAFAFA',
    skipped: 'ECEFF1',
    deleted: 'FFEBEE',
  },

  // Structural colors
  metadata: '666666',
  timestamp: '999999',
  separator: 'CCCCCC',
  tableHeader: 'E0E0E0',
  tableBorder: 'CCCCCC',
  divider: 'E0E0E0',

  // Message border colors (left accent)
  messageBorder: {
    user: '4CAF50',
    assistant: '2196F3',
    system: '9E9E9E',
  },
} as const;

/**
 * Font sizes in half-points (Word uses half-points internally).
 * To get point size: divide by 2 (e.g., 48 = 24pt).
 */
export const DocxFontSizes = {
  title: 48, // 24pt
  heading1: 36, // 18pt
  heading2: 28, // 14pt
  heading3: 24, // 12pt
  body: 22, // 11pt
  small: 20, // 10pt
  metadata: 18, // 9pt
} as const;

/**
 * Spacing values in twips (1/20th of a point).
 * Common conversions: 100 twips ≈ 5pt, 200 twips ≈ 10pt.
 */
export const DocxSpacing = {
  afterTitle: 200,
  afterHeading: 100,
  afterParagraph: 150,
  sectionGap: 300,
  messageGap: 200,
  // Role label spacing
  beforeRole: 150,
  afterRole: 50,
} as const;

/**
 * Border sizes in eighths of a point.
 * 8 = 1pt border, 16 = 2pt border.
 */
export const DocxBorderSizes = {
  thin: 4, // 0.5pt
  normal: 8, // 1pt
  thick: 16, // 2pt
  accent: 24, // 3pt (for message left borders)
} as const;

/**
 * Table column widths as percentages (for quest exports).
 */
export const DocxTableWidths = {
  questNumber: 10,
  questTitle: 50,
  questStatus: 20,
  questNotes: 20,
} as const;

/**
 * Role display names and their styling info.
 */
export const DocxRoleStyles = {
  user: {
    label: 'User',
    textColor: DocxColors.userMessage.text,
    backgroundColor: DocxColors.userMessage.background,
    borderColor: DocxColors.messageBorder.user,
  },
  assistant: {
    label: 'Assistant',
    textColor: DocxColors.assistantMessage.text,
    backgroundColor: DocxColors.assistantMessage.background,
    borderColor: DocxColors.messageBorder.assistant,
  },
  system: {
    label: 'System',
    textColor: DocxColors.systemMessage.text,
    backgroundColor: DocxColors.systemMessage.background,
    borderColor: DocxColors.messageBorder.system,
  },
} as const;

export type MessageRole = keyof typeof DocxRoleStyles;
export type SubQuestStatusType = keyof typeof DocxColors.status;
