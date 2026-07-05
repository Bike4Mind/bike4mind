import { useState, useCallback } from 'react';
import { toast } from 'sonner';
import { enhanceBlogContent } from './data/blog';

export const useBlogContentEnhancement = (
  content: string,
  currentTitle: string,
  currentSummary: string,
  onTitleUpdate: (title: string) => void,
  onSummaryUpdate: (summary: string) => void
) => {
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false);
  const [shimmeringField, setShimmeringField] = useState<string | null>(null);

  const handleGenerateTitle = useCallback(async () => {
    if (!content.trim()) {
      toast.error('Please provide content first');
      return;
    }

    setIsGeneratingTitle(true);
    setShimmeringField('title');

    try {
      toast.info('✨ Generating title from content...');

      const result = await enhanceBlogContent({
        content,
        currentTitle,
        currentSummary,
        enhancementType: 'title',
      });

      if (result.success && result.enhancedTitle) {
        // Delay content update to sync with shimmer animation
        setTimeout(() => {
          onTitleUpdate(result.enhancedTitle!);
        }, 150);
        toast.success('🔥 Title generated successfully!');

        // Clear shimmer after animation completes
        setTimeout(() => {
          setShimmeringField(null);
        }, 800);
      } else {
        toast.error(result.message || 'Failed to generate title');
        setShimmeringField(null);
      }
    } catch (error: any) {
      toast.error('Failed to generate title. Please try again.');
      setShimmeringField(null);
    } finally {
      setIsGeneratingTitle(false);
    }
  }, [content, currentTitle, currentSummary, onTitleUpdate]);

  const handleGenerateSummary = useCallback(async () => {
    if (!content.trim()) {
      toast.error('Please provide content first');
      return;
    }

    setIsGeneratingSummary(true);
    setShimmeringField('summary');

    try {
      toast.info('✨ Generating summary from content...');

      const result = await enhanceBlogContent({
        content,
        currentTitle,
        currentSummary,
        enhancementType: 'summary',
      });

      if (result.success && result.enhancedSummary) {
        // Delay content update to sync with shimmer animation
        setTimeout(() => {
          onSummaryUpdate(result.enhancedSummary!);
        }, 150);
        toast.success('🔥 Summary generated successfully!');

        // Clear shimmer after animation completes
        setTimeout(() => {
          setShimmeringField(null);
        }, 800);
      } else {
        toast.error(result.message || 'Failed to generate summary');
        setShimmeringField(null);
      }
    } catch (error: any) {
      toast.error('Failed to generate summary. Please try again.');
      setShimmeringField(null);
    } finally {
      setIsGeneratingSummary(false);
    }
  }, [content, currentTitle, currentSummary, onSummaryUpdate]);

  return {
    isGeneratingTitle,
    isGeneratingSummary,
    shimmeringField,
    handleGenerateTitle,
    handleGenerateSummary,
  };
};
