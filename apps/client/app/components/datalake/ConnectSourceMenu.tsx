import { Dropdown, ListItemContent, ListItemDecorator, Menu, MenuButton, MenuItem, Typography } from '@mui/joy';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import {
  useOfferedLakeSources,
  type LakeSourceKind,
  type LakeSourceLake,
} from '@client/app/components/datalake/lakeSources';

/** Test-id stem per source; kept from before the registry so selectors stay stable. */
const TEST_ID_SLUG: Record<LakeSourceKind, string> = { googleDrive: 'drive', github: 'github' };

type ConnectSourceMenuProps = {
  lake: LakeSourceLake;
  /** Take the user to where the chosen source is connected. */
  onConnect: (kind: LakeSourceKind) => void;
};

/**
 * The lake-level list of external sources that can feed a lake, so a manager can tell from the lake
 * itself that it need not be fed by upload alone. One item per source in the lakeSources registry;
 * a source the lake cannot take stays listed, disabled, with the reason inline rather than in a
 * tooltip a disabled item cannot raise. A source whose feature flag is off is not listed at all.
 */
export default function ConnectSourceMenu({ lake, onConnect }: ConnectSourceMenuProps) {
  const offered = useOfferedLakeSources(lake);

  return (
    <Dropdown>
      <MenuButton
        data-testid="datalake-connect-source-btn"
        size="sm"
        variant="plain"
        color="neutral"
        endDecorator={<KeyboardArrowDownIcon sx={{ fontSize: 16 }} />}
      >
        Connect a source
      </MenuButton>
      <Menu size="sm" placement="bottom" sx={{ maxWidth: 280 }}>
        {offered.map(({ source, availability }) => {
          const slug = TEST_ID_SLUG[source.kind];
          return (
            <MenuItem
              key={source.kind}
              data-testid={`datalake-connect-source-${slug}-item`}
              disabled={availability.status === 'disabled'}
              onClick={() => onConnect(source.kind)}
            >
              <ListItemDecorator>
                <source.Icon />
              </ListItemDecorator>
              <ListItemContent>
                {source.label}
                <Typography
                  level="body-xs"
                  data-testid={`datalake-connect-source-${slug}-hint`}
                  sx={{ color: 'text.tertiary', whiteSpace: 'normal' }}
                >
                  {availability.status === 'disabled' ? availability.reason : source.hint}
                </Typography>
              </ListItemContent>
            </MenuItem>
          );
        })}
      </Menu>
    </Dropdown>
  );
}
