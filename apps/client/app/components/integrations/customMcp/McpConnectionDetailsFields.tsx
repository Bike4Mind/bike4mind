import { FormControl, FormHelperText, FormLabel, Input, Stack, Textarea } from '@mui/joy';
import { MCP_CONNECTION_LIMITS } from '@bike4mind/common';
import type { McpConnectionScope } from '@client/app/hooks/data/mcpConnections';

const DESCRIPTION_HELP: Record<McpConnectionScope, string> = {
  user: 'Shown under the name in your Tools menu. One paragraph of plain text: line breaks and <tags> are removed.',
  platform:
    'Users offered this connector see it under the name in their Tools menu. One paragraph of plain text: line breaks and <tags> are removed.',
};

/** The optional description a connector's manager writes; the server cleans it and caps its length. */
export const McpDescriptionField = ({
  value,
  onChange,
  scope = 'user',
  testId,
  size = 'sm',
}: {
  value: string;
  onChange: (value: string) => void;
  scope?: McpConnectionScope;
  testId: string;
  size?: 'sm' | 'md';
}) => (
  <FormControl>
    <FormLabel>Description</FormLabel>
    <Textarea
      size={size}
      minRows={2}
      maxRows={5}
      value={value}
      onChange={event => onChange(event.target.value.replace(/ *[\r\n]+[ \r\n]*/g, ' '))}
      onKeyDown={event => {
        // The server collapses line breaks, so the box never takes one.
        if (event.key === 'Enter' && !event.nativeEvent.isComposing) event.preventDefault();
      }}
      slotProps={{ textarea: { maxLength: MCP_CONNECTION_LIMITS.descriptionLength, 'data-testid': testId } }}
    />
    <FormHelperText>
      {`${DESCRIPTION_HELP[scope]} ${value.length}/${MCP_CONNECTION_LIMITS.descriptionLength}`}
    </FormHelperText>
  </FormControl>
);

export interface McpConnectionDetailsDraft {
  displayName: string;
  description: string;
}

/** Name and description of an existing connector, edited together. */
const McpConnectionDetailsFields = ({
  draft,
  onChange,
  scope = 'user',
  testIdPrefix,
  autoFocus = false,
  size = 'sm',
}: {
  draft: McpConnectionDetailsDraft;
  onChange: (draft: McpConnectionDetailsDraft) => void;
  scope?: McpConnectionScope;
  testIdPrefix: string;
  autoFocus?: boolean;
  size?: 'sm' | 'md';
}) => {
  const nameMissing = draft.displayName.trim() === '';
  return (
    <Stack gap="12px">
      <FormControl required error={nameMissing}>
        <FormLabel>Name</FormLabel>
        <Input
          size={size}
          value={draft.displayName}
          autoFocus={autoFocus}
          onChange={event => onChange({ ...draft, displayName: event.target.value })}
          slotProps={{
            input: {
              maxLength: MCP_CONNECTION_LIMITS.displayNameLength,
              'data-testid': `${testIdPrefix}-name-input`,
            },
          }}
        />
        {nameMissing && <FormHelperText>Enter a name.</FormHelperText>}
      </FormControl>
      <McpDescriptionField
        value={draft.description}
        onChange={description => onChange({ ...draft, description })}
        scope={scope}
        size={size}
        testId={`${testIdPrefix}-description-input`}
      />
    </Stack>
  );
};

export default McpConnectionDetailsFields;
