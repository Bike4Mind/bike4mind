import { Chip, Tooltip } from '@mui/joy';
import GitHubIcon from '@mui/icons-material/GitHub';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useLakeGitHubConnection } from '@client/app/hooks/data/githubLake';
import { describeGitHubConnection } from '@client/app/hooks/data/githubConnectionDisplay';

/**
 * LakeDriveStatusChip's GitHub twin: the read-only "a repository feeds this lake" marker on the
 * surfaces a user reaches to inspect or remove a lake. Same contract - a personal lake is not read,
 * and it renders nothing with no connection, mid-read, on a failed read, or while
 * EnableDataLakeGitHub is off. Absence is not a guarantee that no connection exists.
 */
export default function LakeGitHubStatusChip({ lakeId, organizationId }: { lakeId: string; organizationId?: string }) {
  const { isAdminFeatureEnabled } = useFeatureEnabled();
  const gitHubEnabled = !!organizationId && isAdminFeatureEnabled('EnableDataLakeGitHub');
  const { data: connection } = useLakeGitHubConnection(lakeId, gitHubEnabled);
  if (!gitHubEnabled || !connection) return null;

  const { title, color } = describeGitHubConnection(connection);

  return (
    <Tooltip size="sm" title={title}>
      <Chip
        size="sm"
        variant="soft"
        color={color}
        startDecorator={<GitHubIcon sx={{ fontSize: 12 }} />}
        sx={{ fontSize: '11px', maxWidth: 220 }}
        data-testid={`datalake-github-status-chip-${lakeId}`}
      >
        {connection.repositoryFullName}
      </Chip>
    </Tooltip>
  );
}
