import { Box } from '@mui/joy';
import KnowledgeViewer from '@client/app/components/Knowledge/KnowledgeViewer';

/**
 * The KnowledgeViewer for hosts whose chat is docked OUTSIDE the explorer (the premium overlay).
 * Those hosts run a docked layout, in which the chat's own SessionContainer renders no viewer at
 * all - and the layout cannot be switched to get one: the host renders its chat 0x0 in any
 * non-docked layout, and nothing on that surface restores it. Mounting our own instance is what
 * makes View behave the same here as it does with the chat embedded.
 *
 * Deliberately bare: no header, no frame. The viewer brings its own header, so any wrapper
 * chrome would read as a second, competing one.
 *
 * Both props are load-bearing:
 * - `autoHideOnEmpty={false}`: the viewer otherwise pushes the global layout to `hide` whenever
 *   it has nothing to show, which would take the host's docked chat down with it.
 * - `showLayoutControls={false}`: the header's layout ButtonGroup writes the global layout
 *   unconditionally, so any of those buttons would collapse the docked chat the same way. Close
 *   stays - DataLakeExplorer's layout subscription turns its `hide` write into close-and-restore.
 */
export default function DataLakeRailViewer() {
  return (
    <Box
      data-testid="datalake-rail-viewer"
      sx={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        height: '100%',
        display: 'flex',
        // The viewer's own root sets a height but no width, so as a flex child it would shrink to
        // its content instead of filling the pane out to the host's dock.
        '& .knowledge-viewer-container': { flex: 1, minWidth: 0 },
      }}
    >
      <KnowledgeViewer autoHideOnEmpty={false} showLayoutControls={false} />
    </Box>
  );
}
