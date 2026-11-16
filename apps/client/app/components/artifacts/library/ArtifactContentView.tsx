import React from 'react';
import dynamic from 'next/dynamic';
import { Box, CircularProgress } from '@mui/joy';
import { HtmlArtifactSchema, PythonArtifactSchema, ReactArtifactSchema, SvgArtifactSchema } from '@bike4mind/common';
import type { artifactService } from '@bike4mind/services';

type ArtifactViewerView = artifactService.ArtifactViewerView;
import HighlightedCode from '@client/app/components/common/HighlightedCode';
import ErrorBoundary from '@client/app/components/common/ErrorBoundary';

const ViewerLoading = () => (
  <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
    <CircularProgress size="sm" />
  </Box>
);

// Same lazy, client-only viewers the notebook's KnowledgeViewer uses.
const HtmlArtifactViewer = dynamic(() => import('@client/app/components/Knowledge/HtmlArtifactViewer'), {
  ssr: false,
  loading: ViewerLoading,
});
const SvgArtifactViewer = dynamic(() => import('@client/app/components/Knowledge/SvgArtifactViewer'), {
  ssr: false,
  loading: ViewerLoading,
});
const ReactArtifactViewer = dynamic(() => import('@client/app/components/Knowledge/ReactArtifactViewer'), {
  ssr: false,
  loading: ViewerLoading,
});
const PythonArtifactViewer = dynamic(() => import('@client/app/components/Knowledge/PythonArtifactViewer'), {
  ssr: false,
  loading: ViewerLoading,
});
const MermaidChart = dynamic(() => import('@client/app/components/Charts/MermaidChart'), {
  ssr: false,
  loading: ViewerLoading,
});
const RechartsRenderer = dynamic(() => import('@client/app/components/Charts/RechartsRenderer'), {
  ssr: false,
  loading: ViewerLoading,
});

type ArtifactContentViewProps = {
  /** Only the fields a public-only reader also gets, so any read access can render. */
  artifact: ArtifactViewerView;
  content: string;
};

/**
 * Renders a stored artifact's content with the viewer for its type. The viewers take the legacy
 * in-chat artifact shape, so the stored document is mapped onto it through that type's schema
 * (which also fills the metadata defaults); a type with no viewer, or a document the schema
 * rejects, falls back to its source.
 */
export const ArtifactContentView: React.FC<ArtifactContentViewProps> = ({ artifact, content }) => {
  const viewerInput = {
    id: artifact.id,
    title: artifact.title,
    content,
    version: artifact.version,
    metadata: artifact.metadata ?? {},
    createdAt: new Date(artifact.createdAt),
    updatedAt: new Date(artifact.updatedAt),
  };

  const renderViewer = (): React.ReactNode => {
    switch (artifact.type) {
      case 'html': {
        const parsed = HtmlArtifactSchema.safeParse({ ...viewerInput, type: 'html' });
        return parsed.success ? <HtmlArtifactViewer artifact={parsed.data} /> : null;
      }
      case 'svg': {
        const parsed = SvgArtifactSchema.safeParse({ ...viewerInput, type: 'svg' });
        return parsed.success ? <SvgArtifactViewer artifact={parsed.data} /> : null;
      }
      case 'react': {
        const parsed = ReactArtifactSchema.safeParse({ ...viewerInput, type: 'react' });
        return parsed.success ? <ReactArtifactViewer artifact={parsed.data} /> : null;
      }
      case 'python': {
        const parsed = PythonArtifactSchema.safeParse({ ...viewerInput, type: 'python' });
        return parsed.success ? <PythonArtifactViewer artifact={parsed.data} /> : null;
      }
      case 'mermaid':
        return <MermaidChart chartDefinition={content} />;
      case 'recharts':
        return <RechartsRenderer config={content} title={artifact.title} forceMode="artifact" />;
      default:
        return null;
    }
  };

  const viewer = renderViewer();
  const language = typeof artifact.metadata?.language === 'string' ? artifact.metadata.language : undefined;

  return (
    <Box sx={{ width: '100%', height: '100%', minHeight: 0 }} data-testid="artifact-content-view">
      {viewer ? (
        <ErrorBoundary fallback={<HighlightedCode code={content} wrapLongLines />}>{viewer}</ErrorBoundary>
      ) : (
        <HighlightedCode code={content} language={language} wrapLongLines />
      )}
    </Box>
  );
};

export default ArtifactContentView;
