import { useState } from 'react';
import dayjs from 'dayjs';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';

// Extend dayjs with required plugins
dayjs.extend(isSameOrAfter);
dayjs.extend(isSameOrBefore);

export interface MetadataFilter {
  field: string;
  operator: 'equals' | 'contains' | 'in' | 'exists' | 'not_exists';
  value: any;
}

export interface FilterState {
  counterNameSearch: string;
  userEmailSearch: string;
  startDate: string;
  endDate: string;
  metadataFilters: MetadataFilter[];
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
  return daysOffset < 0 ? now.subtract(Math.abs(daysOffset), 'day').format('YYYY-MM-DD') : now.format('YYYY-MM-DD'); // For today (0) or future dates
};

export const useUserActivityFilters = () => {
  const [filters, setFilters] = useState<FilterState>({
    counterNameSearch: '',
    userEmailSearch: '',
    startDate: getLocalDate(-7),
    endDate: getLocalDate(),
    metadataFilters: [],
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

    // Create a Map to store unique entries by action+user+report combination
    const uniqueEntries = new Map();

    logs.forEach(log => {
      // Skip if the date is outside the selected range
      const logDate = dayjs(log.date);
      if (!logDate.isSameOrAfter(filters.startDate, 'day') || !logDate.isSameOrBefore(filters.endDate, 'day')) {
        return;
      }

      // Skip if organization is excluded
      const userOrg = log.userOrganization || 'Unknown';
      if (
        (filters.excludedOrgs.millionOnMars && userOrg === 'Million on Mars') ||
        (filters.excludedOrgs.unknown && userOrg === 'Unknown') ||
        (filters.excludedOrgs.personal && userOrg === 'Personal')
      ) {
        return;
      }

      // Apply organization filter
      if (!filters.selectedOrganization.includes('all') && !filters.selectedOrganization.includes(userOrg)) {
        return;
      }

      // Apply counter name search filter
      if (
        filters.counterNameSearch &&
        !log.counterName.toLowerCase().includes(filters.counterNameSearch.toLowerCase())
      ) {
        return;
      }

      log.users?.forEach((user: UserData) => {
        // Apply user email search filter
        if (filters.userEmailSearch && !user.userEmail.toLowerCase().includes(filters.userEmailSearch.toLowerCase())) {
          return;
        }

        const metadata = { ...log.metadata, ...user.metadata };

        // Apply metadata filters
        if (filters.metadataFilters.length > 0) {
          const passesMetadataFilters = filters.metadataFilters.every(filter => {
            if (!filter.field) return true; // Skip empty filters

            const fieldValue = metadata[filter.field];

            switch (filter.operator) {
              case 'exists':
                return fieldValue !== undefined && fieldValue !== null;
              case 'not_exists':
                return fieldValue === undefined || fieldValue === null;
              case 'equals':
                return String(fieldValue) === String(filter.value);
              case 'contains':
                return String(fieldValue || '')
                  .toLowerCase()
                  .includes(String(filter.value).toLowerCase());
              case 'in': {
                const values = String(filter.value)
                  .split(',')
                  .map(v => v.trim().toLowerCase());
                return values.includes(String(fieldValue || '').toLowerCase());
              }
              default:
                return true;
            }
          });

          if (!passesMetadataFilters) {
            return; // Skip this entry if it doesn't pass metadata filters
          }
        }

        const reportId = metadata.reportId;

        // For report actions, use a more specific key to avoid duplicates
        const isReportAction = log.counterName.toLowerCase().includes('report');
        const key =
          isReportAction && reportId
            ? `${log.date}-${log.counterName}-${user.userEmail}-${reportId}`
            : `${log.date}-${log.counterName}-${user.userEmail}`;

        if (!uniqueEntries.has(key)) {
          uniqueEntries.set(key, {
            date: log.date,
            counterName: log.counterName,
            userEmail: user.userEmail,
            userOrganization: user.userOrganization || log.userOrganization,
            metadata: metadata,
            count: user.count || 0,
            totalValue: user.totalValue || 0,
          });
        } else {
          // For existing entries, add to the count and update metadata if needed
          const entry = uniqueEntries.get(key);
          entry.count += user.count || 0;
          entry.totalValue += user.totalValue || 0;
          if (metadata.isGated || metadata.isHero) {
            entry.metadata = metadata;
          }
        }
      });
    });

    // Convert to array and prepare final data
    const result = Array.from(uniqueEntries.values());

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
