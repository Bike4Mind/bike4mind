import { Breadcrumbs, Link, Typography } from '@mui/joy';

/**
 * Shared breadcrumb used by each /opti mode sub-view AND the open Data Lakes
 * home. Lives in the open datalake namespace (extracted from the private hub)
 * so the open surface does not depend on the premium one.
 */

interface OptiModeBreadcrumbProps {
  segments: { label: string; onClick?: () => void }[];
  /** Bottom margin in theme spacing units. Default 2 (standalone above a hero); pass 0 when
   *  embedded in a header row that owns its own spacing. */
  mb?: number;
  /** Left margin (spacing units or a raw CSS length). Default 0; used to sit the breadcrumb a
   *  fixed distance from a sibling control in a header row. */
  ml?: number | string;
}

export function OptiModeBreadcrumb({ segments, mb = 2, ml = 0 }: OptiModeBreadcrumbProps) {
  return (
    <Breadcrumbs size="sm" sx={{ px: 0, mb, ml }}>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        if (isLast || !seg.onClick) {
          return (
            <Typography
              key={seg.label}
              level="body-sm"
              fontWeight={isLast ? 400 : undefined}
              // Active (last) page is text.primary; any non-active plain crumb is muted tertiary.
              sx={{ color: isLast ? 'text.primary' : 'text.tertiary' }}
            >
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
            // Parent crumbs are muted tertiary; override the plain-variant color var so it wins
            // over Joy's neutral link color (a plain sx color loses to var(--variant-plainColor)).
            sx={{
              cursor: 'pointer',
              color: 'text.tertiary',
              '--variant-plainColor': 'var(--joy-palette-text-tertiary)',
            }}
          >
            {seg.label}
          </Link>
        );
      })}
    </Breadcrumbs>
  );
}
