import { Box, Card, Dropdown, IconButton, Menu, MenuButton, MenuItem, Stack, Typography } from '@mui/joy';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import { toast } from 'sonner';
import type { ICustomPageDocument, PageWidget } from '@bike4mind/common';
import { useRemovePageWidget } from '@client/app/hooks/data/customPages';
import PageWidgetRenderer from './widgets/PageWidgetRenderer';

/** Widgets with an `order` come first, ascending; the rest keep their stored order. */
export function sortWidgets(widgets: PageWidget[]): PageWidget[] {
  return widgets
    .map((widget, index) => ({ widget, index }))
    .sort((a, b) => {
      const ao = a.widget.order ?? Number.POSITIVE_INFINITY;
      const bo = b.widget.order ?? Number.POSITIVE_INFINITY;
      return ao === bo ? a.index - b.index : ao - bo;
    })
    .map(({ widget }) => widget);
}

const CustomPageBody = ({ page }: { page: ICustomPageDocument }) => {
  const removeWidget = useRemovePageWidget(page.id);
  const widgets = sortWidgets(page.widgets ?? []);

  return (
    <Box data-testid="custom-page-body" sx={{ p: { xs: 2, md: 3 }, maxWidth: 1100, mx: 'auto', width: '100%' }}>
      <Stack spacing={0.5} sx={{ mb: 3 }}>
        <Typography level="h3" data-testid="custom-page-title">
          {page.name}
        </Typography>
        {page.description && (
          <Typography level="body-sm" textColor="text.tertiary">
            {page.description}
          </Typography>
        )}
      </Stack>

      {widgets.length === 0 ? (
        <Typography level="body-md" textColor="text.tertiary" data-testid="custom-page-empty">
          Tell the assistant what this page is for.
        </Typography>
      ) : (
        <Stack spacing={2}>
          {widgets.map(widget => (
            <Card key={widget.id} variant="outlined" data-testid={`page-widget-card-${widget.id}`}>
              <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
                <Typography level="title-md">{widget.title ?? ''}</Typography>
                <Dropdown>
                  <MenuButton
                    slots={{ root: IconButton }}
                    slotProps={{ root: { variant: 'plain', size: 'sm' } }}
                    aria-label="Widget actions"
                    data-testid={`page-widget-menu-btn-${widget.id}`}
                  >
                    <MoreVertIcon />
                  </MenuButton>
                  <Menu placement="bottom-end">
                    <MenuItem
                      color="danger"
                      data-testid={`page-widget-remove-btn-${widget.id}`}
                      onClick={() =>
                        removeWidget.mutate(widget.id, {
                          onError: () => toast.error('Could not remove the widget.'),
                        })
                      }
                    >
                      Remove from page
                    </MenuItem>
                  </Menu>
                </Dropdown>
              </Stack>
              <PageWidgetRenderer pageId={page.id} widget={widget} />
            </Card>
          ))}
        </Stack>
      )}
    </Box>
  );
};

export default CustomPageBody;
