"use client";

// ====================================================================
// Nexus Gate Logo — matches the favicon (icon-192.svg)
// Shield with QR code pattern inside, rendered in the primary color.
// ====================================================================

interface Props {
  size?: number;
  className?: string;
}

export function NexusLogo({ size = 40, className = "" }: Props) {
  return (
    <div
      className={`grid place-items-center rounded-lg bg-primary text-primary-foreground ng-glow ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        viewBox="0 0 192 192"
        style={{ width: size * 0.6, height: size * 0.6 }}
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M96 32 L152 52 V96 C152 128 128 152 96 160 C64 152 40 128 40 96 V52 Z" />
        <rect x="72" y="72" width="14" height="14" fill="currentColor" stroke="none" />
        <rect x="106" y="72" width="14" height="14" fill="currentColor" stroke="none" />
        <rect x="72" y="106" width="14" height="14" fill="currentColor" stroke="none" />
        <rect x="106" y="106" width="14" height="14" fill="currentColor" stroke="none" />
      </svg>
    </div>
  );
}
