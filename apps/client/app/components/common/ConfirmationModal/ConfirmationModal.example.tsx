import { FC, useState } from 'react';
import { Button, Box } from '@mui/joy';
import ConfirmationModal from './index';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import SaveOutlinedIcon from '@mui/icons-material/SaveOutlined';

/** Example usage of ConfirmationModal showing various configurations. */
const ConfirmationModalExamples: FC = () => {
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [customModalOpen, setCustomModalOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleDelete = async () => {
    setLoading(true);
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 2000));
    setLoading(false);
    setDeleteModalOpen(false);
    console.log('Item deleted');
  };

  const handleSave = () => {
    setSaveModalOpen(false);
    console.log('Changes saved');
  };

  const handleCustomAction = () => {
    setCustomModalOpen(false);
    console.log('Custom action executed');
  };

  return (
    <Box sx={{ p: 3, display: 'flex', gap: 2, flexWrap: 'wrap' }}>
      {/* Basic Delete Confirmation */}
      <Button color="danger" startDecorator={<DeleteOutlineOutlinedIcon />} onClick={() => setDeleteModalOpen(true)}>
        Delete Item
      </Button>

      {/* Save Confirmation */}
      <Button color="primary" startDecorator={<SaveOutlinedIcon />} onClick={() => setSaveModalOpen(true)}>
        Save Changes
      </Button>

      {/* Custom Modal */}
      <Button color="neutral" onClick={() => setCustomModalOpen(true)}>
        Custom Action
      </Button>

      {/* Delete Confirmation Modal */}
      <ConfirmationModal
        open={deleteModalOpen}
        onClose={() => setDeleteModalOpen(false)}
        onConfirm={handleDelete}
        loading={loading}
        title="Delete Item"
        description="Are you sure you want to delete this item? This action cannot be undone."
        confirmText="Delete"
        cancelText="Cancel"
        confirmColor="danger"
      />

      {/* Save Confirmation Modal */}
      <ConfirmationModal
        open={saveModalOpen}
        onClose={() => setSaveModalOpen(false)}
        onConfirm={handleSave}
        title="Save Changes"
        description="Do you want to save your changes?"
        confirmText="Save"
        cancelText="Don't Save"
        confirmColor="primary"
        showWarningIcon={false}
      />

      {/* Custom Modal with Custom Icon */}
      <ConfirmationModal
        open={customModalOpen}
        onClose={() => setCustomModalOpen(false)}
        onConfirm={handleCustomAction}
        title="Custom Action"
        description={
          <Box>
            <p>This is a custom modal with:</p>
            <ul>
              <li>Custom description with JSX</li>
              <li>Different button colors</li>
              <li>Custom styling</li>
            </ul>
          </Box>
        }
        confirmText="Proceed"
        cancelText="Cancel"
        confirmColor="neutral"
        maxWidth={500}
        showWarningIcon={false}
      />
    </Box>
  );
};

export default ConfirmationModalExamples;
