/**
 * Trimmed body of the first ```mermaid fence in `content`, or null when there is none. Shared by
 * KnowledgeViewer and MarkdownViewer. The body has no surrounding whitespace consumers because
 * they backtrack quadratically on an unclosed fence, and the trim makes them redundant.
 */
export function extractMermaidFence(content: string): string | null {
  const match = content.match(/```mermaid([\s\S]*?)```/);
  return match ? match[1].trim() : null;
}
