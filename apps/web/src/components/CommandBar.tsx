import React from 'react';
import {
  Activity,
  Layers,
  Cpu,
  Radio,
  ShieldAlert,
  Sliders,
  Terminal,
  Search,
  Sun,
  Moon,
  Zap,
  UserCheck,
  PanelRight,
} from 'lucide-react';
import { ConnectionState, SystemStats } from '../types.js';
import { LiveIndicator } from './LiveIndicator.js';
import { useTheme } from '../store/ThemeContext.js';

interface CommandBarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  openIncidentsCount: number;
  connection: ConnectionState;
  onReconnect?: () => void;
  onOpenCommandPalette: () => void;
  stats?: SystemStats | null;
  isRailOpen?: boolean;
  onToggleRail?: () => void;
}

export const CommandBar: React.FC<CommandBarProps> = ({
  activeTab,
  onTabChange,
  openIncidentsCount,
  connection,
  onReconnect,
  onOpenCommandPalette,
  stats,
  isRailOpen = true,
  onToggleRail,
}) => {
  const { theme, toggleTheme } = useTheme();

  const navItems = [
    { id: 'overview', label: 'Situation Board', icon: Layers },
    { id: 'devices', label: 'Fleet Devices', icon: Cpu },
    { id: 'events', label: 'Live Stream', icon: Radio },
    { id: 'incidents', label: 'Incidents', icon: ShieldAlert, badge: openIncidentsCount },
    { id: 'rules', label: 'Rules Engine', icon: Sliders },
    { id: 'ops', label: 'System Health', icon: Terminal },
  ];

  return (
    <header className="border-b border-[var(--hairline)] bg-[var(--surface)] sticky top-0 z-40 select-none shadow-xs">
      <div className="w-full px-3 sm:px-6">
        <div className="flex items-center justify-between h-14 gap-3">
          {/* Brand + Logo */}
          <div
            className="flex items-center space-x-2.5 cursor-pointer shrink-0"
            onClick={() => onTabChange('overview')}
          >
            <div className="w-7 h-7 rounded-[var(--radius-control,6px)] bg-[var(--accent)] text-[#0E1116] flex items-center justify-center font-bold shadow-xs">
              <Zap className="w-4 h-4 fill-current text-[#0E1116]" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-heading font-bold text-sm tracking-tight text-[var(--ink)]">
                  APS
                </span>
                <span className="text-[10px] font-mono px-1 rounded bg-[var(--surface-raised)] border border-[var(--hairline)] text-[var(--muted)] uppercase tracking-wider">
                  MISSION CONTROL
                </span>
              </div>
            </div>
          </div>

          {/* Desktop Navigation Workspace Tabs */}
          <nav className="hidden lg:flex items-center space-x-1 overflow-x-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => onTabChange(item.id)}
                  className={`px-3 py-1.5 rounded-[var(--radius-control,6px)] text-xs font-medium flex items-center space-x-1.5 transition ${
                    isActive
                      ? 'bg-[var(--surface-raised)] text-[var(--ink)] font-semibold border border-[var(--hairline)] shadow-xs'
                      : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--canvas)] border border-transparent'
                  }`}
                >
                  <Icon
                    className={`w-3.5 h-3.5 ${
                      isActive ? 'text-[var(--accent)]' : 'text-[var(--muted)]'
                    }`}
                  />
                  <span>{item.label}</span>

                  {typeof item.badge === 'number' && item.badge > 0 && (
                    <span
                      className={`ml-1 px-1.5 py-0.2 rounded-full font-mono text-[10px] font-bold ${
                        isActive
                          ? 'bg-[var(--critical-bg)] text-[var(--critical)]'
                          : 'bg-[var(--hairline)] text-[var(--muted)]'
                      }`}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>

          {/* Right Action Cluster */}
          <div className="flex items-center space-x-2 shrink-0">
            {/* Global Search / Cmd+K */}
            <button
              onClick={onOpenCommandPalette}
              className="flex items-center space-x-2 px-2.5 py-1 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] hover:bg-[var(--surface-raised)] text-xs text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--hairline)] transition"
              title="Search command palette (Cmd+K)"
            >
              <Search className="w-3.5 h-3.5 text-[var(--muted)]" />
              <span className="hidden sm:inline text-xs">Search...</span>
              <kbd className="hidden sm:inline px-1.5 py-0.5 rounded bg-[var(--surface)] text-[10px] font-mono border border-[var(--hairline)] text-[var(--muted)]">
                ⌘K
              </kbd>
            </button>

            {/* Connection Status Pill */}
            <LiveIndicator connection={connection} onReconnect={onReconnect} />

            {/* Operator Badge */}
            <div className="hidden md:flex items-center space-x-1.5 px-2 py-1 rounded-[var(--radius-control,6px)] bg-[var(--surface-raised)] border border-[var(--hairline)] text-[11px] font-mono text-[var(--muted)]">
              <UserCheck className="w-3.5 h-3.5 text-[var(--healthy)]" />
              <span className="font-semibold text-[var(--ink)]">FDE-OPS</span>
            </div>

            {/* Incident Rail Toggle (desktop) */}
            {onToggleRail && (
              <button
                onClick={onToggleRail}
                className={`hidden xl:flex items-center space-x-1 px-2 py-1 rounded-[var(--radius-control,6px)] border text-xs font-mono transition ${
                  isRailOpen
                    ? 'bg-[var(--surface-raised)] text-[var(--ink)] border-[var(--accent)]/40'
                    : 'text-[var(--muted)] border-[var(--hairline)] hover:text-[var(--ink)]'
                }`}
                title="Toggle Incident Rail"
                aria-label="Toggle Incident Rail"
              >
                <PanelRight className="w-3.5 h-3.5 text-[var(--accent)]" />
                <span className="text-[11px]">Rail</span>
                {openIncidentsCount > 0 && (
                  <span className="px-1 rounded-full bg-[var(--critical-bg)] text-[var(--critical)] text-[9px] font-bold">
                    {openIncidentsCount}
                  </span>
                )}
              </button>
            )}

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="p-1.5 rounded-[var(--radius-control,6px)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--canvas)] border border-[var(--hairline)] transition"
              title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
              aria-label="Toggle theme"
            >
              {theme === 'dark' ? <Sun className="w-3.5 h-3.5" /> : <Moon className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>

        {/* Mobile Navigation Sub-bar */}
        <div className="flex lg:hidden overflow-x-auto space-x-1 py-1.5 border-t border-[var(--hairline)]">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`px-2.5 py-1 rounded-[var(--radius-control,6px)] text-xs font-medium whitespace-nowrap flex items-center space-x-1.5 transition ${
                  isActive
                    ? 'bg-[var(--surface-raised)] text-[var(--ink)] font-semibold border border-[var(--hairline)]'
                    : 'text-[var(--muted)] hover:text-[var(--ink)]'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-[var(--accent)]' : 'text-[var(--muted)]'}`} />
                <span>{item.label}</span>
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span className="ml-1 px-1 rounded-full font-mono text-[9px] font-bold bg-[var(--critical-bg)] text-[var(--critical)]">
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </header>
  );
};
