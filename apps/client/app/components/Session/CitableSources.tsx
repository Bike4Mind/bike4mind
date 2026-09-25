import { FC, useMemo, useState } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/joy';
import {
  Language as WebIcon,
  Description as DocumentIcon,
  Storage as DatasetIcon,
  Extension as McpIcon,
  WarningAmberRounded as TruncatedIcon,
  CompareArrowsRounded as ConflictIcon,
} from '@mui/icons-material';
import { CitableSource, CitableSourceType } from '@bike4mind/common';
import { DATA_LAKE } from '@client/app/components/datalake/dataLakeBranding';
import { useNavigate } from '@tanstack/react-router';
import { useCitationInteraction } from './CitationInteractionContext';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';
import { citedPassageOf } from '@client/app/components/Knowledge/citedPassage';

interface CitableSourcesProps {
  citables: CitableSource[];
  /** Maximum height in pixels before scrolling */
  maxHeight?: number;
}

const getIconForType = (type: CitableSourceType) => {
  switch (type) {
    case 'web_url':
      return <WebIcon sx={{ fontSize: '1rem', color: 'text.tertiary' }} />;
    case 'document':
      return <DocumentIcon sx={{ fontSize: '1rem', color: 'text.tertiary' }} />;
    case 'dataset':
      return <DatasetIcon sx={{ fontSize: '1rem', color: 'text.tertiary' }} />;
    case 'mcp':
      return <McpIcon sx={{ fontSize: '1rem', color: 'text.tertiary' }} />;
    default:
      return <WebIcon sx={{ fontSize: '1rem', color: 'text.tertiary' }} />;
  }
};

/**
 * Get favicon URL for a given domain
 * Uses Google's favicon service as fallback
 */
const getFaviconUrl = (url: string): string | null => {
  try {
    const parsedUrl = new URL(url);
    // Use Google's favicon service which works reliably
    return `https://www.google.com/s2/favicons?domain=${parsedUrl.hostname}&sz=32`;
  } catch {
    return null;
  }
};

/** Names listed in the conflict tooltip before it degrades to a count. Keeps one line readable. */
const CONFLICT_NAMES_SHOWN = 2;

/**
 * Titles of the other cited sources this one provably disagrees with (#3041).
 *
 * Resolved against the rendered chips rather than read off the chip itself: the detector stamps
 * `fabFileId`s, and only a sibling chip knows the title behind one. An unresolvable id is still a
 * real conflict - its partner may not have survived the dedup above - so it degrades to a count
 * rather than dropping a true signal.
 *
 * `Array.isArray` because `metadata` is an open bag filled from a stored document: a malformed
 * value must render no badge, never throw inside the reply.
 */
const conflictingTitlesOf = (source: CitableSource, titleById: Map<string, string>): string[] => {
  const ids = source.metadata?.conflictsWith;
  if (!Array.isArray(ids)) return [];
  const named = ids.map(id => titleById.get(id)).filter((title): title is string => !!title);
  const unnamed = ids.length - named.length;
  return unnamed > 0 ? [...named, `${unnamed} further source${unnamed === 1 ? '' : 's'}`] : named;
};

