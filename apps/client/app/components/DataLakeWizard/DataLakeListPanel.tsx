import DataLakeManagerPanel from './DataLakeManagerPanel';

/**
 * @deprecated Compat alias for the currently PINNED premium overlays, which still render
 * <DataLakeListPanel /> inside their own manager modals. The old list + stacked-viewer UI
 * was replaced by the two-pane DataLakeManagerPanel; this alias keeps pinned overlays
 * typechecking against main (and gives them the new panel, albeit in their narrower
 * modals). Remove with the next overlay pin bumps, once overlays import
 * DataLakeManagerPanel and size their modals like Files/Browser.tsx does.
 */
export default DataLakeManagerPanel;
