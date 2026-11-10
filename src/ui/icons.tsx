import type { ReactNode } from 'react';
import type { ModeId } from '../core/modes';

/** Decorative stroke icons; the button or label next to each one carries the name. */
function Icon({ children, size = 24 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

const MODE_PATHS: Record<ModeId, ReactNode> = {
  chat: <path d="M5 5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-5 4v-4H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M20 20l-4.5-4.5" />
    </>
  ),
  math: <path d="M5 7h6M8 4v6M14 7h5M5 17h6M14 15h5M14 19h5" />,
  draw: (
    <>
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4 16l5-4 4 3 3-2 4 3" />
    </>
  ),
};

export function ModeIcon({ mode, size }: { mode: ModeId; size?: number }) {
  return <Icon size={size}>{MODE_PATHS[mode]}</Icon>;
}
