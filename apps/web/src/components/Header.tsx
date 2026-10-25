import React from 'react';
import { SystemStats } from '../types.js';
import {
  Activity,
  Layers,
  Radio,
  ShieldAlert,
  Sliders,
  Terminal,
  Cpu,
  Zap,
} from 'lucide-react';

interface HeaderProps {
  stats: SystemStats | null;
  activeTab: string;
  onTabChange: (tab: string) => void;
  openIncidentsCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  stats,
  activeTab,
  onTabChange,
  openIncidentsCount,
}) => {
  const tabs = [
    { id: 'overview', label: 'Overview', icon: Layers },
    { id: 'devices', label: 'Devices', icon: Cpu },
    { id: 'events', label: 'Live Events', icon: Radio },
    { id: 'incidents', label: 'Incidents', icon: ShieldAlert, badge: openIncidentsCount },
    { id: 'rules', label: 'Rules', icon: Sliders },
    { id: 'ops', label: 'Ops', icon: Terminal },
  ];

  const deadLettersCount = stats?.failed_events?.failed_count ?? 0;

  return (
    <header className="border-b border-zinc-800 bg-zinc-950/90 backdrop-blur sticky top-0 z-30">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo and App Title */}
          <div
            className="flex items-center space-x-3 cursor-pointer group select-none"
            onClick={() => onTabChange('overview')}
          >
            <div className="w-8 h-8 rounded-md bg-zinc-900 border border-zinc-700/80 flex items-center justify-center text-zinc-100 group-hover:border-zinc-500 transition">
              <Zap className="w-4 h-4 text-zinc-100" />
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-zinc-100 text-sm tracking-tight">
                  APS
                </span>
                <span className="text-zinc-500 text-xs">/</span>
                <span className="text-zinc-300 text-xs font-medium">Device Operations</span>
                <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 font-medium">
                  v1.0
                </span>
              </div>
              <div className="text-[11px] text-zinc-500 font-mono">
                PostgreSQL Single Source of Truth
              </div>
            </div>
          </div>

          {/* Quick Real-Time Metrics Bar */}
          <div className="hidden md:flex items-center space-x-3 text-xs font-mono">
            <div className="flex items-center space-x-3 bg-zinc-900/60 px-3 py-1.5 rounded-md border border-zinc-800 text-zinc-400">
              <div className="flex items-center space-x-1.5">
                <Activity className="w-3.5 h-3.5 text-zinc-400" />
                <span className="text-zinc-500">Rate:</span>
                <span className="text-zinc-200 font-semibold">{stats?.events_per_minute ?? 0} ev/m</span>
              </div>
              <span className="text-zinc-700">|</span>
              <div className="flex items-center space-x-1.5">
                <span className="text-zinc-500">Queue Lag:</span>
                <span className="text-zinc-200 font-medium">
                  {stats?.queue_depth_and_lag?.lag_seconds ?? 0}s
                </span>
              </div>
              <span className="text-zinc-700">|</span>
              <div className="flex items-center space-x-1.5">
                <span className="text-zinc-500">Dead Letters:</span>
                <span
                  className={
                    deadLettersCount > 0
                      ? 'text-red-400 font-semibold px-1 rounded bg-red-950/60 border border-red-900/50'
                      : 'text-zinc-400'
                  }
                >
                  {deadLettersCount}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div className="flex space-x-1 text-xs border-t border-zinc-800/80 pt-1 pb-2 overflow-x-auto">
          {tabs.map((tab) => {
            const isActive = activeTab === tab.id;
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`py-1.5 px-3 rounded-md font-medium flex items-center space-x-2 whitespace-nowrap transition-all duration-150 ${
                  isActive
                    ? 'bg-zinc-800 text-zinc-100 border border-zinc-700/60 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900/60 border border-transparent'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-zinc-100' : 'text-zinc-500'}`} />
                <span>{tab.label}</span>
                {typeof tab.badge === 'number' && tab.badge > 0 && (
                  <span className="px-1.5 py-0.2 rounded-full text-[10px] font-mono font-semibold bg-red-950/80 text-red-300 border border-red-900/60">
                    {tab.badge}
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
