export type OfficeRoom = 'reception' | 'desks' | 'michael-door' | 'break-room' | 'conference-room';

export interface OfficeRoomDefinition {
  id: OfficeRoom;
  label: string;
}

export const OFFICE_ROOMS: readonly OfficeRoomDefinition[] = [
  { id: 'reception', label: 'Reception' },
  { id: 'desks', label: 'Main office' },
  { id: 'michael-door', label: "Outside Michael's office" },
  { id: 'break-room', label: 'Break room' },
  { id: 'conference-room', label: 'Conference room' },
];
