import type { Story, StoryDefault } from './ladleTypes';
import Checkbox from '@mui/joy/Checkbox';
import FormControl from '@mui/joy/FormControl';
import FormHelperText from '@mui/joy/FormHelperText';
import FormLabel from '@mui/joy/FormLabel';
import Input from '@mui/joy/Input';
import Option from '@mui/joy/Option';
import Radio from '@mui/joy/Radio';
import RadioGroup from '@mui/joy/RadioGroup';
import Select from '@mui/joy/Select';
import Slider from '@mui/joy/Slider';
import Stack from '@mui/joy/Stack';
import Switch from '@mui/joy/Switch';
import Textarea from '@mui/joy/Textarea';
import { COLORS, Row, Section, SIZES, VARIANTS, VariantMatrix } from './matrix';

export default { title: 'Inputs' } satisfies StoryDefault;

export const TextFields: Story = () => (
  <>
    <Section title="Input: variant by color">
      <VariantMatrix
        render={(variant, color) => (
          <Input variant={variant} color={color} placeholder="Placeholder" sx={{ width: 160 }} />
        )}
      />
    </Section>
    <Section title="Input: sizes and states">
      <Row>
        {SIZES.map(size => (
          <Input key={size} size={size} defaultValue={`Size ${size}`} sx={{ width: 160 }} />
        ))}
        <Input disabled defaultValue="Disabled" sx={{ width: 160 }} />
        <Input error defaultValue="Error" sx={{ width: 160 }} />
      </Row>
    </Section>
    <Section title="Textarea">
      <Row>
        {VARIANTS.map(variant => (
          <Textarea key={variant} variant={variant} minRows={3} placeholder={variant} sx={{ width: 200 }} />
        ))}
      </Row>
    </Section>
    <Section title="FormControl">
      <Row>
        <FormControl sx={{ width: 240 }}>
          <FormLabel>Label</FormLabel>
          <Input placeholder="Placeholder" />
          <FormHelperText>Helper text</FormHelperText>
        </FormControl>
        <FormControl error sx={{ width: 240 }}>
          <FormLabel>Label</FormLabel>
          <Input defaultValue="Not valid" />
          <FormHelperText>Error text</FormHelperText>
        </FormControl>
      </Row>
    </Section>
  </>
);

export const Selects: Story = () => (
  <>
    <Section title="variant by color">
      <VariantMatrix
        render={(variant, color) => (
          <Select variant={variant} color={color} defaultValue="one" sx={{ width: 160 }}>
            <Option value="one">Option one</Option>
            <Option value="two">Option two</Option>
            <Option value="three" disabled>
              Disabled
            </Option>
          </Select>
        )}
      />
    </Section>
    <Section title="sizes and states">
      <Row>
        {SIZES.map(size => (
          <Select key={size} size={size} placeholder={`Size ${size}`} sx={{ width: 160 }}>
            <Option value="one">Option one</Option>
          </Select>
        ))}
        <Select disabled placeholder="Disabled" sx={{ width: 160 }} />
      </Row>
    </Section>
  </>
);

export const Toggles: Story = () => (
  <>
    <Section title="Checkbox: variant by color">
      <VariantMatrix
        render={(variant, color) => <Checkbox variant={variant} color={color} label="Label" defaultChecked />}
      />
    </Section>
    <Section title="Checkbox states">
      <Row>
        <Checkbox label="Unchecked" />
        <Checkbox label="Checked" defaultChecked />
        <Checkbox label="Indeterminate" indeterminate />
        <Checkbox label="Disabled" disabled />
        <Checkbox label="Disabled checked" disabled defaultChecked />
      </Row>
    </Section>
    <Section title="Radio">
      <RadioGroup defaultValue="primary" orientation="horizontal">
        {COLORS.map(color => (
          <Radio key={color} value={color} color={color} label={color} />
        ))}
        <Radio value="disabled" label="disabled" disabled />
      </RadioGroup>
    </Section>
    <Section title="Switch: variant by color">
      <VariantMatrix render={(variant, color) => <Switch variant={variant} color={color} defaultChecked />} />
    </Section>
    <Section title="Switch states">
      <Row>
        <Switch />
        <Switch defaultChecked />
        <Switch disabled />
        {SIZES.map(size => (
          <Switch key={size} size={size} defaultChecked />
        ))}
      </Row>
    </Section>
    <Section title="Slider">
      <Stack spacing={2} sx={{ width: 320 }}>
        {COLORS.map(color => (
          <Slider key={color} color={color} defaultValue={40} aria-label={color} />
        ))}
        <Slider disabled defaultValue={40} aria-label="disabled" />
      </Stack>
    </Section>
  </>
);
