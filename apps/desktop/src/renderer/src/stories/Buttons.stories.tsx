import { useState } from 'react';
import type { Story, StoryDefault } from './ladleTypes';
import Button from '@mui/joy/Button';
import ButtonGroup from '@mui/joy/ButtonGroup';
import IconButton from '@mui/joy/IconButton';
import Link from '@mui/joy/Link';
import ToggleButtonGroup from '@mui/joy/ToggleButtonGroup';
import type { ColorPaletteProp, VariantProp } from '@mui/joy/styles';
import { COLORS, Row, Section, SIZES, VARIANTS, VariantMatrix } from './matrix';

export default { title: 'Buttons' } satisfies StoryDefault;

const PlusIcon = () => (
  <svg width="1em" height="1em" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M8 3v10M3 8h10" />
  </svg>
);

export const ButtonMatrix: Story = () => (
  <>
    <Section title="variant by color">
      <VariantMatrix
        render={(variant, color) => (
          <Button variant={variant} color={color}>
            Button
          </Button>
        )}
      />
    </Section>
    <Section title="disabled">
      <VariantMatrix
        render={(variant, color) => (
          <Button variant={variant} color={color} disabled>
            Button
          </Button>
        )}
      />
    </Section>
    <Section title="sizes, loading, decorators">
      <Row>
        {SIZES.map(size => (
          <Button key={size} size={size}>
            Size {size}
          </Button>
        ))}
        <Button loading>Loading</Button>
        <Button startDecorator={<PlusIcon />}>Start decorator</Button>
        <Button variant="outlined" color="neutral" endDecorator={<PlusIcon />}>
          End decorator
        </Button>
      </Row>
    </Section>
  </>
);

export const Playground: Story<{
  variant: VariantProp;
  color: ColorPaletteProp;
  size: (typeof SIZES)[number];
  disabled: boolean;
  loading: boolean;
  label: string;
}> = ({ label, ...props }) => <Button {...props}>{label}</Button>;
Playground.args = { label: 'Button', disabled: false, loading: false };
Playground.argTypes = {
  variant: { options: [...VARIANTS], control: { type: 'radio' }, defaultValue: 'solid' },
  color: { options: [...COLORS], control: { type: 'radio' }, defaultValue: 'primary' },
  size: { options: [...SIZES], control: { type: 'radio' }, defaultValue: 'md' },
};

export const IconButtonMatrix: Story = () => (
  <>
    <Section title="variant by color">
      <VariantMatrix
        render={(variant, color) => (
          <IconButton variant={variant} color={color} aria-label="Add">
            <PlusIcon />
          </IconButton>
        )}
      />
    </Section>
    <Section title="sizes">
      <Row>
        {SIZES.map(size => (
          <IconButton key={size} size={size} variant="outlined" aria-label={`Add, size ${size}`}>
            <PlusIcon />
          </IconButton>
        ))}
      </Row>
    </Section>
  </>
);

export const Groups: Story = () => {
  const [value, setValue] = useState<string | null>('chat');
  return (
    <>
      <Section title="ButtonGroup">
        <Row>
          {VARIANTS.map(variant => (
            <ButtonGroup key={variant} variant={variant}>
              <Button>One</Button>
              <Button>Two</Button>
              <Button>Three</Button>
            </ButtonGroup>
          ))}
        </Row>
      </Section>
      <Section title="ToggleButtonGroup">
        <ToggleButtonGroup value={value} onChange={(_event, next) => setValue(next)}>
          <Button value="chat">Chat</Button>
          <Button value="code">Code</Button>
          <Button value="watch">Watch</Button>
        </ToggleButtonGroup>
      </Section>
    </>
  );
};

export const Links: Story = () => (
  <Row>
    {COLORS.map(color => (
      <Link key={color} color={color} href="#">
        {color} link
      </Link>
    ))}
    <Link href="#" underline="always">
      Always underlined
    </Link>
    <Link href="#" disabled>
      Disabled
    </Link>
  </Row>
);
