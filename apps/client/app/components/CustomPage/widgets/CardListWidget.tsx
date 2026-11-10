import { Box, Card, Typography } from '@mui/joy';
import type { CardListItem } from '@bike4mind/common';

const CardListWidget = ({ items }: { items: CardListItem[] }) => {
  if (items.length === 0) {
    return (
      <Typography level="body-sm" textColor="text.tertiary">
        No items yet.
      </Typography>
    );
  }
  return (
    <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))' }}>
      {items.map(item => (
        <Card key={item.id} variant="outlined" size="sm" data-testid={`page-card-item-${item.id}`}>
          <Typography level="title-sm">{item.title}</Typography>
          {item.subtitle && (
            <Typography level="body-xs" textColor="text.tertiary">
              {item.subtitle}
            </Typography>
          )}
          {item.body && (
            <Typography level="body-sm" sx={{ whiteSpace: 'pre-wrap' }}>
              {item.body}
            </Typography>
          )}
        </Card>
      ))}
    </Box>
  );
};

export default CardListWidget;
