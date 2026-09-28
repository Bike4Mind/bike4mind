import { FC } from 'react';
import { premiumReplyAccessories } from '@client/app/premium-generated/premiumReplyAccessories.generated';

interface ReplyAccessoriesProps {
  questId?: string;
  sessionId?: string;
}

/** Premium overlay contributions at the foot of a completed reply (see PremiumReplyAccessory). */
const ReplyAccessories: FC<ReplyAccessoriesProps> = ({ questId, sessionId }) => {
  if (!questId || !sessionId || premiumReplyAccessories.length === 0) return null;
  return (
    <>
      {premiumReplyAccessories.map((Accessory, i) => (
        <Accessory key={i} questId={questId} sessionId={sessionId} />
      ))}
    </>
  );
};

export default ReplyAccessories;
