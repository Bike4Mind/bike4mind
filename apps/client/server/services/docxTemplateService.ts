/**
 * DOCX Template Service
 *
 * Validates user-uploaded Word template files for DOCX export customization.
 */

/**
 * Valid MIME types for DOCX/DOTX template files.
 */
export const VALID_DOCX_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template', // .dotx
] as const;

/**
 * Maximum file size for DOCX templates (10MB).
 */
export const MAX_DOCX_TEMPLATE_SIZE = 10 * 1024 * 1024;

/**
 * Validates MIME type for DOCX/DOTX files.
 */
export function isValidDocxMimeType(mimeType: string): boolean {
  return (VALID_DOCX_MIME_TYPES as readonly string[]).includes(mimeType);
}
