import { Box, List, ListItem, ListItemButton, Skeleton, Typography } from '@mui/joy';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { TREE_LIST_SX } from '@client/app/components/datalake/treeChrome';
import { RowActionsMenu } from '@client/app/components/datalake/rowActionsMenu';

export function NavSkeletons() {
  return (
    <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
      {[1, 2, 3, 4].map(i => (
        <Skeleton key={i} variant="rectangular" height={32} sx={{ borderRadius: 'sm' }} />
      ))}
    </Box>
  );
}

export function EmptyHint({ text }: { text: string }) {
  return (
    <Box sx={{ p: 2, textAlign: 'center' }}>
      <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
        {text}
      </Typography>
    </Box>
  );
}

/** Accordion header for the sidebar's root sections, styled like the tree rows. */
export function NavSectionHeader({
  label,
  open,
  onToggle,
  testid,
  hoverBg,
  infoTooltip,
  trailing,
}: {
  label: string;
  open?: boolean;
  /** Omit to render a static row: no collapse, no chevron - for a section with nothing to open. */
  onToggle?: () => void;
  testid: string;
  hoverBg: string;
  /** Persistent help affordance next to the label, e.g. explaining RAG for the Lakes section. */
  infoTooltip?: React.ReactNode;
  /** Right-hand content replacing the chevron, e.g. "No files" on an empty section. */
  trailing?: React.ReactNode;
}) {
  const rowSx = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    px: '8px',
    mb: '4px',
    height: '32px',
    minHeight: '32px',
    borderRadius: '8px',
    transition: 'background 0.15s',
    '--variant-plainHoverBg': hoverBg,
  } as const;

  const content = (
    <>
      {/* Label and help sit as one group, so the icon stays beside the text instead of being
          pushed across to the chevron by a stretching label. Same pairing as the tree header. */}
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: '6px' }}>
        <Typography noWrap sx={{ minWidth: 0, fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
          {label}
        </Typography>
        {/* Not part of the toggle - stop the click from also collapsing/expanding the section. */}
        {infoTooltip && (
          <Box onClick={e => e.stopPropagation()} sx={{ display: 'flex', flexShrink: 0 }}>
            {infoTooltip}
          </Box>
        )}
      </Box>
      {trailing ??
        (open ? (
          <ExpandLessIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
        ) : (
          <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
        ))}
    </>
  );

  // Nothing to expand means nothing to click: render the row as a statement rather than a
  // control, so it neither highlights on hover nor offers a chevron that would do nothing.
  return onToggle ? (
    <ListItemButton onClick={onToggle} data-testid={testid} sx={rowSx}>
      {content}
    </ListItemButton>
  ) : (
    <Box data-testid={testid} sx={rowSx}>
      {content}
    </Box>
  );
}

export interface LifecycleSectionLake {
  id: string;
  name: string;
  fileTagPrefix: string;
}

/** Sidebar accordion for archived/deleted lakes: tree-style rows with restore/delete actions.
 *  `lakes` undefined -> still loading (header shows a chevron, body a skeleton). An empty list
 *  collapses to a single static row stating so, since there is nothing to open. */
export function NavLifecycleSection({
  label,
  open,
  onToggle,
  testid,
  emptyLabel,
  lakes,
  hoverBg,
  renderActions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  /** Right-hand text on the static row when the section has nothing in it, e.g. "No files". */
  emptyLabel: string;
  lakes: LifecycleSectionLake[] | undefined;
  hoverBg: string;
  renderActions: (lake: LifecycleSectionLake) => React.ReactNode;
}) {
  if (lakes?.length === 0) {
    return (
      <Box data-testid={testid} sx={{ mt: '8px' }}>
        <NavSectionHeader
          label={label}
          testid={`${testid}-toggle`}
          hoverBg={hoverBg}
          trailing={
            <Typography level="body-xs" noWrap sx={{ color: 'text.tertiary', flexShrink: 0 }}>
              {emptyLabel}
            </Typography>
          }
        />
      </Box>
    );
  }

  return (
    <Box data-testid={testid} sx={{ mt: '8px' }}>
      <NavSectionHeader label={label} open={open} onToggle={onToggle} testid={`${testid}-toggle`} hoverBg={hoverBg} />
      {open &&
        (!lakes ? (
          <Box sx={{ px: '8px', pb: 1 }}>
            <Skeleton variant="rectangular" height={28} sx={{ borderRadius: 'sm' }} />
          </Box>
        ) : (
          <List size="sm" sx={TREE_LIST_SX}>
            {lakes.map(lake => (
              <ListItem key={lake.id}>
                <Box
                  data-testid={`${testid}-card-${lake.id}`}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    minHeight: '28px',
                    width: '100%',
                  }}
                >
                  <FolderOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary', flexShrink: 0 }} />
                  <Typography
                    noWrap
                    sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 400, color: 'text.primary' }}
                  >
                    {lake.name}
                  </Typography>
                  {/* Folded behind one trigger, sharing the tree's row-menu recipe, so a lifecycle
                      row reads the same as a file row instead of exposing two coloured buttons. */}
                  <RowActionsMenu testId={`${testid}-menu-btn-${lake.id}`} ariaLabel={`${label} lake actions`}>
                    {renderActions(lake)}
                  </RowActionsMenu>
                </Box>
              </ListItem>
            ))}
          </List>
        ))}
    </Box>
  );
}
