import React, { useEffect, useRef, useState } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Box, CircularProgress, Typography } from '@mui/joy';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Options as RehypeSanitizeOptions } from 'rehype-sanitize';
import type { PluggableList } from 'unified';
import { useHelpContent } from '@client/app/hooks/useHelpContent';
import { useHelpPanel } from '@client/app/hooks/useHelpPanel';
import { toAnchor, resolveRelativePath, hasVideoExtension } from '@bike4mind/scripts/help/utils';
import { CodeBlock } from '@client/app/components/common/CodeBlock';
import HelpFeedbackWidget from './HelpFeedbackWidget';

// Blocked protocols that should not be navigated to
const BLOCKED_PROTOCOLS = ['javascript:', 'data:', 'vbscript:'];

/**
 * Resolve an internal help link's path portion (anchor already stripped) to a
 * target article slug.
 *
 * Relative links resolve against the current article's FILE path, not its slug:
 * an index page's slug drops the trailing "/index" segment, so slug-based
 * resolution computes the wrong base directory (e.g. from `features/opti`,
 * `./scheduling.md` must resolve to `features/opti/scheduling`, not
 * `features/scheduling`). Falls back to the slug before the file path is known.
 * This mirrors the file-path resolution in validate-help-content.ts so the
 * runtime renderer and the content validator stay in sync.
 */
export function resolveHelpLinkSlug(path: string, currentFilePath: string | undefined, currentSlug: string): string {
  if (path.startsWith('/')) {
    return normalizeResolvedSlug(path.substring(1).replace(/\.md$/, '')); // Absolute path
  }
  const fileBase = currentFilePath ? currentFilePath.replace(/\.md$/, '') : currentSlug;
  return normalizeResolvedSlug(resolveRelativePath(fileBase, path));
}

/**
 * Collapse a trailing "/index" so a relative link TO an index page resolves to
 * its canonical slug (`features/x/index` -> `features/x`), matching
 * `filePathToSlug`. Unlike the validator's `normalizeSlug`, a bare `index` is
 * left intact: the regex requires a leading slash, so root `index` (the
 * renderer's home slug - useHelpPanel's DEFAULT_SLUG) survives untouched, where
 * the validator would map it to ''. Mapping it to '' would break home/root
 * navigation. Kept as a documented sibling of `normalizeSlug` for that reason.
 */
function normalizeResolvedSlug(slug: string): string {
  return slug.replace(/\/index$/, '');
}

// Custom sanitization schema - allows id on headings (anchors) and details/summary (accordions)
// Defined as stable constants outside component to prevent re-renders
const sanitizeSchema: RehypeSanitizeOptions = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames || []), 'details', 'summary'],
  attributes: {
    ...defaultSchema.attributes,
    h1: [...(defaultSchema.attributes?.h1 || []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 || []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 || []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 || []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 || []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 || []), 'id'],
  },
};
// Stable plugin arrays - defined outside component to prevent re-renders.
// Exported so tests can render through the EXACT production pipeline (no drift).
export const remarkPlugins = [remarkGfm];
// rehype-raw must come before rehype-sanitize so raw HTML is parsed before sanitization.
export const rehypePlugins: PluggableList = [rehypeRaw, [rehypeSanitize, sanitizeSchema]];

interface HelpContentProps {
  slug: string;
  anchor?: string;
}

/**
 * Handle link clicks for help content navigation.
 * Uses getState() instead of hooks to avoid useInsertionEffect conflicts during markdown rendering.
 */
const handleLinkClick = (e: React.MouseEvent<HTMLAnchorElement>, href: string | undefined) => {
  if (!href) return;

  // Block dangerous protocols (XSS prevention)
  if (BLOCKED_PROTOCOLS.some(p => href.toLowerCase().startsWith(p))) {
    e.preventDefault();
    return;
  }

  // Check if it's an internal link (relative path or anchor)
  if (href.startsWith('#')) {
    // Anchor link - scroll to element
    e.preventDefault();
    const element = document.getElementById(href.slice(1));
    if (element) {
      element.scrollIntoView({ behavior: 'smooth' });
    }
  } else if (href.startsWith('/') || (!href.startsWith('http') && !href.startsWith('mailto:'))) {
    // Internal link - navigate within help panel
    e.preventDefault();

    // Parse the link to extract path and anchor
    const [path, hash] = href.split('#');

    // Resolve against the current article's file path (falls back to its slug).
    // Uses getState() to avoid hook calls during render - prevents useInsertionEffect conflicts.
    const store = useHelpPanel.getState();
    const slug = resolveHelpLinkSlug(path, store.currentFilePath, store.currentSlug);

    store.navigateTo(slug, hash);
  }
  // External links open normally in new tab
};

