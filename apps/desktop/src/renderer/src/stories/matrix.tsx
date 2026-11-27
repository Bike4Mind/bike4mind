import type { ReactNode } from 'react';
import Box from '@mui/joy/Box';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import type { ColorPaletteProp, VariantProp } from '@mui/joy/styles';

export const VARIANTS: readonly VariantProp[] = ['solid', 'soft', 'outlined', 'plain'];
export const COLORS: readonly ColorPaletteProp[] = ['primary', 'neutral', 'danger', 'success', 'warning'];
export const SIZES = ['sm', 'md', 'lg'] as const;

/** One cell per variant and color, which is how Joy keys nearly every component style. */
export function VariantMatrix({ render }: { render: (variant: VariantProp, color: ColorPaletteProp) => ReactNode }) {
  return (
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: `max-content repeat(${COLORS.length}, max-content)`,
        gap: 2,
        alignItems: 'center',
        justifyItems: 'start',
      }}
    >
      <span />
      {COLORS.map(color => (
        <Typography key={color} level="body-xs">
          {color}
        </Typography>
      ))}
      {VARIANTS.map(variant => [
        <Typography key={variant} level="body-xs">
          {variant}
        </Typography>,
        ...COLORS.map(color => <Box key={`${variant}-${color}`}>{render(variant, color)}</Box>),
      ])}
    </Box>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack spacing={1.5} sx={{ mb: 4, alignItems: 'flex-start' }}>
      <Typography level="title-md">{title}</Typography>
      {children}
    </Stack>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return (
    <Stack direction="row" spacing={2} useFlexGap sx={{ flexWrap: 'wrap', alignItems: 'center' }}>
      {children}
    </Stack>
  );
}
