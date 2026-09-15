import { FC, SVGAttributes } from 'react';

const JapanFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="22" height="16" rx="2" fill="white" />
      <path
        d="M11 11.7333C13.025 11.7333 14.6666 10.0619 14.6666 8C14.6666 5.93813 13.025 4.26666 11 4.26666C8.97494 4.26666 7.33331 5.93813 7.33331 8C7.33331 10.0619 8.97494 11.7333 11 11.7333Z"
        fill="#F93939"
      />
    </svg>
  );
};
export default JapanFlag;
