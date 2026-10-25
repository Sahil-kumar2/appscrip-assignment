import React, { useState } from 'react';

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isOffline?: boolean;
  offlineTooltip?: string;
  variant?: 'primary' | 'secondary' | 'danger' | 'warning' | 'success';
}

export const ActionButton: React.FC<ActionButtonProps> = ({
  isOffline = false,
  offlineTooltip = 'Actions are disabled while offline',
  disabled = false,
  variant = 'primary',
  children,
  className = '',
  title,
  ...props
}) => {
  const [showTooltip, setShowTooltip] = useState(false);
  const effectivelyDisabled = disabled || isOffline;

  const variantStyles = {
    primary:
      'bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[#0E1116] font-semibold border-transparent shadow-sm active:scale-[0.98]',
    secondary:
      'bg-[var(--surface)] hover:bg-[var(--surface-raised)] text-[var(--ink)] border-[var(--hairline)] hover:border-[var(--muted)]/40 active:scale-[0.98]',
    danger:
      'bg-[var(--critical-bg)] text-[var(--critical)] border-[var(--critical)]/30 hover:bg-[var(--critical-bg)]/80 active:scale-[0.98]',
    warning:
      'bg-[var(--stale-bg)] text-[var(--stale)] border-[var(--stale)]/30 hover:bg-[var(--stale-bg)]/80 active:scale-[0.98]',
    success:
      'bg-[var(--healthy-bg)] text-[var(--healthy)] border-[var(--healthy)]/30 hover:bg-[var(--healthy-bg)]/80 active:scale-[0.98]',
  }[variant];

  return (
    <div
      className="relative inline-block"
      onMouseEnter={() => isOffline && setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        {...props}
        disabled={effectivelyDisabled}
        title={isOffline ? offlineTooltip : title}
        className={`px-2.5 py-1.5 rounded-[var(--radius-control,6px)] text-xs font-medium border transition-all duration-150 inline-flex items-center justify-center space-x-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] ${variantStyles} ${
          effectivelyDisabled ? 'opacity-50 cursor-not-allowed pointer-events-none' : ''
        } ${className}`}
      >
        {children}
      </button>

      {isOffline && showTooltip && (
        <div
          role="tooltip"
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-2.5 py-1 text-[11px] font-sans font-medium text-[var(--ink)] bg-[var(--surface-raised)] border border-[var(--hairline)] rounded-[var(--radius-control,6px)] shadow-xl whitespace-nowrap z-50 pointer-events-none"
        >
          {offlineTooltip}
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-[var(--surface-raised)]" />
        </div>
      )}
    </div>
  );
};
