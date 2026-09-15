import { Box, List, ListItem, ListItemButton, ListItemContent, Typography } from '@mui/joy';
import type { MyRecentlyViewedArticle } from '@client/app/hooks/useHelpAnalytics';

interface RecentlyViewedListProps {
  articles: MyRecentlyViewedArticle[];
  onNavigate: (slug: string) => void;
}

/**
 * "Recently viewed" help articles section shown on the Help Center home view.
 * Renders nothing when the user has no recently viewed articles.
 */
export default function RecentlyViewedList({ articles, onNavigate }: RecentlyViewedListProps) {
  if (articles.length === 0) return null;

  return (
    <Box sx={{ mb: 3 }} data-testid="help-recently-viewed">
      <Typography level="title-md" sx={{ mb: 1 }}>
        Recently viewed
      </Typography>
      <List size="sm">
        {articles.map(article => (
          <ListItem key={article.slug}>
            <ListItemButton
              data-testid={`help-recently-viewed-${article.slug.replace(/\//g, '-')}`}
              onClick={() => onNavigate(article.slug)}
            >
              <ListItemContent>
                <Typography level="body-sm">{article.articleTitle || article.slug}</Typography>
              </ListItemContent>
            </ListItemButton>
          </ListItem>
        ))}
      </List>
    </Box>
  );
}
