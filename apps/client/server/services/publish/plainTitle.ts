/**
 * A reply-derived title without its inline markdown markers ("Recap: *Tides*" -> "Recap: Tides").
 * Titles render as plain text (the page <title>, the viewer header, link-preview cards), where the
 * markers would show literally. Not for fabfile titles: a file name's underscores are not emphasis.
 */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
    .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
    .trim();
}
