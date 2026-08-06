import { Box, List, ListItem, ListItemButton, Skeleton, Typography } from '@mui/joy';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import { TREE_LIST_SX } from '@client/app/components/datalake/treeChrome';

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
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  hoverBg: string;
  /** Persistent help affordance next to the label, e.g. explaining RAG for the Lakes section. */
  infoTooltip?: React.ReactNode;
}) {
  return (
    <ListItemButton
      onClick={onToggle}
      data-testid={testid}
      sx={{
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
      }}
    >
      <Typography noWrap sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: 400, color: 'text.primary' }}>
        {label}
      </Typography>
      {/* Not part of the toggle - stop the click from also collapsing/expanding the section. */}
      {infoTooltip && <Box onClick={e => e.stopPropagation()}>{infoTooltip}</Box>}
      {open ? (
        <ExpandLessIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
      ) : (
        <ExpandMoreIcon sx={{ fontSize: 18, color: 'text.tertiary', flexShrink: 0 }} />
      )}
    </ListItemButton>
  );
}

export interface LifecycleSectionLake {
  id: string;
  name: string;
  fileTagPrefix: string;
}

/** Sidebar accordion for archived/deleted lakes: tree-style rows with restore/delete actions.
 *  `lakes` undefined -> loading skeleton (the query fires only once the section is expanded). */
export function NavLifecycleSection({
  label,
  open,
  onToggle,
  testid,
  emptyText,
  lakes,
  hoverBg,
  renderActions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  testid: string;
  emptyText: string;
  lakes: LifecycleSectionLake[] | undefined;
  hoverBg: string;
  renderActions: (lake: LifecycleSectionLake) => React.ReactNode;
}) {
  return (
    <Box data-testid={testid} sx={{ mt: '8px' }}>
      <NavSectionHeader label={label} open={open} onToggle={onToggle} testid={`${testid}-toggle`} hoverBg={hoverBg} />
      {open &&
        (!lakes ? (
          <Box sx={{ px: '8px', pb: 1 }}>
            <Skeleton variant="rectangular" height={28} sx={{ borderRadius: 'sm' }} />
          </Box>
        ) : lakes.length === 0 ? (
          <Typography level="body-xs" sx={{ color: 'text.tertiary', px: '8px', pb: 1 }}>
            {emptyText}
          </Typography>
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
                    px: '8px',
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
                  {renderActions(lake)}
                </Box>
              </ListItem>
            ))}
          </List>
        ))}
    </Box>
  );
}
