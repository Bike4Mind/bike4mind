import { Stack, Typography } from '@mui/joy';
import { TOOL_ADD_ISSUE_TO_PROJECT, TOOL_UPDATE_PROJECT_ITEM_FIELDS } from '@bike4mind/mcp/github/constants';

type GitHubProjectActionTargetProps = {
  tool: string;
  params: Record<string, unknown>;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function GitHubProjectActionTarget({ tool, params }: GitHubProjectActionTargetProps) {
  if (tool !== TOOL_ADD_ISSUE_TO_PROJECT && tool !== TOOL_UPDATE_PROJECT_ITEM_FIELDS) {
    return null;
  }

  const project = nonEmptyString(params.display_project_name) ?? nonEmptyString(params.project_id) ?? 'Unknown project';
  const itemId = tool === TOOL_ADD_ISSUE_TO_PROJECT ? params.issue_node_id : params.item_id;
  const item = nonEmptyString(params.display_issue_title) ?? nonEmptyString(itemId) ?? 'Unknown item';
  const repository = nonEmptyString(params.display_repository);

  return (
    <Stack spacing={0.5} sx={{ mb: 1.5, overflowWrap: 'anywhere' }} data-testid="mcp-project-action-target">
      <Typography level="body-sm">Project: {project}</Typography>
      <Typography level="body-sm">Item: {item}</Typography>
      {repository && <Typography level="body-sm">Repository: {repository}</Typography>}
    </Stack>
  );
}
