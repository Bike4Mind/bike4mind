import { List, ListItem, ListItemButton } from '@mui/joy';
import { useNavigate } from '@tanstack/react-router';
import { useStudioFeature } from '../useStudioFeature';
import type { StudioMedium } from '../studioModality';
import { STUDIO_CREATE_DEFINITIONS, STUDIO_CREATE_MEDIA } from './studioCreateMedia';

/** Create's medium picker: a column beside the form on desktop, a scrolling row above it on narrow screens. */
const StudioMediumRail = ({ medium }: { medium: StudioMedium }) => {
  const navigate = useNavigate();
  const isImageOpen = useStudioFeature('image');
  const media = STUDIO_CREATE_MEDIA.filter(candidate => candidate !== 'image' || isImageOpen);

  return (
    <List
      aria-label="Medium"
      data-testid="studio-medium-rail"
      sx={{
        flexGrow: 0,
        flexDirection: { xs: 'row', md: 'column' },
        overflowX: { xs: 'auto', md: 'visible' },
        minWidth: { md: 160 },
        gap: 0.5,
        '--List-radius': '8px',
      }}
    >
      {media.map(candidate => (
        <ListItem key={candidate}>
          <ListItemButton
            selected={candidate === medium}
            aria-current={candidate === medium ? 'page' : undefined}
            onClick={() => {
              if (candidate !== medium) void navigate({ to: '/studio/$modality', params: { modality: candidate } });
            }}
            data-testid={`studio-rail-${candidate}`}
            sx={{ whiteSpace: 'nowrap' }}
          >
            {STUDIO_CREATE_DEFINITIONS[candidate].railLabel}
          </ListItemButton>
        </ListItem>
      ))}
    </List>
  );
};

export default StudioMediumRail;
