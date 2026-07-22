import { toast } from 'sonner';

/** Clipboard write with the standard toast feedback both embed surfaces use. */
export async function copyTextWithToast(text: string, successMessage = 'Copied to clipboard!'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(successMessage);
  } catch {
    toast.error("Couldn't copy - select the code manually");
  }
}