/**
 * Custom link component that handles internal navigation.
 * Avoids React hooks to prevent useInsertionEffect conflicts with MUI during markdown rendering.
 */
const CustomLink: React.FC<React.AnchorHTMLAttributes<HTMLAnchorElement>> = ({ href, children, ...props }) => {
  const isExternal = href?.startsWith('http') || href?.startsWith('mailto:');

  return (
    <a
      href={href}
      onClick={e => handleLinkClick(e, href)}
      target={isExternal ? '_blank' : undefined}
      rel={isExternal ? 'noopener noreferrer' : undefined}
      style={{ color: 'var(--joy-palette-primary-500)', textDecoration: 'underline' }}
      {...props}
    >
      {children}
    </a>
  );
};

/**
 * Recursively extract text content from React children (handles nested elements like <strong>)
 */
const getTextContent = (children: React.ReactNode): string => {
  return React.Children.toArray(children)
    .map(child => {
      if (typeof child === 'string') {
        return child;
      }
      if (typeof child === 'number') {
        return String(child);
      }
      if (React.isValidElement<{ children?: React.ReactNode }>(child) && child.props.children) {
        return getTextContent(child.props.children);
      }
      return '';
    })
    .join('');
};

/**
 * Custom heading component that generates anchor IDs
 * Uses the shared toAnchor function to ensure IDs match the precomputed anchors in help-index.json
 */
const createHeadingComponent = (level: 1 | 2 | 3 | 4 | 5 | 6): React.FC<React.HTMLAttributes<HTMLHeadingElement>> => {
  const HeadingComponent: React.FC<React.HTMLAttributes<HTMLHeadingElement>> = ({ children, ...props }) => {
    // Generate anchor from text content (recursively extracts from nested elements)
    // Uses shared toAnchor to match the anchors generated by build-help-index.ts
    const text = getTextContent(children);
    const anchor = toAnchor(text);

    const headingProps = { id: anchor, ...props };

    switch (level) {
      case 1:
        return <h1 {...headingProps}>{children}</h1>;
      case 2:
        return <h2 {...headingProps}>{children}</h2>;
      case 3:
        return <h3 {...headingProps}>{children}</h3>;
      case 4:
        return <h4 {...headingProps}>{children}</h4>;
      case 5:
        return <h5 {...headingProps}>{children}</h5>;
      case 6:
        return <h6 {...headingProps}>{children}</h6>;
      default:
        return <h2 {...headingProps}>{children}</h2>;
    }
  };

  return HeadingComponent;
};

// Pre-create heading components outside render to ensure stable references
const H1 = createHeadingComponent(1);
const H2 = createHeadingComponent(2);
const H3 = createHeadingComponent(3);
const H4 = createHeadingComponent(4);
const H5 = createHeadingComponent(5);
const H6 = createHeadingComponent(6);

// Custom accordion components for <details>/<summary> blocks in markdown.
// Defined at module level (not inside render) to keep references stable.
const DetailsAccordion: React.FC<{ children?: React.ReactNode; node?: unknown }> = ({ children }) => {
  const [expanded, setExpanded] = useState(false);
  // summary is always the first child of details per HTML spec; filter blank text nodes
  const childArray = React.Children.toArray(children).filter(
    child => !(typeof child === 'string' && child.trim() === '')
  );
  const [summaryChild, ...contentChildren] = childArray;
  return (
    <Accordion expanded={expanded} onChange={(_event, isExpanded) => setExpanded(isExpanded)} sx={{ mb: 1 }}>
      {summaryChild}
      {contentChildren.length > 0 && <AccordionDetails>{contentChildren}</AccordionDetails>}
    </Accordion>
  );
};

