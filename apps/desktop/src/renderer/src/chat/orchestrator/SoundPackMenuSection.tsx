import Box from '@mui/joy/Box';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import type { SoundPackSummary } from '@shared/mods';
import { CheckIcon, ReloadIcon, WarningIcon } from '../icons';
import { refreshSoundPacks, selectSoundPack, useSoundPacks } from './soundPacks';

/**
 * The sound pack picker, a section of the view menu beside the skin picker: Built-in plus every pack
 * found under userData/mods. One is active at a time. A broken pack is listed, disabled, with the
 * reason it was rejected; the check mark follows the pack actually in effect.
 */
export function SoundPackMenuSection() {
  const { packs, active, refreshing } = useSoundPacks();
  const activeId = active?.id ?? null;

  return (
    <>
      <ListDivider />
      <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, pt: 0.75, pb: 0.25 }}>
        Sound pack
      </Typography>
      <MenuItem
        selected={activeId === null}
        onClick={() => selectSoundPack(null)}
        data-testid="orchestrator-sound-pack-option-default"
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm">Built-in</Typography>
        </Box>
        {activeId === null && <CheckIcon />}
      </MenuItem>
      {packs.map(pack => (
        <SoundPackOption key={pack.id} pack={pack} active={pack.id === activeId} />
      ))}
      <MenuItem
        disabled={refreshing}
        onClick={() => void refreshSoundPacks()}
        data-testid="orchestrator-sound-pack-refresh"
      >
        <ListItemDecorator>
          <ReloadIcon />
        </ListItemDecorator>
        <Typography level="body-sm">Refresh sound packs</Typography>
      </MenuItem>
    </>
  );
}

function SoundPackOption({ pack, active }: { pack: SoundPackSummary; active: boolean }) {
  if (pack.status === 'broken') {
    return (
      <MenuItem disabled data-testid={`orchestrator-sound-pack-option-${pack.id}`} data-broken="true">
        <ListItemDecorator sx={{ color: 'danger.plainColor' }}>
          <WarningIcon />
        </ListItemDecorator>
        <Box sx={{ flex: 1, minWidth: 0, maxWidth: 300 }}>
          <Typography level="body-sm">{pack.name ?? pack.id}</Typography>
          <Typography
            level="body-xs"
            textColor="danger.plainColor"
            data-testid={`orchestrator-sound-pack-error-${pack.id}`}
            sx={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}
          >
            {`Not loaded: ${pack.error}`}
          </Typography>
        </Box>
      </MenuItem>
    );
  }
  return (
    <MenuItem
      selected={active}
      onClick={() => selectSoundPack(pack.id)}
      data-testid={`orchestrator-sound-pack-option-${pack.id}`}
    >
      <Box sx={{ flex: 1, minWidth: 0, maxWidth: 300 }}>
        <Typography level="body-sm">{pack.name}</Typography>
        {pack.description && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'normal' }}>
            {pack.description}
          </Typography>
        )}
      </Box>
      {active && <CheckIcon />}
    </MenuItem>
  );
}
