import { useInbox } from '@client/app/contexts/InboxContext';
import { useUser } from '@client/app/contexts/UserContext';
import FeedbackOutlinedIcon from '@mui/icons-material/FeedbackOutlined';
import ForwardToInboxIcon from '@mui/icons-material/ForwardToInbox';
import MessageIcon from '@mui/icons-material/Message';
import { Box, Badge, Skeleton } from '@mui/joy';
import Tab from '@mui/joy/Tab';
import TabList from '@mui/joy/TabList';
import TabPanel from '@mui/joy/TabPanel';
import Tabs from '@mui/joy/Tabs';
import { FC, lazy, Suspense } from 'react';
import Invites from './Invites';
import Messages from './Messages';
import { useTranslation } from 'react-i18next';
import { useGetInbox } from '@client/app/hooks/data/inbox';
import { useGetUserInvites } from '@client/app/hooks/data/invites';
import { useMemo } from 'react';
import { defaultFeedbackRollupWindow } from '@client/app/utils/feedbackRollupWindow';

// Lazy: InboxModal is imported statically by the always-loaded InboxContext, so a static import here
// would put the rollup view in the app's entry chunk for a tab most sessions never open.
const FeedbackRollupView = lazy(() => import('@client/app/components/feedback/FeedbackRollupView'));

const FeedbackRollupFallback = () => (
  <Box sx={{ p: 3 }} data-testid="inbox-feedback-loading" aria-busy="true">
    <Skeleton variant="text" level="body-sm" sx={{ width: '60%', mb: 3 }} />
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
      {[0, 1, 2].map(i => (
        <Skeleton
          key={i}
          variant="rectangular"
          sx={{ flex: '1 1 260px', minWidth: 240, height: 160, borderRadius: 'md' }}
        />
      ))}
    </Box>
  </Box>
);

// Values are the Tabs indices that `inboxIndex` holds.
export enum InboxTabList {
  Messages = 0,
  Invites = 1,
  Feedback = 2,
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
              width: '33.33%',
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
            data-testid="inbox-tab-messages"
          >
            <Badge size="sm" color="danger" invisible={!hasUnreadMessages} sx={{ mr: 1 }}>
              <MessageIcon />
            </Badge>
            {t('inbox.messages')}
          </Tab>
          <Tab
            sx={{
              width: '33.33%',
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
            data-testid="inbox-tab-invites"
          >
            <Badge size="sm" color="danger" invisible={!hasPendingInvites} sx={{ mr: 1 }}>
              <ForwardToInboxIcon />
            </Badge>
            {t('inbox.invites')}
          </Tab>
          <Tab
            sx={{
              width: '33.33%',
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
            data-testid="inbox-tab-feedback"
          >
            <FeedbackOutlinedIcon sx={{ mr: 1 }} />
            {t('feedback.rollupTitle', 'Your feedback')}
          </Tab>
        </TabList>

        <TabPanel sx={{ padding: 0, flex: 1, minHeight: 0 }} value={InboxTabList.Messages}>
          <Messages />
        </TabPanel>

        <TabPanel sx={{ padding: 0, flex: 1, minHeight: 0 }} value={InboxTabList.Invites}>
          {currentUser && <Invites />}
        </TabPanel>

        <TabPanel sx={{ padding: 0, flex: 1, minHeight: 0, overflow: 'auto' }} value={InboxTabList.Feedback}>
          {inboxIndex === InboxTabList.Feedback && (
            <Suspense fallback={<FeedbackRollupFallback />}>
              <FeedbackRollupView {...defaultFeedbackRollupWindow()} showHeading={false} />
            </Suspense>
          )}
        </TabPanel>
      </Tabs>
    </Box>
  );
};

export default InboxTabs;
