import { ORG_INVITE_ROLES, OrgInviteRole } from '@bike4mind/common';
import {
  Alert,
  Box,
  Button,
  Chip,
  ColorPaletteProp,
  FormControl,
  FormLabel,
  Modal,
  ModalClose,
  ModalDialog,
  Stack,
  Table,
  Textarea,
  Typography,
} from '@mui/joy';
import UploadFileIcon from '@mui/icons-material/UploadFile';
import { ChangeEvent, FC, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BulkInviteRowStatus, BulkInviteResult, useBulkInviteOrganization } from '@client/app/hooks/data/organizations';
import { getErrorMessage } from '@client/app/utils/error';
import { MAX_BULK_INVITE_ROWS, parseCsvFirstColumn, parseEmailList } from './bulkInviteParse';
import OrgInviteRoleSelect from './OrgInviteRoleSelect';

// A 100-row address list is a few KB; anything this large is not an invite list.
const MAX_BULK_INVITE_FILE_BYTES = 1024 * 1024;

interface BulkInviteModalProps {
  organizationId: string;
  availableSeats: number;
  canGrantAdmin: boolean;
  onDone: () => void;
}

const STATUS_DISPLAY: Record<BulkInviteRowStatus, { label: string; color: ColorPaletteProp }> = {
  invite: { label: 'Invited', color: 'success' },
  already_member: { label: 'Already a member', color: 'neutral' },
  already_pending: { label: 'Already invited', color: 'neutral' },
  duplicate: { label: 'Duplicate', color: 'neutral' },
  invalid: { label: 'Invalid address', color: 'danger' },
  seat_limit: { label: 'Over seat limit', color: 'warning' },
};

const SUMMARY_PARTS: [BulkInviteRowStatus, string][] = [
  ['already_member', 'already in the team'],
  ['already_pending', 'already invited'],
  ['duplicate', 'repeated in the list'],
  ['invalid', 'invalid'],
  ['seat_limit', 'over seat limit'],
];

export function summarizeBulkInvite(result: BulkInviteResult): string {
  const counts = new Map<BulkInviteRowStatus, number>();
  for (const row of result.rows) counts.set(row.status, (counts.get(row.status) ?? 0) + 1);
  const parts = [`${result.invitedCount} invited`];
  for (const [status, label] of SUMMARY_PARTS) {
    const count = counts.get(status);
    if (count) parts.push(`${count} ${label}`);
  }
  return parts.join(', ');
}

const BulkInviteModal: FC<BulkInviteModalProps> = ({ organizationId, availableSeats, canGrantAdmin, onDone }) => {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [role, setRole] = useState<OrgInviteRole>('viewer');
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bulkInvite = useBulkInviteOrganization();

  const emails = useMemo(() => parseEmailList(text), [text]);
  const overCap = emails.length > MAX_BULK_INVITE_ROWS;

  const handleFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > MAX_BULK_INVITE_FILE_BYTES) {
      setFileError('That file is too large. Use a file under 1 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setFileError(null);
      const addresses = parseCsvFirstColumn(typeof reader.result === 'string' ? reader.result : '');
      setText(current => [current.trim(), ...addresses].filter(Boolean).join('\n'));
    };
    reader.onerror = () => setFileError('Could not read that file.');
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    bulkInvite.mutate({ organizationId, emails, permissions: [...ORG_INVITE_ROLES[role]] });
  };

  const result = bulkInvite.data;

  return (
    <Modal open onClose={onDone}>
      <ModalDialog sx={{ width: 'min(640px, 95vw)', overflow: 'auto' }} data-testid="org-bulk-invite-modal">
        <ModalClose />
        <Typography level="title-lg">{t('organizations.modals.bulk_invite.title', 'Bulk invite')}</Typography>
        <Typography level="body-sm">
          {t(
            'organizations.modals.bulk_invite.subtitle',
            `Paste addresses or upload a CSV (first column). Up to ${MAX_BULK_INVITE_ROWS} per batch; ${availableSeats} seats available.`
          )}
        </Typography>
        <Stack spacing={1.5}>
          <OrgInviteRoleSelect
            value={role}
            onChange={setRole}
            canGrantAdmin={canGrantAdmin}
            testId="org-bulk-invite-role-select"
          />
          <FormControl>
            <FormLabel>{t('organizations.modals.bulk_invite.addresses_label', 'Email addresses')}</FormLabel>
            <Textarea
              minRows={4}
              maxRows={10}
              placeholder="ann@example.com, bob@example.com"
              value={text}
              onChange={event => setText(event.target.value)}
              slotProps={{ textarea: { 'data-testid': 'org-bulk-invite-textarea' } }}
            />
          </FormControl>
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              size="sm"
              variant="outlined"
              startDecorator={<UploadFileIcon />}
              data-testid="org-bulk-invite-upload"
              onClick={() => fileInputRef.current?.click()}
            >
              {t('organizations.modals.bulk_invite.upload', 'Upload CSV')}
            </Button>
            <input
              ref={fileInputRef}
              hidden
              type="file"
              accept=".csv,.txt"
              data-testid="org-bulk-invite-file"
              onChange={handleFile}
            />
            <Typography level="body-xs" data-testid="org-bulk-invite-count">
              {emails.length} {emails.length === 1 ? 'address' : 'addresses'}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="sm"
              data-testid="org-bulk-invite-submit"
              disabled={emails.length === 0 || overCap}
              loading={bulkInvite.isPending}
              onClick={handleSubmit}
            >
              {t('organizations.modals.bulk_invite.submit', 'Invite')}
            </Button>
          </Box>
          {overCap && (
            <Typography level="body-sm" color="danger" data-testid="org-bulk-invite-cap-error">
              {`At most ${MAX_BULK_INVITE_ROWS} addresses per batch; remove ${emails.length - MAX_BULK_INVITE_ROWS}.`}
            </Typography>
          )}
          {fileError && (
            <Typography level="body-sm" color="danger">
              {fileError}
            </Typography>
          )}
          {bulkInvite.isError && (
            <Alert color="danger" data-testid="org-bulk-invite-error">
              {getErrorMessage(bulkInvite.error)}
            </Alert>
          )}
          {result && (
            <Stack spacing={1}>
              <Typography role="status" aria-live="polite" level="title-sm" data-testid="org-bulk-invite-summary">
                {summarizeBulkInvite(result)}
              </Typography>
              <Table size="sm" stickyHeader>
                <thead>
                  <tr>
                    <th>Address</th>
                    <th style={{ width: 160 }}>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr key={`${index}-${row.raw}`} data-testid={`org-bulk-invite-row-${index}`}>
                      <td style={{ wordBreak: 'break-all' }}>{row.email || row.raw}</td>
                      <td>
                        <Chip size="sm" variant="soft" color={STATUS_DISPLAY[row.status].color}>
                          {STATUS_DISPLAY[row.status].label}
                        </Chip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Stack>
          )}
        </Stack>
      </ModalDialog>
    </Modal>
  );
};

export default BulkInviteModal;
