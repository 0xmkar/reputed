import type { SVGProps } from 'react';

function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="1em"
      height="1em"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ShieldIcon = () => (
  <Icon>
    <path d="M12 3l8 3v6c0 4.5-3.2 8-8 9-4.8-1-8-4.5-8-9V6z" />
    <path d="M9 12l2 2 4-4" />
  </Icon>
);
export const CheckIcon = () => (
  <Icon>
    <path d="M5 12l5 5 9-10" />
  </Icon>
);
export const CrossIcon = () => (
  <Icon>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);
export const LockIcon = () => (
  <Icon>
    <rect x="5" y="11" width="14" height="9" rx="2" />
    <path d="M8 11V8a4 4 0 018 0v3" />
  </Icon>
);
export const CopyIcon = () => (
  <Icon>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 012-2h9" />
  </Icon>
);
export const ExternalIcon = () => (
  <Icon>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" />
  </Icon>
);
export const ArrowUpRightIcon = () => (
  <Icon>
    <path d="M7 17L17 7M9 7h8v8" />
  </Icon>
);
export const FingerprintIcon = () => (
  <Icon>
    <path d="M12 10a2 2 0 00-2 2c0 2.5-.4 4.6-1.2 6.4" />
    <path d="M14 13.1c0 2.3-.3 4.3-1 6.1" />
    <path d="M8.2 20A12 12 0 009 12a3 3 0 016 0c0 1.1 0 2.1-.1 3" />
    <path d="M5.3 17.5A16 16 0 006 12a6 6 0 0112 0" />
    <path d="M4.6 9A8 8 0 0119.4 9" />
  </Icon>
);
export const KeyIcon = () => (
  <Icon>
    <circle cx="8" cy="15" r="4" />
    <path d="M10.9 12.1L20 3M16 7l2 2M13 10l2 2" />
  </Icon>
);
export const StarIcon = () => (
  <Icon>
    <path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z" />
  </Icon>
);
/** The Reputed mark: a ring with a check, the score ring in miniature. */
export const Logo = () => (
  <Icon strokeWidth="2.4">
    <circle cx="12" cy="12" r="8.5" />
    <path d="M8.5 12.2l2.3 2.3 4.7-5" />
  </Icon>
);
