import { Box, Table } from '@mui/joy';
import {
  DIMENSIONLESS_UNIT,
  FUNCTION_CONTRACT_LIMITS,
  type FunctionField,
  type FunctionObjectField,
} from '@bike4mind/common';

/** "a", "a or b", "a, b, or c". */
const listWithOr = (items: string[]): string =>
  items.length < 3 ? items.join(' or ') : `${items.slice(0, -1).join(', ')}, or ${items[items.length - 1]}`;

export const unitLabel = (field: FunctionField): string =>
  field.type === 'number' || field.type === 'integer' ? (field.unit === DIMENSIONLESS_UNIT ? 'none' : field.unit) : '-';

const TYPE_LABELS: Record<FunctionField['type'], string> = {
  number: 'Number',
  integer: 'Whole number',
  string: 'Text',
  boolean: 'True or false',
  array: 'List',
  object: 'Group',
};

const typeLabel = (field: FunctionField): string =>
  field.type === 'string' && field.enum ? 'Choice' : TYPE_LABELS[field.type];

function rangeLabel(field: FunctionField): string {
  switch (field.type) {
    case 'number':
    case 'integer': {
      if (field.enum) return `one of ${listWithOr(field.enum.map(String))}`;
      const lower =
        field.exclusiveMinimum !== undefined
          ? `greater than ${field.exclusiveMinimum}`
          : field.minimum !== undefined
            ? `at least ${field.minimum}`
            : null;
      const upper =
        field.exclusiveMaximum !== undefined
          ? `less than ${field.exclusiveMaximum}`
          : field.maximum !== undefined
            ? `at most ${field.maximum}`
            : null;
      return [lower, upper].filter(Boolean).join(' and ') || 'any';
    }
    case 'string':
      return field.enum
        ? `one of ${listWithOr(field.enum)}`
        : `up to ${field.maxLength ?? FUNCTION_CONTRACT_LIMITS.maxStringLength} characters`;
    case 'array':
      if (field.minItems !== undefined && field.maxItems !== undefined) {
        return `${field.minItems} to ${field.maxItems} items`;
      }
      if (field.minItems !== undefined) return `at least ${field.minItems} items`;
      if (field.maxItems !== undefined) return `at most ${field.maxItems} items`;
      return 'any';
    default:
      return '-';
  }
}

/** One side of a function's contract, a row per field: the Function tab and a recipient's review both show it. */
export const ContractTable = ({ schema, testId }: { schema: FunctionObjectField; testId: string }) => {
  const required = new Set(schema.required ?? []);
  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Table
        size="sm"
        borderAxis="xBetween"
        data-testid={testId}
        sx={{ tableLayout: 'auto', '& th': { whiteSpace: 'nowrap' } }}
      >
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Unit</th>
            <th>Range</th>
            <th>Required</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(schema.properties).map(([name, field]) => (
            <tr key={name}>
              <td>
                <code>{name}</code>
              </td>
              <td>{typeLabel(field)}</td>
              <td>{unitLabel(field)}</td>
              <td>{rangeLabel(field)}</td>
              <td>{required.has(name) ? 'Yes' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Box>
  );
};
