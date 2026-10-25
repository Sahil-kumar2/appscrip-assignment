// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { groupIncidents, formatRelativeTime } from '../utils/incidentGrouping.js';
import { Incident } from '../types.js';

describe('Incident Grouping by Rule + Device', () => {
  const sampleIncidents: Incident[] = [
    {
      id: 'inc-1',
      rule_id: 'rule-temp',
      rule_name: 'Overheat Critical',
      rule_type: 'threshold',
      device_id: 'dev-001',
      device_name: 'Pump Sensor 1',
      dedup_key: 'rule-temp:dev-001',
      severity: 'critical',
      status: 'open',
      occurrence_count: 3,
      last_event_at: new Date(Date.now() - 1000 * 60 * 12).toISOString(), // 12m ago
      summary: 'Temperature exceeded 80C',
    },
    {
      id: 'inc-2',
      rule_id: 'rule-vib',
      rule_name: 'Vibration Spike',
      rule_type: 'threshold',
      device_id: 'dev-002',
      device_name: 'Turbine Sensor 2',
      dedup_key: 'rule-vib:dev-002',
      severity: 'warning',
      status: 'open',
      occurrence_count: 1,
      last_event_at: new Date(Date.now() - 1000 * 60 * 25).toISOString(), // 25m ago
      summary: 'Vibration 4.2g',
    },
    {
      id: 'inc-3',
      rule_id: 'rule-temp',
      rule_name: 'Overheat Critical',
      rule_type: 'threshold',
      device_id: 'dev-001',
      device_name: 'Pump Sensor 1',
      dedup_key: 'rule-temp:dev-001',
      severity: 'critical',
      status: 'acknowledged',
      occurrence_count: 2,
      last_event_at: new Date(Date.now() - 1000 * 60 * 5).toISOString(), // 5m ago
    },
  ];

  it('groups multiple incidents for the same rule and device into a single card', () => {
    const grouped = groupIncidents(sampleIncidents);
    // inc-1 and inc-3 share rule-temp:dev-001
    expect(grouped.length).toBe(2);

    const tempGroup = grouped.find((g) => g.key === 'rule-temp:dev-001');
    expect(tempGroup).toBeDefined();
    expect(tempGroup?.incidentIds).toEqual(['inc-1', 'inc-3']);
    expect(tempGroup?.severity).toBe('critical');
    // Open status takes precedence over acknowledged
    expect(tempGroup?.status).toBe('open');
    expect(tempGroup?.occurrence_count).toBeGreaterThanOrEqual(5);
  });

  it('sorts critical open incidents before warnings and acknowledged incidents', () => {
    const grouped = groupIncidents(sampleIncidents);
    expect(grouped[0].severity).toBe('critical');
    expect(grouped[0].key).toBe('rule-temp:dev-001');
    expect(grouped[1].key).toBe('rule-vib:dev-002');
  });

  it('formats relative time accurately', () => {
    const now = new Date();
    expect(formatRelativeTime(now.toISOString())).toBe('just now');

    const tenMinAgo = new Date(Date.now() - 1000 * 60 * 10).toISOString();
    expect(formatRelativeTime(tenMinAgo)).toBe('10m ago');

    const threeHoursAgo = new Date(Date.now() - 1000 * 60 * 60 * 3).toISOString();
    expect(formatRelativeTime(threeHoursAgo)).toBe('3h ago');
  });
});
