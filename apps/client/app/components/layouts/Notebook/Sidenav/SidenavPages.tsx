import { useState } from 'react';
import { Box, IconButton, Typography } from '@mui/joy';
import AddIcon from '@mui/icons-material/Add';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import { useLocation, useNavigate } from '@tanstack/react-router';
import { useFeatureEnabled } from '@client/app/hooks/useFeatureEnabled';
import { useCustomPages } from '@client/app/hooks/data/customPages';
import { useIsMobile } from '@client/app/hooks/useIsMobile';
import NewCustomPageDialog from '@client/app/components/CustomPage/NewCustomPageDialog';
import { useNotebookLayout } from '..';
import { NavIcon, SidenavNavRow } from './kit';

const SidenavPagesGroup = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const setOpenSideNav = useNotebookLayout(s => s.setOpenSideNav);
  const { data } = useCustomPages();
  const [dialogOpen, setDialogOpen] = useState(false);
  const pages = data ?? [];

  const openPage = (id: string) => {
    if (isMobile) setOpenSideNav(false);
    navigate({ to: '/pages/$id', params: { id } } as never);
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', px: 1, pt: 1 }}>
        <Typography level="body-xs" sx={{ color: 'text.tertiary', fontWeight: 600 }}>
          My Pages
        </Typography>
        <IconButton
          size="sm"
          variant="plain"
          color="neutral"
          aria-label="New page"
          onClick={() => setDialogOpen(true)}
          data-testid="sidenav-pages-new-btn"
        >
          <AddIcon sx={{ fontSize: '18px' }} />
        </IconButton>
      </Box>
      {pages.map(page => (
        <SidenavNavRow
          key={page.id}
          data-testid={`sidenav-page-${page.id}`}
          icon={
            <NavIcon>
              {page.icon ? <span aria-hidden>{page.icon}</span> : <DescriptionOutlinedIcon sx={{ fontSize: '18px' }} />}
            </NavIcon>
          }
          label={page.name}
          active={location.pathname === `/pages/${page.id}`}
          onClick={() => openPage(page.id)}
        />
      ))}
      <NewCustomPageDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </>
  );
};

const SidenavPages = () => {
  const { isFeatureEnabled } = useFeatureEnabled();
  if (!isFeatureEnabled('enableCustomPages')) return null;
  return <SidenavPagesGroup />;
};

export default SidenavPages;
