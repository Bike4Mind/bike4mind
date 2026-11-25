// Recorded 2026-10-27. These pre-toolkit screens need tab-level layout/interaction migrations;
// swapping primitives alone would change form, dialog and table behavior. Remove entries as migrated.
const componentsByFile = {
  'AdminModalTab.tsx': ['Card', 'Table'],
  'AdminModalTabNew.tsx': ['Modal', 'Card'],
  'AdminWhatsNewModalsTab.tsx': ['Modal'],
  'SreAgentTab.tsx': ['Card', 'Modal', 'Table'],
  'email/EmailJobDetail.tsx': ['Table', 'Modal'],
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
