import { FormControl, FormHelperText, FormLabel, Option, Select } from '@mui/joy';
import { useQuery } from '@tanstack/react-query';
import { fetchGrantPackages, type GrantPackageRow } from '@client/app/utils/grantPackageAPICalls';
import { GRANT_PACKAGES_QUERY_KEY } from '../Packages/GrantPackagesTab';

const capText = (cap: number | null) => (cap === null ? 'uncapped' : `cap ${cap.toLocaleString()}`);

export const grantPackageUsage = (pkg: GrantPackageRow) => {
  const redeemed = `${pkg.redeemedTotal.toLocaleString()}${pkg.totalCap === null ? '' : ` / ${pkg.totalCap.toLocaleString()}`} redeemed`;
  const hits = pkg.capHits
    ? `cap hit ${pkg.capHits.toLocaleString()} times${pkg.lastCapHitAt ? `, last ${new Date(pkg.lastCapHitAt).toUTCString()}` : ''}`
    : 'cap never hit';
  return `${redeemed}; ${hits}${pkg.active ? '' : ' (inactive)'}`;
};

export const useGrantPackageOptions = () =>
  useQuery({
    queryKey: [GRANT_PACKAGES_QUERY_KEY, { page: 1, pageSize: 100 }],
    queryFn: () => fetchGrantPackages({ page: 1, limit: 100 }),
  });

type Props = {
  value: string | null;
  onChange: (id: string | null) => void;
  testId: string;
  helperText?: string;
  disabled?: boolean;
};

/**
 * Optional grant package picker. Inactive packages are listed only when already selected, so an
 * existing link stays visible but cannot be newly chosen.
 */
const GrantPackageSelect = ({ value, onChange, testId, helperText, disabled }: Props) => {
  const { data, isPending } = useGrantPackageOptions();
  const packages = (data?.data ?? []).filter(pkg => pkg.active || pkg.id === value);
  const selected = packages.find(pkg => pkg.id === value);

  return (
    <FormControl>
      <FormLabel>Grant package</FormLabel>
      <Select
        value={value ?? ''}
        onChange={(_, next) => onChange(next ? String(next) : null)}
        disabled={disabled || isPending}
        placeholder={isPending ? 'Loading packages...' : 'None'}
        slotProps={{ button: { 'data-testid': testId } }}
      >
        <Option value="">None</Option>
        {packages.map(pkg => (
          <Option key={pkg.id} value={pkg.id} data-testid={`${testId}-option-${pkg.id}`}>
            {pkg.name} ({pkg.credits.toLocaleString()} credits, {capText(pkg.totalCap)}, daily {capText(pkg.dailyCap)})
          </Option>
        ))}
      </Select>
      <FormHelperText data-testid={`${testId}-usage`}>
        {selected ? grantPackageUsage(selected) : helperText}
      </FormHelperText>
    </FormControl>
  );
};

export default GrantPackageSelect;
