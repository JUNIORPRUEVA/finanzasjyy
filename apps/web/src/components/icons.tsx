import type { SVGProps } from 'react';

/**
 * ICONOGRAFÍA DE FINANZA
 * ----------------------
 * Iconos dibujados a mano en SVG, con el mismo trazo (1.6), el mismo tamaño de
 * rejilla (24) y las mismas terminaciones. Así toda la aplicación se ve
 * coherente sin arrastrar una librería de iconos entera.
 *
 * Todos heredan el color del texto (`currentColor`) y el tamaño por `size`.
 */

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
}

function Icon({ size = 24, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const IconHome = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 10.5 12 4l8 6.5" />
    <path d="M6 10.5V19h12v-8.5" />
    <path d="M10 19v-5h4v5" />
  </Icon>
);

export const IconList = (props: IconProps) => (
  <Icon {...props}>
    <path d="M8 6h12M8 12h12M8 18h12" />
    <circle cx="4" cy="6" r="1" />
    <circle cx="4" cy="12" r="1" />
    <circle cx="4" cy="18" r="1" />
  </Icon>
);

export const IconPlus = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const IconTarget = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="8" />
    <circle cx="12" cy="12" r="3.5" />
  </Icon>
);

export const IconMenu = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Icon>
);

export const IconWallet = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="6" width="18" height="12" rx="3" />
    <path d="M16 12h2" />
    <path d="M3 10h18" />
  </Icon>
);

export const IconTransfer = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8h13l-3-3" />
    <path d="M20 16H7l3 3" />
  </Icon>
);

export const IconDebt = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4v16" />
    <path d="M8 7h6a3 3 0 0 1 0 6h-4a3 3 0 0 0 0 6h6" />
  </Icon>
);

export const IconCalendar = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3.5" y="5" width="17" height="15" rx="3" />
    <path d="M8 3v4M16 3v4M3.5 10h17" />
  </Icon>
);

export const IconChart = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 20h16" />
    <path d="M7 20V11M12 20V6M17 20v-6" />
  </Icon>
);

export const IconBell = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5" />
    <path d="M4 16h16" />
    <path d="M10 19a2 2 0 0 0 4 0" />
  </Icon>
);

export const IconSettings = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2.5M12 18.5V21M4.5 12H7M17 12h2.5M6.4 6.4l1.8 1.8M15.8 15.8l1.8 1.8M17.6 6.4l-1.8 1.8M8.2 15.8l-1.8 1.8" />
  </Icon>
);

export const IconCamera = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 8.5A2 2 0 0 1 6 6.5h1.5l1.2-2h6.6l1.2 2H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    <circle cx="12" cy="13" r="3.5" />
  </Icon>
);

export const IconLock = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8.5 10.5V8a3.5 3.5 0 1 1 7 0v2.5" />
  </Icon>
);

export const IconEye = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const IconEyeOff = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4l16 16" />
    <path d="M9.9 5.1A9.9 9.9 0 0 1 12 5c6 0 9.5 5.5 9.5 5.5a17 17 0 0 1-2.6 3.2" />
    <path d="M6.2 7.3A16.6 16.6 0 0 0 2.5 10.5S6 16 12 16a9.6 9.6 0 0 0 3.6-.7" />
    <path d="M10 10.2a2.5 2.5 0 0 0 3.5 3.5" />
  </Icon>
);

export const IconCheck = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 12.5 10 17.5 19 7" />
  </Icon>
);

export const IconAlert = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 4.5 21 19H3z" />
    <path d="M12 10v4" />
    <circle cx="12" cy="16.6" r="0.9" fill="currentColor" stroke="none" />
  </Icon>
);

export const IconChevronRight = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 5l7 7-7 7" />
  </Icon>
);

export const IconChevronDown = (props: IconProps) => (
  <Icon {...props}>
    <path d="M5 9l7 7 7-7" />
  </Icon>
);

export const IconClose = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Icon>
);

export const IconArrowDown = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="M6 13l6 6 6-6" />
  </Icon>
);

export const IconArrowUp = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 19V5" />
    <path d="M6 11l6-6 6 6" />
  </Icon>
);

export const IconRefresh = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
    <path d="M20 4v4h-4" />
    <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
    <path d="M4 20v-4h4" />
  </Icon>
);

export const IconWifiOff = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 3l18 18" />
    <path d="M8.5 15.5a5 5 0 0 1 6 0" />
    <path d="M5 12a10 10 0 0 1 3-1.9" />
    <path d="M15.5 10.5A10 10 0 0 1 19 12" />
    <path d="M12 19h.01" />
  </Icon>
);

export const IconBuilding = (props: IconProps) => (
  <Icon {...props}>
    <rect x="4" y="4" width="10" height="16" rx="2" />
    <path d="M14 9h4a2 2 0 0 1 2 2v9" />
    <path d="M7 8h4M7 12h4M7 16h4" />
  </Icon>
);

export const IconFile = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7 3.5h6l5 5V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20V5A1.5 1.5 0 0 1 7.5 3.5z" />
    <path d="M13 3.5V9h5" />
  </Icon>
);

export const IconLogout = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 5H7.5A1.5 1.5 0 0 0 6 6.5v11A1.5 1.5 0 0 0 7.5 19H15" />
    <path d="M12 12h9" />
    <path d="M18 9l3 3-3 3" />
  </Icon>
);

/** Bolsa de la compra: identifica el módulo de compras personales. */
export const IconBag = (props: IconProps) => (
  <Icon {...props}>
    <path d="M6 8h12l1 11.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 19.5z" />
    <path d="M9 8V6.5a3 3 0 0 1 6 0V8" />
  </Icon>
);

export const IconSearch = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="M16 16l4.5 4.5" />
  </Icon>
);

export const IconChevronLeft = (props: IconProps) => (
  <Icon {...props}>
    <path d="M14.5 5.5L8 12l6.5 6.5" />
  </Icon>
);

/** Compartir: la flecha que sale de una caja (el gesto de «enviar a»). */
export const IconShare = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 15V4" />
    <path d="M8.5 7.5L12 4l3.5 3.5" />
    <path d="M6 12v6.5A1.5 1.5 0 0 0 7.5 20h9a1.5 1.5 0 0 0 1.5-1.5V12" />
  </Icon>
);

