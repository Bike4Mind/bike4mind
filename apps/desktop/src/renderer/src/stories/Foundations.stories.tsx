import type { Story, StoryDefault } from './ladleTypes';
import Box from '@mui/joy/Box';
import Sheet from '@mui/joy/Sheet';
import Stack from '@mui/joy/Stack';
import Typography from '@mui/joy/Typography';
import { useTheme } from '@mui/joy/styles';
import { COLORS, Row, Section } from './matrix';

export default { title: 'Foundations' } satisfies StoryDefault;

const STEPS = ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900'] as const;
const BACKGROUNDS = ['body', 'surface', 'popup', 'level1', 'level2', 'level3', 'tooltip', 'backdrop'] as const;
const TEXTS = ['primary', 'secondary', 'tertiary', 'icon'] as const;
const LEVELS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'title-lg',
  'title-md',
  'title-sm',
  'body-lg',
  'body-md',
  'body-sm',
  'body-xs',
] as const;
const RADII = ['xs', 'sm', 'md', 'lg', 'xl'] as const;
const SHADOWS = ['xs', 'sm', 'md', 'lg', 'xl'] as const;

function Swatch({ label, color, value }: { label: string; color: string; value?: string }) {
  return (
    <Stack spacing={0.5} sx={{ width: 96 }}>
      <Box sx={{ height: 48, borderRadius: 'sm', border: '1px solid', borderColor: 'divider', bgcolor: color }} />
      <Typography level="body-xs">{label}</Typography>
      {value && (
        <Typography level="body-xs" sx={{ color: 'text.tertiary', overflowWrap: 'anywhere' }}>
          {value}
        </Typography>
      )}
    </Stack>
  );
}

export const Palette: Story = () => {
  const theme = useTheme();
  return (
    <>
      {COLORS.map(color => (
        <Section key={color} title={color}>
          <Row>
            {STEPS.map(step => (
              <Swatch
                key={step}
                label={step}
                color={theme.vars.palette[color][step]}
                value={theme.palette[color][step]}
              />
            ))}
          </Row>
        </Section>
      ))}
      <Section title="background">
        <Row>
          {BACKGROUNDS.map(name => (
            <Swatch
              key={name}
              label={name}
              color={theme.vars.palette.background[name]}
              value={theme.palette.background[name]}
            />
          ))}
        </Row>
      </Section>
      <Section title="text and divider">
        <Row>
          {TEXTS.map(name => (
            <Swatch key={name} label={name} color={theme.vars.palette.text[name]} value={theme.palette.text[name]} />
          ))}
          <Swatch label="divider" color={theme.vars.palette.divider} value={theme.palette.divider} />
        </Row>
      </Section>
    </>
  );
};

export const TypographyLevels: Story = () => (
  <Stack spacing={1.5}>
    {LEVELS.map(level => (
      <Typography key={level} level={level}>
        {level}: the quick brown fox jumps over the lazy dog
      </Typography>
    ))}
  </Stack>
);

export const RadiusAndShadow: Story = () => (
  <>
    <Section title="radius">
      <Row>
        {RADII.map(radius => (
          <Sheet key={radius} variant="outlined" sx={{ width: 96, height: 64, borderRadius: radius, p: 1 }}>
            <Typography level="body-xs">{radius}</Typography>
          </Sheet>
        ))}
      </Row>
    </Section>
    <Section title="shadow">
      <Row>
        {SHADOWS.map(shadow => (
          <Sheet key={shadow} sx={{ width: 96, height: 64, borderRadius: 'md', boxShadow: shadow, p: 1, m: 1 }}>
            <Typography level="body-xs">{shadow}</Typography>
          </Sheet>
        ))}
      </Row>
    </Section>
  </>
);
