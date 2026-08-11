import { Box } from '@mui/joy';
import KnowledgeViewer from '@client/app/components/Knowledge/KnowledgeViewer';

/**
 * The KnowledgeViewer for hosts whose chat is docked OUTSIDE the explorer (the premium overlay).
 * Those hosts run the `dockRight` layout, in which the chat's own SessionContainer renders no
 * viewer at all, and the layout cannot be switched to get one - the host force-redocks anything
 * else, and `vertical` collapses the dock. Mounting our own instance is what makes View behave
 * the same here as it does with the chat embedded.
 *
 * Deliberately bare: no header, no frame. The viewer brings its own header (file picker, layout
 * controls, Close), so any wrapper chrome would read as a second, competing one.
 *
 * `autoHideOnEmpty={false}` is load-bearing: the viewer otherwise pushes the global layout to
 * `hide` whenever it has nothing to show, which would take the host's docked chat down with it.
 */
export default function DataLakeRailViewer() {
  return (
    <Box
      data-testid="datalake-rail-viewer"
      sx={{ flex: 1, minWidth: 0, minHeight: 0, height: '100%', display: 'flex' }}
    >
      <KnowledgeViewer autoHideOnEmpty={false} />
    </Box>
  );
}
