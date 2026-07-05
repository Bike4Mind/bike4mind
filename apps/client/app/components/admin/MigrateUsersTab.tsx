import { useGetAllOrganizations } from '@client/app/utils/organizationAPICalls';
import { useMigrateUsers } from '@client/app/utils/userAPICalls';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import {
  Box,
  Button,
  Card,
  Checkbox,
  FormControl,
  FormHelperText,
  Grid,
  IconButton,
  Modal,
  Sheet,
  Stack,
  Textarea,
  Tooltip,
  Typography,
} from '@mui/joy';
import React, { ReactNode, useMemo, useState } from 'react';
import { toast } from 'sonner';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';
import SingleOrganizationSelector from '../common/SingleOrganizationSelector';

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
            setShowModal(true);
          },
          onError: error => {
            toast.error('Failed to migrate users');
          },
        }
      );
    }
  };

  const generateCSV = () => {
    const header = ['Name', 'Email'];

    if (createdUsers[0].tempPassword) {
      header.push('Temporary Password');
    }

    const rows = createdUsers.map(user => [
      `"${user.name}"`, // Enclose in quotes to handle commas in names
      `"${user.email}"`,
      `"${user.tempPassword}"`,
    ]);
    const csvContent = [header, ...rows].map(e => e.join(',')).join('\n');
    return csvContent;
  };

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

  return (
    <Sheet sx={{ overflow: 'hidden', width: '100%' }}>
      <Stack spacing={2}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography level="h1">Migrate Users</Typography>
          <ContextHelpButton helpId="admin/user-migration" tooltipText="User Migration Help" />
        </Stack>
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
          {migrateUsers.length > 0 && !isFaultyData && (
            <Sheet sx={{ overflowY: 'auto', maxHeight: '400px', width: '100%' }}>
              {migrateUsers.map((user, index) => (
                <Card
                  key={index}
                  sx={{
                    mb: 1,
                    width: '100%',
                    bgcolor: index % 2 ? 'background.level1' : 'background.level2',
                    p: 1,
                  }}
                >
                  <Grid container spacing={2}>
                    <Grid xs={6}>
                      <Typography>{user.name}</Typography>
                    </Grid>
                    <Grid xs={6}>
                      <Typography>{user.email}</Typography>
                    </Grid>
                  </Grid>
                </Card>
              ))}
            </Sheet>
          )}
          {isFaultyData && <Typography>The data entered does not match the given format.</Typography>}
        </Stack>
        <Button
          onClick={handleMigrateUsers}
          disabled={migrateUsers.length === 0 || isFaultyData || isOrgUsersExceed}
          loading={isPending}
        >
          Migrate Users
        </Button>
      </Stack>
      <Modal open={showModal} onClose={() => setShowModal(false)}>
        <Sheet
          sx={{
            p: 3,
            width: '100%',
            maxWidth: '90%',
            maxHeight: '80vh',
            overflow: 'auto',
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            borderRadius: 'md',
            boxShadow: 'lg',
            bgcolor: 'background.body',
          }}
        >
          <Stack spacing={2}>
            <Typography level="h4" mb={2}>
              Created Users
            </Typography>

            {!sendEmail && (
              <Typography color="warning" fontWeight="bold">
                Important: Make sure to copy these results. No welcome email was sent — users will need their login
                email addresses to sign in via the email code flow.
              </Typography>
            )}

            <Sheet sx={{ overflowY: 'auto', maxHeight: '400px', width: '100%' }}>
              <Grid container spacing={2}>
                <Grid xs={4}>
                  <Typography level="body-xs" fontWeight="bold">
                    Name:
                  </Typography>
                </Grid>
                <Grid xs={4}>
                  <Typography level="body-xs" fontWeight="bold">
                    Email:
                  </Typography>
                </Grid>
              </Grid>

              {createdUsers.map((user, index) => (
                <Card
                  key={index}
                  sx={{
                    mb: 1,
                    width: '100%',
                    bgcolor: index % 2 ? 'background.level1' : 'background.level2',
                    p: 1,
                  }}
                >
                  <Grid container spacing={2}>
                    <Grid xs={6}>
                      <Typography>{user.name}</Typography>
                    </Grid>
                    <Grid xs={6}>
                      <Typography>{user.email}</Typography>
                    </Grid>
                  </Grid>
                </Card>
              ))}
            </Sheet>
            <Stack direction="row" spacing={2} justifyContent="flex-end">
              <Tooltip title="Copy CSV to Clipboard">
                <IconButton color="primary" onClick={copyCSVToClipboard}>
                  <ContentCopyIcon />
                </IconButton>
              </Tooltip>
              <Button onClick={() => setShowModal(false)}>Close</Button>
            </Stack>
          </Stack>
        </Sheet>
      </Modal>
    </Sheet>
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
