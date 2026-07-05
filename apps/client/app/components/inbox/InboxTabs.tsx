import { useInbox } from '@client/app/contexts/InboxContext';
import { useUser } from '@client/app/contexts/UserContext';
import ForwardToInboxIcon from '@mui/icons-material/ForwardToInbox';
import MessageIcon from '@mui/icons-material/Message';
import { Box, Badge } from '@mui/joy';
import Tab from '@mui/joy/Tab';
import TabList from '@mui/joy/TabList';
import TabPanel from '@mui/joy/TabPanel';
import Tabs from '@mui/joy/Tabs';
import { FC } from 'react';
import Invites from './Invites';
import Messages from './Messages';
import { useTranslation } from 'react-i18next';
import { useGetInbox } from '@client/app/hooks/data/inbox';
import { useGetUserInvites } from '@client/app/hooks/data/invites';
import { useMemo } from 'react';

export enum InboxTabList {
  Messages = 'Messages',
  Invites = 'Invites',
}

const InboxTabs: FC = () => {
  const { currentUser } = useUser();
  const { inboxIndex, setInboxIndex } = useInbox();
  const { t } = useTranslation();
  const userEmail = currentUser?.email;
  const { data: inbox } = useGetInbox(currentUser?.id || null);
  const { data: invites } = useGetUserInvites(currentUser!.id);

  const hasUnreadMessages = useMemo(() => {
    return inbox?.some(item => {
      // Only count messages that would actually be displayed in the message list
      // Skip messages without sender data (except SYSTEM messages)
      if (item.userId !== 'SYSTEM' && !(item as any).sender) {
        return false;
      }
      return !item.readAt;
    });
  }, [inbox]);

  const hasPendingInvites = useMemo(() => {
    const pendingInvites = invites?.filter(invite => invite?.recipients?.pending?.includes(userEmail || ''));
    return pendingInvites && pendingInvites.length > 0;
  }, [invites, userEmail]);

  return (
    <Box sx={{ mt: 4, flex: 1, display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Tabs
        value={inboxIndex}
        onChange={(_, newValue) => setInboxIndex(newValue as number)}
        aria-label="Inbox tab"
        sx={{
          flex: 1,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <TabList
          variant="plain"
          sx={{
            fontSize: 'small',
            padding: '0 0 10px 0',
            boxShadow: 'unset',
            mb: '4px',
          }}
        >
          <Tab
            sx={{
              width: '50%',
              height: '48px',
              borderTopLeftRadius: '12px',
              borderTopRightRadius: '12px',
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              borderBottom: '1px solid',
              borderBottomColor: 'inbox.border.light',
              backgroundColor: theme => theme.vars.palette.background.body,
              color: theme => theme.vars.palette.text.primary,
              // boxShadow: '0 2px 8px 0 rgba(0,0,0,0.08)',
              position: 'relative',
              zIndex: 2,
              '&[aria-selected="false"]': {
                backgroundColor: 'transparent',
                color: 'inbox.text.disabledTab',
                zIndex: 1,
              },
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              fontWeight: '400',
              fontSize: '16px',
            }}
            color="primary"
            variant={'soft'}
          >
            <Badge size="sm" color="danger" invisible={!hasUnreadMessages} sx={{ mr: 1 }}>
              <MessageIcon />
            </Badge>
            {t('inbox.messages')}
          </Tab>
          <Tab
            sx={{
              width: '50%',
              height: '48px',
              borderTopLeftRadius: '12px',
              borderTopRightRadius: '12px',
              borderBottomLeftRadius: 0,
              borderBottomRightRadius: 0,
              borderBottom: '1px solid',
              borderBottomColor: 'inbox.border.light',
              backgroundColor: theme => theme.vars.palette.primary.softBg,
              color: theme => theme.vars.palette.text.primary,
              position: 'relative',
              zIndex: 2,
              '&[aria-selected="false"]': {
                backgroundColor: 'transparent',
                color: 'inbox.text.disabledTab',
                zIndex: 1,
              },
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              fontWeight: '400',
              fontSize: '16px',
            }}
            color="primary"
            variant={'soft'}
          >
            <Badge size="sm" color="danger" invisible={!hasPendingInvites} sx={{ mr: 1 }}>
              <ForwardToInboxIcon />
            </Badge>
            {t('inbox.invites')}
          </Tab>
        </TabList>

        <TabPanel sx={{ padding: 0, flex: 1, minHeight: 0 }} value={0}>
          <Messages />
        </TabPanel>

        <TabPanel sx={{ padding: 0, flex: 1, minHeight: 0 }} value={1}>
          {currentUser && <Invites />}
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default InboxTabs;
