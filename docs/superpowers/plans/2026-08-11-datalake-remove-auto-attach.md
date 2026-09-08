# Data Lake Tree Auto-Attach Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** File clicks in the chat-mode Data Lake tree stop auto-attaching files to the chat; rows get explicit hover actions instead: `[+]` add to chat, `[x]` remove from lake (gated), and a `...` menu with View that swaps the rail to an inline reader.

**Architecture:** All behavior lives in `DataLakeExplorer` (owner of handlers/state) and `DataLakeChatTree` (owner of row chrome). A new pure helper resolves a file's owning manageable lake for delete gating; a new `DataLakeRailReader` renders file content in the rail. The `chatEmbedded` prop and the KnowledgeViewer-split coupling are deleted end to end. Page mode (`/data-lakes`) and the Discover modal tree are untouched.

**Tech Stack:** React + MUI Joy (`Dropdown`/`Menu` for the row menu), react-query hooks in `apps/client/app/hooks/data/dataLakes.ts`, vitest + testing-library.

**Spec:** `docs/superpowers/specs/2026-08-11-datalake-remove-auto-attach-design.md`

## Global Constraints

- Repo: run everything from the worktree root `/Users/victor/coding.victor/bike4mind/.claude/worktrees/fix+datalake-remove-auto-attach`.
- Node 24 is required but not on the default PATH. Prefix every pnpm/node command with `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH"`.
- Test command: `PATH=... pnpm --filter @bike4mind/client test <relative-paths>` (the script is `vitest run`, so paths append directly; do NOT insert `-- run`, which breaks the filter and runs the whole 909-file suite). Paths are relative to `apps/client`. Set `VITEST_MAX_WORKERS=2`.
- ASCII only in `.ts`/`.tsx` (no smart punctuation; write typographic chars as `—`-style escapes or HTML entities in JSX).
- MUI Joy tests need the theme wrapper (custom tokens like `palette.notebooklist.hoverBg` break without it):
  ```tsx
  import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
  import { getThemeConfig } from '@client/app/utils/themes';
  const appTheme = extendTheme({ ...getThemeConfig() });
  const TestWrapper = ({ children }: { children: React.ReactNode }) => (
    <CssVarsProvider theme={appTheme}>{children}</CssVarsProvider>
  );
  ```
- `data-testid` naming: `component-action-element`. Never select by CSS class.
- Conventional commits; never mention teammate names or internal trackers.
- Comment hygiene: comments explain the why the code cannot; no restating code.

---

### Task 1: `resolveManageableLake` helper

**Files:**
- Create: `apps/client/app/components/datalake/resolveManageableLake.ts`
- Test: `apps/client/app/components/datalake/resolveManageableLake.test.ts`

**Interfaces:**
- Consumes: `DATALAKE_TAG_PREFIX`, `ManageableDataLakeConfig`, `IFabFileDocument` from `@bike4mind/common` (all exported from the package root).
- Produces: `resolveManageableLake(file: Pick<IFabFileDocument, 'tags'>, lakes: ManageableDataLakeConfig[] | undefined): ManageableDataLakeConfig | null` - Task 4 imports this by name.

- [ ] **Step 1: Write the failing test**

```ts
// apps/client/app/components/datalake/resolveManageableLake.test.ts
import { describe, it, expect } from 'vitest';
import type { ManageableDataLakeConfig } from '@bike4mind/common';
import { resolveManageableLake } from './resolveManageableLake';

const lake = (over: Partial<ManageableDataLakeConfig>): ManageableDataLakeConfig =>
  ({
    id: 'lake-1',
    slug: 'lake-a',
    name: 'Lake A',
    fileTagPrefix: 'lk:',
    datalakeTag: 'datalake:lake-a',
    canManage: true,
    ...over,
  }) as ManageableDataLakeConfig;

const file = (tagNames: string[]) => ({ tags: tagNames.map(name => ({ name })) }) as never;

describe('resolveManageableLake', () => {
  it('resolves the single manageable lake matching the membership meta-tag', () => {
    const l = lake({});
    expect(resolveManageableLake(file(['lk:books', 'datalake:lake-a']), [l])).toBe(l);
  });

  it('returns null when the resolved lake is not manageable by the caller', () => {
    expect(resolveManageableLake(file(['datalake:lake-a']), [lake({ canManage: false })])).toBeNull();
  });

  it('returns null when canManage is absent (fallback/read-only lakes)', () => {
    expect(resolveManageableLake(file(['datalake:lake-a']), [lake({ canManage: undefined })])).toBeNull();
  });

  it('returns null for a file with no membership meta-tag (prefix-only files)', () => {
    expect(resolveManageableLake(file(['lk:books']), [lake({})])).toBeNull();
  });

  it('returns null when the file belongs to more than one known lake', () => {
    const a = lake({});
    const b = lake({ id: 'lake-2', slug: 'lake-b', datalakeTag: 'datalake:lake-b' });
    expect(resolveManageableLake(file(['datalake:lake-a', 'datalake:lake-b']), [a, b])).toBeNull();
  });

  it('returns null when the lake list is not loaded yet', () => {
    expect(resolveManageableLake(file(['datalake:lake-a']), undefined)).toBeNull();
  });

  it('returns null for a membership tag naming no accessible lake', () => {
    expect(resolveManageableLake(file(['datalake:other']), [lake({})])).toBeNull();
  });

  it('returns null for a file with no tags at all', () => {
    expect(resolveManageableLake({ tags: undefined } as never, [lake({})])).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test app/components/datalake/resolveManageableLake.test.ts`
