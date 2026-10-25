import React from 'react';
import {
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
} from 'lucide-react';
import { ConnectionState } from '../types.js';
import { LiveIndicator } from './LiveIndicator.js';
import { useTheme } from '../store/ThemeContext.js';

interface SidebarProps {
  activeTab: string;
  onTabChange: (tab: string) => void;
  openIncidentsCount: number;
  connection: ConnectionState;
  onReconnect?: () => void;
  onOpenCommandPalette: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  activeTab,
  onTabChange,
  openIncidentsCount,
  connection,
  onReconnect,
  onOpenCommandPalette,
}) => {
  const { theme, toggleTheme } = useTheme();

  const navItems = [
    { id: 'overview', label: 'Overview', icon: Layers },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'events', label: 'Live Events', icon: Radio },
    { id: 'incidents', label: 'Incidents', icon: ShieldAlert, badge: openIncidentsCount },
    { id: 'rules', label: 'Rules', icon: Sliders },
    { id: 'ops', label: 'Operations', icon: Terminal },
  ];

  return (
    <>
      {/* Desktop Sidebar (Left) */}
      <aside className="hidden md:flex flex-col w-56 shrink-0 bg-[var(--surface)] border-r border-[var(--hairline)] h-screen sticky top-0 z-30 select-none">
        {/* Brand & Command Palette Button */}
        <div className="p-4 border-b border-[var(--hairline)] space-y-3">
          <div
            className="flex items-center space-x-2.5 cursor-pointer"
            onClick={() => onTabChange('overview')}
          >
            <div className="w-7 h-7 rounded-[var(--radius-control,6px)] bg-[var(--brand)] text-white flex items-center justify-center font-bold shadow-sm">
              <Zap className="w-4 h-4 fill-current" />
            </div>
            <div>
              <div className="font-semibold text-sm tracking-tight text-[var(--ink)] leading-none">
                APS Fleet
              </div>
              <div className="text-[11px] text-[var(--muted)] mt-0.5">Device Operations</div>
            </div>
          </div>

          {/* Quick Search / Cmd+K Button */}
          <button
            onClick={onOpenCommandPalette}
            className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] hover:bg-[var(--hairline)] text-xs text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--hairline)] transition"
          >
            <div className="flex items-center space-x-2">
              <Search className="w-3.5 h-3.5" />
              <span>Search...</span>
            </div>
            <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface)] text-[10px] font-mono border border-[var(--hairline)] text-[var(--muted)]">
              ⌘K
            </kbd>
          </button>
        </div>

        {/* Navigation Links */}
        <nav className="flex-1 p-3 space-y-0.5 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2 rounded-[var(--radius-control,6px)] text-xs font-medium transition ${
                  isActive
                    ? 'bg-[var(--brand-soft)] text-[var(--brand)] font-semibold'
                    : 'text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--canvas)]'
                }`}
              >
                <div className="flex items-center space-x-2.5">
                  <Icon
                    className={`w-4 h-4 shrink-0 ${
                      isActive ? 'text-[var(--brand)]' : 'text-[var(--muted)]'
                    }`}
                  />
                  <span>{item.label}</span>
                </div>

                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span
                    className={`px-1.5 py-0.2 rounded-full text-[10px] font-mono font-semibold ${
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

        {/* Footer Area: Live Indicator & Theme Toggle */}
        <div className="p-3 border-t border-[var(--hairline)] flex items-center justify-between">
          <LiveIndicator connection={connection} onReconnect={onReconnect} />

          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-[var(--radius-control,6px)] text-[var(--muted)] hover:text-[var(--ink)] hover:bg-[var(--canvas)] transition"
            title={`Switch to ${theme === 'dark' ? 'Light' : 'Dark'} mode`}
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* Mobile Top Header */}
      <div className="md:hidden flex items-center justify-between px-4 py-3 bg-[var(--surface)] border-b border-[var(--hairline)] sticky top-0 z-30">
        <div
          className="flex items-center space-x-2 cursor-pointer"
          onClick={() => onTabChange('overview')}
        >
          <div className="w-6 h-6 rounded-[var(--radius-control,6px)] bg-[var(--brand)] text-white flex items-center justify-center font-bold">
            <Zap className="w-3.5 h-3.5 fill-current" />
          </div>
          <span className="font-semibold text-sm text-[var(--ink)]">APS</span>
        </div>

        <div className="flex items-center space-x-2">
          <LiveIndicator connection={connection} onReconnect={onReconnect} />

          <button
            onClick={onOpenCommandPalette}
            className="p-1.5 rounded-[var(--radius-control,6px)] text-[var(--muted)] hover:text-[var(--ink)] bg-[var(--canvas)]"
            aria-label="Search"
          >
            <Search className="w-4 h-4" />
          </button>

          <button
            onClick={toggleTheme}
            className="p-1.5 rounded-[var(--radius-control,6px)] text-[var(--muted)] hover:text-[var(--ink)] bg-[var(--canvas)]"
            aria-label="Toggle theme"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </div>

      {/* Mobile Bottom Bar */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-[var(--surface)] border-t border-[var(--hairline)] z-30 flex items-center justify-around py-2 px-1">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = activeTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onTabChange(item.id)}
              className={`flex flex-col items-center py-1 px-2 rounded-[var(--radius-control,6px)] text-[10px] font-medium transition ${
                isActive ? 'text-[var(--brand)] font-semibold' : 'text-[var(--muted)]'
              }`}
            >
              <div className="relative">
                <Icon className="w-4 h-4" />
                {typeof item.badge === 'number' && item.badge > 0 && (
                  <span className="absolute -top-1 -right-2 h-3 w-3 rounded-full bg-[var(--critical)] text-white text-[8px] flex items-center justify-center font-mono font-bold">
                    {item.badge}
                  </span>
                )}
              </div>
              <span className="mt-1 leading-none">{item.label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
};
