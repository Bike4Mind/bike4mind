import React from 'react';
import { type HtmlArtifact } from '@bike4mind/common';
import InlineArtifactPreview from './InlineArtifactPreview';
import ArtifactPreviewCard from './ArtifactPreviewCard';
import { artifactFileName } from '@client/app/utils/artifactFileName';

interface HtmlArtifactPreviewCardProps {
  artifact: HtmlArtifact;
  onExpand?: () => void;
}

const HtmlArtifactPreviewCard: React.FC<HtmlArtifactPreviewCardProps> = ({ artifact, onExpand }) => {
  return (
    <ArtifactPreviewCard
      sourceLanguage="html"
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
        fileName: artifactFileName(artifact.title, 'html', 'html-document'),
        mimeType: 'text/html',
        successMessage: 'Saved HTML as file',
      })}
      actions={{ copy: true, save: true }}
      // Users asking for an "article" should see the article, not a wall of HTML.
      defaultRenderedView
      renderPreview={() => (
        <InlineArtifactPreview
          artifact={artifact}
          type="html"
          maxHeight={420}
          onError={error => console.error('[HtmlArtifactPreviewCard] Preview error:', error)}
        />
      )}
      onExpand={onExpand}
    />
  );
};

export default HtmlArtifactPreviewCard;
