import { useId } from "react";

/**
 * The Shipfig mark: a fig carrying a sailboat (ship + fig).
 * Kept in sync with app/icon.svg, which the favicon files are rendered from.
 */
export function LogoMark({ className = "h-5 w-5", title }: { className?: string; title?: string }) {
  const gradient = `shipfig-bg-${useId().replace(/:/g, "")}`;
  return (
    <svg viewBox="0 0 32 32" className={className} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <defs>
        <linearGradient id={gradient} x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#9d3d78" />
          <stop offset="1" stopColor="#4a1747" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${gradient})`} />
      <path d="M19.2 6.4c1.9-1.9 4.6-2 5.6-1.6.3 1-.1 3.6-2.1 5.2-1.4 1.1-3 1.2-4.1 1-.2-1.2.2-3.1.6-4.6Z" fill="#86efac" />
      <path d="M16 8.2c1.6 2.2 8.6 5.3 8.6 12.1 0 4.5-3.8 7.4-8.6 7.4s-8.6-2.9-8.6-7.4c0-6.8 7-9.9 8.6-12.1Z" fill="#fff" />
      <path d="M16 8.6V5.2" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M16.7 13.2v7.4h4.5Z" fill="#6b2160" />
      <path d="M15.3 14.9v5.7h-3.6Z" fill="#6b2160" />
      <path d="M10.6 21.9h10.8l-1.6 2.5a1 1 0 0 1-.8.4h-6a1 1 0 0 1-.8-.4Z" fill="#6b2160" />
    </svg>
  );
}
