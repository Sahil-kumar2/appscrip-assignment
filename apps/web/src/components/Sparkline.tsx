import React, { useId } from 'react';

interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fillOpacity?: number;
  className?: string;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data = [],
  width = 72,
  height = 24,
  color = 'var(--brand)',
  fillOpacity = 0.12,
  className = '',
}) => {
  const gradientId = useId();

  if (!data || data.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={`shrink-0 overflow-visible ${className}`}
        aria-hidden="true"
      >
        <line
          x1={2}
          y1={height / 2}
          x2={width - 2}
          y2={height / 2}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="2 3"
          opacity={0.4}
        />
      </svg>
    );
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min === 0 ? 1 : max - min;
  const paddingY = 3;
  const usableHeight = height - paddingY * 2;

  const points = data.map((val, idx) => {
    const x = 2 + (idx / (data.length - 1)) * (width - 4);
    const y = height - paddingY - ((val - min) / range) * usableHeight;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const pathD = `M ${points.join(' L ')}`;
  const fillD = `${pathD} L ${width - 2},${height} L 2,${height} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`shrink-0 overflow-visible ${className}`}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={fillD} fill={`url(#${gradientId})`} />
      <path
        d={pathD}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Last value dot */}
      {points.length > 0 && (
        <circle
          cx={Number(points[points.length - 1].split(',')[0])}
          cy={Number(points[points.length - 1].split(',')[1])}
          r={2}
          fill={color}
        />
      )}
    </svg>
  );
};
