import type { ReactNode } from 'react';
import { Box, Sheet, Stack, Typography } from '@mui/joy';
import { adminSurface } from './adminStyles';

type SectionCardProps = {
  title: string;
  /** A ghost button (or meta text) on the right of the title bar. */
  action?: ReactNode;
  children: ReactNode;
  /** `facts` (default) lays children out as a definition list; `custom` hands the body over as is. */
  body?: 'facts' | 'custom';
  'data-testid'?: string;
};

/** A titled group of facts (DESIGN_GUIDE.md section 5). Facts are `<Fact>`s; no form inputs inside. */
export function SectionCard({ title, action, children, body = 'facts', 'data-testid': testId }: SectionCardProps) {
  return (
    <Sheet
      component="section"
      variant="outlined"
      sx={{ ...adminSurface, borderRadius: 'lg', p: 0, minWidth: 0 }}
      data-testid={testId ?? 'admin-section-card'}
    >
      <Stack
        direction="row"
        flexWrap="wrap"
        gap={1}
        alignItems="center"
        sx={{ px: 2, minHeight: 50, py: 1, borderBottom: '1px solid', borderColor: 'admin.border' }}
      >
        <Typography level="title-md" component="h3" sx={{ color: 'admin.ink', mr: 'auto' }}>
          {title}
        </Typography>
        {action}
      </Stack>
      {body === 'facts' ? (
        <Box
          component="dl"
          sx={{
            m: 0,
            px: 2,
            py: 1.75,
            display: 'grid',
            gridTemplateColumns: 'minmax(120px, 40%) 1fr',
            columnGap: 1.5,
            rowGap: 1.25,
            fontSize: 14,
            '& dt': { color: 'admin.inkMuted' },
            '& dd': { m: 0, minWidth: 0, overflowWrap: 'anywhere', color: 'admin.ink' },
          }}
        >
          {children}
        </Box>
      ) : (
        children
      )}
    </Sheet>
  );
}

/** One row of a SectionCard's definition list. An empty value renders as a muted dash. */
export function Fact({
  label,
  children,
  'data-testid': testId,
}: {
  label: string;
  children?: ReactNode;
  'data-testid'?: string;
}) {
  const empty = children === undefined || children === null || children === '';
  return (
    <>
      <dt>{label}</dt>
      <dd data-testid={testId}>
        {empty ? (
          <Box component="span" sx={{ color: 'admin.inkMuted' }}>
            -
          </Box>
        ) : (
          children
        )}
      </dd>
    </>
  );
}
