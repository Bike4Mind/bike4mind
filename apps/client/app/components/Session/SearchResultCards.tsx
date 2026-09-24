import { FC, useEffect, useMemo, useState } from 'react';
import { Box, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/apiClient';
import { parseSearchResultCards, type SearchResultCard, type SearchResultCardImage } from './parseSearchResultCards';

/**
 * Renders the `b4m_cards` fence the model emits inline in a reply, as a horizontally scrollable row
 * of entity cards: a collage of attributed pictures, the model's own prose, and a footer line.
 *
 * Images come from arbitrary search-result hosts, which the app's CSP `img-src` allowlist
 * (apps/client/proxy.ts) will never contain, so a direct hotlink is blocked by the browser. They
 * are read through /api/search-image, a same-origin, non-caching proxy added for exactly this - see
 * that route for why /api/external-image is not the one used.
 */

/** The same-origin proxy path for a third-party image URL. */
export const proxiedImageSrc = (url: string) => `/api/search-image?url=${encodeURIComponent(url)}`;

/**
 * Load a proxied image through the authenticated API client and hand back a blob: URL.
 *
 * A bare `<img src="/api/search-image?...">` cannot work: the proxy authenticates with a bearer
 * JWT that only the axios interceptor attaches, and the browser sends no Authorization header on
 * an image request - every tile would 401. Fetching the bytes ourselves keeps the route behind
 * normal auth, and `blob:` is already on the CSP `img-src` allowlist.
 */
export function useProxiedImage(url: string): { src?: string; failed: boolean } {
  const [src, setSrc] = useState<string>();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | undefined;
    let cancelled = false;

    setSrc(undefined);
    setFailed(false);

    api
      .get(proxiedImageSrc(url), { responseType: 'blob' })
      .then(({ data }) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(data as Blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  return { src, failed };
}

const CARD_WIDTH = 300;
const COLLAGE_HEIGHT = 200;

/**
 * Clamp model-authored copy to a fixed number of lines. The card is a fixed 300px wide and the
 * model writes as much prose as it likes, so without this one long `note` stretches its card far
 * past its neighbours and a single unbroken token (a URL, a model number) escapes the border.
 */
const clampLines = (lines: number) => ({
  // `&&` doubles specificity: Joy's own Typography root sets `display`, and its class otherwise
  // wins over sx, leaving the clamp inert with the text on a single clipped line.
  '&&': { display: '-webkit-box' },
  WebkitBoxOrient: 'vertical' as const,
  WebkitLineClamp: lines,
  overflow: 'hidden',
  overflowWrap: 'anywhere' as const,
  // The reply body renders with `white-space: pre`, which a card inherits - without resetting it
  // the copy never wraps and the clamp has no second line to clamp to.
  whiteSpace: 'normal' as const,
});

/** One picture, replaced in place by a caption when the origin refuses to serve it. */
const CollageTile: FC<{ image: SearchResultCardImage; flex?: string }> = ({ image, flex }) => {
  const { src, failed } = useProxiedImage(image.url);

  return (
    <Box
      sx={{
        position: 'relative',
        flex: flex ?? '1 1 0',
        minHeight: 0,
        minWidth: 0,
        overflow: 'hidden',
        borderRadius: 'xs',
        bgcolor: 'background.level2',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {failed ? (
        <Typography level="body-xs" sx={{ color: 'text.tertiary', px: 1, textAlign: 'center' }}>
          Image unavailable
        </Typography>
      ) : (
        <>
          {src && (
            <Box
              component="img"
              src={src}
              alt=""
              decoding="async"
              sx={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
            />
          )}
          {src && image.source && (
            <Typography
              level="body-xs"
              sx={{
                position: 'absolute',
                bottom: 0,
                right: 0,
                left: 0,
                px: 0.75,
                py: 0.25,
                color: 'common.white',
                // The tile behind is arbitrary third-party artwork, so the label carries its own
                // scrim rather than trusting the image to be dark enough underneath it.
                background: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0))',
                textAlign: 'right',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {image.source}
            </Typography>
          )}
        </>
      )}
    </Box>
  );
};

/** Hero tile on the left, the rest stacked beside it - degrades to a single full-width tile. */
const Collage: FC<{ images: SearchResultCardImage[] }> = ({ images }) => {
  const [hero, ...rest] = images;
  return (
    <Box sx={{ display: 'flex', gap: 0.5, height: COLLAGE_HEIGHT }}>
      <CollageTile image={hero} flex={rest.length > 0 ? '1 1 60%' : '1 1 100%'} />
      {rest.length > 0 && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, flex: '1 1 40%', minWidth: 0 }}>
          {rest.map(image => (
            <CollageTile key={image.url} image={image} />
          ))}
        </Box>
      )}
    </Box>
  );
};

const Card: FC<{ card: SearchResultCard }> = ({ card }) => (
  <Box
    component={card.url ? 'a' : 'div'}
    href={card.url}
    target={card.url ? '_blank' : undefined}
    rel={card.url ? 'noopener noreferrer' : undefined}
    data-testid="search-result-card"
    sx={{
      flex: `0 0 ${CARD_WIDTH}px`,
      width: CARD_WIDTH,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'stretch',
      gap: 1,
      p: 1,
      borderRadius: 'sm',
      border: '1px solid',
      borderColor: 'divider',
      bgcolor: 'background.level1',
      textDecoration: 'none',
      color: 'inherit',
      transition: 'border-color 0.2s',
      '&:hover': card.url ? { borderColor: 'primary.outlinedBorder' } : undefined,
    }}
  >
    <Collage images={card.images} />
    <Typography level="title-sm" sx={{ color: 'text.primary', ...clampLines(2) }}>
      {card.name}
    </Typography>
    {card.note && (
      <Typography level="body-sm" sx={{ color: 'text.secondary', ...clampLines(4) }}>
        {card.note}
      </Typography>
    )}
    {card.meta && (
      <Typography level="body-xs" sx={{ color: 'text.tertiary', mt: 'auto', ...clampLines(1) }}>
        {card.meta}
      </Typography>
    )}
  </Box>
);

/** Placeholder held while the fence is still streaming, so the reply does not jump when it lands. */
const CardsSkeleton: FC = () => (
  <Box
    data-testid="search-result-cards-skeleton"
    sx={{
      height: COLLAGE_HEIGHT,
      my: 2,
      borderRadius: 'sm',
      border: '1px solid',
      borderColor: 'divider',
      bgcolor: 'background.level1',
      opacity: 0.5,
    }}
  />
);

interface SearchResultCardsProps {
  content: string;
  /**
   * Whether the reply that contains this fence has finished generating. A block can stay
   * unparseable forever - the user hit stop mid-fence, the reply was truncated, the model left a
   * quote unclosed - and without this the skeleton would be baked into the stored reply and shown
   * on every later view. Once the reply is done, "still streaming" is no longer a possible reading.
   */
  replyComplete?: boolean;
}

const SearchResultCards: FC<SearchResultCardsProps> = ({ content, replyComplete }) => {
  const parsed = useMemo(() => parseSearchResultCards(content), [content]);

  if (parsed.state === 'pending') return replyComplete ? null : <CardsSkeleton />;
  // A block that finished malformed is dropped silently: the prose around it already carries the
  // answer, and raw JSON in the middle of a reply is worse than no pictures.
  if (parsed.state === 'invalid') return null;

  return (
    <Box
      data-testid="search-result-cards"
      sx={{
        display: 'flex',
        gap: 1,
        my: 2,
        overflowX: 'auto',
        pb: 1,
        '&::-webkit-scrollbar': { height: '6px' },
        '&::-webkit-scrollbar-track': { bgcolor: 'background.level1', borderRadius: '3px' },
        '&::-webkit-scrollbar-thumb': { bgcolor: 'neutral.400', borderRadius: '3px' },
      }}
    >
      {/* Keyed by position, not name: the model routinely emits two cards with the same name (two
          listings of one product), and a duplicate key would leak one tile's load-failure state
          into the other. */}
      {parsed.cards.map((card, index) => (
        <Card key={`${index}-${card.images[0].url}`} card={card} />
      ))}
    </Box>
  );
};

export default SearchResultCards;
