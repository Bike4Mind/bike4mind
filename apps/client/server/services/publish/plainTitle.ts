// Private-use delimiter for parked code spans; cannot occur in a title that came from chat text.
const CODE_SPAN_MARK = '\uE000';

/**
 * A reply-derived title without its inline markdown markers ("Recap: *Tides*" -> "Recap: Tides").
 * Titles render as plain text (the page <title>, the viewer header, link-preview cards), where the
 * markers would show literally. Not for fabfile titles: a file name's underscores are not emphasis.
 */
export function stripInlineMarkdown(text: string): string {
  // Code span contents are literal, so park them while the emphasis rules run (`a*b*c` keeps its stars).
  const codeSpans: string[] = [];
  const withoutCode = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    codeSpans.push(code);
    return `${CODE_SPAN_MARK}${codeSpans.length - 1}${CODE_SPAN_MARK}`;
  });

  return (
    withoutCode
      // The URL may hold one level of balanced parentheses: [a](https://x/(y)).
      .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
      .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
      .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
      .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
      .replace(/(^|\W)_(?=\S)(.+?)(?<=\S)_(?!\w)/g, '$1$2')
      .replace(new RegExp(`${CODE_SPAN_MARK}(\\d+)${CODE_SPAN_MARK}`, 'g'), (_match, index: string) => {
        return codeSpans[Number(index)] ?? '';
      })
      .trim()
  );
}
