import { useEffect, useRef } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { Box, CircularProgress, Typography } from '@mui/joy';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import CustomPageBody from '@client/app/components/CustomPage/CustomPageBody';
import { clearActiveCustomPage, setActiveCustomPage } from '@client/app/components/CustomPage/pageChatContext';
import { NotebookFilepondProvider } from '@client/app/components/Session/NotebookFilepondProvider';
import SessionContainer from '@client/app/components/Session/SessionContainer';
import { useSessions } from '@client/app/contexts/SessionsContext';
import { useCustomPage } from '@client/app/hooks/data/customPages';
import { useDocumentTitle } from '@client/app/hooks/useDocumentTitle';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import useSessionLayout, { setSessionLayout } from '@client/app/hooks/useSessionLayout';

export const CUSTOM_PAGE_CHAT_WIDTH = 420;

const CustomPagePage = () => {
  const { id } = useParams({ strict: false });
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const { currentSessionId } = useSessions();
  const { data: page, isLoading, isError, error } = useCustomPage(id);
  const hasRedirectedRef = useRef(false);

  useDocumentTitle(page?.name, ' | Page');

  useEffect(() => {
    if (hasRedirectedRef.current || !isError) return;
    const status = isAxiosError(error) ? error.response?.status : undefined;
    if (status === 404 || status === 403) {
      hasRedirectedRef.current = true;
      toast.error('Page not found, or you do not have access to it.');
      navigate({ to: '/new' });
    }
  }, [isError, error, navigate]);

  // The chat lives in its own column here, so the notebook split/dock layouts would only hide it.
  useEffect(() => {
    const previous = useSessionLayout.getState().layout;
    setSessionLayout({ layout: 'hide' });
    return () => setSessionLayout({ layout: previous });
  }, []);

  useEffect(() => {
    setActiveCustomPage(page ?? null, currentSessionId);
  }, [page, currentSessionId]);

  useEffect(() => clearActiveCustomPage, []);

  if (isLoading || !page) {
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
        {isLoading ? <CircularProgress size="sm" /> : null}
      </Box>
    );
  }

  return (
    <NotebookFilepondProvider>
      <Box
        data-testid="custom-page"
        sx={{
          display: 'flex',
          flexDirection: isMobile ? 'column' : 'row',
          height: '100%',
          width: '100%',
          minHeight: 0,
          gap: 1,
        }}
      >
        <Box sx={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
          <CustomPageBody page={page} />
        </Box>
        <Box
          data-testid="custom-page-chat"
          sx={{
            width: isMobile ? '100%' : CUSTOM_PAGE_CHAT_WIDTH,
            flexShrink: 0,
            height: isMobile ? '70vh' : '100%',
            minHeight: 0,
          }}
        >
          <SessionContainer
            currentSessionId={page.orchestratorSessionId}
            isLoading={false}
            autoHideOnEmpty={false}
            emptySessionSplash={
              <Typography level="body-sm" textColor="text.tertiary" sx={{ p: 2, textAlign: 'center' }}>
                Tell me what this page is for, and the facts I should keep on it.
              </Typography>
            }
          />
        </Box>
      </Box>
    </NotebookFilepondProvider>
  );
};

export default CustomPagePage;
