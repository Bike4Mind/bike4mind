const GOOGLE_DRIVE_PICKER_STYLE_ID = 'b4m-google-drive-picker-styles';

/**
 * Inject the shared Google Picker stylesheet once per document. Lifts the picker's z-index to 1400 -
 * ABOVE the MUI wizard/dialog layer (1300) so it isn't opened hidden behind a modal - and tidies the
 * picker's file-type icons. Idempotent (keyed by a fixed id).
 *
 * Single source of truth for BOTH picker call sites (the session AttachFileButton and the data-lake
 * DriveConnectAction). They previously injected two different sheets that fought over the shared
 * `.picker-dialog-bg` selector with different z-index values, so the winner depended on which picker
 * the user opened first that session.
 */
export const ensureGoogleDrivePickerStyles = () => {
  if (typeof document === 'undefined') return;
  if (document.getElementById(GOOGLE_DRIVE_PICKER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = GOOGLE_DRIVE_PICKER_STYLE_ID;
  style.textContent = `
    .picker-dialog,
    .picker-dialog-bg,
    .google-picker-dialog {
      z-index: 1400 !important;
    }

    /* Improve file type icons */
    .picker-spr-generic-file,
    .picker-spr-unknown-file {
      background: #f1f3f4 !important;
      border-radius: 2px !important;
      position: relative !important;
    }

    /* Google Docs icon */
    .picker-spr-doc-icon {
      background: #4285f4 !important;
      border-radius: 2px !important;
    }

    /* Google Sheets icon */
    .picker-spr-spreadsheet-icon {
      background: #0f9d58 !important;
      border-radius: 2px !important;
    }

    /* PDF icon */
    .picker-spr-pdf-icon {
      background: #ea4335 !important;
      border-radius: 2px !important;
    }

    /* Fallback for missing thumbnails */
    .picker-photo-control-default {
      background: #f8f9fa !important;
      border: 1px solid #dadce0 !important;
      border-radius: 4px !important;
    }
  `;
  document.head.appendChild(style);
};
