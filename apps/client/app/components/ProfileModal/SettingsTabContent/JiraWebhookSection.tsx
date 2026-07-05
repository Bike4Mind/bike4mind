/**
 * Jira notifications wrapper for the Integrations page.
 * Renders only when the user has an active Atlassian connection.
 */

import { FC } from 'react';
import { Chip } from '@mui/joy';
import SiAtlassian, { defaultColor as SiAtlassianHex } from '@icons-pack/react-simple-icons/icons/SiAtlassian';
import SectionContainer from '../SectionContainer';
import JiraNotificationsForm from '@client/app/components/settings/JiraNotificationsForm';
import { useGetJiraWebhookConfig } from '@client/app/hooks/data/useJiraWebhooks';
import { Typography } from '@mui/joy';

const JiraWebhookSection: FC = () => {
  const { data: config, isError } = useGetJiraWebhookConfig();
  const hasConfig = !!config && !isError;
  const isEnabled = hasConfig && config.enabled;

  return (
    <SectionContainer
      title={
        <>
          <SiAtlassian color={SiAtlassianHex} size={20} style={{ marginRight: 8, verticalAlign: 'middle' }} />
          <Typography level="h4">Jira → Slack Notifications</Typography>

          {hasConfig && (
            <Chip color={isEnabled ? 'success' : 'danger'} size="sm" sx={{ ml: 1 }}>
              {isEnabled ? 'Active' : 'Disabled'}
            </Chip>
          )}
        </>
      }
      subtitle="Get Slack notifications for Jira events like issues, comments, and sprints"
    >
      <JiraNotificationsForm />
    </SectionContainer>
  );
};

export default JiraWebhookSection;
