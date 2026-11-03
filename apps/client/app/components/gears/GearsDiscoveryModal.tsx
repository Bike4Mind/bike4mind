import { Box, Modal, ModalClose, ModalDialog, Stack, Typography, type Theme } from '@mui/joy';
import type { GearStatus } from '@client/app/hooks/useGearsStatus';
import { useGearsDiscovery } from '@client/app/hooks/useGearsDiscovery';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { GearCard } from './GearCard';

const footerLinkSx = (theme: Theme) => ({
  p: 0,
  border: 0,
  background: 'none',
  font: 'inherit',
  fontSize: '14px',
  cursor: 'pointer',
  '&:hover': { textDecoration: 'underline' },
  '&:focus-visible': { outline: `2px solid ${theme.palette.primary[500]}`, outlineOffset: '2px', borderRadius: '2px' },
});

interface GearsDiscoveryModalProps {
  open: boolean;
  gears: GearStatus[];
  onClose: () => void;
  onDismissForever: () => void;
  onSeeAll: () => void;
  onSelect: (gear: GearStatus, position: number) => void;
}

export const GearsDiscoveryModal = ({
  open,
  gears,
  onClose,
  onDismissForever,
  onSeeAll,
  onSelect,
}: GearsDiscoveryModalProps) => {
  const isMobile = useIsMobile();
  return (
    <Modal open={open} onClose={onClose}>
      <ModalDialog
        layout={isMobile ? 'fullscreen' : 'center'}
        data-testid="gears-discovery-modal"
        aria-labelledby="gears-discovery-title"
        sx={{
          width: { sm: 'min(1120px, calc(100vw - 48px))' },
          overflowY: 'auto',
          // Spacing comes from each child's margin; Joy's default gap would stack on top of it.
          gap: 0,
        }}
      >
        <ModalClose data-testid="gears-discovery-close-btn" />
        <Typography id="gears-discovery-title" level="h2" sx={{ fontWeight: 500, fontSize: '20px', pr: '32px' }}>
          Don&apos;t miss these features
        </Typography>
        <Typography level="body-sm" sx={{ mt: '6px', fontSize: '14px', fontWeight: 500, opacity: 0.85 }}>
          Each one pays a one-time credit bonus the first time you use it.
        </Typography>
        <Box
          sx={{
            mt: '24px',
            display: 'grid',
            gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: '1fr 1fr 1fr' },
            gap: 2,
          }}
        >
          {gears.map((gear, position) => (
            <GearCard key={gear.key} gear={gear} ctaLabel={gear.cta} onActivate={() => onSelect(gear, position)} />
          ))}
        </Box>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: '24px' }}>
          <Typography
            level="body-xs"
            component="button"
            onClick={onDismissForever}
            data-testid="gears-discovery-never-btn"
            sx={theme => ({ ...footerLinkSx(theme), color: 'text.tertiary' })}
          >
            Don&apos;t show again
          </Typography>
          <Typography
            level="body-sm"
            component="button"
            onClick={onSeeAll}
            data-testid="gears-discovery-see-all-btn"
            sx={theme => ({ ...footerLinkSx(theme), color: 'text.primary' })}
          >
            See all gears
          </Typography>
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default function GearsDiscovery() {
  const d = useGearsDiscovery();
  return (
    <GearsDiscoveryModal
      open={d.open}
      gears={d.gears}
      onClose={d.close}
      onDismissForever={d.dismissForever}
      onSeeAll={d.seeAll}
      onSelect={d.select}
    />
  );
}
