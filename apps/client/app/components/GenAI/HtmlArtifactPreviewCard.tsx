import React from 'react';
import { Typography } from '@mui/joy';
import { type HtmlArtifact } from '@bike4mind/common';
import InlineArtifactPreview from './InlineArtifactPreview';
import ArtifactPreviewCard from './ArtifactPreviewCard';

interface HtmlArtifactPreviewCardProps {
  artifact: HtmlArtifact;
  onExpand?: () => void;
}

const HtmlArtifactPreviewCard: React.FC<HtmlArtifactPreviewCardProps> = ({ artifact, onExpand }) => {
  const lineCount = artifact.content.split('\n').length;
  const titleMatch = artifact.content.match(/<title>(.*?)<\/title>/i);
  const htmlTitle = titleMatch ? titleMatch[1] : null;

  return (
    <ArtifactPreviewCard
      artifactId={artifact.id}
      artifactType="html"
      mimeType="text/html"
      artifactContent={artifact}
      contentKey={artifact.content}
      title={artifact.title}
      chipLabel="HTML"
      testIdPrefix="html"
      source={artifact.content}
      copyTooltip="Copy HTML to clipboard"
      copyMessage="HTML code copied to clipboard"
      saveTooltip="Save as HTML file"
      saveFile={() => ({
        fileName: `${artifact.title.toLowerCase().replace(/\s+/g, '_')}_${Date.now()}.html`,
        mimeType: 'text/html',
        successMessage: 'Saved HTML as file',
      })}
      actions={{ copy: true, save: true, codeToggle: true }}
      // Users asking for an "article" should see the article, not a wall of HTML.
      defaultRenderedView
      stats={
        <>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            {lineCount} lines
          </Typography>
          {htmlTitle && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
              {htmlTitle}
            </Typography>
          )}
        </>
      }
      renderPreview={() => (
        <InlineArtifactPreview
          artifact={artifact}
          type="html"
          maxHeight={400}
          onError={error => console.error('[HtmlArtifactPreviewCard] Preview error:', error)}
        />
      )}
      onExpand={onExpand}
    />
  );
};

export default HtmlArtifactPreviewCard;
