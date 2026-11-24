import { Box, Modal, ModalDialog } from '@mui/joy';
import KnowledgeViewer from '@client/app/components/Knowledge/KnowledgeViewer';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import { setSessionLayout } from '@client/app/hooks/useSessionLayout';

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
  const isMobile = useIsMobile();
  const viewer = <KnowledgeViewer autoHideOnEmpty={false} showLayoutControls={false} />;

  // Joy's Modal raises the popup z-index variable, so the file Select and download Menu portals
  // open above this layer instead of behind it.
  if (isMobile) {
    return (
      <Modal open onClose={() => setSessionLayout({ layout: 'hide' })}>
        <ModalDialog
          layout="fullscreen"
          data-testid="datalake-rail-viewer"
          data-presentation="fullscreen"
          sx={{ p: 0, borderRadius: 0, display: 'flex', minWidth: 0, minHeight: 0, backgroundColor: 'background.body' }}
        >
          <Box
            sx={{
              flex: 1,
              minWidth: 0,
              minHeight: 0,
              display: 'flex',
              '& .knowledge-viewer-container': { flex: 1, minWidth: 0 },
            }}
          >
            {viewer}
          </Box>
        </ModalDialog>
      </Modal>
    );
  }

  return (
    <Box
      data-testid="datalake-rail-viewer"
      data-presentation="rail"
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
      {viewer}
    </Box>
  );
}
