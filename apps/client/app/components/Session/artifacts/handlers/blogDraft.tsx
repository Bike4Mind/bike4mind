import React from 'react';
import { Box, Typography } from '@mui/joy';
import ContentTransformPreviewCard from '@client/app/components/GenAI/ContentTransformPreviewCard';
import { registerArtifactType, type ArtifactPreviewProps } from '../registry';

interface BlogDraftContent {
  title: string;
  content: string;
  summary: string;
  suggestedTags: string[];
}

/**
 * Renders a blog/social draft produced by the `blog_draft` tool. The artifact
 * content is the JSON payload `{ title, content, summary, suggestedTags }`
 * emitted inside the tool's <artifact> tag. Card UI is delegated to
 * ContentTransformPreviewCard, which owns the review/publish modal.
 */
const BlogDraftPreviewCard: React.FC<ArtifactPreviewProps> = ({ artifact, artifactId }) => {
  let parsed: Partial<BlogDraftContent> | null = null;
  let parseError: unknown = null;

  try {
    parsed = JSON.parse(artifact.content) as Partial<BlogDraftContent>;
  } catch (error) {
    parseError = error;
  }

  if (parseError || !parsed?.title || !parsed?.content) {
    if (parseError) {
      console.error('Error parsing blog draft artifact:', parseError);
    }
    return (
      <Box
        data-testid="artifact-preview-blog-draft-error"
        sx={{ my: 2, p: 2, border: '1px solid', borderColor: 'danger.300', borderRadius: 'sm' }}
      >
        <Typography level="body-sm" color="danger">
          Error rendering blog draft
        </Typography>
      </Box>
    );
  }

  return (
    <Box data-testid={`artifact-preview-blog-draft-${artifactId}`} sx={{ my: 2 }}>
      <ContentTransformPreviewCard
        data={{
          title: parsed.title,
          content: parsed.content,
          summary: parsed.summary || '',
          suggestedTags: Array.isArray(parsed.suggestedTags) ? parsed.suggestedTags : [],
        }}
      />
    </Box>
  );
};

registerArtifactType({ type: 'blog-draft', PreviewCard: BlogDraftPreviewCard });
