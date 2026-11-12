/**
 * The controls a Studio form can show, as data. A modality turns the selected model's capabilities into a list of
 * these (see videoCapabilityFields) and CapabilityForm renders it, so a new modality adds a field builder, not a form.
 * Each field carries its current value and its own change handler, which keeps every handler typed to its value.
 * Test ids derive from the form's prefix and the field id (CapabilityForm documents the pattern).
 */
export type CapabilityOption = {
  value: string;
  label: string;
  // The current value kept from a previous model that this one does not take; rendered in the danger color.
  invalid?: boolean;
};

/** A one-click way back to a value the model takes. Offered beside the reason; never applied by itself. */
export type CapabilityFix = { label: string; apply: () => void };

type FieldBase = {
  // Unique within the form; becomes part of the field's data-testid.
  id: string;
  label: string;
  disabled?: boolean;
  // Why the current value does not fit the selected model. The form shows it and holds submit until it is fixed.
  invalidReason?: string;
  fix?: CapabilityFix;
};

export type TextField = FieldBase & {
  kind: 'text';
  value: string;
  placeholder?: string;
  maxLength: number;
  minRows?: number;
  // Shown as buttons that insert their text at the cursor on a line of its own (e.g. lyric section tags).
  snippets?: readonly string[];
  onChange: (value: string) => void;
};

/** A short list of choices shown as buttons. */
export type SegmentedField = FieldBase & {
  kind: 'segmented';
  value: string;
  options: readonly CapabilityOption[];
  onChange: (value: string) => void;
};

/** A longer list of choices shown as a dropdown. */
export type SelectField = FieldBase & {
  kind: 'select';
  value: string;
  options: readonly CapabilityOption[];
  onChange: (value: string) => void;
};

/** Aspect ratios as tiles drawn in their own shape. A `W:H` value draws its shape; any other value a square. */
export type AspectField = FieldBase & {
  kind: 'aspect';
  value: string;
  options: readonly CapabilityOption[];
  onChange: (value: string) => void;
};

export type RangeField = FieldBase & {
  kind: 'range';
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
};

export type SwitchField = FieldBase & {
  kind: 'switch';
  checked: boolean;
  onChange: (checked: boolean) => void;
};

/** A capability the user cannot change for this model, stated rather than offered (e.g. "Audio is included."). */
export type NoteField = FieldBase & {
  kind: 'note';
};

/** An image from the user's library; the modality owns the picker and opens it from onPick. */
export type ImageField = FieldBase & {
  kind: 'image';
  fileName: string | null;
  onPick: () => void;
};

export type ReferenceFile = { fileId: string; fileName: string };

/** Up to `max` library images that guide the look; the modality owns the picker and opens it from onAdd. */
export type ReferencesField = FieldBase & {
  kind: 'references';
  files: readonly ReferenceFile[];
  max: number;
  onAdd: () => void;
  onRemove: (fileId: string) => void;
};

/** Fields laid out side by side on wide screens. */
export type FieldGroup = {
  kind: 'group';
  id: string;
  fields: readonly CapabilityControl[];
};

export type CapabilityControl =
  | TextField
  | SegmentedField
  | SelectField
  | AspectField
  | RangeField
  | SwitchField
  | NoteField
  | ImageField
  | ReferencesField;

export type CapabilityField = CapabilityControl | FieldGroup;

/** The options plus the current value, marked invalid, when the model does not list it. */
export const withCurrentValue = (
  options: readonly CapabilityOption[],
  value: string,
  label: string = value
): readonly CapabilityOption[] =>
  options.some(option => option.value === value) ? options : [...options, { value, label, invalid: true }];

/** Whether any field holds a value the selected model does not take. */
export const hasInvalidField = (fields: readonly CapabilityField[]): boolean =>
  fields.some(field => (field.kind === 'group' ? hasInvalidField(field.fields) : field.invalidReason !== undefined));
