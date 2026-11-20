// The package exports map resolves only .ts, so app code reaches editableFields.json through here.
import editableFields from './editableFields.json';
import type { FieldMap } from './overrides';

export const CORE_EDITABLE_FIELDS = editableFields as FieldMap;
