# ConfirmationModal Component

A reusable confirmation modal component built with MUI Joy UI that provides a consistent way to handle user confirmations throughout the application.

## Features

- ✅ **Portal Rendering** - Renders outside the component tree to avoid z-index issues
- ✅ **Accessibility** - Proper ARIA attributes and keyboard navigation
- ✅ **Customizable** - Flexible props for different use cases
- ✅ **Loading States** - Built-in loading state support
- ✅ **Event Handling** - Prevents event propagation automatically
- ✅ **Theme Integration** - Uses your custom theme colors
- ✅ **TypeScript** - Fully typed with comprehensive interfaces

## Basic Usage

```tsx
import ConfirmationModal from '@client/app/components/common/ConfirmationModal';

const MyComponent = () => {
  const [showModal, setShowModal] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await performAction();
      setShowModal(false);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button onClick={() => setShowModal(true)}>Delete Item</Button>

      <ConfirmationModal
        open={showModal}
        onClose={() => setShowModal(false)}
        onConfirm={handleConfirm}
        loading={loading}
        title="Delete Item"
        description="Are you sure you want to delete this item?"
        confirmText="Delete"
        cancelText="Cancel"
        confirmColor="danger"
      />
    </>
  );
};
```

## Props

| Prop              | Type                                 | Default                                                             | Description                                 |
| ----------------- | ------------------------------------ | ------------------------------------------------------------------- | ------------------------------------------- |
| `open`            | `boolean`                            | -                                                                   | Whether the modal is open                   |
| `onClose`         | `() => void`                         | -                                                                   | Callback when modal should close            |
| `onConfirm`       | `() => void`                         | -                                                                   | Callback when user confirms the action      |
| `loading`         | `boolean`                            | `false`                                                             | Whether the confirm action is in progress   |
| `title`           | `string`                             | `"Confirm Action"`                                                  | Title of the modal                          |
| `description`     | `string \| ReactNode`                | `"Are you sure you want to proceed? This action cannot be undone."` | Description text                            |
| `confirmText`     | `string`                             | `"Confirm"`                                                         | Text for the confirm button                 |
| `cancelText`      | `string`                             | `"Cancel"`                                                          | Text for the cancel button                  |
| `confirmColor`    | `'danger' \| 'primary' \| 'neutral'` | `'danger'`                                                          | Color variant for the confirm button        |
| `icon`            | `ReactNode`                          | -                                                                   | Custom icon to display in the header        |
| `maxWidth`        | `number \| string`                   | `400`                                                               | Maximum width of the modal                  |
| `showWarningIcon` | `boolean`                            | `true`                                                              | Whether to show the warning icon            |
| `successMessage`  | `string`                             | -                                                                   | Success message to show after confirmation  |
| `errorMessage`    | `string`                             | -                                                                   | Error message to show if confirmation fails |
| `showToast`       | `boolean`                            | `false`                                                             | Whether to show toast notifications         |

## Use Cases

### 1. Delete Confirmation

```tsx
<ConfirmationModal
  open={deleteModalOpen}
  onClose={() => setDeleteModalOpen(false)}
  onConfirm={handleDelete}
  loading={isDeleting}
  title="Delete Agent"
  description="Are you sure you want to delete this agent? This action cannot be undone."
  confirmText="Delete"
  confirmColor="danger"
  showToast={true}
  successMessage="Agent deleted successfully"
  errorMessage="Failed to delete agent. Please try again."
/>
```

### 2. Save Confirmation

```tsx
<ConfirmationModal
  open={saveModalOpen}
  onClose={() => setSaveModalOpen(false)}
  onConfirm={handleSave}
  title="Save Changes"
  description="Do you want to save your changes?"
  confirmText="Save"
  confirmColor="primary"
  showWarningIcon={false}
/>
```

### 3. Custom Action with JSX Description

```tsx
<ConfirmationModal
  open={customModalOpen}
  onClose={() => setCustomModalOpen(false)}
  onConfirm={handleCustomAction}
  title="Custom Action"
  description={
    <Box>
      <p>This action will:</p>
      <ul>
        <li>Update your profile</li>
        <li>Send notifications</li>
        <li>Log the activity</li>
      </ul>
    </Box>
  }
  confirmText="Proceed"
  confirmColor="neutral"
  maxWidth={500}
/>
```

## Toast Notifications

The component supports built-in toast notifications using Sonner:

```tsx
<ConfirmationModal
  open={showModal}
  onClose={() => setShowModal(false)}
  onConfirm={handleAction}
  showToast={true}
  successMessage="Action completed successfully!"
  errorMessage="Something went wrong. Please try again."
/>
```

**Features:**

- ✅ **Automatic success/error handling** - Shows toast based on promise resolution
- ✅ **Customizable messages** - Set your own success and error messages
- ✅ **Optional** - Disabled by default, enable with `showToast={true}`
- ✅ **Error propagation** - Re-throws errors so parent components can handle them

## Best Practices

1. **Always handle loading states** - Use the `loading` prop to prevent multiple submissions
2. **Provide clear descriptions** - Make it clear what the action will do
3. **Use appropriate colors** - Use `danger` for destructive actions, `primary` for important actions
4. **Keep titles concise** - Short, clear titles work best
5. **Handle errors gracefully** - Always wrap async operations in try-catch blocks
6. **Use toast notifications** - Enable `showToast` for better user feedback

## Accessibility

The component includes:

- Proper ARIA attributes (`role="alertdialog"`)
- Keyboard navigation support
- Focus management
- Screen reader friendly descriptions

## Styling

The component uses your theme's color palette and automatically adapts to light/dark modes. Custom styling can be applied through the `sx` prop on individual elements if needed.

## Migration from Custom Modals

If you have existing custom confirmation modals, you can easily migrate by:

1. Import the `ConfirmationModal` component
2. Replace your custom modal JSX with the component
3. Map your existing props to the new interface
4. Remove custom event handling (it's built-in)

This component provides a consistent, accessible, and maintainable solution for all confirmation dialogs in your application.
