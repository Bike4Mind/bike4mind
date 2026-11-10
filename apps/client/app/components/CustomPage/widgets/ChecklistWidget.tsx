import { Checkbox, Stack, Typography } from '@mui/joy';
import { toast } from 'sonner';
import type { ChecklistItem } from '@bike4mind/common';
import { useToggleChecklistItem } from '@client/app/hooks/data/customPages';

interface Props {
  pageId: string;
  widgetId: string;
  items: ChecklistItem[];
}

const ChecklistWidget = ({ pageId, widgetId, items }: Props) => {
  const toggle = useToggleChecklistItem(pageId);

  if (items.length === 0) {
    return (
      <Typography level="body-sm" textColor="text.tertiary">
        No items yet.
      </Typography>
    );
  }
  return (
    <Stack spacing={1}>
      {items.map(item => (
        <Checkbox
          key={item.id}
          label={item.label}
          checked={item.checked}
          onChange={event =>
            toggle.mutate(
              { widgetId, itemId: item.id, checked: event.target.checked },
              { onError: () => toast.error('Could not update the item.') }
            )
          }
          slotProps={{ input: { 'data-testid': `page-checklist-item-${item.id}` } }}
          sx={item.checked ? { '& .MuiCheckbox-label': { textDecoration: 'line-through' } } : undefined}
        />
      ))}
    </Stack>
  );
};

export default ChecklistWidget;
