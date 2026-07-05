import { useState } from 'react';
import dayjs from 'dayjs';
import { MetadataFilter } from './useUserActivityFilters';

export interface FilterState {
  counterNameSearch: string;
  reportNameSearch?: string;
  userEmailSearch: string;
  startDate: string;
  endDate: string;
  metadataFilters?: MetadataFilter[];
  showUniqueCountOnly: boolean;
  showGatedOnly: boolean;
  showHeroOnly: boolean;
  selectedOrganization: string[];
  excludedOrgs: {
    millionOnMars: boolean;
    unknown: boolean;
    personal: boolean;
  };
}

interface UserData {
  userId: string;
  userEmail: string;
  totalValue: number;
  count: number;
  metadata?: {
    reportId?: string;
    name?: string;
    title?: string;
    [key: string]: any;
  };
  userOrganization?: string;
}

const getLocalDate = (daysOffset = 0) => {
  const now = dayjs();
  return daysOffset < 0
    ? now.subtract(Math.abs(daysOffset), 'day').format('YYYY-MM-DD')
    : now.add(daysOffset, 'day').format('YYYY-MM-DD');
};

export const useReportActivityFilters = () => {
  const [filters, setFilters] = useState<FilterState>({
    counterNameSearch: '',
    reportNameSearch: '',
    userEmailSearch: '',
    startDate: getLocalDate(-7),
    endDate: getLocalDate(),
    showUniqueCountOnly: false,
    showGatedOnly: false,
    showHeroOnly: false,
    selectedOrganization: ['all'],
    excludedOrgs: {
      millionOnMars: false,
      unknown: false,
      personal: false,
    },
  });

  const updateFilter = (key: keyof FilterState, value: any) => {
    setFilters(prev => ({ ...prev, [key]: value }));
  };

  const transformData = (logs: any[] = []) => {
    if (!logs?.length) return [];

    const uniqueEntries = new Map();

    logs.forEach(log => {
      // Skip if organization is excluded
      const userOrg = log.userOrganization || 'Unknown';
      if (
        (filters.excludedOrgs.millionOnMars && userOrg === 'Million on Mars') ||
        (filters.excludedOrgs.unknown && userOrg === 'Unknown') ||
        (filters.excludedOrgs.personal && userOrg === 'Personal')
      ) {
        return;
      }

      // Skip if not in selected organizations
      if (!filters.selectedOrganization.includes('all') && !filters.selectedOrganization.includes(userOrg)) {
        return;
      }

      log.users?.forEach((user: UserData) => {
        const reportName = log.metadata?.reportName || log.metadata?.title || 'N/A';
        const reportId = log.metadata?.reportId || user.metadata?.reportId;

        if (filters.showUniqueCountOnly) {
          // For unique count view, use date-counter-report as key
          const key = `${log.date}-${log.counterName}-${reportId}`;
          if (!uniqueEntries.has(key)) {
            uniqueEntries.set(key, {
              date: log.date,
              counterName: log.counterName,
              metadata: {
                ...log.metadata,
                ...user.metadata,
                reportName: reportName,
              },
              uniqueUsers: new Set<string>(),
              count: 0,
            });
          }
          const entry = uniqueEntries.get(key);
          if (user.userEmail) {
            entry.uniqueUsers.add(user.userEmail);
            entry.count = entry.uniqueUsers.size;
          }
        } else {
          // For normal view, use date, counterName, userEmail, and reportId as the unique key
          const key = `${log.date}-${log.counterName}-${user.userEmail}-${reportId}`;
          if (!uniqueEntries.has(key)) {
            uniqueEntries.set(key, {
              date: log.date,
              counterName: log.counterName,
              metadata: {
                ...log.metadata,
                ...user.metadata,
                reportName: reportName,
              },
              userEmail: user.userEmail,
              userOrganization: user.userOrganization || log.userOrganization,
              count: 0,
            });
          }
          // Always update the count by adding the user's count
          const entry = uniqueEntries.get(key);
          entry.count += user.count || 0;
          // Update metadata preferring entries with more information
          if (user.metadata?.isGated || user.metadata?.isHero) {
            entry.metadata = {
              ...entry.metadata,
              ...user.metadata,
              reportName: reportName,
            };
          }
        }
      });
    });

    const result = Array.from(uniqueEntries.values()).map(entry => ({
      ...entry,
      userEmail: entry.userEmails ? Array.from(entry.userEmails).join(', ') : entry.userEmail,
      uniqueUsers: undefined,
      userEmails: undefined,
    }));

    // Sort by date (desc) and then by count (desc)
    result.sort((a, b) => {
      const dateCompare = dayjs(b.date).diff(dayjs(a.date));
      if (dateCompare !== 0) return dateCompare;
      return b.count - a.count;
    });

    return result;
  };

  return { filters, updateFilter, transformData };
};
