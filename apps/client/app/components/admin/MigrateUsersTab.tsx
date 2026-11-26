import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { useMigrateUsers } from '@client/app/utils/userAPICalls';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { Alert, Box, Button, Checkbox, FormControl, FormHelperText, Stack, Textarea, Typography } from '@mui/joy';
import React, { ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { buildMigratedUsersCsv } from '@client/app/utils/migratedUsersCsv';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import SingleOrganizationSelector from '../common/SingleOrganizationSelector';
import { AdminDialog, AdminDialogFooter, AdminPageHeader, DataTable, type DataColumn } from './shared';
import { ADMIN_DETAIL_MAX_WIDTH, ADMIN_REGION_GAP } from './shared/adminStyles';

type UserRow = { key: string; name: string; email: string };

// A results table someone copies from: emails wrap instead of ending in an ellipsis.
const userColumns: DataColumn<UserRow>[] = [
  { id: 'name', label: 'Name', render: row => row.name },
  { id: 'email', label: 'Email', wrap: true, render: row => row.email },
];

// Keyed by position: a pasted list can repeat an email.
const toUserRows = (users: readonly { name: string; email: string }[]): UserRow[] =>
  users.map((user, index) => ({ key: `${index}`, name: user.name, email: user.email }));
const getUserRowId = (row: UserRow) => row.key;
const noop = () => {};

const MigrateUsersTab: React.FC = () => {
  const organizations = useGetAllOrganizations({ filters: { personal: false } });
  const [userList, setUserList] = useState('');
  const [migrateUsers, setMigrateUsers] = useState<{ name: string; email: string }[]>([]);
  const [isFaultyData, setIsFaultyData] = useState(false);
  const [tempPassword, setTempPassword] = useState(false);

  const { mutate: migrateUsersMutation, isPending } = useMigrateUsers();
  const [sendEmail, setSendEmail] = useState(false);
  const [createdUsers, setCreatedUsers] = useState<
    Array<{ name: string; email: string; tempPassword?: string; sendEmail?: boolean }>
  >([]);
  const [showModal, setShowModal] = useState(false);
  const [createdWithEmail, setCreatedWithEmail] = useState(false);
  const [orgId, setOrgId] = useState('');
  const isOrgUsersExceed = useMemo(() => {
    if (!orgId) return false;
    if (!migrateUsers.length) return false;
    const foundOrg = (organizations.data ?? [])?.find(org => org.id === orgId);
    if (foundOrg) {
      const { seats, users } = foundOrg;
      return users.length + migrateUsers.length > seats;
    }
    return false;
  }, [orgId, migrateUsers, organizations.data]);

  const handleUserListChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setUserList(e.target.value);
  };

  const parseUserList = () => {
    const lines = userList.split('\n');
    const users: { name: string; email: string }[] = [];
    let hasInvalidFormat = false;

    lines.forEach(line => {
      const trimmedLine = line.trim();
      const regex = /^(.+),\s*([\w.+-]+@[\w.-]+\.[a-zA-Z]{2,})$/;

      const match = trimmedLine.match(regex);
      if (match) {
        const name = match[1];
        const email = match[2];
        users.push({ name, email });
      } else {
        hasInvalidFormat = true;
      }
    });

    if (hasInvalidFormat) {
      setIsFaultyData(true);
      console.error("One or more lines are in the wrong format. Each line must be in the 'username, email' format.");
    } else {
      setIsFaultyData(false);
      setMigrateUsers(users);
    }
  };
  const handleMigrateUsers = () => {
    if (isOrgUsersExceed) return;

    if (!isFaultyData) {
      migrateUsersMutation(
        {
          usersData: migrateUsers,
          sendEmail,
          orgId,
        },
        {
          onSuccess: data => {
            setCreatedUsers(data.createdUsers);
            setCreatedWithEmail(sendEmail);
            setShowModal(true);
          },
          onError: error => {
            toast.error('Failed to migrate users');
          },
        }
      );
    }
  };

  const generateCSV = () => buildMigratedUsersCsv(createdUsers);

  const copyCSVToClipboard = async () => {
    const csv = generateCSV();
    try {
      await navigator.clipboard.writeText(csv);
      toast.success('CSV copied to clipboard!');
    } catch (err) {
      console.error('Failed to copy CSV: ', err);
      toast.error('Failed to copy CSV.');
    }
  };

  const secondOption = false;
  const parsedRows = useMemo(() => toUserRows(migrateUsers), [migrateUsers]);
  const createdRows = useMemo(() => toUserRows(createdUsers), [createdUsers]);

  return (
    <Stack gap={ADMIN_REGION_GAP} sx={{ maxWidth: ADMIN_DETAIL_MAX_WIDTH }}>
      <AdminPageHeader
        title="Migrate users"
        description="Add people to an organization in bulk from a pasted list, with an optional welcome email."
        actions={<ContextHelpButton helpId="admin/user-migration" tooltipText="User migration help" />}
      />
      <Stack spacing={2}>
        <FormControl>
          <Checkbox
            label="Send Welcome Email to Users"
            checked={sendEmail}
            onChange={e => setSendEmail(e.target.checked)}
          />
          <FormHelperText>
            If checked, users will receive a welcome email with instructions on how to sign in via email code.
          </FormHelperText>
        </FormControl>
        {secondOption && (
          <FormControl>
            <Checkbox
              label="Set & Send Temporary Password"
              checked={tempPassword}
              onChange={e => setTempPassword(e.target.checked)}
            />
            <FormHelperText>
              If selected, a unique temporary password will be generated for each user and sent to them via email.
            </FormHelperText>
          </FormControl>
        )}

        <Button onClick={() => (window.location.href = '/developer/migration')}>Migration Tutorial</Button>
        <Textarea
          minRows={10}
          placeholder="Enter user list (name, email) separated by commas and new lines"
          value={userList}
          onChange={handleUserListChange}
        />
        {!!orgId && <WarningBox>Users will be added to the selected organization.</WarningBox>}
        {isOrgUsersExceed && (
          <WarningBox>
            This will exceed the maximum allowed seats for this organization. Please increase the seats before trying
            again.
          </WarningBox>
        )}
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <Button disabled={userList.length === 0} onClick={parseUserList}>
            Parse User List
          </Button>
          <SingleOrganizationSelector currentOrgId={orgId} onChange={orgId => setOrgId(orgId ?? '')} />
          {isFaultyData && <Typography>The data entered does not match the given format.</Typography>}
        </Stack>
        {migrateUsers.length > 0 && !isFaultyData && (
          <DataTable
            label="Parsed users"
            testId="migrate-parsed-users-table"
            rows={parsedRows}
            columns={userColumns}
            getRowId={getUserRowId}
            onRetry={noop}
            minWidth="20rem"
          />
        )}
        <Button
          onClick={handleMigrateUsers}
          disabled={migrateUsers.length === 0 || isFaultyData || isOrgUsersExceed}
          loading={isPending}
        >
          Migrate Users
        </Button>
      </Stack>
      <AdminDialog
        open={showModal}
        onClose={() => setShowModal(false)}
        title="Created users"
        width={720}
        data-testid="migrate-created-users-dialog"
      >
        <Stack spacing={2}>
          {!createdWithEmail && (
            <Alert color="warning" variant="soft" data-testid="migrate-no-email-warning">
              Important: Make sure to copy these results. No welcome email was sent{' \u2014 '}users will need their
              login email addresses to sign in via the email code flow.
            </Alert>
          )}
          <DataTable
            label="Created users"
            testId="migrate-created-users-table"
            rows={createdRows}
            columns={userColumns}
            getRowId={getUserRowId}
            onRetry={noop}
            minWidth="18rem"
            maxHeight="50vh"
            pagination={false}
          />
        </Stack>
        <AdminDialogFooter>
          <Button
            variant="outlined"
            startDecorator={<ContentCopyIcon />}
            onClick={() => void copyCSVToClipboard()}
            data-testid="migrate-copy-csv-btn"
          >
            Copy CSV
          </Button>
          <Button onClick={() => setShowModal(false)} data-testid="migrate-created-users-done-btn">
            Close
          </Button>
        </AdminDialogFooter>
      </AdminDialog>
    </Stack>
  );
};

const WarningBox = ({ children }: { children: ReactNode }) => {
  return (
    <Box
      sx={{
        backgroundColor: 'warning.100',
        border: '1px solid',
        borderColor: 'warning.500',
        borderRadius: '3px',
        padding: '5px',
        display: 'flex',
        alignItems: 'center',
      }}
    >
      <Typography sx={{ marginLeft: '0.5rem' }}>{children}</Typography>
    </Box>
  );
};

export default MigrateUsersTab;
