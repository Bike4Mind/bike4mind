import { auth as googleAuth, calendar as calendarApi } from '@googleapis/calendar';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import isBetween from 'dayjs/plugin/isBetween';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import { getSettingsMap, getSettingsValue } from '@bike4mind/utils';
import { adminSettingsRepository } from '@bike4mind/database';
import { BadGatewayError, ServiceUnavailableError } from '@bike4mind/server-utils/utils/errors';

const scopes = ['https://www.googleapis.com/auth/calendar'];

const getCalendarConfig = async () => {
  const settings = await getSettingsMap({ adminSettings: adminSettingsRepository });
  const serviceAccountEmail = getSettingsValue('googleCalendarServiceAccountEmail', settings);
  const serviceAccountKey = getSettingsValue('googleCalendarServiceAccountSecret', settings);
  const organizerEmail = getSettingsValue('googleCalendarOrganizerEmail', settings);

  if (!serviceAccountEmail || !serviceAccountKey || !organizerEmail) {
    throw new ServiceUnavailableError('Google Calendar is not configured');
  }
  return { serviceAccountEmail, serviceAccountKey, organizerEmail };
};

// The organizer's primary calendar id is their email address.
export const calendarClient = async () => {
  const { serviceAccountEmail, serviceAccountKey, organizerEmail } = await getCalendarConfig();

  const authClient = new googleAuth.JWT({
    email: serviceAccountEmail,
    key: Buffer.from(serviceAccountKey, 'base64').toString('utf-8'),
    scopes,
    subject: organizerEmail,
  });

  return { client: calendarApi({ version: 'v3', auth: authClient }), calendarId: organizerEmail };
};

// Google's status and message must not reach the caller: a delegation fault is a 401 that the SPA
// would read as an expired session, and a 4xx is logged at warn so it never alarms.
const callGoogle = async <T>(call: () => Promise<T>): Promise<T> => {
  try {
    return await call();
  } catch (error) {
    console.error('Google Calendar request failed', error);
    throw new BadGatewayError('Google Calendar request failed');
  }
};

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(isBetween);
dayjs.extend(weekOfYear);

export const isValidTimeZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

export async function getAvailableTimeSlots(year: number, week: number, timeZone: string) {
  const currentDate = dayjs().year(year);

  const startOfWeek = currentDate.week(week).startOf('week').add(1, 'day'); // Monday

  const endOfWeek = startOfWeek.add(6, 'days').endOf('day'); // Sunday

  const { client, calendarId } = await calendarClient();

  const res = await callGoogle(() =>
    client.freebusy.query({
      requestBody: {
        timeMin: startOfWeek.toISOString(),
        timeMax: endOfWeek.toISOString(),
        timeZone,
        items: [{ id: calendarId }],
      },
    })
  );

  const busyTimes = res.data.calendars?.[calendarId]?.busy ?? [];
  console.log('Gooogle Calendar: busyTimes', busyTimes);

  const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const isBusy = (time: dayjs.Dayjs) => {
    return busyTimes.some(period => {
      const start = dayjs(period.start);
      const end = dayjs(period.end);
      return time.isBetween(start, end, null, '[)');
    });
  };

  const generateTimeSlots = (day: dayjs.Dayjs) => {
    const slots = [];
    const start = day.startOf('day').hour(8); // 8 AM
    const end = day.endOf('day').hour(17); // 5 PM

    let time = start;
    while (time.isBefore(end)) {
      if (!isBusy(time)) {
        slots.push({
          value: time.tz(timeZone).format('YYYY-MM-DD HH:mm:ss'),
          label: time.tz(timeZone).format('h:mma'),
        });
      }
      time = time.add(1, 'hours');
    }
    return slots;
  };

  const availableSlots = [];
  for (let i = 0; i < 7; i++) {
    const currentDay = startOfWeek.add(i, 'days');
    const dayName = daysOfWeek[currentDay.day()];
    const slots = generateTimeSlots(currentDay);

    availableSlots.push({
      day: dayName,
      date: currentDay.date(),
      isToday: currentDay.isSame(currentDate, 'day'),
      monthInfo: currentDay.format('MMM YYYY'),
      slots,
    });
  }

  return availableSlots;
}

export async function createEvent({
  summary,
  description,
  date,
  timeZone,
  attendees,
}: {
  summary: string;
  description: string;
  date: string; // date in format 'YYYY-MM-DD HH:mm:ss'
  timeZone: string; // e.g., 'Asia/Manila'
  attendees: { email: string }[];
}) {
  const startDateTime = dayjs.tz(date, timeZone).format(); // ISO format with timezone offset
  const endDateTime = dayjs.tz(date, timeZone).add(1, 'hour').format();
  const { client, calendarId } = await calendarClient();

  const res = await callGoogle(() =>
    client.events.insert({
      calendarId,
      requestBody: {
        summary,
        description,
        start: {
          dateTime: startDateTime,
          timeZone,
        },
        attendees,
        end: {
          dateTime: endDateTime,
          timeZone,
        },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 10 },
          ],
        },
      },
      sendUpdates: 'all',
    })
  );

  return res;
}
