import React, { useState, useMemo } from 'react';
import { usePlatformStore } from '../store/PlatformContext.js';
import { Rule, RuleType, IncidentSeverity } from '../types.js';
import { ActionButton } from '../components/ActionButton.js';
import { useToast } from '../components/Toast.js';
import {
  Sliders,
  Plus,
  Trash2,
  X,
  Layers,
  Clock,
  ShieldAlert,
  SlidersHorizontal,
  CheckCircle2,
  AlertTriangle,
  Info,
} from 'lucide-react';

export const RulesPage: React.FC = () => {
  const { state, createRule, deleteRule, toggleRuleEnabled } = usePlatformStore();
  const { rules, devices, connection } = state;
  const isOffline = connection.status === 'offline';
  const { showToast } = useToast();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Form State
  const [ruleType, setRuleType] = useState<RuleType>('threshold');
  const [name, setName] = useState('');
  const [severity, setSeverity] = useState<IncidentSeverity>('critical');
  const [scopeType, setScopeType] = useState<'all' | 'location' | 'device'>('all');
  const [scopeValue, setScopeValue] = useState('');
  const [cooldown, setCooldown] = useState<number>(60);

  // Dynamic Rule Config State
  const [threshField, setThreshField] = useState('temperature');
  const [threshOp, setThreshOp] = useState<'>' | '>=' | '<' | '<=' | '==' | '!='>('>');
  const [threshValue, setThreshValue] = useState<number>(80);
  const [absenceTimeout, setAbsenceTimeout] = useState<number>(60);
  const [eventTypeVal, setEventTypeVal] = useState('device.error');

  const rulesList = useMemo(() => Object.values(rules), [rules]);

  const resetForm = () => {
    setName('');
    setRuleType('threshold');
    setSeverity('critical');
    setScopeType('all');
    setScopeValue('');
    setCooldown(60);
    setThreshField('temperature');
    setThreshOp('>');
    setThreshValue(80);
    setAbsenceTimeout(60);
    setEventTypeVal('device.error');
  };

  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isOffline) return;

    if (!name.trim()) {
      alert('Please provide a rule name');
      return;
    }

    let config: any = {};
    if (ruleType === 'threshold') {
      config = {
        field: threshField.trim(),
        operator: threshOp,
        value: Number(threshValue),
      };
    } else if (ruleType === 'absence') {
      config = {
        timeout_seconds: Number(absenceTimeout),
      };
    } else if (ruleType === 'event_type') {
      config = {
        event_type: eventTypeVal.trim(),
      };
    }

    const payload = {
      name: name.trim(),
      type: ruleType,
      rule_type: ruleType,
      config,
      scope: {
        type: scopeType,
        value: scopeType === 'all' ? undefined : scopeValue.trim(),
      },
      scope_type: scopeType,
      scope_value: scopeType === 'all' ? undefined : scopeValue.trim(),
      severity,
      enabled: true,
      cooldown: Number(cooldown),
    };

    setSubmitting(true);
    const success = await createRule(payload);
    setSubmitting(false);

    if (success) {
      setIsModalOpen(false);
      resetForm();
      showToast('Rule created', name);
    }
  };

  const handleDelete = async (id: string, ruleName: string) => {
    if (isOffline) return;
    if (window.confirm(`Are you sure you want to delete rule '${ruleName}'?`)) {
      const ok = await deleteRule(id);
      if (ok) {
        showToast('Rule deleted', ruleName);
      }
    }
  };

  const getSeverityBadge = (sev: IncidentSeverity) => {
    const isCritical = sev === 'critical';
    const isWarning = sev === 'warning';
    return (
      <span
        className={`inline-flex items-center space-x-1 px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase tracking-wider ${
          isCritical
            ? 'bg-[var(--critical-bg)] text-[var(--critical)] border border-[var(--critical)]/30'
            : isWarning
              ? 'bg-[var(--stale-bg)] text-[var(--stale)] border border-[var(--stale)]/30'
              : 'bg-[var(--surface-raised)] text-[var(--muted)] border border-[var(--hairline)]'
        }`}
      >
        {isCritical ? (
          <AlertTriangle className="w-3 h-3 text-[var(--critical)] shrink-0" />
        ) : isWarning ? (
          <AlertTriangle className="w-3 h-3 text-[var(--stale)] shrink-0" />
        ) : (
          <Info className="w-3 h-3 text-[var(--muted)] shrink-0" />
        )}
        <span>{sev}</span>
      </span>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center space-x-2">
            <Sliders className="w-4 h-4 text-[var(--accent)]" />
            <h1 className="text-xl sm:text-2xl font-heading font-bold tracking-tight text-[var(--ink)]">
              Detection Rules Engine
            </h1>
          </div>
          <p className="text-xs text-[var(--muted)] mt-0.5">
            Automated evaluation logic for thresholds, device silence heartbeats, and error types
          </p>
        </div>

        <ActionButton
          isOffline={isOffline}
          variant="primary"
          onClick={() => {
            resetForm();
            setIsModalOpen(true);
          }}
        >
          <Plus className="w-3.5 h-3.5 mr-1" />
          <span>New Rule</span>
        </ActionButton>
      </div>

      {/* Rules Table */}
      <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] overflow-hidden shadow-xs">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[var(--surface-raised)] border-b border-[var(--hairline)] text-[var(--muted)] text-[11px] font-mono font-medium">
              <tr>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Rule</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Type</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Trigger Condition</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Scope</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">Severity</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold">State</th>
                <th className="px-5 py-3 uppercase tracking-wider font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--hairline)]">
              {rulesList.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-12 text-center text-[var(--muted)] font-mono">
                    No rules configured yet. Click 'New Rule' to register one.
                  </td>
                </tr>
              ) : (
                rulesList.map((rule: Rule) => (
                  <tr key={rule.id} className="hover:bg-[var(--surface-raised)] transition">
                    <td className="px-5 py-3.5">
                      <div className="font-heading font-semibold text-[var(--ink)]">{rule.name}</div>
                      <div className="text-[11px] text-[var(--muted)] font-mono">{rule.id}</div>
                    </td>

                    <td className="px-5 py-3.5">
                      <span className="px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase bg-[var(--surface-raised)] text-[var(--accent)] border border-[var(--hairline)]">
                        {rule.rule_type || rule.type}
                      </span>
                    </td>

                    <td className="px-5 py-3.5 text-[var(--ink)] font-mono text-xs">
                      {rule.rule_type === 'threshold' && (
                        <span>
                          {rule.config?.field} {rule.config?.operator} {rule.config?.value}
                        </span>
                      )}
                      {rule.rule_type === 'absence' && (
                        <span>Silence &gt; {rule.config?.timeout_seconds}s</span>
                      )}
                      {rule.rule_type === 'event_type' && (
                        <span>type == &quot;{rule.config?.event_type}&quot;</span>
                      )}
                    </td>

                    <td className="px-5 py-3.5 font-mono text-xs">
                      <span className="text-[var(--muted)] uppercase">
                        {rule.scope_type || rule.scope?.type || 'all'}
                        {rule.scope_value ? `: ${rule.scope_value}` : ''}
                      </span>
                    </td>

                    <td className="px-5 py-3.5">{getSeverityBadge(rule.severity)}</td>

                    <td className="px-5 py-3.5">
                      <label className="relative inline-flex items-center cursor-pointer select-none">
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          disabled={isOffline}
                          onChange={(e) => toggleRuleEnabled(rule.id, e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-8 h-4 bg-[var(--hairline)] peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-[var(--hairline)] after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-[var(--accent)]" />
                        <span className="ml-2 font-mono text-[11px] text-[var(--muted)] font-medium">
                          {rule.enabled ? 'ACTIVE' : 'MUTED'}
                        </span>
                      </label>
                    </td>

                    <td className="px-5 py-3.5 text-right">
                      <ActionButton
                        isOffline={isOffline}
                        variant="danger"
                        className="py-1 px-2 text-xs font-mono"
                        onClick={() => handleDelete(rule.id, rule.name)}
                      >
                        <Trash2 className="w-3.5 h-3.5 mr-1" />
                        Delete
                      </ActionButton>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Rule Modal Form */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-[var(--surface)] border border-[var(--hairline)] rounded-[var(--radius-panel,8px)] max-w-lg w-full p-6 shadow-2xl space-y-4 text-xs animate-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-[var(--hairline)] pb-3">
              <h3 className="font-heading font-bold text-sm text-[var(--ink)]">
                Register Detection Rule
              </h3>
              <button
                onClick={() => setIsModalOpen(false)}
                className="text-[var(--muted)] hover:text-[var(--ink)] p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateSubmit} className="space-y-4">
              {/* Rule Name */}
              <div className="space-y-1">
                <label className="text-[var(--ink)] font-heading font-semibold">Rule Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. Rack Overheat Alert (>80C)"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] placeholder-[var(--muted)] focus:outline-none focus:border-[var(--accent)] font-mono text-xs"
                />
              </div>

              {/* Rule Type Selector */}
              <div className="space-y-1">
                <label className="text-[var(--ink)] font-heading font-semibold">Rule Type</label>
                <select
                  value={ruleType}
                  onChange={(e) => setRuleType(e.target.value as RuleType)}
                  className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] text-xs focus:outline-none focus:border-[var(--accent)] font-mono"
                >
                  <option value="threshold">Threshold (Numeric telemetry payload comparison)</option>
                  <option value="absence">Absence (Device silence &gt; N seconds)</option>
                  <option value="event_type">Event Type (Exact match on type)</option>
                </select>
              </div>

              {/* Dynamic Form per Rule Type */}
              {ruleType === 'threshold' && (
                <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)] space-y-3 font-mono">
                  <span className="font-bold text-[var(--ink)] block uppercase text-[11px]">
                    Threshold Parameters
                  </span>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <label className="text-[10px] text-[var(--muted)] uppercase">Field</label>
                      <input
                        type="text"
                        required
                        value={threshField}
                        onChange={(e) => setThreshField(e.target.value)}
                        placeholder="temperature"
                        className="w-full px-2 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                      />
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--muted)] uppercase">Op</label>
                      <select
                        value={threshOp}
                        onChange={(e) => setThreshOp(e.target.value as any)}
                        className="w-full px-2 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                      >
                        <option value=">">&gt;</option>
                        <option value=">=">&gt;=</option>
                        <option value="<">&lt;</option>
                        <option value="<=">&lt;=</option>
                        <option value="==">==</option>
                        <option value="!=">!=</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-[var(--muted)] uppercase">Value</label>
                      <input
                        type="number"
                        step="any"
                        required
                        value={threshValue}
                        onChange={(e) => setThreshValue(Number(e.target.value))}
                        className="w-full px-2 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                      />
                    </div>
                  </div>
                </div>
              )}

              {ruleType === 'absence' && (
                <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)] space-y-2 font-mono">
                  <span className="font-bold text-[var(--ink)] block uppercase text-[11px]">
                    Silence Timeout
                  </span>
                  <div>
                    <label className="text-[10px] text-[var(--muted)] uppercase">
                      Seconds Before Triggering
                    </label>
                    <input
                      type="number"
                      min="1"
                      required
                      value={absenceTimeout}
                      onChange={(e) => setAbsenceTimeout(Number(e.target.value))}
                      className="w-full px-3 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                    />
                  </div>
                </div>
              )}

              {ruleType === 'event_type' && (
                <div className="p-3 bg-[var(--surface-raised)] rounded-[var(--radius-control,6px)] border border-[var(--hairline)] space-y-2 font-mono">
                  <span className="font-bold text-[var(--ink)] block uppercase text-[11px]">
                    Target Event Type
                  </span>
                  <div>
                    <input
                      type="text"
                      required
                      value={eventTypeVal}
                      onChange={(e) => setEventTypeVal(e.target.value)}
                      placeholder="e.g. device.error"
                      className="w-full px-3 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                    />
                  </div>
                </div>
              )}

              {/* Scope & Severity */}
              <div className="grid grid-cols-2 gap-3 font-mono">
                <div className="space-y-1">
                  <label className="text-[var(--ink)] font-sans font-semibold">Scope</label>
                  <select
                    value={scopeType}
                    onChange={(e) => setScopeType(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                  >
                    <option value="all">All Devices</option>
                    <option value="location">Specific Location</option>
                    <option value="device">Specific Device</option>
                  </select>
                </div>

                <div className="space-y-1">
                  <label className="text-[var(--ink)] font-sans font-semibold">Severity</label>
                  <select
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as any)}
                    className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                  >
                    <option value="critical">Critical</option>
                    <option value="warning">Warning</option>
                    <option value="info">Info</option>
                  </select>
                </div>
              </div>

              {scopeType !== 'all' && (
                <div className="space-y-1 font-mono">
                  <label className="text-[var(--ink)] font-sans font-semibold">
                    {scopeType === 'location' ? 'Location ID' : 'Device ID'}
                  </label>
                  {scopeType === 'device' ? (
                    <select
                      value={scopeValue}
                      onChange={(e) => setScopeValue(e.target.value)}
                      className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                    >
                      <option value="">Select device</option>
                      {Object.values(devices).map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} ({d.id})
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      placeholder="e.g. loc-warehouse-1"
                      value={scopeValue}
                      onChange={(e) => setScopeValue(e.target.value)}
                      className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                    />
                  )}
                </div>
              )}

              {/* Cooldown */}
              <div className="space-y-1 font-mono">
                <label className="text-[var(--ink)] font-sans font-semibold">Cooldown (Seconds)</label>
                <input
                  type="number"
                  min="0"
                  value={cooldown}
                  onChange={(e) => setCooldown(Number(e.target.value))}
                  className="w-full px-3 py-2 rounded-[var(--radius-control,6px)] bg-[var(--canvas)] border border-[var(--hairline)] text-[var(--ink)] text-xs"
                />
              </div>

              {/* Actions */}
              <div className="pt-3 border-t border-[var(--hairline)] flex justify-end space-x-2">
                <button
                  type="button"
                  onClick={() => setIsModalOpen(false)}
                  className="px-3 py-1.5 rounded-[var(--radius-control,6px)] bg-[var(--surface)] hover:bg-[var(--canvas)] text-[var(--muted)] hover:text-[var(--ink)] border border-[var(--hairline)] transition font-mono"
                >
                  Cancel
                </button>
                <ActionButton isOffline={isOffline} variant="primary" disabled={submitting}>
                  {submitting ? 'Registering...' : 'Save Rule'}
                </ActionButton>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
