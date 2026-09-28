import React from 'react';
import { Stack, Tab, TabList, Typography } from '@mui/joy';
import { PlayArrow as PreviewIcon, Code as CodeIcon } from '@mui/icons-material';

/**
 * The Preview/Code tab strip every renderable artifact shows in the full viewer.
 *
 * One component rather than three copies because the point is that they read
 * identically: React said "Preview/Code", Mermaid said "Chart/Source", and HTML
 * offered no way to reach its source at all. A reader who learns the control on one
 * artifact should recognise it on the next.
 *
 * A TabList, not a whole `Tabs`: each host keeps its own tab state and values, which
 * are not interchangeable - React swaps the numeric values so an artifact with
 * validation errors opens on Code, while Mermaid keys on strings.
 */
export interface ArtifactModeTabsProps<T> {
  /** Tab value for the rendered view. */
  previewValue: T;
  /** Tab value for the source view. */
  codeValue: T;
  /** data-testid for the preview tab; the code tab gets `codeTestId`. */
  previewTestId?: string;
  codeTestId?: string;
  className?: string;
}

export function ArtifactModeTabs<T extends string | number>({
  previewValue,
  codeValue,
  previewTestId,
  codeTestId,
  className,
}: ArtifactModeTabsProps<T>) {
  return (
    <TabList className={className} sx={{ minHeight: 'auto' }}>
      <Tab value={previewValue} data-testid={previewTestId} sx={{ py: 0.5, minHeight: 'auto' }}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <PreviewIcon sx={{ fontSize: 18 }} />
          <Typography level="body-sm">Preview</Typography>
        </Stack>
      </Tab>
      <Tab value={codeValue} data-testid={codeTestId} sx={{ py: 0.5, minHeight: 'auto' }}>
        <Stack direction="row" spacing={0.5} alignItems="center">
          <CodeIcon sx={{ fontSize: 18 }} />
          <Typography level="body-sm">Code</Typography>
        </Stack>
      </Tab>
    </TabList>
  );
}

export default ArtifactModeTabs;
