// Recorded 2026-10-27. These pre-toolkit screens need tab-level layout/interaction migrations;
// swapping primitives alone would change form, dialog and table behavior. Remove entries as migrated.
const componentsByFile = {
  'AdminDashboardTab.tsx': ['Card'],
  'AdminModalTab.tsx': ['Card', 'Table'],
  'AdminModalTabNew.tsx': ['Modal', 'Card'],
  'AdminWhatsNewModalsTab.tsx': ['Modal'],
  'EventMetrics/components/CurationBreakdownTab.tsx': ['Card'],
  'EventMetrics/components/OverviewTab.tsx': ['Card'],
  'EventMetrics/components/RawDataTab.tsx': ['Table'],
  'EventMetrics/components/UsageBySourceCard.tsx': ['Card', 'Table'],
  'EventMetrics/UserActivity/AnalyticsErrorCard.tsx': ['Card'],
  'EventMetrics/UserActivity/filters/MetadataFilterPanel.tsx': ['Card'],
  'EventMetrics/UserActivity/UserActivityTab.tsx': ['Card'],
  'MigrateUsersTab.tsx': ['Card', 'Modal'],
  'OrganizationProfile.tsx': ['Card'],
  'ScopedOverridesByScope.tsx': ['Card'],
  'SlackMetrics/SlackMetricsTab.tsx': ['Card'],
  'SreAgentTab.tsx': ['Card', 'Modal', 'Table'],
  'Team/index.tsx': ['Card', 'Modal'],
  'Users/ComplianceModal.tsx': ['Table'],
  'Users/Views/RecentActivityView.tsx': ['Card'],
  'email/EmailActivityHistory.tsx': ['Table'],
  'email/EmailJobDetail.tsx': ['Table', 'Modal'],
  'email/EmailJobsPanel.tsx': ['Table'],
  'email/EmailTemplatesPanel.tsx': ['Table', 'Modal'],
};

const migrationReasons = {
  Card: 'Preserve the existing content/form layout until the screen is reviewed against SectionCard content-only rules.',
  Modal:
    'Preserve the existing dialog contract until its action, reason and focus behavior is migrated to ActionDialog.',
  Table: 'Preserve the existing row/rendering contract until columns, selection and states are migrated to DataTable.',
};

export default Object.fromEntries(
  Object.entries(componentsByFile).map(([file, components]) => [
    file,
    {
      date: '2026-10-27',
      components,
      reason: components.map(component => `${file} (${component}): ${migrationReasons[component]}`).join(' '),
    },
  ])
);
