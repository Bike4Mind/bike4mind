import { useState } from 'react';
import type { Story, StoryDefault } from './ladleTypes';
import Alert from '@mui/joy/Alert';
import Button from '@mui/joy/Button';
import Chip from '@mui/joy/Chip';
import ChipDelete from '@mui/joy/ChipDelete';
import CircularProgress from '@mui/joy/CircularProgress';
import LinearProgress from '@mui/joy/LinearProgress';
import Snackbar from '@mui/joy/Snackbar';
import Stack from '@mui/joy/Stack';
import Tooltip from '@mui/joy/Tooltip';
import { COLORS, Row, Section, SIZES, VARIANTS, VariantMatrix } from './matrix';

export default { title: 'Feedback' } satisfies StoryDefault;

export const Alerts: Story = () => (
  <VariantMatrix
    render={(variant, color) => (
      <Alert variant={variant} color={color}>
        Alert text
      </Alert>
    )}
  />
);

export const Chips: Story = () => (
  <>
    <Section title="variant by color">
      <VariantMatrix
        render={(variant, color) => (
          <Chip variant={variant} color={color}>
            Chip
          </Chip>
        )}
      />
    </Section>
    <Section title="sizes, clickable, deletable, disabled">
      <Row>
        {SIZES.map(size => (
          <Chip key={size} size={size}>
            Size {size}
          </Chip>
        ))}
        <Chip onClick={() => undefined}>Clickable</Chip>
        <Chip endDecorator={<ChipDelete aria-label="Remove" onDelete={() => undefined} />}>Deletable</Chip>
        <Chip disabled>Disabled</Chip>
      </Row>
    </Section>
  </>
);

export const Progress: Story = () => (
  <>
    <Section title="CircularProgress">
      <VariantMatrix render={(variant, color) => <CircularProgress variant={variant} color={color} />} />
    </Section>
    <Section title="CircularProgress sizes and determinate">
      <Row>
        {SIZES.map(size => (
          <CircularProgress key={size} size={size} />
        ))}
        <CircularProgress determinate value={66} />
      </Row>
    </Section>
    <Section title="LinearProgress">
      <Stack spacing={2} sx={{ width: 320 }}>
        {COLORS.map(color => (
          <LinearProgress key={color} color={color} />
        ))}
        <LinearProgress determinate value={66} />
      </Stack>
    </Section>
  </>
);

export const Tooltips: Story = () => (
  <>
    <Section title="held open, by variant">
      <Row>
        {VARIANTS.map(variant => (
          <Tooltip key={variant} title={`${variant} tooltip`} variant={variant} open placement="bottom" arrow>
            <Button variant="outlined" color="neutral" sx={{ mb: 5, mr: 4 }}>
              {variant}
            </Button>
          </Tooltip>
        ))}
      </Row>
    </Section>
    <Section title="on hover, with the long-text width cap">
      <Row>
        <Tooltip title="Short tooltip">
          <Button variant="outlined" color="neutral">
            Short
          </Button>
        </Tooltip>
        <Tooltip title="/Users/someone/projects/a-rather-long-directory-name/another-directory/src/components/SomeComponent.tsx">
          <Button variant="outlined" color="neutral">
            Long path
          </Button>
        </Tooltip>
      </Row>
    </Section>
  </>
);

export const Snackbars: Story = () => {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outlined" color="neutral" onClick={() => setOpen(true)}>
        Show snackbar
      </Button>
      <Snackbar open={open} onClose={() => setOpen(false)} autoHideDuration={4000} color="success" variant="soft">
        Snackbar text
      </Snackbar>
    </>
  );
};
