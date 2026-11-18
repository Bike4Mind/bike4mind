import Box from '@mui/joy/Box';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import MenuItem from '@mui/joy/MenuItem';
import Typography from '@mui/joy/Typography';
import type { SkinSummary } from '@shared/mods';
import { CheckIcon, ReloadIcon, WarningIcon } from '../icons';
import { refreshSkins, selectSkin, useSkins } from './skins';

/**
 * The skin picker, as a section of the view menu (ViewSwitcher): Default plus every skin found under
 * userData/mods. A broken skin is listed, disabled, with the reason it was rejected; the check mark
 * follows the theme actually in effect, so a picked skin that broke shows Default checked.
 */
export function SkinMenuSection() {
  const { skins, theme, refreshing } = useSkins();
  const activeId = theme.id;

  return (
    <>
      <ListDivider />
      <Typography level="body-xs" textColor="text.tertiary" sx={{ px: 1.5, pt: 0.75, pb: 0.25 }}>
        Skin
      </Typography>
      <MenuItem
        selected={activeId === null}
        onClick={() => selectSkin(null)}
        data-testid="orchestrator-skin-option-default"
      >
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography level="body-sm">Default</Typography>
        </Box>
        {activeId === null && <CheckIcon />}
      </MenuItem>
      {skins.map(skin => (
        <SkinOption key={skin.id} skin={skin} active={skin.id === activeId} />
      ))}
      <MenuItem disabled={refreshing} onClick={() => void refreshSkins()} data-testid="orchestrator-skin-refresh">
        <ListItemDecorator>
          <ReloadIcon />
        </ListItemDecorator>
        <Typography level="body-sm">Refresh skins</Typography>
      </MenuItem>
    </>
  );
}

function SkinOption({ skin, active }: { skin: SkinSummary; active: boolean }) {
  if (skin.status === 'broken') {
    return (
      <MenuItem disabled data-testid={`orchestrator-skin-option-${skin.id}`} data-broken="true">
        <ListItemDecorator sx={{ color: 'danger.plainColor' }}>
          <WarningIcon />
        </ListItemDecorator>
        <Box sx={{ flex: 1, minWidth: 0, maxWidth: 300 }}>
          <Typography level="body-sm">{skin.name ?? skin.id}</Typography>
          <Typography
            level="body-xs"
            textColor="danger.plainColor"
            data-testid={`orchestrator-skin-error-${skin.id}`}
            sx={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}
          >
            {`Not loaded: ${skin.error}`}
          </Typography>
        </Box>
      </MenuItem>
    );
  }
  return (
    <MenuItem selected={active} onClick={() => selectSkin(skin.id)} data-testid={`orchestrator-skin-option-${skin.id}`}>
      <Box sx={{ flex: 1, minWidth: 0, maxWidth: 300 }}>
        <Typography level="body-sm">{skin.name}</Typography>
        {skin.description && (
          <Typography level="body-xs" textColor="text.tertiary" sx={{ whiteSpace: 'normal' }}>
            {skin.description}
          </Typography>
        )}
        {skin.warnings?.map(warning => (
          <Typography
            key={warning}
            level="body-xs"
            textColor="warning.plainColor"
            data-testid={`orchestrator-skin-warning-${skin.id}`}
            sx={{ overflowWrap: 'anywhere', whiteSpace: 'normal' }}
          >
            {warning}
          </Typography>
        ))}
      </Box>
      {active && <CheckIcon />}
    </MenuItem>
  );
}
