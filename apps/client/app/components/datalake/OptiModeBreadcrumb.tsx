import { Breadcrumbs, Link, Typography } from '@mui/joy';

/**
 * Shared breadcrumb used by each /opti mode sub-view AND the open Data Lakes
 * home. Lives in the open datalake namespace (extracted from the private hub)
 * so the open surface does not depend on the premium one.
 */

interface OptiModeBreadcrumbProps {
  segments: { label: string; onClick?: () => void }[];
}

export function OptiModeBreadcrumb({ segments }: OptiModeBreadcrumbProps) {
  return (
    <Breadcrumbs size="sm" sx={{ px: 0, mb: 2 }}>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        if (isLast || !seg.onClick) {
          return (
            <Typography key={seg.label} level="body-sm" fontWeight={isLast ? 'lg' : undefined}>
              {seg.label}
            </Typography>
          );
        }
        return (
          <Link
            key={seg.label}
            component="button"
            level="body-sm"
            color="neutral"
            onClick={seg.onClick}
            sx={{ cursor: 'pointer' }}
          >
            {seg.label}
          </Link>
        );
      })}
    </Breadcrumbs>
  );
}
