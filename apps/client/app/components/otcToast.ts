import { toast } from 'sonner';

const OTC_SENT_TOAST_ID = 'otc-code-sent';

/** Shows the "code sent" toast under a fixed id so it can be dismissed once the code is verified. */
export function toastOtcCodeSent(message: string): void {
  toast.success(message, { id: OTC_SENT_TOAST_ID });
}

/** Clears the "code sent" toast so it does not linger over the post-login screens. */
export function dismissOtcCodeSentToast(): void {
  toast.dismiss(OTC_SENT_TOAST_ID);
}
