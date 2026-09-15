export interface ActivityConfig<T> {
  key: string;
  icon: T;
  message: string;
}

export type ActivityConfigMap<T> = Record<string, ActivityConfig<T>>;
// Usage example:
/*
const message = formatActivityMessage(
  ActivityType.FRIEND_REQUESTED,
  {
    performer: "John",
    receiver: "Jane"
  }
); // Returns: "John sent a friend request to Jane"

const ProjectMessage = formatActivityMessage(
  ActivityType.PROJECT_JOINED,
  {
    performer: "John",
    projectName: "Amazing Project"
  }
); // Returns: "John joined Amazing Project"
*/
export const formatActivityMessage = <T>(activityConfig: ActivityConfig<T>, data: Record<string, string>): string => {
  let message = activityConfig.message;

  // Replace all placeholders in the message with actual values
  Object.entries(data).forEach(([key, value]) => {
    message = message.replace(`{${key}}`, value);
  });

  return message;
};