Expected: FAIL - cannot resolve `./resolveManageableLake`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/client/app/components/datalake/resolveManageableLake.ts
import { DATALAKE_TAG_PREFIX } from '@bike4mind/common';
import type { IFabFileDocument, ManageableDataLakeConfig } from '@bike4mind/common';

/**
 * Resolve the one lake a tree file can be removed from. The chat tree is cross-lake but the
 * removal endpoint is per-lake, so ownership is derived from the file's `datalake:` membership
 * meta-tag matched against the caller's lake list. Deliberately conservative - returns null
 * (hide the action) unless EXACTLY one accessible lake matches AND the caller can manage it:
 * prefix-only files carry no membership tag, and fallback lakes are server-side read-only and
 * arrive with canManage unset.
 */
export function resolveManageableLake(
  file: Pick<IFabFileDocument, 'tags'>,
  lakes: ManageableDataLakeConfig[] | undefined
): ManageableDataLakeConfig | null {
  if (!lakes?.length) return null;
  const memberTags = (file.tags ?? [])
    .map(t => t.name)
    .filter(name => name.startsWith(DATALAKE_TAG_PREFIX));
  if (memberTags.length === 0) return null;
  const owners = lakes.filter(l => memberTags.includes(l.datalakeTag));
  if (owners.length !== 1) return null;
  return owners[0].canManage ? owners[0] : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/datalake/resolveManageableLake.ts apps/client/app/components/datalake/resolveManageableLake.test.ts
git commit -m "feat(data-lake): add manageable-lake resolver for tree file actions"
```

---

### Task 2: `DataLakeRailReader` component

**Files:**
- Create: `apps/client/app/components/datalake/DataLakeRailReader.tsx`
- Test: `apps/client/app/components/datalake/DataLakeRailReader.test.tsx`

**Interfaces:**
- Consumes: `useGetFabFileContent(file)` from `@client/app/hooks/data/fabFiles` (takes the file document, returns `{ data: string | undefined, isLoading }`); `MarkdownViewer` from `@client/app/components/Knowledge/MarkdownViewer` (prop: `content: string`); `gray` from `@client/app/utils/themes/colors`.
- Produces: `default DataLakeRailReader({ file: IFabFileDocument; onBack: () => void })` - Task 4 renders it in place of the chat tree. Test ids: `datalake-rail-reader`, `datalake-reader-back-btn`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/client/app/components/datalake/DataLakeRailReader.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import DataLakeRailReader from './DataLakeRailReader';

const { contentState } = vi.hoisted(() => ({
  contentState: { data: undefined as string | undefined, isLoading: false },
}));
vi.mock('@client/app/hooks/data/fabFiles', () => ({
  useGetFabFileContent: () => contentState,
}));
vi.mock('@client/app/components/Knowledge/MarkdownViewer', () => ({
  default: ({ content }: { content: string }) => <div data-testid="mock-markdown">{content}</div>,
}));

const appTheme = extendTheme({ ...getThemeConfig() });
const file = { id: 'f1', fileName: '[Books] Deep Work.pdf', tags: [] } as unknown as IFabFileDocument;

const renderReader = (onBack = vi.fn()) => {
  render(
    <CssVarsProvider theme={appTheme}>
      <DataLakeRailReader file={file} onBack={onBack} />
    </CssVarsProvider>
  );
  return onBack;
};

describe('DataLakeRailReader', () => {
  beforeEach(() => {
    contentState.data = undefined;
    contentState.isLoading = false;
  });

  it('shows the cleaned file name (no extension, no [Category] prefix) in the header', () => {
    renderReader();
    expect(screen.getByTestId('datalake-rail-reader')).toHaveTextContent('Deep Work');
    expect(screen.queryByText('[Books] Deep Work.pdf')).toBeNull();
  });

  it('renders the file content as markdown once loaded', () => {
    contentState.data = '# Chapter 1';
    renderReader();
    expect(screen.getByTestId('mock-markdown')).toHaveTextContent('# Chapter 1');
  });

  it('shows a fallback message when content cannot load', () => {
    renderReader();
    expect(screen.getByTestId('datalake-rail-reader')).toHaveTextContent(/unable to load/i);
  });

  it('back button calls onBack', () => {
    const onBack = renderReader();
    fireEvent.click(screen.getByTestId('datalake-reader-back-btn'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test app/components/datalake/DataLakeRailReader.test.tsx`
Expected: FAIL - cannot resolve `./DataLakeRailReader`.

- [ ] **Step 3: Write the implementation**

```tsx
// apps/client/app/components/datalake/DataLakeRailReader.tsx
import { Box, IconButton, Skeleton, Tooltip, Typography, useTheme } from '@mui/joy';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import MarkdownViewer from '@client/app/components/Knowledge/MarkdownViewer';
import { useGetFabFileContent } from '@client/app/hooks/data/fabFiles';
import { gray } from '@client/app/utils/themes/colors';
import type { IFabFileDocument } from '@bike4mind/common';

interface DataLakeRailReaderProps {
  file: IFabFileDocument;
  onBack: () => void;
}

/**
 * Inline read-only reader that takes the chat tree's place in the Data Lake rail (View action).
 * Deliberately session-free: reading a lake file must not attach it to the chat or require a
 * session to exist - see the auto-attach removal spec. Wider than the 260px tree for comfort.
 */
export default function DataLakeRailReader({ file, onBack }: DataLakeRailReaderProps) {
  const theme = useTheme();
  const isDark = theme.palette.mode === 'dark';
  const { data: content, isLoading } = useGetFabFileContent(file);
  const title = file.fileName.replace(/\.[^/.]+$/, '').replace(/^\[.*?\]\s*/, '');

  return (
    <Box
      data-testid="datalake-rail-reader"
      sx={{
        width: 420,
        minWidth: 320,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        // Same shell treatment as the chat tree rail it replaces (DataLakeChatTree containerSx).
        backgroundColor: 'background.surface2',
        border: '1px solid',
        borderColor: isDark ? gray[800] : gray[200],
        borderRadius: '10px',
      }}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          p: '8px 12px',
          borderBottom: '1px solid',
          borderColor: isDark ? gray[800] : gray[200],
        }}
      >
        <Tooltip title="Back to files" size="sm">
          <IconButton
            size="sm"
            variant="plain"
            color="neutral"
            onClick={onBack}
            aria-label="Back to files"
            data-testid="datalake-reader-back-btn"
          >
            <ArrowBackIcon sx={{ fontSize: 18 }} />
          </IconButton>
        </Tooltip>
        <Typography noWrap sx={{ fontSize: '14px', fontWeight: 500, color: 'text.primary' }}>
          {title}
        </Typography>
      </Box>
      <Box sx={{ flex: 1, overflow: 'auto', px: 2, py: 1.5 }}>
        {isLoading ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            <Skeleton variant="text" level="body-md" sx={{ width: '100%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '90%' }} />
            <Skeleton variant="text" level="body-md" sx={{ width: '95%' }} />
          </Box>
        ) : content ? (
          <MarkdownViewer content={content} />
        ) : (
          <Typography level="body-sm" sx={{ color: 'text.tertiary' }}>
            Unable to load file content.
          </Typography>
        )}
      </Box>
    </Box>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: same command as Step 2.
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/datalake/DataLakeRailReader.tsx apps/client/app/components/datalake/DataLakeRailReader.test.tsx
git commit -m "feat(data-lake): add rail reader panel for inline file viewing"
```

---

### Task 3: Hover actions on `DataLakeChatTree` file rows

**Files:**
- Modify: `apps/client/app/components/datalake/DataLakeChatTree.tsx`
- Test (create): `apps/client/app/components/datalake/DataLakeChatTree.test.tsx`

**Interfaces:**
- Consumes: `DataLakeTreeChrome.renderFileRow(file, selected, onSelect)` from `./DataLakeTreeView` (signature unchanged; the chat chrome now ignores `onSelect`).
- Produces (new required props on `DataLakeChatTreeProps`, consumed by Task 4):
  - `onAttachFile: (file: IFabFileDocument) => void`
  - `onViewFile: (file: IFabFileDocument) => void`
  - `canDeleteFile: (file: IFabFileDocument) => boolean`
  - `onDeleteFile: (file: IFabFileDocument) => void`
  - `onSelectFile` becomes OPTIONAL and ignored in this task (kept so the current `DataLakeExplorer` call site still typechecks); Task 4 deletes it.
- Test ids produced: `datalake-attach-btn-<id>`, `datalake-delete-btn-<id>`, `datalake-row-menu-btn-<id>`, `datalake-view-item-<id>`; row keeps `datalake-file-<id>`.

- [ ] **Step 1: Write the failing test**

```tsx
// apps/client/app/components/datalake/DataLakeChatTree.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CssVarsProvider, extendTheme } from '@mui/joy/styles';
import { getThemeConfig } from '@client/app/utils/themes';
import type { IFabFileDocument } from '@bike4mind/common';
import DataLakeChatTree from './DataLakeChatTree';

const appTheme = extendTheme({ ...getThemeConfig() });

const article = {
  id: 'f1',
  fileName: 'Deep Work.pdf',
  tags: [{ name: 'books' }, { name: 'datalake:lake-a' }],
} as unknown as IFabFileDocument;

// breadcrumb ['books'] with an empty tree resolves to a leaf tag, so the file list renders.
const baseProps = {
  tree: [],
  articles: [article],
  breadcrumb: ['books'],
  onNavigate: vi.fn(),
  selectedFileId: null,
  isLoading: false,
  onAttachFile: vi.fn(),
  onViewFile: vi.fn(),
  canDeleteFile: () => true,
  onDeleteFile: vi.fn(),
};

const renderTree = (props: Partial<React.ComponentProps<typeof DataLakeChatTree>> = {}) =>
  render(
    <CssVarsProvider theme={appTheme}>
      <DataLakeChatTree {...baseProps} {...props} />
    </CssVarsProvider>
  );

describe('DataLakeChatTree file-row actions', () => {
  it('file rows are not buttons: clicking the row triggers no action', () => {
    const onAttachFile = vi.fn();
    const onViewFile = vi.fn();
    renderTree({ onAttachFile, onViewFile });
    fireEvent.click(screen.getByTestId('datalake-file-f1'));
    expect(onAttachFile).not.toHaveBeenCalled();
    expect(onViewFile).not.toHaveBeenCalled();
    // No ListItemButton semantics on the row itself.
    expect(screen.getByTestId('datalake-file-f1').closest('[role="button"]')).toBeNull();
  });

  it('attach button calls onAttachFile with the file', () => {
    const onAttachFile = vi.fn();
    renderTree({ onAttachFile });
    fireEvent.click(screen.getByTestId('datalake-attach-btn-f1'));
    expect(onAttachFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('delete button shows only when canDeleteFile allows, and calls onDeleteFile', () => {
    const onDeleteFile = vi.fn();
    renderTree({ onDeleteFile });
    fireEvent.click(screen.getByTestId('datalake-delete-btn-f1'));
    expect(onDeleteFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });

  it('hides the delete button when canDeleteFile returns false', () => {
    renderTree({ canDeleteFile: () => false });
    expect(screen.queryByTestId('datalake-delete-btn-f1')).toBeNull();
    // The other actions stay.
    expect(screen.getByTestId('datalake-attach-btn-f1')).toBeInTheDocument();
  });

  it('View lives in the row menu and calls onViewFile', () => {
    const onViewFile = vi.fn();
    renderTree({ onViewFile });
    fireEvent.click(screen.getByTestId('datalake-row-menu-btn-f1'));
    fireEvent.click(screen.getByTestId('datalake-view-item-f1'));
    expect(onViewFile).toHaveBeenCalledWith(expect.objectContaining({ id: 'f1' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test app/components/datalake/DataLakeChatTree.test.tsx`
Expected: FAIL - unknown props / missing test ids (`datalake-attach-btn-f1` not found).

- [ ] **Step 3: Implement the row actions**

In `apps/client/app/components/datalake/DataLakeChatTree.tsx`:

3a. Add imports:

```tsx
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import MoreVertIcon from '@mui/icons-material/MoreVert';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import { Dropdown, Menu, MenuButton, MenuItem } from '@mui/joy';
```

(Extend the existing `@mui/joy` import list rather than adding a second one; `ListItemButton` stays - the back row and node rows still use it.)

3b. Replace the `selectedFileId`/`onSelectFile` block of `DataLakeChatTreeProps` (lines 44-45) with:

```tsx
  selectedFileId: string | null;
  /** Dead since the auto-attach removal (rows are action-driven); deleted with the explorer rewire. */
  onSelectFile?: (file: IFabFileDocument) => void;
  /** Hover action: attach the file to the chat session. */
  onAttachFile: (file: IFabFileDocument) => void;
  /** Hover menu action: open the file in the rail reader. */
  onViewFile: (file: IFabFileDocument) => void;
  /** Gates the per-row delete button (owning lake resolved + manageable). */
  canDeleteFile: (file: IFabFileDocument) => boolean;
  /** Hover action: request removal from the owning lake (host owns the confirm). */
  onDeleteFile: (file: IFabFileDocument) => void;
```

Destructure the new props in the component signature (`onSelectFile` no longer needs destructuring; remove it).

3c. Replace `renderFileRow` (the whole `renderFileRow: (file, selected, onSelect) => (...)` entry) with:

```tsx
    renderFileRow: (file, selected) => (
      <ListItem key={file.id}>
        {/* Plain row, not a ListItemButton: row clicks are dead by design (auto-attach removal);
            every action is an explicit control. Actions reveal on hover/focus and stay visible
            on touch (no-hover) devices. */}
        <Box
          data-testid={`datalake-file-${file.id}`}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            width: '100%',
            minWidth: 0,
            minHeight: '28px',
            borderRadius: '8px',
            px: '8px',
            transition: 'background 0.15s',
            backgroundColor: selected ? theme.palette.notebooklist.hoverBg : undefined,
            '&:hover': { backgroundColor: theme.palette.notebooklist.hoverBg },
            '@media (hover: hover)': { '& .dl-row-actions': { opacity: 0 } },
            '&:hover .dl-row-actions, &:focus-within .dl-row-actions': { opacity: 1 },
          }}
        >
          <ArticleOutlinedIcon
            sx={{ fontSize: 16, color: selected ? inkFor(HUES.cyan, isDark) : 'text.tertiary', flexShrink: 0 }}
          />
          <Typography
            noWrap
            sx={{ flex: 1, minWidth: 0, fontSize: '14px', fontWeight: selected ? 'lg' : 400, color: 'text.primary' }}
          >
            {file.fileName.replace(/\.[^/.]+$/, '')}
          </Typography>
          <Box
            className="dl-row-actions"
            sx={{ display: 'flex', alignItems: 'center', gap: '2px', flexShrink: 0, transition: 'opacity 0.15s' }}
          >
            <Tooltip title="Add to chat" size="sm">
              <IconButton
                size="sm"
                variant="plain"
                color="neutral"
                aria-label="Add to chat"
                data-testid={`datalake-attach-btn-${file.id}`}
                onClick={() => onAttachFile(file)}
                sx={ROW_ACTION_SX}
              >
                <AddIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
            {canDeleteFile(file) && (
              <Tooltip title="Remove from lake" size="sm">
                <IconButton
                  size="sm"
                  variant="plain"
                  color="neutral"
                  aria-label="Remove from lake"
                  data-testid={`datalake-delete-btn-${file.id}`}
                  onClick={() => onDeleteFile(file)}
                  sx={ROW_ACTION_SX}
                >
                  <DeleteOutlineIcon sx={{ fontSize: 16 }} />
                </IconButton>
              </Tooltip>
            )}
            <Dropdown>
              <MenuButton
                slots={{ root: IconButton }}
                slotProps={{
                  root: {
                    size: 'sm',
                    variant: 'plain',
                    color: 'neutral',
                    'aria-label': 'More actions',
                    'data-testid': `datalake-row-menu-btn-${file.id}`,
                    sx: ROW_ACTION_SX,
                  },
                }}
              >
                <MoreVertIcon sx={{ fontSize: 16 }} />
              </MenuButton>
              <Menu size="sm" placement="bottom-end">
                <MenuItem data-testid={`datalake-view-item-${file.id}`} onClick={() => onViewFile(file)}>
                  <VisibilityOutlinedIcon sx={{ fontSize: 16 }} />
                  View
                </MenuItem>
              </Menu>
            </Dropdown>
          </Box>
        </Box>
      </ListItem>
    ),
```

3d. Add the shared action-button sizing next to the component (module scope, above the component):

```tsx
/** Compact 22px hover-action buttons so three of them fit a 260px rail row. */
const ROW_ACTION_SX = {
  '--IconButton-size': '22px',
  minWidth: '22px',
  minHeight: '22px',
} as const;
```

3e. In the `DataLakeTreeView` render at the bottom, replace `onSelectFile={onSelectFile}` with `onSelectFile={() => {}}`, and add this comment on its own line ABOVE the `<DataLakeTreeView` element (comments inside a JSX opening tag are brittle):

```tsx
  // Chat rows carry explicit actions instead of a click handler; TreeView still requires the
  // callback for the page tree's sake, so it gets a no-op.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test app/components/datalake/DataLakeChatTree.test.tsx app/components/datalake/DataLakeTreeView.test.tsx`
Expected: both PASS. `DataLakeTreeView.test.tsx` builds its own test chrome (it never imports `DataLakeChatTree`), so it must stay green untouched; a failure there means the TreeView engine was changed, which this task must not do.

- [ ] **Step 5: Commit**

```bash
git add apps/client/app/components/datalake/DataLakeChatTree.tsx apps/client/app/components/datalake/DataLakeChatTree.test.tsx
git commit -m "feat(data-lake): add hover actions to chat tree file rows"
```

---

### Task 4: Rewire `DataLakeExplorer` + `DataLakeChatSurface` (the actual bug fix)

**Files:**
- Modify: `apps/client/app/components/datalake/DataLakeExplorer.tsx`
- Modify: `apps/client/app/components/datalake/DataLakeChatSurface.tsx` (drop `chatEmbedded`)
- Modify: `apps/client/app/components/datalake/DataLakeChatTree.tsx` (delete the dead optional `onSelectFile` prop from Task 3)
- Test: `apps/client/app/components/datalake/DataLakeExplorer.test.tsx` (rewrite chat-surface describe)
- Test: `apps/client/app/components/datalake/DataLakeChatSurface.test.tsx` (drop chat-embedded assertion)
- Test: `apps/client/app/components/datalake/DataLakeExplorer.nav.test.tsx` (extend module mocks only)

**Interfaces:**
- Consumes: `resolveManageableLake` (Task 1), `DataLakeRailReader` (Task 2), chat-tree props `onAttachFile`/`onViewFile`/`canDeleteFile`/`onDeleteFile` (Task 3), `useGetDataLakes(enabled)` and `useRemoveFileFromDataLake(dataLakeId | null)` from `@client/app/hooks/data/dataLakes`.
- Produces: `DataLakeExplorerProps` WITHOUT `chatEmbedded`. New test ids: `datalake-tree-removefile-confirm`, `datalake-tree-removefile-confirm-btn`.

- [ ] **Step 1: Rewrite the chat-surface tests to describe the new behavior**

In `apps/client/app/components/datalake/DataLakeExplorer.test.tsx`:

1a. Extend the hoisted spies (line 10-15) with a delete-mutation spy and a mutable lake list:

```tsx
const { setWorkBenchFiles, setSessionLayout, sessionState, removeFileMutate, lakesState } = vi.hoisted(() => ({
  setWorkBenchFiles: vi.fn(),
  setSessionLayout: vi.fn(),
  // Mutable so the /new (deferred creation, no session yet) case can null it per-test.
  sessionState: { currentSessionId: 'sess-1' as string | null },
  removeFileMutate: vi.fn(),
  // Mutable so delete-gating tests can vary the accessible-lake list per-test.
  lakesState: { value: [{ id: 'lake-1', name: 'Lake A', datalakeTag: 'datalake:lake-a', canManage: true }] as unknown[] },
}));
```

1b. Extend the `@client/app/hooks/data/dataLakes` mock factory (line 26-40) with the two hooks the explorer now consumes:

```tsx
  useGetDataLakes: () => ({ data: lakesState.value }),
  useRemoveFileFromDataLake: () => ({ mutate: removeFileMutate, isPending: false }),
```

1c. Replace the `./DataLakeChatTree` mock (lines 80-102) with one exposing the action props:

```tsx
// Stub the tree so we can trigger the row actions deterministically and read the highlight
// prop. Chat mode (chatSlot set) renders DataLakeChatTree, so that is what we stub. The file
// carries a membership meta-tag so delete-gating tests exercise resolveManageableLake for real.
vi.mock('./DataLakeChatTree', () => ({
  default: (props: {
    onAttachFile: (f: { id: string; fileName: string }) => void;
    onViewFile: (f: { id: string; fileName: string }) => void;
    canDeleteFile: (f: { id: string; fileName: string }) => boolean;
    onDeleteFile: (f: { id: string; fileName: string }) => void;
    selectedFileId: string | null;
    onClose?: () => void;
  }) => {
    const file = { id: 'file-123', fileName: 'x.pdf', tags: [{ name: 'datalake:lake-a' }] };
    return (
      <div
        data-testid="mock-tree"
        data-selected={props.selectedFileId ?? ''}
        data-can-delete={String(props.canDeleteFile(file))}
        data-has-row-click={String('onSelectFile' in props)}
      >
        <button data-testid="mock-attach" onClick={() => props.onAttachFile(file)}>
          attach
        </button>
        <button data-testid="mock-view" onClick={() => props.onViewFile(file)}>
          view
        </button>
        <button data-testid="mock-delete" onClick={() => props.onDeleteFile(file)}>
          delete
        </button>
        {props.onClose && (
          <button data-testid="mock-close" onClick={props.onClose}>
            close
          </button>
        )}
      </div>
    );
  },
}));
```

1d. In `baseProps` (line 111-115), delete `chatEmbedded: true`.

1e. In the `beforeEach` (line 125-128), reset the lake list:

```tsx
    lakesState.value = [{ id: 'lake-1', name: 'Lake A', datalakeTag: 'datalake:lake-a', canManage: true }];
```

1f. Replace ALL tests between `it('opens a clicked file inline...')` and the end of the first describe (lines 135-211) with:

```tsx
  it('gives the tree no row-click handler: browsing must not mutate the chat', () => {
    renderExplorer();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-has-row-click', 'false');
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('attach action adds the file to the workbench and toasts, never touching layout', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-attach'));
    expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-1', expect.any(Function));
    expect(toastInfo).toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('attach on /new with createSessionForFile mints the session, then attaches', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockResolvedValue('sess-new');
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-attach'));
    await vi.waitFor(() => {
      expect(setWorkBenchFiles).toHaveBeenCalledWith('sess-new', expect.any(Function));
    });
    expect(createSessionForFile).toHaveBeenCalledTimes(1);
  });

  it('attach with no session and no create path guides via toast, writes nothing', () => {
    sessionState.currentSessionId = null;
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-attach'));
    expect(toastInfo).toHaveBeenCalled();
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
  });

  it('attach create rejection toasts an error and attaches nothing', async () => {
    sessionState.currentSessionId = null;
    const createSessionForFile = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderExplorer({ createSessionForFile });
    fireEvent.click(screen.getByTestId('mock-attach'));
    await vi.waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('view swaps the rail to the reader without attaching or needing a session', () => {
    sessionState.currentSessionId = null;
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-view'));
    expect(screen.getByTestId('datalake-rail-reader')).toBeInTheDocument();
    expect(screen.queryByTestId('mock-tree')).toBeNull();
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('reader back returns to the tree with the viewed file highlighted', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-view'));
    fireEvent.click(screen.getByTestId('datalake-reader-back-btn'));
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-selected', 'file-123');
    expect(screen.queryByTestId('datalake-rail-reader')).toBeNull();
  });

  it('deep-linked articleId opens the reader without attaching', () => {
    renderExplorer({ articleId: 'deep-1' });
    expect(screen.getByTestId('datalake-rail-reader')).toBeInTheDocument();
    expect(setWorkBenchFiles).not.toHaveBeenCalled();
    expect(setSessionLayout).not.toHaveBeenCalled();
  });

  it('delete is offered only for a uniquely-resolved manageable lake', () => {
    renderExplorer();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-can-delete', 'true');
  });

  it('delete is not offered when the owning lake is not manageable', () => {
    lakesState.value = [{ id: 'lake-1', name: 'Lake A', datalakeTag: 'datalake:lake-a', canManage: false }];
    renderExplorer();
    expect(screen.getByTestId('mock-tree')).toHaveAttribute('data-can-delete', 'false');
  });

  it('delete action confirms first, then fires the per-lake removal', () => {
    renderExplorer();
    fireEvent.click(screen.getByTestId('mock-delete'));
    expect(removeFileMutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('datalake-tree-removefile-confirm-btn'));
    expect(removeFileMutate).toHaveBeenCalledWith('file-123', expect.anything());
  });
```

Keep the `renders chatSlot`, close (X), and `showModeClose` tests as they are.

- [ ] **Step 2: Run the explorer tests to verify the new ones fail**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test app/components/datalake/DataLakeExplorer.test.tsx`
Expected: FAIL - `mock-attach` etc. not rendered (explorer passes no `onAttachFile`), `data-has-row-click` is `'true'`.

- [ ] **Step 3: Rewire `DataLakeExplorer.tsx`**

3a. Imports: DELETE `import { setSessionLayout } from '@client/app/hooks/useSessionLayout';`. ADD:

```tsx
import { Button, DialogActions, DialogContent, DialogTitle, Modal, ModalDialog } from '@mui/joy';
import DataLakeRailReader from './DataLakeRailReader';
import { resolveManageableLake } from './resolveManageableLake';
import type { ManageableDataLakeConfig } from '@bike4mind/common';
```

(Merge the Joy names into the existing `@mui/joy` import - `Box, Button, Typography, useTheme` already come from there. Extend the existing dataLakes hook import to `import { useGetDataLakeArticles, useGetDataLakeTagCounts, useGetDataLakes, useRemoveFileFromDataLake } from '@client/app/hooks/data/dataLakes';`. Merge the type import with the existing `IFabFileDocument` type import.)

3b. In `DataLakeExplorerProps`, DELETE the whole `chatEmbedded` property and its doc comment (lines 69-77). Update the `chatSlot` doc comment's embedded/docked distinction sentence to:

```tsx
  /**
   * Fills the pane right of the tree and switches this component into CHAT mode. The chat may
   * be the main app's SessionContainer (DataLakeChatSurface) or live docked OUTSIDE this
   * component (premium overlay); either way the tree never drives the global session layout.
   */
  chatSlot?: React.ReactNode;
```

Update `createSessionForFile`'s doc comment to describe attach instead of click-to-open:

```tsx
  /**
   * Called when a file is ATTACHED with no active session (/new, where creation is deferred to
   * the first message): must create + adopt the session and resolve its id so the attach can
   * land in a real workbench. Omitted (overlay) -> a guidance toast instead.
   */
```

Also update the component-level doc comment (lines 36-39): replace the "files open in the KnowledgeViewer split (embedded) or the chat's workbench (docked)" sentence with "file rows carry explicit actions (attach to chat, view in the rail reader, remove from lake) - browsing never mutates the chat".

3c. In the component signature, remove `chatEmbedded = false,`.

3d. Replace the `viewerFileId` comment + state (lines 120-121) and add reader/delete state right after it:

```tsx
  // Chat mode: id of the file most recently viewed, kept to highlight it in the tree.
  const [viewerFileId, setViewerFileId] = useState<string | null>(articleId ?? null);
  // Chat mode: file open in the rail reader (View action); it replaces the tree until Back.
  const [readerFile, setReaderFile] = useState<IFabFileDocument | null>(null);
  // Chat mode: pending remove-from-lake confirmation.
  const [deleteTarget, setDeleteTarget] = useState<{ file: IFabFileDocument; lake: ManageableDataLakeConfig } | null>(
    null
  );
```

3e. Replace the whole `openFileInViewer` callback (lines 134-170) with:

```tsx
  // Explicit [+] action; the one place lake browsing writes into the chat. Comment at the
  // hooks above (#836) still applies: hooks always run, page mode never calls this.
  const attachFileToChat = useCallback(
    async (file: IFabFileDocument) => {
      let sessionId = currentSessionId;
      if (!sessionId) {
        // /new: session creation is deferred to the first message, so there is no workbench to
        // attach to. Hosts that can mint the grounded session do so here; otherwise guide.
        if (!createSessionForFile || creatingSessionRef.current) {
          if (!createSessionForFile) {
            toast.info('Start the chat with a first message - then lake files can be added to it.');
          }
          return;
        }
        creatingSessionRef.current = true;
        try {
          sessionId = await createSessionForFile();
        } catch (error) {
          console.error('Data Lake session create failed:', error);
          toast.error("Couldn't start the chat - please try again.");
          return;
        } finally {
          creatingSessionRef.current = false;
        }
      }
      setWorkBenchFiles(sessionId, prev => (prev.some(f => f.id === file.id) ? prev : [...prev, file]));
      toast.info(`Added "${file.fileName.replace(/\.[^/.]+$/, '')}" to the chat's files`);
    },
    [currentSessionId, setWorkBenchFiles, createSessionForFile]
  );

  const handleViewFile = useCallback((file: IFabFileDocument) => {
    setReaderFile(file);
    setViewerFileId(file.id);
  }, []);

  // Delete gating: the lake list is only needed in chat mode (page mode has no row actions).
  const { data: lakes } = useGetDataLakes(chatMode);
  const removeFile = useRemoveFileFromDataLake(deleteTarget?.lake.id ?? null);
  const canDeleteFile = useCallback(
    (file: IFabFileDocument) => resolveManageableLake(file, lakes) != null,
    [lakes]
  );
  const handleDeleteFile = useCallback(
    (file: IFabFileDocument) => {
      const lake = resolveManageableLake(file, lakes);
      if (lake) setDeleteTarget({ file, lake });
    },
    [lakes]
  );
```

3f. Replace the deep-link effect body (lines 243-250):

```tsx
  // Chat mode: show the URL's article in the rail reader once it resolves, once per id.
  const openedDeepLinkRef = useRef<string | null>(null);
  useEffect(() => {
    if (chatMode && deepLinkTarget && openedDeepLinkRef.current !== deepLinkTarget.id) {
      openedDeepLinkRef.current = deepLinkTarget.id;
      setReaderFile(deepLinkTarget);
      setViewerFileId(deepLinkTarget.id);
    }
  }, [chatMode, deepLinkTarget]);
```

Also update the comment above the deep-link fetch (line 232-233): "chat mode shows it in the rail reader (effect below)".

3g. Replace `handleNavigate` (lines 252-268):

```tsx
  const handleNavigate = useCallback(
    (newBreadcrumb: string[]) => {
      setBreadcrumb(newBreadcrumb);
      if (chatMode) {
        // Browsing away closes the rail reader; navigation can arrive from the host's idle
        // pane (DataLakeNavProvider) while the reader has the rail.
        setReaderFile(null);
        setViewerFileId(null);
      } else {
        setUserSelectedFile(null);
      }
    },
    [chatMode]
  );
```

3h. Replace `handleSelectFile` (lines 270-276) - it is page-mode-only now:

```tsx
  // Page mode only: the chat tree's rows carry explicit actions instead of a click handler.
  const handleSelectFile = useCallback((file: IFabFileDocument) => setUserSelectedFile(file), []);
```

3i. In the chat-mode render branch (lines 485-498), swap tree/reader and rewire props - replace the `<DataLakeChatTree ... />` element with:

```tsx
          {readerFile ? (
            <DataLakeRailReader file={readerFile} onBack={() => setReaderFile(null)} />
          ) : (
            <DataLakeChatTree
              tree={tree}
              articles={leafArticles}
              breadcrumb={breadcrumb}
              onNavigate={handleNavigate}
              selectedFileId={viewerFileId}
              onAttachFile={attachFileToChat}
              onViewFile={handleViewFile}
              canDeleteFile={canDeleteFile}
              onDeleteFile={handleDeleteFile}
              isLoading={tagCountsLoading || (!!leafTag && leafLoading)}
              isError={tagCountsError}
              title={rootLabel ?? copy.rootLabel}
              onManage={onManage}
              onCreateLake={onCreateLake}
              onClose={showModeClose ? () => setDataLakeMode(false) : undefined}
            />
          )}
```

3j. Add the confirm modal directly above `<DataLakeIngestPickerModal`:

```tsx
      {/* Remove-from-lake confirmation for the tree's [x] action. Same contract as the
          Discover viewer's remove: membership + prefix tags go, the file itself stays. */}
      <Modal open={deleteTarget != null} onClose={() => setDeleteTarget(null)}>
        <ModalDialog data-testid="datalake-tree-removefile-confirm" role="alertdialog">
          <DialogTitle>Remove file from data lake?</DialogTitle>
          <DialogContent>
            &ldquo;{deleteTarget ? deleteTarget.file.fileName.replace(/\.[^/.]+$/, '') : ''}&rdquo; will be removed
            from &ldquo;{deleteTarget?.lake.name}&rdquo; and stops appearing here right away. The file stays in your
            Files list and in any chats that use it.
          </DialogContent>
          <DialogActions>
            <Button
              variant="solid"
              color="danger"
              data-testid="datalake-tree-removefile-confirm-btn"
              loading={removeFile.isPending}
              onClick={() =>
                deleteTarget &&
                removeFile.mutate(deleteTarget.file.id, { onSuccess: () => setDeleteTarget(null) })
              }
            >
              Remove
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
```

- [ ] **Step 4: Drop `chatEmbedded` from `DataLakeChatSurface.tsx` and the dead prop from `DataLakeChatTree.tsx`**

4a. In `DataLakeChatSurface.tsx` line 43: delete the `chatEmbedded` line from the `<DataLakeExplorer ...>` JSX. Update the `createSessionForFile` comment (lines 32-33) to match the new meaning:

```tsx
  // Attach on /new: mint the grounded session right away (same creation the first-send
  // seam uses) so the [+] action lands in a real workbench instead of dead-ending.
```

4b. In `DataLakeChatTree.tsx`: delete the optional `onSelectFile` prop and its comment from `DataLakeChatTreeProps` (left there by Task 3 only to keep the old call site compiling).

- [ ] **Step 5: Update the sibling test files' mocks**

5a. `DataLakeChatSurface.test.tsx`: in the `./DataLakeExplorer` stub (lines 28-41), remove `chatEmbedded` from the destructure and the `data-chat-embedded` attribute; delete the assertion `expect(explorer).toHaveAttribute('data-chat-embedded', 'true');` and its comment (lines 62-63). Keep `data-can-create-session`.

5b. `DataLakeExplorer.nav.test.tsx`: the explorer now imports two more hooks from the mocked module - add to the `@client/app/hooks/data/dataLakes` factory (after `useGetDataLakeTagCounts`):

```tsx
  useGetDataLakes: () => ({ data: [] }),
  useRemoveFileFromDataLake: () => ({ mutate: vi.fn(), isPending: false }),
```

If its `./DataLakeChatTree` stub destructures `onSelectFile`, leave the stub alone (extra props on a stub are harmless); only the module factory needs the new hooks.

- [ ] **Step 6: Run the affected tests**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test app/components/datalake`
Expected: PASS across the whole directory (explorer, nav, chat surface, chat tree, tree view, article, rail reader).

- [ ] **Step 7: Typecheck**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm --filter @bike4mind/client typecheck`
Expected: clean. (Catches any missed `chatEmbedded` / `onSelectFile` references.)

- [ ] **Step 8: Commit**

```bash
git add apps/client/app/components/datalake
git commit -m "fix(data-lake): stop auto-attaching tree files to the chat"
```

---

### Task 5: Full verification + branch push

**Files:** none new.

- [ ] **Step 1: Full client test suite**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" VITEST_MAX_WORKERS=2 pnpm --filter @bike4mind/client test`
Expected: PASS. Investigate ANY failure - `KnowledgeViewer`, `useSendMessage`, and `WorkBench` tests must be untouched by this change; a failure there means a missed coupling, not test flake.

- [ ] **Step 2: Repo-wide typecheck and lint**

Run: `PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm turbo:typecheck && PATH="$HOME/.nvm/versions/node/v24.16.0/bin:$PATH" pnpm lint:check`
Expected: both clean.

- [ ] **Step 3: Grep for leftovers**

Run: `git grep -n 'chatEmbedded' -- apps/client b4m-core packages`
Expected: no hits. (The premium overlay's guard test lives in the private repo and asserts absence; nothing to change there.)

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin fix/datalake-remove-auto-attach
```

PR (fill the repo's PR template; base `main`): title `fix(data-lake): stop auto-attaching tree files to the chat`. Body must describe: the two chat surfaces' old click behavior, the new explicit actions (`[+]` attach, `[x]` remove with confirm + canManage gating, `...` > View rail reader), the `chatEmbedded` removal, and that page mode / Discover tree are untouched. No teammate names, no internal tracker refs, no overlay change details (there are none - state that the overlay needed no changes).

---

## Self-review notes (kept for the executor)

- Spec coverage: click-does-nothing (Task 3 row + Task 4 no-handler test), attach (Task 4 3e), delete gating (Tasks 1, 4 3e), View rail reader (Tasks 2, 4 3i), deep-link (Task 4 3f), `chatEmbedded` removal (Task 4 3b/4a), page/Discover untouched (no task touches them), test inversion (Task 4 Step 1).
- Between Tasks 3 and 4 the repo typechecks because Task 3 keeps `onSelectFile` as an optional ignored prop; Task 4 deletes it.
- `resolveManageableLake` runs REAL in the explorer tests (only the tree and data hooks are stubbed), so gating tests exercise the actual meta-tag matching.
