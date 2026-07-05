import { useCallback, useEffect, useState } from 'react';
import { Box, Button, Checkbox, CircularProgress, Option, Select, Typography } from '@mui/joy';
import { api } from '@client/app/contexts/ApiContext';
import { toast } from 'sonner';

// Icons
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import StorageOutlinedIcon from '@mui/icons-material/StorageOutlined';

interface PageNode {
  id: string;
  title: string;
  type: 'page' | 'database';
  hasChildren: boolean;
}

export interface AllowedPage {
  id: string;
  title: string;
  type: 'page' | 'database';
  access: 'read' | 'readwrite';
}

interface NotionPagePickerProps {
  allowedPages: AllowedPage[];
  excludedPageIds: string[];
  onSave: (allowedPages: AllowedPage[], excludedPageIds: string[]) => void;
  saving: boolean;
}

interface TreeNodeState {
  children?: PageNode[];
  loading: boolean;
  expanded: boolean;
}

const NotionPagePicker = ({ allowedPages, excludedPageIds, onSave, saving }: NotionPagePickerProps) => {
  const [topLevelPages, setTopLevelPages] = useState<PageNode[]>([]);
  const [loadingRoot, setLoadingRoot] = useState(false);
  const [nodeStates, setNodeStates] = useState<Record<string, TreeNodeState>>({});
  const [localAllowed, setLocalAllowed] = useState<AllowedPage[]>(allowedPages);
  const [localExcluded, setLocalExcluded] = useState<string[]>(excludedPageIds);

  // Sync from props when they change - compare serialized value to avoid unnecessary updates
  const prevAllowedRef = JSON.stringify(allowedPages);
  const prevExcludedRef = JSON.stringify(excludedPageIds);
  useEffect(() => {
    setLocalAllowed(JSON.parse(prevAllowedRef));
  }, [prevAllowedRef]);

  useEffect(() => {
    setLocalExcluded(JSON.parse(prevExcludedRef));
  }, [prevExcludedRef]);

  const loadTopLevel = useCallback(async () => {
    setLoadingRoot(true);
    try {
      const { data } = await api.get('/api/mcp-servers/notion/pages');
      setTopLevelPages(data.pages);
    } catch (err) {
      console.error('Failed to load Notion pages:', err);
      toast.error('Failed to load Notion workspace pages');
    } finally {
      setLoadingRoot(false);
    }
  }, []);

  useEffect(() => {
    void loadTopLevel();
  }, [loadTopLevel]);

  const loadChildren = useCallback(async (parentId: string) => {
    setNodeStates(prev => ({
      ...prev,
      [parentId]: { ...prev[parentId], loading: true, expanded: true },
    }));

    try {
      const { data } = await api.get(`/api/mcp-servers/notion/pages?parentId=${encodeURIComponent(parentId)}`);
      setNodeStates(prev => ({
        ...prev,
        [parentId]: { children: data.pages, loading: false, expanded: true },
      }));
    } catch (err) {
      console.error('Failed to load children:', err);
      setNodeStates(prev => ({
        ...prev,
        [parentId]: { ...prev[parentId], loading: false },
      }));
    }
  }, []);

  const toggleExpand = useCallback(
    (pageId: string) => {
      const current = nodeStates[pageId];
      if (current?.expanded) {
        // Collapse
        setNodeStates(prev => ({
          ...prev,
          [pageId]: { ...prev[pageId], expanded: false },
        }));
      } else if (current?.children) {
        // Re-expand (already loaded)
        setNodeStates(prev => ({
          ...prev,
          [pageId]: { ...prev[pageId], expanded: true },
        }));
      } else {
        // Load children
        void loadChildren(pageId);
      }
    },
    [nodeStates, loadChildren]
  );

  const isAllowed = useCallback((pageId: string) => localAllowed.some(p => p.id === pageId), [localAllowed]);

  const isExcluded = useCallback((pageId: string) => localExcluded.includes(pageId), [localExcluded]);

  const getAccessLevel = useCallback(
    (pageId: string): 'read' | 'readwrite' => {
      const entry = localAllowed.find(p => p.id === pageId);
      return entry?.access ?? 'read';
    },
    [localAllowed]
  );

  /**
   * Determines if a page inherits access from a parent in the allowed list.
   * Walks the ancestor chain from closest to furthest, respecting excluded
   * intermediates: if an excluded ancestor is encountered before an allowed one,
   * inheritance is blocked.
   */
  const isInheritedFromParent = useCallback(
    (pageId: string, parentChain: string[]): boolean => {
      if (isExcluded(pageId)) return false;
      // Walk from closest ancestor to furthest
      for (let i = parentChain.length - 1; i >= 0; i--) {
        if (isExcluded(parentChain[i])) return false;
        if (isAllowed(parentChain[i])) return true;
      }
      return false;
    },
    [isAllowed, isExcluded]
  );

  const togglePage = useCallback(
    (page: PageNode, parentChain: string[]) => {
      const directlyAllowed = isAllowed(page.id);
      const inherited = isInheritedFromParent(page.id, parentChain);
      const excluded = isExcluded(page.id);

      if (directlyAllowed) {
        // Remove from allowed list
        setLocalAllowed(prev => prev.filter(p => p.id !== page.id));
      } else if (inherited && !excluded) {
        // Currently inherited - exclude it
        setLocalExcluded(prev => [...prev, page.id]);
      } else if (inherited && excluded) {
        // Currently excluded - un-exclude it
        setLocalExcluded(prev => prev.filter(id => id !== page.id));
      } else {
        // Not allowed at all - add to allowed list with read access
        setLocalAllowed(prev => [...prev, { id: page.id, title: page.title, type: page.type, access: 'read' }]);
        // Remove from excluded if it was there
        setLocalExcluded(prev => prev.filter(id => id !== page.id));
      }
    },
    [isAllowed, isExcluded, isInheritedFromParent]
  );

  const setPageAccess = useCallback((pageId: string, access: 'read' | 'readwrite') => {
    setLocalAllowed(prev => prev.map(p => (p.id === pageId ? { ...p, access } : p)));
  }, []);

  const hasChanges =
    JSON.stringify(localAllowed) !== JSON.stringify(allowedPages) ||
    JSON.stringify(localExcluded) !== JSON.stringify(excludedPageIds);

  const handleSave = () => {
    onSave(localAllowed, localExcluded);
  };

  const renderPageNode = (page: PageNode, depth: number, parentChain: string[]) => {
    const state = nodeStates[page.id];
    const expanded = state?.expanded ?? false;
    const loading = state?.loading ?? false;
    const children = state?.children;

    const directlyAllowed = isAllowed(page.id);
    const inherited = isInheritedFromParent(page.id, parentChain);
    const excluded = isExcluded(page.id);
    const checked = directlyAllowed || (inherited && !excluded);

    const currentParentChain = [...parentChain, page.id];

    return (
      <Box key={page.id} data-testid={`notion-page-node-${page.id}`}>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            pl: `${depth * 24}px`,
            py: '4px',
            '&:hover': { bgcolor: 'background.level1' },
            borderRadius: '4px',
          }}
        >
          {/* Expand/collapse toggle */}
          {page.hasChildren ? (
            <Box
              component="button"
              onClick={() => toggleExpand(page.id)}
              sx={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                p: 0,
                display: 'flex',
                alignItems: 'center',
                color: 'text.secondary',
                width: 20,
                height: 20,
                flexShrink: 0,
              }}
            >
              {loading ? (
                <CircularProgress size="sm" sx={{ '--CircularProgress-size': '14px' }} />
              ) : expanded ? (
                <KeyboardArrowDownIcon sx={{ fontSize: 18 }} />
              ) : (
                <KeyboardArrowRightIcon sx={{ fontSize: 18 }} />
              )}
            </Box>
          ) : (
            <Box sx={{ width: 20, flexShrink: 0 }} />
          )}

          {/* Checkbox */}
          <Checkbox
            data-testid={`notion-page-checkbox-${page.id}`}
            size="sm"
            checked={checked}
            indeterminate={inherited && excluded}
            onChange={() => togglePage(page, parentChain)}
            sx={{ flexShrink: 0 }}
          />

          {/* Icon */}
          {page.type === 'database' ? (
            <StorageOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary', flexShrink: 0 }} />
          ) : (
            <DescriptionOutlinedIcon sx={{ fontSize: 16, color: 'text.tertiary', flexShrink: 0 }} />
          )}

          {/* Title */}
          <Typography
            level="body-sm"
            sx={{
              flex: 1,
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              fontWeight: directlyAllowed ? 500 : 400,
              color: excluded ? 'text.tertiary' : 'text.primary',
              textDecoration: excluded ? 'line-through' : 'none',
            }}
          >
            {page.title}
          </Typography>

          {/* Inherited badge */}
          {inherited && !directlyAllowed && !excluded && (
            <Typography level="body-xs" sx={{ color: 'text.tertiary', fontStyle: 'italic', flexShrink: 0 }}>
              inherited
            </Typography>
          )}

          {/* Access level selector - only for directly allowed pages */}
          {directlyAllowed && (
            <Select
              data-testid={`notion-page-access-${page.id}`}
              size="sm"
              variant="plain"
              value={getAccessLevel(page.id)}
              onChange={(_, val) => val && setPageAccess(page.id, val)}
              sx={{
                minWidth: 110,
                fontSize: '12px',
                flexShrink: 0,
                '--Select-decoratorChildHeight': '24px',
              }}
            >
              <Option value="read">Read only</Option>
              <Option value="readwrite">Read + Write</Option>
            </Select>
          )}
        </Box>

        {/* Children */}
        {expanded && children && (
          <Box>
            {children.length === 0 ? (
              <Typography level="body-xs" sx={{ pl: `${(depth + 1) * 24 + 24}px`, py: '4px', color: 'text.tertiary' }}>
                No child pages
              </Typography>
            ) : (
              children.map(child => renderPageNode(child, depth + 1, currentParentChain))
            )}
          </Box>
        )}
      </Box>
    );
  };

  if (loadingRoot) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', gap: '8px', py: '12px' }}>
        <CircularProgress size="sm" />
        <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
          Loading workspace pages...
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Box>
          <Typography level="body-sm" sx={{ fontWeight: 500 }}>
            Allowed pages
          </Typography>
          <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
            Select pages to grant access. Children inherit their parent&apos;s access level.
          </Typography>
        </Box>
        <Button
          data-testid="notion-page-picker-save"
          size="sm"
          disabled={!hasChanges || saving}
          loading={saving}
          onClick={handleSave}
        >
          Save
        </Button>
      </Box>

      {/* Page tree */}
      <Box
        data-testid="notion-page-tree"
        sx={{
          border: '1px solid',
          borderColor: 'divider',
          borderRadius: '6px',
          maxHeight: 320,
          overflowY: 'auto',
          p: '8px',
        }}
      >
        {topLevelPages.length === 0 ? (
          <Typography level="body-sm" sx={{ color: 'text.tertiary', textAlign: 'center', py: '16px' }}>
            No pages found in workspace. Make sure pages are shared with the integration in Notion.
          </Typography>
        ) : (
          topLevelPages.map(page => renderPageNode(page, 0, []))
        )}
      </Box>

      {/* Summary */}
      {localAllowed.length > 0 && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary' }}>
          {localAllowed.length} page{localAllowed.length !== 1 ? 's' : ''} selected
          {localAllowed.some(p => p.access === 'readwrite') && (
            <> ({localAllowed.filter(p => p.access === 'readwrite').length} with write access)</>
          )}
          {localExcluded.length > 0 && <>, {localExcluded.length} excluded</>}
        </Typography>
      )}
    </Box>
  );
};

export default NotionPagePicker;
