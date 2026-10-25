import pg from 'pg';
import { Rule, StoredEvent } from '@aps/shared';

export interface DeviceContext {
  id: string;
  location_id?: string | null;
}

export interface RuleEvaluationResult {
  applies: boolean;
  matched: boolean;
  reason: string;
}

/**
 * Extracts nested property from an object using dot notation (e.g., 'metrics.temperature' or 'temperature').
 */
export function getNestedValue(obj: any, path: string): any {
  if (!obj || typeof obj !== 'object' || !path) return undefined;
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr == null || typeof curr !== 'object') return undefined;
    curr = curr[part];
  }
  return curr;
}

/**
 * Short-TTL in-memory cache for enabled rules to avoid database roundtrips per event.
 */
export class RuleCache {
  private rules: Rule[] = [];
  private lastFetch = 0;
  private readonly ttlMs: number;

  constructor(ttlMs: number = 5000) {
    this.ttlMs = ttlMs;
  }

  async getEnabledRules(db: pg.Pool | pg.PoolClient): Promise<Rule[]> {
    const now = Date.now();
    if (now - this.lastFetch < this.ttlMs && this.rules.length > 0) {
      return this.rules;
    }
    const res = await db.query<Rule>('SELECT * FROM rules WHERE enabled = true');
    this.rules = res.rows;
    this.lastFetch = now;
    return this.rules;
  }

  invalidate(): void {
    this.lastFetch = 0;
  }
}

export function evaluateRule(
  rule: Rule,
  event: Pick<StoredEvent, 'type' | 'payload'>,
  device: DeviceContext
): RuleEvaluationResult {
  // 1. Resolve scope (support both scope_type/scope_value and scope json object)
  const scopeType = rule.scope_type || (rule as any).scope?.type || 'all';
  const scopeValue = rule.scope_value || (rule as any).scope?.value;

  if (scopeType === 'device') {
    if (scopeValue !== device.id) {
      return {
        applies: false,
        matched: false,
        reason: `Scope mismatch: rule applies only to device '${scopeValue}', but event is from '${device.id}'`,
      };
    }
  } else if (scopeType === 'location') {
    if (!device.location_id || scopeValue !== device.location_id) {
      return {
        applies: false,
        matched: false,
        reason: `Scope mismatch: rule applies only to location '${scopeValue}', but device is at '${device.location_id}'`,
      };
    }
  }
  // 'all' applies to every device

  const ruleType = rule.rule_type || (rule as any).type;

  // 2. Evaluate by Rule Type
  switch (ruleType) {
    case 'threshold': {
      // Optional event_type filter on threshold rule
      const requiredEventType = rule.config.event_type;
      if (requiredEventType && event.type !== requiredEventType) {
        return {
          applies: true,
          matched: false,
          reason: `Event type '${event.type}' does not match threshold rule event_type '${requiredEventType}'`,
        };
      }

      const field = rule.config.field;
      const op = rule.config.operator;
      const thresholdVal = Number(rule.config.value);

      if (!field || !op || Number.isNaN(thresholdVal)) {
        return {
          applies: true,
          matched: false,
          reason: `Invalid threshold rule configuration: missing field, operator, or numeric value`,
        };
      }

      const rawVal = getNestedValue(event.payload, field);
      if (
        rawVal === undefined ||
        rawVal === null ||
        typeof rawVal !== 'number' ||
        Number.isNaN(rawVal)
      ) {
        return {
          applies: true,
          matched: false,
          reason: `Payload field '${field}' is missing or not a valid number (value: ${JSON.stringify(rawVal)})`,
        };
      }

      let matched = false;
      switch (op) {
        case '>':
          matched = rawVal > thresholdVal;
          break;
        case '>=':
          matched = rawVal >= thresholdVal;
          break;
        case '<':
          matched = rawVal < thresholdVal;
          break;
        case '<=':
          matched = rawVal <= thresholdVal;
          break;
        case '==':
          matched = rawVal === thresholdVal;
          break;
        case '!=':
          matched = rawVal !== thresholdVal;
          break;
      }

      const reason = matched
        ? `Threshold matched: ${field} (${rawVal}) ${op} ${thresholdVal}`
        : `Threshold not met: ${field} (${rawVal}) is not ${op} ${thresholdVal}`;

      return { applies: true, matched, reason };
    }

    case 'event_type': {
      const targetType = rule.config.event_type;
      if (!targetType) {
        return {
          applies: true,
          matched: false,
          reason: 'Invalid event_type rule configuration: event_type is required',
        };
      }

      const matched = event.type === targetType;
      const reason = matched
        ? `Event type matched: '${event.type}' equals '${targetType}'`
        : `Event type '${event.type}' does not match target '${targetType}'`;

      return { applies: true, matched, reason };
    }

    case 'absence': {
      // Incoming events prove device presence
      return {
        applies: true,
        matched: false,
        reason: 'Device is actively transmitting events; absence condition not met',
      };
    }

    default:
      return {
        applies: false,
        matched: false,
        reason: `Unsupported rule type: ${ruleType}`,
      };
  }
}
