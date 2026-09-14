import React from 'react';

interface YinYangMicIconProps {
  className?: string;
  size?: number | string;
}

export const YinYangMicIcon: React.FC<YinYangMicIconProps> = ({
  className = "w-24 h-24",
  size
}) => {
  return (
    <svg
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      style={size ? { width: size, height: size } : undefined}
      role="img"
      aria-label="Yin Yang Microphone"
    >
      {/* Outer subtle shadow / ambient ring */}
      <circle cx="256" cy="256" r="248" fill="#0A0B0E" />

      {/* Main Base Disc - White (Yang) */}
      <circle cx="256" cy="256" r="236" fill="#F6F5F0" />

      {/* Black (Yin) Half with S-Curve */}
      {/*
        Outer left arc from (256, 20) to (256, 492) [R = 236]
        Bottom bulb cutout from (256, 492) to (256, 256) [r = 118]
        Top bulb black section from (256, 256) to (256, 20) [r = 118]
      */}
      <path
        d="M 256 20
           A 236 236 0 0 0 256 492
           A 118 118 0 0 0 256 256
           A 118 118 0 0 1 256 20
           Z"
        fill="#0D0F13"
      />

      {/* Thin Outer Ring border matching the user's design */}
      <circle
        cx="256"
        cy="256"
        r="236"
        fill="none"
        stroke="#F6F5F0"
        strokeWidth="10"
      />

      {/* ============================================================ */}
      {/* TOP MICROPHONE (Inside Black Bulb, Off-White / Cream Stroke) */}
      {/* Center at (256, 138) */}
      {/* ============================================================ */}
      <g id="top-mic">
        {/* Capsule pill */}
        <rect
          x="238"
          y="98"
          width="36"
          height="64"
          rx="18"
          ry="18"
          fill="#0D0F13"
          stroke="#F6F5F0"
          strokeWidth="8.5"
          strokeLinejoin="round"
        />

        {/* U-cradle around pill */}
        <path
          d="M 226 128
             V 144
             A 30 30 0 0 0 286 144
             V 128"
          fill="none"
          stroke="#F6F5F0"
          strokeWidth="8.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Stem down from bottom of U-cradle */}
        <line
          x1="256"
          y1="174"
          x2="256"
          y2="198"
          stroke="#F6F5F0"
          strokeWidth="8.5"
          strokeLinecap="round"
        />

        {/* Base horizontal bar */}
        <line
          x1="234"
          y1="198"
          x2="278"
          y2="198"
          stroke="#F6F5F0"
          strokeWidth="8.5"
          strokeLinecap="round"
        />
      </g>

      {/* ============================================================ */}
      {/* BOTTOM MICROPHONE (Inside White Bulb, Black Stroke)          */}
      {/* Center at (256, 374) */}
      {/* ============================================================ */}
      <g id="bottom-mic">
        {/* Capsule pill */}
        <rect
          x="238"
          y="334"
          width="36"
          height="64"
          rx="18"
          ry="18"
          fill="#F6F5F0"
          stroke="#0D0F13"
          strokeWidth="8.5"
          strokeLinejoin="round"
        />

        {/* U-cradle around pill */}
        <path
          d="M 226 364
             V 380
             A 30 30 0 0 0 286 380
             V 364"
          fill="none"
          stroke="#0D0F13"
          strokeWidth="8.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Stem down from bottom of U-cradle */}
        <line
          x1="256"
          y1="410"
          x2="256"
          y2="434"
          stroke="#0D0F13"
          strokeWidth="8.5"
          strokeLinecap="round"
        />

        {/* Base horizontal bar */}
        <line
          x1="234"
          y1="434"
          x2="278"
          y2="434"
          stroke="#0D0F13"
          strokeWidth="8.5"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
};

export default YinYangMicIcon;
