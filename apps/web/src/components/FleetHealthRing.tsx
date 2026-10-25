import React from 'react';
import { CheckCircle2, AlertTriangle, ShieldAlert } from 'lucide-react';

interface FleetHealthRingProps {
  total: number;
  online: number;
  stale: number;
  offline: number;
}

export const FleetHealthRing: React.FC<FleetHealthRingProps> = ({
  total,
  online,
  stale,
  offline,
}) => {
  const size = 150;
  const strokeWidth = 14;
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  const validTotal = Math.max(1, total);
  const healthPercent = Math.round((online / validTotal) * 100);

  // Segment proportions
  const onlineFraction = online / validTotal;
  const staleFraction = stale / validTotal;
  const offlineFraction = offline / validTotal;

  const onlineDash = onlineFraction * circumference;
  const staleDash = staleFraction * circumference;
  const offlineDash = offlineFraction * circumference;

  const onlineOffset = 0;
  const staleOffset = -onlineDash;
  const offlineOffset = -(onlineDash + staleDash);

  const getStatusLabel = () => {
    if (offline > 0) return { label: 'DEGRADED', color: 'text-[var(--critical)]' };
    if (stale > 0) return { label: 'WARNING', color: 'text-[var(--stale)]' };
    return { label: 'NOMINAL', color: 'text-[var(--healthy)]' };
  };

  const status = getStatusLabel();

  return (
    <div className="flex flex-col sm:flex-row items-center gap-6 p-4">
      {/* SVG Ring */}
      <div className="relative shrink-0 flex items-center justify-center">
        <svg width={size} height={size} className="transform -rotate-90">
          {/* Base track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="transparent"
            stroke="var(--hairline)"
            strokeWidth={strokeWidth}
          />

          {/* Online Segment (Teal) */}
          {online > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="var(--healthy)"
              strokeWidth={strokeWidth}
              strokeDasharray={`${onlineDash} ${circumference - onlineDash}`}
              strokeDashoffset={onlineOffset}
              strokeLinecap="round"
              className="transition-all duration-500"
            />
          )}

          {/* Stale Segment (Amber) */}
          {stale > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="var(--stale)"
              strokeWidth={strokeWidth}
              strokeDasharray={`${staleDash} ${circumference - staleDash}`}
              strokeDashoffset={staleOffset}
              strokeLinecap="round"
              className="transition-all duration-500"
            />
          )}

          {/* Offline Segment (Coral) */}
          {offline > 0 && (
            <circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="transparent"
              stroke="var(--critical)"
              strokeWidth={strokeWidth}
              strokeDasharray={`${offlineDash} ${circumference - offlineDash}`}
              strokeDashoffset={offlineOffset}
              strokeLinecap="round"
              className="transition-all duration-500"
            />
          )}
        </svg>

        {/* Center Readout */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center select-none">
          <span className="font-heading text-2xl font-bold tabular-nums text-[var(--ink)] leading-none">
            {healthPercent}%
          </span>
          <span className={`text-[10px] font-mono font-bold mt-1 tracking-wider ${status.color}`}>
            {status.label}
          </span>
        </div>
      </div>

      {/* Fleet Breakdown Details */}
      <div className="space-y-3 flex-1 min-w-0">
        <div>
          <div className="text-xs font-mono text-[var(--muted)] uppercase tracking-wider">
            Fleet Health Index
          </div>
          <div className="font-heading font-semibold text-base text-[var(--ink)] mt-0.5">
            {online} of {total} devices reporting normally
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="p-2 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] space-y-0.5">
            <div className="flex items-center space-x-1.5 text-[var(--healthy)] font-semibold font-mono text-[11px]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--healthy)]" />
              <span>ONLINE</span>
            </div>
            <div className="font-mono text-base font-bold tabular-nums text-[var(--ink)]">
              {online}
            </div>
          </div>

          <div className="p-2 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] space-y-0.5">
            <div className="flex items-center space-x-1.5 text-[var(--stale)] font-semibold font-mono text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full bg-[var(--stale)] ${stale > 0 ? 'animate-pulse' : ''}`} />
              <span>STALE</span>
            </div>
            <div className="font-mono text-base font-bold tabular-nums text-[var(--ink)]">
              {stale}
            </div>
          </div>

          <div className="p-2 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] space-y-0.5">
            <div className="flex items-center space-x-1.5 text-[var(--critical)] font-semibold font-mono text-[11px]">
              <span className={`w-1.5 h-1.5 rounded-full bg-[var(--critical)] ${offline > 0 ? 'animate-pulse' : ''}`} />
              <span>OFFLINE</span>
            </div>
            <div className="font-mono text-base font-bold tabular-nums text-[var(--ink)]">
              {offline}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
