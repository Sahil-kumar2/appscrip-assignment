import { describe, it, expect } from 'vitest';
import { evaluateRule } from '../rule-engine.js';
import { Rule } from '@aps/shared';

describe('Worker: Rule Engine', () => {
  const device = { id: 'dev-001', location_id: 'loc-1' };

  describe('Scope filtering', () => {
    const baseRule: Rule = {
      id: 'rule-1',
      name: 'Scope Test',
      rule_type: 'event_type',
      scope_type: 'all',
      config: { event_type: 'error' },
      enabled: true,
      severity: 'warning',
      cooldown: 0,
    };

    it('applies to any device when scope is all', () => {
      const res = evaluateRule(baseRule, { type: 'error', payload: {} }, device);
      expect(res.applies).toBe(true);
      expect(res.matched).toBe(true);
    });

    it('respects scope_type: device', () => {
      const deviceRule: Rule = {
        ...baseRule,
        scope_type: 'device',
        scope_value: 'dev-001',
      };
      expect(evaluateRule(deviceRule, { type: 'error', payload: {} }, device).applies).toBe(true);

      const otherDevice = { id: 'dev-002', location_id: 'loc-1' };
      const res = evaluateRule(deviceRule, { type: 'error', payload: {} }, otherDevice);
      expect(res.applies).toBe(false);
      expect(res.matched).toBe(false);
      expect(res.reason).toContain('Scope mismatch');
    });

    it('respects scope_type: location', () => {
      const locRule: Rule = {
        ...baseRule,
        scope_type: 'location',
        scope_value: 'loc-1',
      };
      expect(evaluateRule(locRule, { type: 'error', payload: {} }, device).applies).toBe(true);

      const otherLocationDevice = { id: 'dev-001', location_id: 'loc-99' };
      const res = evaluateRule(locRule, { type: 'error', payload: {} }, otherLocationDevice);
      expect(res.applies).toBe(false);
      expect(res.matched).toBe(false);
    });
  });

  describe('Threshold rules', () => {
    const tempRule: Rule = {
      id: 'rule-temp',
      name: 'High Temperature',
      rule_type: 'threshold',
      scope_type: 'all',
      config: { field: 'temperature', operator: '>', value: 80 },
      enabled: true,
      severity: 'critical',
      cooldown: 0,
    };

    it('matches when threshold is exceeded', () => {
      const res = evaluateRule(
        tempRule,
        { type: 'telemetry', payload: { temperature: 85.5 } },
        device
      );
      expect(res.matched).toBe(true);
      expect(res.reason).toContain('(85.5) > 80');
    });

    it('does not match when threshold is not exceeded', () => {
      const res = evaluateRule(
        tempRule,
        { type: 'telemetry', payload: { temperature: 75 } },
        device
      );
      expect(res.matched).toBe(false);
      expect(res.reason).toContain('(75) is not > 80');
    });

    it('handles missing payload field gracefully', () => {
      const res = evaluateRule(tempRule, { type: 'telemetry', payload: { humidity: 50 } }, device);
      expect(res.matched).toBe(false);
      expect(res.reason).toContain('missing or not a valid number');
    });

    it('evaluates all comparison operators correctly', () => {
      const operators: Array<{
        op: '>' | '>=' | '<' | '<=' | '==' | '!=';
        val: number;
        pass: number;
        fail: number;
      }> = [
        { op: '>=', val: 50, pass: 50, fail: 49 },
        { op: '<', val: 20, pass: 15, fail: 25 },
        { op: '<=', val: 20, pass: 20, fail: 21 },
        { op: '==', val: 100, pass: 100, fail: 101 },
        { op: '!=', val: 0, pass: 5, fail: 0 },
      ];

      for (const t of operators) {
        const r: Rule = {
          id: `rule-${t.op}`,
          name: 'Op Test',
          rule_type: 'threshold',
          scope_type: 'all',
          config: { field: 'val', operator: t.op, value: t.val },
          enabled: true,
          severity: 'warning',
          cooldown: 0,
        };

        expect(evaluateRule(r, { type: 't', payload: { val: t.pass } }, device).matched).toBe(true);
        expect(evaluateRule(r, { type: 't', payload: { val: t.fail } }, device).matched).toBe(
          false
        );
      }
    });
  });

  describe('Event Type rules', () => {
    const tamperRule: Rule = {
      id: 'rule-tamper',
      name: 'Tamper Alert',
      rule_type: 'event_type',
      scope_type: 'all',
      config: { event_type: 'tamper' },
      enabled: true,
      severity: 'critical',
      cooldown: 0,
    };

    it('matches when event.type equals target event_type', () => {
      const res = evaluateRule(tamperRule, { type: 'tamper', payload: {} }, device);
      expect(res.matched).toBe(true);
      expect(res.reason).toContain('Event type matched');
    });

    it('does not match when event.type differs', () => {
      const res = evaluateRule(tamperRule, { type: 'telemetry', payload: {} }, device);
      expect(res.matched).toBe(false);
      expect(res.reason).toContain('does not match');
    });
  });

  describe('Absence rules on event stream', () => {
    const absenceRule: Rule = {
      id: 'rule-absence',
      name: 'Device Absence',
      rule_type: 'absence',
      scope_type: 'all',
      config: { timeout_seconds: 60 },
      enabled: true,
      severity: 'warning',
      cooldown: 0,
    };

    it('does not match for incoming event as device is active', () => {
      const res = evaluateRule(absenceRule, { type: 'ping', payload: {} }, device);
      expect(res.matched).toBe(false);
      expect(res.reason).toContain('actively transmitting');
    });
  });
});
