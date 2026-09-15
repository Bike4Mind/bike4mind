import { settingsMap } from '@bike4mind/common';

// MaxFileSize's own definition always sets defaultValue; makeNumberSetting's shared param type
// widens it to number|undefined for settings that omit one.
export const MAX_FILE_SIZE_DEFAULT_MB = settingsMap.MaxFileSize.defaultValue!;
