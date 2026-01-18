"use client";

export type IconName = "plus" | "refresh" | "copy" | "download" | "trash" | "settings" | "search" | "menu";

export default function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    xmlns: "http://www.w3.org/2000/svg",
    className: "ico",
    "aria-hidden": true,
    focusable: false,
  } as const;

  switch (name) {
    case "plus":
      return (
        <svg {...common}>
          <path
            d="M12 5v14M5 12h14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "refresh":
      return (
        <svg {...common}>
          <path
            d="M20 12a8 8 0 0 1-14.7 4M4 12a8 8 0 0 1 14.7-4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M20 4v6h-6M4 20v-6h6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "copy":
      return (
        <svg {...common}>
          <path
            d="M8 8h10v12H8z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M6 16H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "download":
      return (
        <svg {...common}>
          <path
            d="M12 3v10"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M8 11l4 4 4-4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M5 21h14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "trash":
      return (
        <svg {...common}>
          <path
            d="M4 7h16"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M10 11v6M14 11v6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M6 7l1 14h10l1-14"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M9 7V4h6v3"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <path
            d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z"
            stroke="currentColor"
            strokeWidth="2"
          />
          <path
            d="M19.4 15a7.8 7.8 0 0 0 .1-6l-2 .7a6.2 6.2 0 0 0-1.1-1.1l.7-2a7.8 7.8 0 0 0-6-.1l.2 2.1a6.2 6.2 0 0 0-1.6.7L8 7.5a7.8 7.8 0 0 0-4.1 4.4l2 .7a6.2 6.2 0 0 0 0 1.6l-2 .7a7.8 7.8 0 0 0 4.1 4.4l1.7-1.4a6.2 6.2 0 0 0 1.6.7l-.2 2.1a7.8 7.8 0 0 0 6-.1l-.7-2a6.2 6.2 0 0 0 1.1-1.1l2 .7z"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <path
            d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M21 21l-4.35-4.35"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "menu":
      return (
        <svg {...common}>
          <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    default:
      return null;
  }
}
