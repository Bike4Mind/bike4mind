import type { ReactNode } from 'react';
import DashboardIcon from '@mui/icons-material/Dashboard';
import {
  Accordion,
  AccordionDetails,
  AccordionGroup,
  AccordionSummary,
  Badge,
  Box,
  Button,
  Stack,
  Tooltip,
  Typography,
} from '@mui/joy';
import { AdminTab, SIDEBAR_SECTIONS, type SidebarGate, type SidebarItem } from './adminSidebarConfig';
import { useAdminModal } from './useAdminModal';
import { useAdminSidebarSections } from './useAdminSidebarSections';

export type SidebarNavProps = {
  enableUserMigration?: boolean;
  showLiveOpsTriageTab: boolean;
  waitingSubscribersCount?: number;
  hiddenNotifications: string[];
  onTabSelect: (tab: AdminTab) => void;
};

export const SidebarNav = ({
  enableUserMigration,
  showLiveOpsTriageTab,
  waitingSubscribersCount,
  hiddenNotifications,
  onTabSelect,
}: SidebarNavProps) => {
  const activeTab = useAdminModal(state => state.activeTab);

  const { isExpanded, toggleSection } = useAdminSidebarSections(activeTab);

  const gates: Record<SidebarGate, boolean> = {
    userMigration: !!enableUserMigration,
    liveOpsTriage: showLiveOpsTriageTab,
  };

  const getMenuButtonSx = (tabValue: AdminTab) => ({
    justifyContent: 'flex-start',
    fontWeight: 500,
    color: activeTab === tabValue ? 'primary.500' : 'neutral.600',
    bgcolor: activeTab === tabValue ? 'primary.50' : 'transparent',
    '&:hover': {
      bgcolor: activeTab === tabValue ? 'primary.100' : 'neutral.50',
    },
    borderRadius: 'md',
  });

  const renderEndDecorator = (item: SidebarItem): ReactNode => {
    if (
      item.badge === 'waitingSubscribers' &&
      waitingSubscribersCount &&
      waitingSubscribersCount > 0 &&
      !hiddenNotifications.includes('waiting-subscribers')
    ) {
      return (
        <Box sx={{ marginLeft: 1 }}>
          <Tooltip title={`Waiting subscribers: ${waitingSubscribersCount}`}>
            <Badge
              badgeContent={waitingSubscribersCount}
              color="danger"
              size="sm"
              sx={{
                '& .MuiBadge-badge': {
                  justifyContent: 'center',
                  fontSize: '10px',
                  minWidth: '14px',
                  height: '14px',
                  padding: '0 3px',
                },
              }}
            />
          </Tooltip>
        </Box>
      );
    }
    return null;
  };

  return (
    <Stack spacing={1} sx={{ p: 0.5 }}>
      <Button
        startDecorator={<DashboardIcon />}
        onClick={() => onTabSelect(AdminTab.Dashboard)}
        variant="plain"
        sx={getMenuButtonSx(AdminTab.Dashboard)}
        data-testid="admin-dashboard-tab-btn"
      >
        Dashboard
      </Button>
      <AccordionGroup sx={{ marginLeft: 0.5 }}>
        {SIDEBAR_SECTIONS.map(section => {
          const { Icon: SectionIcon } = section;
          const visibleItems = section.items.filter(item => !item.gate || gates[item.gate]);
          return (
            <Accordion key={section.key} expanded={isExpanded(section.key)} onChange={() => toggleSection(section.key)}>
              <AccordionSummary>
                <SectionIcon color="primary" />
                <Typography color="primary" level="body-md">
                  {section.label}
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ '& .MuiAccordionDetails-content': { p: 1 } }}>
                <Stack direction={'column'} spacing={1}>
                  {visibleItems.map(item => {
                    const { Icon: ItemIcon } = item;
                    return (
                      <Button
                        key={item.tab}
                        {...(item.testid ? { 'data-testid': item.testid } : {})}
                        startDecorator={<ItemIcon />}
                        onClick={() => onTabSelect(item.tab)}
                        variant="plain"
                        sx={getMenuButtonSx(item.tab)}
                        endDecorator={renderEndDecorator(item)}
                      >
                        <Typography level="body-sm" sx={{ color: 'inherit' }}>
                          {item.label}
                        </Typography>
                      </Button>
                    );
                  })}
                </Stack>
              </AccordionDetails>
            </Accordion>
          );
        })}
      </AccordionGroup>
    </Stack>
  );
};
