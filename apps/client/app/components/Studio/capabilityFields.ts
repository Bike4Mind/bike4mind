/**
 * The controls a Studio form can show, as data. A modality turns the selected model's capabilities into a list of
 * these (see videoCapabilityFields) and CapabilityForm renders it, so a new modality adds a field builder, not a form.
 * Each field carries its current value and its own change handler, which keeps every handler typed to its value.
 * Test ids derive from the form's prefix and the field id (CapabilityForm documents the pattern).
 */
export type CapabilityOption = { value: string; label: string };

type FieldBase = {
  // Unique within the form; becomes part of the field's data-testid.
  id: string;
  label: string;
  disabled?: boolean;
};

export type TextField = FieldBase & {
  kind: 'text';
  value: string;
  placeholder?: string;
  maxLength: number;
  minRows?: number;
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

/** Fields laid out side by side on wide screens. */
export type FieldGroup = {
  kind: 'group';
  id: string;
  fields: readonly CapabilityControl[];
};

export type CapabilityControl =
  TextField | SegmentedField | SelectField | RangeField | SwitchField | NoteField | ImageField;

export type CapabilityField = CapabilityControl | FieldGroup;
