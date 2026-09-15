import React from 'react';
import ConfigurableBanner from '@client/app/components/Session/List/ConfigurableBanner';
import { IModal } from '@bike4mind/common';

interface BannerProps {
  banner: IModal;
  onClose: (bannerId: string) => void;
}

const Banner: React.FC<BannerProps> = ({ banner, onClose }) => (
  <ConfigurableBanner
    key={banner._id}
    bannerId={banner._id}
    isEnabled={banner.enabled}
    startDateTime={banner.startDate || ''}
    endDateTime={banner.endDate || ''}
    imageUrl={banner.imageUrl ?? undefined}
    textMessage={banner.textMessage ?? undefined}
    onClose={() => banner._id && onClose(banner._id)}
  />
);

export default React.memo(Banner);
