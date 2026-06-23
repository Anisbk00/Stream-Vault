'use client';

/**
 * RetroShield — A 1920s Art Deco-inspired shield emblem.
 * Replaces the plain Lucide Shield with a vintage cinema shield
 * featuring chevron stripes and a heraldic silhouette.
 *
 * Props mirror standard SVG icon conventions (className, style, strokeWidth).
 */

interface RetroShieldProps {
  className?: string;
  style?: React.CSSProperties;
  strokeWidth?: number;
}

export default function RetroShield({
  className = '',
  style,
  strokeWidth = 1.2,
}: RetroShieldProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      style={style}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Outer shield shape — Art Deco heraldic silhouette */}
      <path
        d="M12 2L3 7V12C3 16.97 7.03 21.5 12 22.5C16.97 21.5 21 16.97 21 12V7L12 2Z"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
      />

      {/* Inner shield border — double-line Art Deco motif */}
      <path
        d="M12 4.5L5.5 8.2V12C5.5 15.8 8.4 19.3 12 20.2C15.6 19.3 18.5 15.8 18.5 12V8.2L12 4.5Z"
        stroke="currentColor"
        strokeWidth={strokeWidth * 0.6}
        strokeLinejoin="round"
        opacity="0.6"
      />

      {/* Chevron stripes — vintage cinema heraldry */}
      <path
        d="M12 8L8.5 12L12 16L15.5 12L12 8Z"
        stroke="currentColor"
        strokeWidth={strokeWidth * 0.8}
        strokeLinejoin="round"
      />

      {/* Center diamond — Art Deco focal point */}
      <path
        d="M12 10L10.5 12L12 14L13.5 12L12 10Z"
        fill="currentColor"
        opacity="0.9"
      />
    </svg>
  );
}
