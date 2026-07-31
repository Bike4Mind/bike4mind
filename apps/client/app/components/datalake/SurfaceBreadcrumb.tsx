import { Breadcrumbs, Link, Typography } from '@mui/joy';

/**
 * Brand-agnostic breadcrumb for the Data Lake surface and any sibling mode
 * sub-view: crumb labels and handlers are entirely caller-supplied.
 *
 * `OptiModeBreadcrumb.tsx` re-exports this under its historical name for the
 * premium mode sub-views.
 */

interface SurfaceBreadcrumbProps {
  segments: { label: string; onClick?: () => void }[];
}

export function SurfaceBreadcrumb({ segments }: SurfaceBreadcrumbProps) {
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
