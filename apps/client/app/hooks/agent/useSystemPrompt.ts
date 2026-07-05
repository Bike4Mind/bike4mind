import { useState } from 'react';
import { toast } from 'sonner';

export const useSystemPrompt = () => {
  const [isDownloadingSystemPrompt, setIsDownloadingSystemPrompt] = useState(false);

  const handleDownloadSystemPrompt = async (systemPrompt: string, agentName: string) => {
    if (!systemPrompt) {
      toast.error('No system prompt to download');
      return;
    }

    setIsDownloadingSystemPrompt(true);

    try {
      const timestamp = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
      const safeName = agentName.replace(/[^a-zA-Z0-9-_]/g, '-') || 'untitled-agent';
      const filename = `system-prompt-${safeName}-${timestamp}.md`;

      const blob = new Blob([systemPrompt], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;

      document.body.appendChild(link);
      link.click();

      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      toast.success(`System prompt downloaded as ${filename}`);
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download system prompt');
    } finally {
      setIsDownloadingSystemPrompt(false);
    }
  };

  return {
    isDownloadingSystemPrompt,
    handleDownloadSystemPrompt,
  };
};
