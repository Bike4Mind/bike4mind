export const detectContentType = (content: string): string => {
  if (content.includes('def ') || (content.includes('import ') && content.includes(':'))) return 'python';
  if (content.includes('function ') || content.includes('class ') || content.includes('import ')) return 'typescript';
  if (content.startsWith('{') || content.startsWith('[')) return 'json';
  if (content.includes('public class ')) return 'java';
  return 'text';
};

export const detectChatContentType = (content: string): string => {
  // Check for markdown patterns
  if (content.includes('# ') || content.includes('## ') || content.includes('### ')) {
    return 'Markdown';
  }

  // Check for code blocks
  if (content.includes('```')) {
    return 'Code';
  }

  // Default to text
  return 'Text';
};