const SummaryAccordionItem: React.FC<{ children?: React.ReactNode; node?: unknown }> = ({ children }) => (
  <AccordionSummary>{children}</AccordionSummary>
);

/**
 * Resolve a help media src (image/GIF/video) to its bundled URL under
 * /help-content/. Relative paths resolve against the current article's FILE
 * path using the same base the content validator uses (the article's
 * directory), so bare "media/x.gif" and "./media/x.gif" behave identically.
 * External URLs pass through untouched - the validator rejects them at build
 * time; the renderer just stays tolerant.
 */
export function resolveHelpMediaSrc(src: string | undefined, currentFilePath: string | undefined): string | undefined {
  if (!src) return src;
  const lower = src.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('//')) return src;
  if (src.startsWith('/')) return `/help-content${src}`;
  const fileBase = currentFilePath ? currentFilePath.replace(/\.md$/, '') : '';
  const relative = src.startsWith('.') ? src : `./${src}`;
  return `/help-content/${resolveRelativePath(fileBase, relative)}`;
}

/**
 * Lazy gif-style demo video: nothing is fetched until the demo scrolls near
 * the viewport, then it autoplays muted on a loop (controls kept for
 * pause/scrub). Authored via markdown image syntax, so it renders inside a
 * <p> - hence span wrappers (display:block) instead of div/Box.
 */
const HelpVideo: React.FC<{ src?: string; label?: string }> = ({ src, label }) => {
  const containerRef = useRef<HTMLSpanElement>(null);
  // No IntersectionObserver (jsdom, very old browsers): load immediately.
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (inView) return;
    const el = containerRef.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setInView(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' } // start loading just before the demo scrolls into view
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [inView]);

  return (
    <span ref={containerRef} style={{ display: 'block' }} data-testid="help-video-container">
      {inView ? (
        // Video styling lives in the parent Box sx ('& video') for theme parity
        <video
          src={src}
          aria-label={label}
          autoPlay
          muted
          loop
          playsInline
          controls
          preload="metadata"
          data-testid="help-video-player"
        />
      ) : (
        <span
          aria-label={label}
          data-testid="help-video-placeholder"
          style={{
            display: 'block',
            minHeight: 180,
            borderRadius: 8,
            backgroundColor: 'var(--joy-palette-background-level1)',
          }}
        />
      )}
    </span>
  );
};

/**
 * Media renderer for markdown images. GIF-style demo videos (.webm/.mp4) use
 * the same ![alt](path) syntax as images and are dispatched here by extension.
 * Reads the help panel store via getState() (not a hook) for the same reason
 * as handleLinkClick.
 */
const HelpMedia: React.FC<React.ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }> = ({
  node: _node,
  src,
  alt,
  ...props
}) => {
  const rawSrc = typeof src === 'string' ? src : undefined;
  const resolvedSrc = resolveHelpMediaSrc(rawSrc, useHelpPanel.getState().currentFilePath);
  if (rawSrc && hasVideoExtension(rawSrc)) {
    return <HelpVideo src={resolvedSrc} label={alt} />;
  }
  return <img src={resolvedSrc} alt={alt} loading="lazy" decoding="async" {...props} />;
};

// Stable components object for ReactMarkdown - prevents re-renders.
// Exported so tests can render through the EXACT production component set.
export const markdownComponents = {
  a: CustomLink,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pre: ({ node, ...props }: any) => <CodeBlock {...props} />,
  h1: H1,
  h2: H2,
  h3: H3,
  h4: H4,
  h5: H5,
  h6: H6,
  details: DetailsAccordion,
  summary: SummaryAccordionItem,
  img: HelpMedia,
};

