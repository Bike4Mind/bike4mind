import { api } from '@client/app/contexts/ApiContext';
import { useMutation, useQuery } from '@tanstack/react-query';

export function useGetAvailableSlots(calendarId: string, year: number, weekNumber: number, timeZone: string) {
  return useQuery({
    queryKey: ['google-calendar', `google-calendar-${calendarId}-${year}-${weekNumber}-${timeZone}`],
    queryFn: async () => {
      const response = await api.get('/api/google-calendar/available', {
        params: { calendarId, year, weekNumber, timeZone },
      });
      return response.data;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
    placeholderData: prev => prev,
    enabled: !!(calendarId && weekNumber && timeZone),
  });
}

interface ICreateCalendarEvent {
  objective: string;
  calendarId: string;
  date: string;
  timeZone: string;
  attendees: { email: string }[];
}

interface GoogleCalendarEventInput {
  summary: string;
  description?: string;
  location?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: { email: string }[];
}

export function useCreateCalendarEvent() {
  return useMutation({
    mutationFn: async (params: ICreateCalendarEvent) => {
      const response = await api.post('/api/google-calendar/create-event', params);
      return response.data;
    },
  });
}

export const fetchEventsFromGoogleCalendar = async (range?: { max: Date; min: Date }) => {
  try {
    const response = await api.get('/api/integration/google-calendar/events', { params: range });
    return response.data;
  } catch (error) {
    console.error('Error fetching Google Calendar events:', error);
    return { events: [] };
  }
};

export const addEventToGoogleCalendar = async (event: GoogleCalendarEventInput) => {
  try {
    const response = await api.post('/api/integration/google-calendar/events', { event });
    return response.data;
  } catch (error) {
    console.error('Error adding event to Google Calendar:', error);
    throw error;
  }
};
