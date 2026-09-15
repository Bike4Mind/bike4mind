/**
 * Get current date and time in a user-friendly format
 * @param timezone IANA timezone identifier (defaults to user's local timezone)
 * @param format Format type for the output
 * @returns Formatted date/time string
 */
export const getCurrentDateTime = (timezone?: string, format: 'short' | 'medium' | 'long' = 'medium'): string => {
  const now = new Date();

  // If no timezone specified, use the browser's timezone
  const timeZone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  const formatOptions: Intl.DateTimeFormatOptions = {
    timeZone,
    ...(format === 'short' && {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    ...(format === 'medium' && {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }),
    ...(format === 'long' && {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }),
  };

  try {
    return new Intl.DateTimeFormat('en-US', formatOptions).format(now);
  } catch (error) {
    // Fallback to basic format if timezone is invalid
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(now);
  }
};

/**
 * Get just the current time in a compact format
 */
export const getCurrentTime = (timezone?: string): string => {
  const now = new Date();
  const timeZone = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;

  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(now);
  } catch (error) {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
    }).format(now);
  }
};