const CitableSourceItem: FC<{ source: CitableSource; conflictingTitles: string[] }> = ({
  source,
  conflictingTitles,
}) => {
  const [faviconError, setFaviconError] = useState(false);
  const navigate = useNavigate();
  // Opt-in host override: when a surface provides onCitationClick (e.g. the
  // LibreOncology source drawer), the click is handled in-surface instead of
  // navigating. Default (no provider) keeps the existing navigation behavior.
  const { onCitationClick } = useCitationInteraction();

  // Detect internal (relative) vs external URLs
  const isInternal = !!source.url && source.url.startsWith('/');

  // Extract hostname for display if URL exists
  let hostname = '';
  let faviconUrl: string | null = null;
  if (isInternal) {
    // Show a friendly label for internal deep-links instead of the raw path
    hostname = DATA_LAKE;
  } else {
    try {
      if (source.url) {
        const parsedUrl = new URL(source.url);
        hostname = parsedUrl.hostname.replace('www.', '');
        faviconUrl = getFaviconUrl(source.url);
      }
    } catch {
      hostname = source.url || '';
    }
  }

  // Host override wins for any clickable source (internal or external) - lets a
  // surface present its own document view instead of navigating away.
  const handleHostClick = onCitationClick
    ? (e: React.MouseEvent) => {
        e.preventDefault();
        onCitationClick(source);
      }
    : undefined;

  const handleClick =
    handleHostClick ??
    (isInternal
      ? () => {
          // Hand the reader's destination the passage this chip cited, so the viewer can mark it
          // instead of dropping them at the top of the document (#3038). Written on EVERY internal
          // click, clearing on a chip that carries no passage: a leftover anchor from the previous
          // citation would otherwise mark a stale extent in the newly-opened file.
          setSessionLayout({ citedPassage: citedPassageOf(source) });
          const url = new URL(source.url!, window.location.origin);
          navigate({ to: url.pathname as never, search: Object.fromEntries(url.searchParams) as never });
        }
      : undefined);

  // When the host handles clicks, render as a button (no external navigation).
  const renderAsButton = isInternal || !!handleHostClick;

  // For web_url type, show favicon; for other types, show type icon
  const showFavicon = source.type === 'web_url' && !isInternal && faviconUrl && !faviconError;
  const fallbackIcon = getIconForType(source.type);

  // web_fetch flags content it dropped at its size cap (see webfetch tool / issue #452).
  // Surface it so the user knows the model only saw a partial read.
  const isTruncated = source.metadata?.truncated === true;
  const truncationCap = typeof source.metadata?.cap === 'number' ? source.metadata.cap : undefined;

  // Retrieval found this source stating a value another cited source states differently (#3041) -
  // the same finding the model was warned about, so the reader is not the only one left unaware.
  // Worded as "may disagree" deliberately: the detector is a pattern match over prose and its own
  // contract is that a finding means "worth a human's eye", never a proven contradiction
  // (b4m-core/common/src/constants/corpusInconsistency.ts). Holds for a future kind joining the
  // asserted list too, which is why the wording names no specific kind.
  const conflictTooltip = conflictingTitles.length
    ? `May disagree with ${conflictingTitles.slice(0, CONFLICT_NAMES_SHOWN).join(', ')}` +
      `${conflictingTitles.length > CONFLICT_NAMES_SHOWN ? ` and ${conflictingTitles.length - CONFLICT_NAMES_SHOWN} more` : ''}. ` +
      'This is a heuristic match over the retrieved passages, not a proven contradiction - read the sources before relying on either.'
    : '';

  return (
    <Box
      component={renderAsButton ? 'button' : source.url ? 'a' : 'div'}
      type={renderAsButton ? 'button' : undefined}
      href={!renderAsButton ? source.url : undefined}
      data-testid="citable-source-chip"
      onClick={handleClick}
      target={!renderAsButton && source.url ? '_blank' : undefined}
      rel={!renderAsButton && source.url ? 'noopener noreferrer' : undefined}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.5,
        p: 1,
        borderRadius: 'sm',
        bgcolor: 'background.level1',
        border: '1px solid',
        borderColor: 'divider',
        transition: 'all 0.2s',
        textDecoration: 'none',
        cursor: source.url ? 'pointer' : 'default',
        flexShrink: 0,
        background: 'none',
        width: '100%',
        textAlign: 'left',
        '&:hover': {
          bgcolor: 'background.level2',
          borderColor: 'primary.outlinedBorder',
        },
      }}
    >
      {/* Favicon or fallback icon */}
      <Box
        sx={{
          width: 20,
          height: 20,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {showFavicon && faviconUrl ? (
          <img
            src={faviconUrl}
            alt=""
            onError={() => setFaviconError(true)}
            style={{
              width: 16,
              height: 16,
              borderRadius: '2px',
            }}
          />
        ) : (
          fallbackIcon
        )}
      </Box>

      {/* Title and domain merged */}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* Row so the truncation badge stays visible instead of being ellipsised with a long title. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
          <Typography
            level="body-sm"
            sx={{
              fontWeight: 'md',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'text.primary',
              minWidth: 0,
            }}
          >
            {source.title}
            {hostname && (
              <Typography
                component="span"
                level="body-xs"
                sx={{
                  color: 'text.tertiary',
                  ml: 1,
                }}
              >
                {hostname}
              </Typography>
            )}
          </Typography>
          {/* Chips are full-width and stack, so a default bottom tooltip lands on the next
              chip - which for the conflict badge is often the very source it names. */}
          {isTruncated && (
            <Tooltip
              size="sm"
              placement="top"
              title={`Content truncated${
                truncationCap ? ` at ${truncationCap.toLocaleString()} chars` : ''
              } - the model saw a partial read of this source`}
            >
              <TruncatedIcon
                data-testid="citable-truncated-badge"
                sx={{ fontSize: '0.9rem', color: 'warning.500', flexShrink: 0 }}
              />
            </Tooltip>
          )}
          {conflictTooltip && (
            <Tooltip size="sm" placement="top" title={conflictTooltip}>
              <ConflictIcon
                data-testid="citable-conflict-badge"
                // The Tooltip only names the conflict to a reader who can hover it. titleAccess is
                // what puts the same sentence on the accessibility tree (SvgIcon renders it as
                // <title> and drops its default aria-hidden), so the signal is not sight-only.
                titleAccess={conflictTooltip}
                sx={{ fontSize: '0.9rem', color: 'warning.500', flexShrink: 0 }}
              />
            </Tooltip>
          )}
        </Box>

        {source.description && (
          <Typography
            level="body-xs"
            sx={{
              color: 'text.secondary',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              display: '-webkit-box',
              WebkitLineClamp: 1,
              WebkitBoxOrient: 'vertical',
              mt: 0.25,
            }}
          >
            {source.description}
          </Typography>
        )}
      </Box>
    </Box>
  );
};

