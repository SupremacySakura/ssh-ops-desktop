import type { ReactNode } from 'react';

export type IconName =
  | 'activity'
  | 'agent'
  | 'alert'
  | 'bell'
  | 'box'
  | 'chevron-down'
  | 'close'
  | 'collapse'
  | 'dashboard'
  | 'docker'
  | 'file'
  | 'help'
  | 'history'
  | 'nginx'
  | 'project'
  | 'search'
  | 'server'
  | 'settings'
  | 'terminal'
  | 'user'
  | 'sun'
  | 'moon'
  | 'chevron-right'
  | 'chevron-left'
  | 'plus'
  | 'check'
  | 'upload'
  | 'download'
  | 'trash'
  | 'edit'
  | 'play'
  | 'stop'
  | 'copy'
  | 'refresh'
  | 'send'
  | 'log-out'
  | 'info'
  | 'expand';

const PATHS: Record<IconName, ReactNode> = {
  activity: <><path d="M3 12h4l2-6 4 12 2-6h6" /></>,
  agent: <><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><circle cx="12" cy="12" r="4" /></>,
  alert: <><path d="M12 3 2.8 20h18.4L12 3Z" /><path d="M12 9v4M12 17h.01" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0v5l2 3H4l2-3V9Z" /><path d="M10 20h4" /></>,
  box: <><path d="m4 7 8-4 8 4-8 4-8-4Z" /><path d="M4 7v10l8 4 8-4V7M12 11v10" /></>,
  'chevron-down': <path d="m7 10 5 5 5-5" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  collapse: <path d="m14 7-5 5 5 5" />,
  dashboard: <><rect height="7" rx="1" width="7" x="3" y="3" /><rect height="7" rx="1" width="7" x="14" y="3" /><rect height="7" rx="1" width="7" x="3" y="14" /><rect height="7" rx="1" width="7" x="14" y="14" /></>,
  docker: <><path d="M3.5 16.5h14c2 0 3.5-1 4-2.5" /><rect height="3" rx="0.6" width="3" x="5" y="12" /><rect height="3" rx="0.6" width="3" x="9" y="12" /><rect height="3" rx="0.6" width="3" x="13" y="12" /><rect height="3" rx="0.6" width="3" x="9" y="8" /><rect height="3" rx="0.6" width="3" x="13" y="8" /></>,
  file: <><path d="M5 3h9l5 5v13H5V3Z" /><path d="M14 3v5h5" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 1 1 3.2 2.4c-.7.3-.7.8-.7 1.6M12 17h.01" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  nginx: <><path d="m12 2 8.7 5v10L12 22l-8.7-5V7L12 2Z" /><path d="M8 16V8l8 8V8" /></>,
  project: <><path d="M3 6h7l2 2h9v11H3V6Z" /><path d="M3 10h18" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="m16 16 5 5" /></>,
  server: <><rect height="6" rx="2" width="18" x="3" y="4" /><rect height="6" rx="2" width="18" x="3" y="14" /><path d="M7 7h.01M7 17h.01" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2" /></>,
  terminal: <><rect height="16" rx="2" width="18" x="3" y="4" /><path d="m7 9 3 3-3 3M12 16h5" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>,
  sun: <><circle cx="12" cy="12" r="5" /><path d="M12 1v3M12 20v3M1 12h3M20 12h3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M19.8 4.2l-2.1 2.1M6.3 17.7l-2.1 2.1" /></>,
  moon: <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />,
  'chevron-right': <path d="m9 7 5 5-5 5" />,
  'chevron-left': <path d="m15 7-5 5 5 5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  check: <path d="m5 12 5 5 9-10" />,
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 20h16" /></>,
  download: <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 20h16" /></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" /></>,
  edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" /><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z" /></>,
  play: <path d="M6 4v16l14-8L6 4Z" />,
  stop: <rect height="14" rx="1" width="14" x="5" y="5" />,
  copy: <><rect height="13" rx="1" width="13" x="9" y="9" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></>,
  send: <><path d="M22 2 11 13" /><path d="M22 2 15 22 11 13 2 9l20-7Z" /></>,
  'log-out': <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5" /><path d="M21 12H9" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  expand: <><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></>,
};

export function Icon({ className, name, size = 18 }: {
  className?: string;
  name: IconName;
  size?: number;
}) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {PATHS[name]}
    </svg>
  );
}
