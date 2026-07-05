import { Stack, IconButton, FormControl, RadioGroup, Radio, Typography, Select, Option } from '@mui/joy';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { useIsMobile } from '@client/app/hooks/useIsMobile';

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  itemsPerPage: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onItemsPerPageChange: (itemsPerPage: number) => void;
  showItemsPerPage?: boolean;
  showTotal?: boolean;
  pageLimitOptions?: number[];
}

const PaginationControls = ({
  currentPage,
  totalPages,
  itemsPerPage,
  totalItems,
  onPageChange,
  onItemsPerPageChange,
  showItemsPerPage = true,
  showTotal = true,
  pageLimitOptions = [10, 20, 50, 100],
}: PaginationControlsProps) => {
  const isMobile = useIsMobile();

  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mt: 1, mb: 0.5 }}>
      {/* Page navigation */}
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton
          size="sm"
          variant="outlined"
          disabled={currentPage <= 1}
          onClick={() => onPageChange(currentPage - 1)}
          aria-label="Previous page"
        >
          <ChevronLeftIcon />
        </IconButton>
        <Typography level="body-sm" sx={{ whiteSpace: 'nowrap' }}>
          Page {currentPage} of {totalPages}
        </Typography>
        <IconButton
          size="sm"
          variant="outlined"
          disabled={currentPage >= totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          aria-label="Next page"
        >
          <ChevronRightIcon />
        </IconButton>
      </Stack>

      {showItemsPerPage && (
        <Stack direction="row" spacing={1} alignItems="center">
          {showTotal && (
            <Typography
              level="body-sm"
              sx={{ color: 'text.secondary', whiteSpace: 'nowrap', display: { xs: 'none', sm: 'block' } }}
            >
              Total: {totalItems}
            </Typography>
          )}
          {isMobile ? (
            <Select
              size="sm"
              value={itemsPerPage}
              onChange={(_, value) => onItemsPerPageChange(value as number)}
              sx={{ minWidth: 110 }}
            >
              {pageLimitOptions.map(value => (
                <Option key={value} value={value}>
                  {value} per page
                </Option>
              ))}
            </Select>
          ) : (
            <FormControl>
              <RadioGroup
                orientation="horizontal"
                value={itemsPerPage}
                onChange={e => onItemsPerPageChange(Number(e.target.value))}
                sx={{ display: 'grid', gridTemplateColumns: `repeat(${pageLimitOptions.length}, 1fr)`, gap: 1 }}
              >
                {pageLimitOptions.map(value => (
                  <Radio key={value} value={value} label={`${value} per page`} size="sm" />
                ))}
              </RadioGroup>
            </FormControl>
          )}
        </Stack>
      )}
    </Stack>
  );
};

export default PaginationControls;
