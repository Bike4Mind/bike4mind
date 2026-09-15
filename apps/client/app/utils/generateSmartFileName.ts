import { api } from '@client/app/contexts/ApiContext';

interface SmartFileNameContext {
  chatHistory?: { prompt: string }[];
  hasSession?: boolean;
}

/**
 * Generate a smart file name using AI based on content type and conversation context.
 */
export async function generateSmartFileName(
  content: string,
  fileType: 'image' | 'text',
  context?: SmartFileNameContext
): Promise<string> {
  try {
    let prompt: string;

    if (fileType === 'image') {
      // For images, use conversation context if available
      const contextPrompt =
        context?.hasSession && context.chatHistory && context.chatHistory.length > 0
          ? `Based on this conversation context: "${context.chatHistory
              .slice(-3)
              .map(h => h.prompt)
              .join(' ')}", suggest a filename for a pasted image.`
          : 'Suggest a filename for a pasted image.';

      prompt = `${contextPrompt} Output only the filename without extension, max 5 words, lowercase with hyphens between words.`;
    } else {
      // For text, analyze the content
      const preview = content.slice(0, 500); // First 500 chars for context
      prompt = `Based on this text content, suggest a descriptive filename: "${preview}". Output only the filename without extension, max 5 words, lowercase with hyphens between words.`;
    }

    const response = await api.post('/api/files/generate-smart-name', {
      prompt,
      fileType,
    });

    console.log('Smart name API response:', response.data);
    const filename = response.data.name;
    return filename
      ? fileType === 'image'
        ? `${filename}.png`
        : `${filename}.txt`
      : fileType === 'image'
        ? `pasted-image-${Date.now()}.png`
        : `pasted-text-${Date.now()}.txt`;
  } catch (error) {
    console.error('Failed to generate smart filename:', error);
    // Fallback to timestamp-based names
    return fileType === 'image' ? `pasted-image-${Date.now()}.png` : `pasted-text-${Date.now()}.txt`;
  }
}
