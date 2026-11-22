import { useState } from 'react';
import type { Story, StoryDefault } from './ladleTypes';
import Button from '@mui/joy/Button';
import DialogActions from '@mui/joy/DialogActions';
import DialogContent from '@mui/joy/DialogContent';
import DialogTitle from '@mui/joy/DialogTitle';
import Dropdown from '@mui/joy/Dropdown';
import ListDivider from '@mui/joy/ListDivider';
import ListItemDecorator from '@mui/joy/ListItemDecorator';
import Menu from '@mui/joy/Menu';
import MenuButton from '@mui/joy/MenuButton';
import MenuItem from '@mui/joy/MenuItem';
import MenuList from '@mui/joy/MenuList';
import Modal from '@mui/joy/Modal';
import ModalClose from '@mui/joy/ModalClose';
import ModalDialog from '@mui/joy/ModalDialog';
import { Row, Section, VARIANTS } from './matrix';

export default { title: 'Overlays' } satisfies StoryDefault;

const Dot = () => (
  <svg width="1em" height="1em" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
    <circle cx="8" cy="8" r="3" />
  </svg>
);

export const Menus: Story = () => (
  <>
    <Section title="static, by variant">
      <Row>
        {VARIANTS.map(variant => (
          <MenuList key={variant} variant={variant} sx={{ width: 200, borderRadius: 'md', flexGrow: 0 }}>
            <MenuItem>
              <ListItemDecorator>
                <Dot />
              </ListItemDecorator>
              {variant}
            </MenuItem>
            <MenuItem selected>Selected</MenuItem>
            <ListDivider />
            <MenuItem color="danger">Danger</MenuItem>
            <MenuItem disabled>Disabled</MenuItem>
          </MenuList>
        ))}
      </Row>
    </Section>
    <Section title="Dropdown">
      <Dropdown>
        <MenuButton>Open menu</MenuButton>
        <Menu>
          <MenuItem>First action</MenuItem>
          <MenuItem>Second action</MenuItem>
          <ListDivider />
          <MenuItem color="danger">Delete</MenuItem>
        </Menu>
      </Dropdown>
    </Section>
  </>
);

export const Dialogs: Story = () => {
  const [open, setOpen] = useState<'default' | 'alert' | null>(null);
  return (
    <>
      <Row>
        <Button variant="outlined" color="neutral" onClick={() => setOpen('default')}>
          Open dialog
        </Button>
        <Button variant="outlined" color="danger" onClick={() => setOpen('alert')}>
          Open alert dialog
        </Button>
      </Row>
      <Modal open={open === 'default'} onClose={() => setOpen(null)}>
        <ModalDialog>
          <ModalClose />
          <DialogTitle>Dialog title</DialogTitle>
          <DialogContent>Dialog content that explains what this dialog is for.</DialogContent>
          <DialogActions>
            <Button onClick={() => setOpen(null)}>Confirm</Button>
            <Button variant="plain" color="neutral" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
      <Modal open={open === 'alert'} onClose={() => setOpen(null)}>
        <ModalDialog variant="outlined" role="alertdialog">
          <DialogTitle>Delete this item?</DialogTitle>
          <DialogContent>This cannot be undone.</DialogContent>
          <DialogActions>
            <Button color="danger" onClick={() => setOpen(null)}>
              Delete
            </Button>
            <Button variant="plain" color="neutral" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </DialogActions>
        </ModalDialog>
      </Modal>
    </>
  );
};
