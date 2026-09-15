import { FC, SVGAttributes } from 'react';

const SouthKoreaFlag: FC<SVGAttributes<SVGSVGElement>> = props => {
  return (
    <svg {...props} viewBox="0 0 22 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <g clipPath="url(#clip0_2_547)">
        <rect width="22" height="16" rx="2" fill="white" />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M14.6666 8.00002C14.6666 10.0619 13.025 11.7334 11 11.7334C8.97493 11.7334 7.33331 10.0619 7.33331 8.00002C7.33331 6.80536 9.79522 6.30402 11.8674 6.49282C12.0874 6.43309 12.3242 6.40002 12.5714 6.40002C13.729 6.40002 14.6666 7.11682 14.6666 8.00002Z"
          fill="#232C80"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M10.4762 7.46666C10.4762 7.46666 11.4138 6.4 12.5714 6.4C13.729 6.4 14.6666 7.1168 14.6666 8C14.6666 5.93813 13.025 4.26666 11 4.26666C9.53646 4.26666 8.27303 5.1392 7.68531 6.40213C7.33331 7.46666 7.33331 7.77813 7.33331 8C7.85712 8.53333 8.4396 8.53333 8.90474 8.53333C9.36988 8.53333 9.78788 8.32746 10.076 8L10.4762 7.46666Z"
          fill="#F93939"
        />
        <path
          fillRule="evenodd"
          clipRule="evenodd"
          d="M15.7143 5.33335H17.8095L15.7143 3.20001H14.6667L15.7143 5.33335ZM6.28573 5.33335H4.19049L6.28573 3.20001H7.33335L6.28573 5.33335ZM15.7143 10.6667H17.8095L15.7143 12.8H14.6667L15.7143 10.6667ZM6.28573 10.6667H4.19049L6.28573 12.8H7.33335L6.28573 10.6667Z"
          fill="#151515"
        />
      </g>
      <defs>
        <clipPath id="clip0_2_547">
          <rect width="22" height="16" fill="white" />
        </clipPath>
      </defs>
    </svg>
  );
};
export default SouthKoreaFlag;
