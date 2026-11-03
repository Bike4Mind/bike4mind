import React, { useState } from 'react';
import { FormControl, FormHelperText, FormLabel, Input, Option, Select, Stack } from '@mui/joy';
import { toast } from 'sonner';
import { ipBlockTargetProblem, type IpBlockDuration, type IpBlockScope } from '@bike4mind/common';
import { useBlockIP, useUnblockIP, type BlockedIPItem } from '@client/app/hooks/data/admin';
import { isStepUpCancelled } from '@client/app/utils/stepUpInterceptor';
import { ActionDialog, ADMIN_REASON_PRESETS } from '../shared';
import { adminUpdateErrorMessage } from '../Users/Profile/actions/useAdminUserUpdate';

export const IP_BLOCK_SCOPE_LABELS: Readonly<Record<IpBlockScope, string>> = {
  all: 'Sign-in, signup, checkout and AI',
  login: 'Sign-in only',
};

const DURATION_LABELS: Readonly<Record<IpBlockDuration, string>> = {
  '1h': '1 hour',
  '24h': '24 hours',
  '7d': '7 days',
  '30d': '30 days',
  permanent: 'Permanent',
};

const failToast = (error: unknown, fallback: string) => {
  if (!isStepUpCancelled(error)) toast.error(adminUpdateErrorMessage(error, fallback));
};

/**
 * Blocks an IP address or CIDR range for a chosen scope and duration (DESIGN_GUIDE.md section 4,
 * "changes access"). Used from the Blocked IPs tab and from a user's signup IP on their profile.
 * Mount it only while open, so each open starts from `initialIp`.
 */
export const BlockIpDialog: React.FC<{ onClose: () => void; initialIp?: string }> = ({ onClose, initialIp = '' }) => {
  const [ip, setIp] = useState(initialIp);
  const [scope, setScope] = useState<IpBlockScope>('all');
  const [duration, setDuration] = useState<IpBlockDuration>('24h');
  const blockIp = useBlockIP();
  const problem = ip.trim() ? ipBlockTargetProblem(ip) : 'Enter an IP address or range.';

  const handleConfirm = async (reason: string) => {
    try {
      const result = await blockIp.mutateAsync({ ip: ip.trim(), scope, duration, reason });
      toast.success(result.extended ? 'Block extended' : result.alreadyBlocked ? 'Already blocked' : 'IP blocked');
      onClose();
    } catch (error) {
      failToast(error, 'Could not block the IP.');
      throw error;
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title="Block IP"
      description={
        scope === 'all'
          ? 'Requests from this address or range cannot sign in, sign up, check out or use AI until the block ends. It takes up to 30 seconds to apply everywhere.'
          : 'Sign-in from this address or range is refused until the block ends.'
      }
      reasonPresets={ADMIN_REASON_PRESETS.ipBlock}
      confirmLabel={duration === 'permanent' ? 'Block IP permanently' : 'Block IP'}
      tone="danger"
      blockedReason={problem}
      pending={blockIp.isPending}
      onConfirm={handleConfirm}
      data-testid="block-ip-dialog"
    >
      <Stack gap={1.5}>
        <FormControl error={Boolean(ip.trim()) && problem !== null}>
          <FormLabel>IP address or range</FormLabel>
          <Input
            value={ip}
            onChange={event => setIp(event.target.value)}
            placeholder="203.0.113.7 or 203.0.113.0/24"
            sx={{ fontFamily: 'code' }}
            slotProps={{ input: { 'data-testid': 'block-ip-dialog-ip-input', spellCheck: false } }}
          />
          <FormHelperText>IPv4 ranges down to /16 and IPv6 ranges down to /32.</FormHelperText>
        </FormControl>
        <FormControl>
          <FormLabel>Applies to</FormLabel>
          <Select
            value={scope}
            onChange={(_event, value) => value && setScope(value)}
            data-testid="block-ip-dialog-scope-select"
          >
            {(Object.keys(IP_BLOCK_SCOPE_LABELS) as IpBlockScope[]).map(value => (
              <Option key={value} value={value} data-testid={`block-ip-dialog-scope-${value}`}>
                {IP_BLOCK_SCOPE_LABELS[value]}
              </Option>
            ))}
          </Select>
        </FormControl>
        <FormControl>
          <FormLabel>Duration</FormLabel>
          <Select
            value={duration}
            onChange={(_event, value) => value && setDuration(value)}
            data-testid="block-ip-dialog-duration-select"
          >
            {(Object.keys(DURATION_LABELS) as IpBlockDuration[]).map(value => (
              <Option key={value} value={value} data-testid={`block-ip-dialog-duration-${value}`}>
                {DURATION_LABELS[value]}
              </Option>
            ))}
          </Select>
          {duration === 'permanent' && (
            <FormHelperText>A permanent block stays until an admin removes it.</FormHelperText>
          )}
        </FormControl>
      </Stack>
    </ActionDialog>
  );
};

/** Lifts one block. Audited with a reason, since it removes a security control. */
export const UnblockIpDialog: React.FC<{ block: BlockedIPItem | null; onClose: () => void }> = ({ block, onClose }) => {
  const unblockIp = useUnblockIP();
  if (!block) return null;

  const handleConfirm = async (reason: string) => {
    try {
      await unblockIp.mutateAsync({ id: block._id, reason });
      toast.success('IP unblocked');
      onClose();
    } catch (error) {
      failToast(error, 'Could not unblock the IP.');
      throw error;
    }
  };

  return (
    <ActionDialog
      open
      onClose={onClose}
      title={`Unblock ${block.ip}?`}
      description="Requests from this address or range are allowed again within 30 seconds."
      reasonPresets={ADMIN_REASON_PRESETS.ipUnblock}
      confirmLabel="Unblock IP"
      pending={unblockIp.isPending}
      onConfirm={handleConfirm}
      data-testid="unblock-ip-dialog"
    />
  );
};