/**
 * CitableSources - Displays a scrollable list of sources referenced in AI responses
 * Shows web search results, documents, datasets, and MCP tool results
 */
const CitableSources: FC<CitableSourcesProps> = ({ citables, maxHeight = 200 }) => {
  // Citables accumulate across multiple tool calls (e.g. several search_knowledge_base
  // invocations returning overlapping files), so the same source can appear more than
  // once. Dedupe by a stable identity before rendering - otherwise repeated ids produce
  // React "two children with the same key" errors and an inflated "Sources (N)" count.
  const uniqueCitables = useMemo(() => {
    const seen = new Set<string>();
    const out: CitableSource[] = [];
    for (const source of citables ?? []) {
      const identity = source.id || source.url || source.title;
      if (identity && seen.has(identity)) continue;
      if (identity) seen.add(identity);
      out.push(source);
    }
    return out;
  }, [citables]);

  // Built off the DEDUPED list so a title resolves to the chip actually rendered for that id.
  const titleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const source of uniqueCitables) if (source.id) map.set(source.id, source.title);
    return map;
  }, [uniqueCitables]);

  if (uniqueCitables.length === 0) {
    return null;
  }

  return (
    <Box
      sx={{
        mt: 1.5,
        mb: 1,
        p: 1.5,
        borderRadius: 'sm',
        bgcolor: 'background.surface',
        border: '1px solid',
        borderColor: 'divider',
      }}
      data-testid="citable-sources"
    >
      <Typography
        level="body-xs"
        sx={{
          fontWeight: 'lg',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          color: 'text.secondary',
          mb: 1,
        }}
      >
        Sources ({uniqueCitables.length})
      </Typography>

      <Stack
        spacing={0.75}
        sx={{
          maxHeight,
          overflowY: 'auto',
          pr: 0.5, // Space for scrollbar
          // Custom scrollbar styling
          '&::-webkit-scrollbar': {
            width: '6px',
          },
          '&::-webkit-scrollbar-track': {
            bgcolor: 'background.level1',
            borderRadius: '3px',
          },
          '&::-webkit-scrollbar-thumb': {
            bgcolor: 'neutral.400',
            borderRadius: '3px',
            '&:hover': {
              bgcolor: 'neutral.500',
            },
          },
        }}
      >
        {uniqueCitables.map((source, index) => (
          <CitableSourceItem
            key={source.id || source.url || index}
            source={source}
            conflictingTitles={conflictingTitlesOf(source, titleById)}
          />
        ))}
      </Stack>
    </Box>
  );
};

export default CitableSources;
