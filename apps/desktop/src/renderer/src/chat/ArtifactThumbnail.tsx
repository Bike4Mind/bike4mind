import { useEffect, useRef, useState, type RefObject } from 'react';
import Box from '@mui/joy/Box';
import Typography from '@mui/joy/Typography';
import type { ChatArtifactView } from '@shared/chat';
import { SvgArtifact } from './ArtifactCard';
import { HtmlArtifactFrame } from './HtmlArtifactFrame';
import { renderMermaidDiagram } from './mermaidDiagram';

/** The page size an HTML thumbnail is laid out at before it is scaled down to the card. */
const PAGE_WIDTH = 1280;
const PAGE_HEIGHT = 800;
const SNIPPET_LINES = 14;

/**
 * Whether `target` is on screen or within `margin` of it. True where IntersectionObserver does
 * not exist, so a host without one draws everything rather than nothing.
 */
export function useNearViewport(target: RefObject<Element | null>, margin = '200px'): boolean {
  const [near, setNear] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    const el = target.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), {
      rootMargin: margin,
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [target, margin]);
  return near;
}

/**
 * A live page shrunk to the card: laid out at desktop width, then scaled, so the thumbnail is the
 * page's real composition rather than its mobile reflow. Mounted only while near the viewport -
 * every frame is a running document, and a library is a hundred of them.
 */
function PagePreview({ artifact }: { artifact: ChatArtifactView }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setScale(el.clientWidth / PAGE_WIDTH);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <Box ref={box} sx={{ position: 'absolute', inset: 0, overflow: 'hidden', bgcolor: 'common.white' }}>
      {scale > 0 && (
        <Box
          sx={{
            width: PAGE_WIDTH,
            height: PAGE_HEIGHT,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
        >
          <HtmlArtifactFrame content={artifact.content} title={artifact.title} height={PAGE_HEIGHT} preview />
        </Box>
      )}
    </Box>
  );
}

// Keyed on id and mode: a diagram scrolled out and back, or met again on reopening, is not recompiled.
const diagramCache = new Map<string, string | null>();

function DiagramPreview({ artifact, mode }: { artifact: ChatArtifactView; mode: 'light' | 'dark' }) {
  const key = `${artifact.id}:${mode}`;
  const [svg, setSvg] = useState<string | null | undefined>(() => diagramCache.get(key));

  useEffect(() => {
    if (diagramCache.has(key)) {
      setSvg(diagramCache.get(key));
      return;
    }
    let live = true;
    void renderMermaidDiagram(artifact.content, mode).then(result => {
      const drawn = result.ok ? result.svg : null;
      diagramCache.set(key, drawn);
      if (live) setSvg(drawn);
    });
    return () => {
      live = false;
    };
  }, [artifact.content, key, mode]);

  if (svg === undefined) return null;
  if (svg === null) return <SourcePreview content={artifact.content} />;
  return <SvgArtifact content={svg} title={artifact.title} fill testId="artifact-library-thumb-image" />;
}

/** Source as text, which React escapes: the first lines, fading out where the card ends. */
function SourcePreview({ content }: { content: string }) {
  const snippet = content.split('\n', SNIPPET_LINES).join('\n');
  return (
    <Typography
      component="pre"
      level="body-xs"
      fontFamily="monospace"
      textColor="text.secondary"
      sx={{
        m: 0,
        p: 1.25,
        height: '100%',
        fontSize: 10,
        lineHeight: 1.45,
        whiteSpace: 'pre',
        overflow: 'hidden',
        maskImage: 'linear-gradient(to bottom, black 55%, transparent)',
      }}
      data-testid="artifact-library-thumb-source"
    >
      {snippet}
    </Typography>
  );
}

/** What a card's thumbnail draws once its body has arrived, by the same rules the full view uses. */
export function ArtifactThumbnail({ artifact, mode }: { artifact: ChatArtifactView; mode: 'light' | 'dark' }) {
  if (artifact.type === 'html') return <PagePreview artifact={artifact} />;
  if (artifact.type === 'svg')
    return <SvgArtifact content={artifact.content} title={artifact.title} fill testId="artifact-library-thumb-image" />;
  if (artifact.type === 'mermaid') return <DiagramPreview artifact={artifact} mode={mode} />;
  return <SourcePreview content={artifact.content} />;
}