const HelpContent: React.FC<HelpContentProps> = ({ slug, anchor }) => {
  const { data: content, isLoading, error, filePath } = useHelpContent(slug);
  const contentRef = useRef<HTMLDivElement>(null);

  // Keep the store's current file path in sync with the displayed article so
  // relative-link resolution (handleLinkClick) can use the file path instead of
  // the slug. The index lookup is synchronous, so this is set before any link
  // in the rendered content becomes clickable.
  useEffect(() => {
    useHelpPanel.getState().setCurrentFilePath(filePath);
  }, [filePath]);

  // Defer markdown rendering until after mount to avoid useInsertionEffect conflicts
  // with MUI's style injection
  const [hasMounted, setHasMounted] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      setHasMounted(true);
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Scroll to anchor when content loads or anchor changes
  useEffect(() => {
    if (content && anchor && hasMounted) {
      // Small delay to ensure the DOM has rendered
      const timer = setTimeout(() => {
        const element = document.getElementById(anchor);
        if (element) {
          element.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [content, anchor, hasMounted]);

  // Show loading while fetching content or waiting for mount (to avoid useInsertionEffect conflicts)
  if (isLoading || !hasMounted) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: 200 }}>
        <CircularProgress />
      </Box>
    );
  }

  if (error) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography level="body-lg" color="danger">
          Failed to load help content
        </Typography>
        <Typography level="body-sm" sx={{ mt: 1 }}>
          {error.message}
        </Typography>
      </Box>
    );
  }

  if (!content) {
    return (
      <Box sx={{ p: 2 }}>
        <Typography level="body-lg">No content found</Typography>
      </Box>
    );
  }

  return (
    <Box
      ref={contentRef}
      sx={{
        p: 2,
        '& h1': {
          fontSize: '1.75rem',
          fontWeight: 'bold',
          mt: 0,
          mb: 2,
          pb: 1,
          borderBottom: '1px solid',
          borderColor: 'divider',
        },
        '& h2': {
          fontSize: '1.4rem',
          fontWeight: 'bold',
          mt: 3,
          mb: 1.5,
        },
        '& h3': {
          fontSize: '1.15rem',
          fontWeight: 'bold',
          mt: 2.5,
          mb: 1,
        },
        '& h4': {
          fontSize: '1rem',
          fontWeight: 'bold',
          mt: 2,
          mb: 1,
        },
        '& p': {
          mb: 1.5,
          lineHeight: 1.7,
        },
        '& ul, & ol': {
          pl: 3,
          mb: 1.5,
        },
        '& li': {
          mb: 0.5,
          lineHeight: 1.6,
        },
        '& code': {
          backgroundColor: 'var(--joy-palette-background-level1)',
          padding: '2px 6px',
          borderRadius: '4px',
          fontSize: '0.875em',
          fontFamily: 'monospace',
        },
        '& pre': {
          backgroundColor: 'var(--joy-palette-background-level2)',
          padding: '16px',
          borderRadius: '8px',
          overflow: 'auto',
          mb: 2,
          '& code': {
            backgroundColor: 'transparent',
            padding: 0,
          },
        },
        '& blockquote': {
          borderLeft: '4px solid var(--joy-palette-primary-500)',
          pl: 2,
          ml: 0,
          my: 2,
          color: 'var(--joy-palette-text-secondary)',
          fontStyle: 'italic',
        },
        '& table': {
          width: '100%',
          borderCollapse: 'collapse',
          mb: 2,
        },
        '& th, & td': {
          border: '1px solid var(--joy-palette-divider)',
          padding: '10px 14px',
          textAlign: 'left',
        },
        '& th': {
          backgroundColor: 'var(--joy-palette-background-level2)',
          fontWeight: 'bold',
        },
        '& strong': {
          fontWeight: 'bold',
        },
        '& em': {
          fontStyle: 'italic',
        },
        '& hr': {
          my: 3,
          border: 'none',
          borderTop: '1px solid var(--joy-palette-divider)',
        },
        '& img': {
          maxWidth: '100%',
          height: 'auto',
          borderRadius: '8px',
        },
        '& video': {
          display: 'block',
          width: '100%',
          maxWidth: '100%',
          borderRadius: '8px',
          border: '1px solid var(--joy-palette-divider)',
          backgroundColor: 'var(--joy-palette-background-level1)',
          my: 2,
        },
        // Anchor link styling for headings
        '& h1, & h2, & h3, & h4, & h5, & h6': {
          scrollMarginTop: '80px', // Account for sticky header
        },
      }}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={markdownComponents}>
        {content}
      </ReactMarkdown>
      <HelpFeedbackWidget key={slug} slug={slug} />
    </Box>
  );
};

export default HelpContent;
