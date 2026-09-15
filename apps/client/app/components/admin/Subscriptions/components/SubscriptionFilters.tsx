import { Card, Stack, Input, Button, Select, Option } from '@mui/joy';
import SearchIcon from '@mui/icons-material/Search';
import RefreshIcon from '@mui/icons-material/Refresh';
import ContextHelpButton from '@client/app/components/help/ContextHelpButton';

interface SubscriptionFiltersProps {
  search: string;
  onSearchChange: (value: string) => void;
  onRefresh: () => void;
  isLoading?: boolean;
  status: string;
  onStatusChange: (value: string) => void;
}

const SubscriptionFilters = ({
  search,
  onSearchChange,
  onRefresh,
  isLoading,
  status,
  onStatusChange,
}: SubscriptionFiltersProps) => {
  return (
    <Card sx={{ mb: 2 }}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'stretch', sm: 'center' }}
        spacing={2}
      >
        <Input
          placeholder="Search by user email or name"
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          startDecorator={<SearchIcon />}
          sx={{ minWidth: { xs: 0, sm: 300 }, flex: { xs: 'none', sm: 1 }, width: { xs: '100%', sm: 'auto' } }}
        />

        <Select
          value={status}
          onChange={(_, newValue) => onStatusChange(newValue as string)}
          placeholder="Filter by status"
          sx={{ minWidth: { xs: 0, sm: 150 }, width: { xs: '100%', sm: 'auto' } }}
        >
          <Option value="all">All Status</Option>
          <Option value="active">Active</Option>
          <Option value="canceled">Canceled</Option>
          <Option value="past_due">Past Due</Option>
          <Option value="trialing">Trialing</Option>
          <Option value="incomplete">Incomplete</Option>
          <Option value="unpaid">Unpaid</Option>
        </Select>

        <Stack direction="row" spacing={1} alignItems="center">
          <Button
            size="sm"
            startDecorator={<RefreshIcon />}
            onClick={onRefresh}
            disabled={isLoading}
            sx={{ width: { xs: '100%', sm: 'auto' } }}
          >
            Refresh
          </Button>
          <ContextHelpButton helpId="admin/subscriptions" tooltipText="Subscriptions Help" />
        </Stack>
      </Stack>
    </Card>
  );
};

export default SubscriptionFilters;
