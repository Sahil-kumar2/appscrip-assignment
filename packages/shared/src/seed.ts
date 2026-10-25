import { createDbPool, withTransaction } from './db.js';
import { hashDeviceKey } from './crypto.js';
import { createLogger } from './logger.js';

const logger = createLogger({ service: 'seeder' });

export interface SeedDevice {
  id: string;
  name: string;
  location_id: string;
  rawKey: string;
}

export const SEED_DEVICES: SeedDevice[] = [
  {
    id: 'edge-austin-press-01',
    name: 'Austin Hydraulic Press Monitor',
    location_id: 'loc-facility-austin',
    rawKey: 'sec_live_austin_press_01',
  },
  {
    id: 'edge-austin-cnc-02',
    name: 'Austin Precision CNC Cell',
    location_id: 'loc-facility-austin',
    rawKey: 'sec_live_austin_cnc_02',
  },
  {
    id: 'edge-berlin-chiller-01',
    name: 'Berlin Cold-Chain Refrigeration Unit',
    location_id: 'loc-hub-berlin',
    rawKey: 'sec_live_berlin_chiller_01',
  },
  {
    id: 'edge-berlin-sorter-02',
    name: 'Berlin High-Speed Optical Sorter',
    location_id: 'loc-hub-berlin',
    rawKey: 'sec_live_berlin_sorter_02',
  },
  {
    id: 'edge-berlin-telecom-03',
    name: 'Berlin Gateway Node 3',
    location_id: 'loc-hub-berlin',
    rawKey: 'sec_live_berlin_telecom_03',
  },
  // Legacy fixture device for automated test backwards-compatibility
  {
    id: 'dev-001',
    name: 'Telemetry Test Rig Alpha',
    location_id: 'loc-facility-austin',
    rawKey: 'key-dev-001-secret',
  },
];

export async function runSeed(): Promise<void> {
  const pool = createDbPool();
  const sinkBase = process.env.NOTIFICATION_SINK_URL || 'http://notification-sink:4000/webhook';

  try {
    logger.info('Starting database seeding with primary fleet devices...');

    await withTransaction(pool, async (client) => {
      // 1. Locations
      const locations = [
        {
          id: 'loc-facility-austin',
          name: 'Austin Advanced Manufacturing Facility',
          metadata: JSON.stringify({ region: 'us-south', facility_type: 'manufacturing' }),
        },
        {
          id: 'loc-hub-berlin',
          name: 'Berlin Central Logistics Hub',
          metadata: JSON.stringify({ region: 'eu-central', facility_type: 'distribution' }),
        },
        // Legacy location for test backwards-compatibility
        {
          id: 'loc-warehouse-1',
          name: 'Legacy Test Lab Alpha',
          metadata: JSON.stringify({ region: 'test' }),
        },
        {
          id: 'loc-datacenter-1',
          name: 'Legacy Test Lab Beta',
          metadata: JSON.stringify({ region: 'test' }),
        },
      ];

      for (const loc of locations) {
        await client.query(
          `INSERT INTO locations (id, name, metadata)
           VALUES ($1, $2, $3::jsonb)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, metadata = EXCLUDED.metadata`,
          [loc.id, loc.name, loc.metadata]
        );
      }

      // 2. Operators
      const operators = [
        {
          id: 'op-sarah',
          name: 'Sarah Jenkins',
          email: 'sarah.jenkins@aps-ops.net',
          webhook_url: sinkBase,
          location_ids: ['loc-facility-austin', 'loc-warehouse-1'],
          location_id: 'loc-facility-austin',
        },
        {
          id: 'op-marcus',
          name: 'Marcus Vance',
          email: 'marcus.vance@aps-ops.net',
          webhook_url: sinkBase,
          location_ids: ['loc-hub-berlin', 'loc-datacenter-1'],
          location_id: 'loc-hub-berlin',
        },
        // Legacy operators for test backwards-compatibility
        {
          id: 'op-alice',
          name: 'Alice Chen (Legacy)',
          email: 'alice@example.com',
          webhook_url: sinkBase,
          location_ids: ['loc-facility-austin', 'loc-warehouse-1'],
          location_id: 'loc-facility-austin',
        },
        {
          id: 'op-bob',
          name: 'Bob Smith (Legacy)',
          email: 'bob@example.com',
          webhook_url: sinkBase,
          location_ids: ['loc-hub-berlin', 'loc-datacenter-1'],
          location_id: 'loc-hub-berlin',
        },
      ];

      for (const op of operators) {
        await client.query(
          `INSERT INTO operators (id, name, email, webhook_url, location_ids, location_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO UPDATE 
           SET name = EXCLUDED.name,
               email = EXCLUDED.email,
               webhook_url = EXCLUDED.webhook_url,
               location_ids = EXCLUDED.location_ids,
               location_id = EXCLUDED.location_id`,
          [op.id, op.name, op.email, op.webhook_url, op.location_ids, op.location_id]
        );
      }

      // 3. Devices
      for (const dev of SEED_DEVICES) {
        const keyHash = hashDeviceKey(dev.rawKey);
        await client.query(
          `INSERT INTO devices (id, name, location_id, key_hash, status)
           VALUES ($1, $2, $3, $4, 'offline')
           ON CONFLICT (id) DO UPDATE 
           SET name = EXCLUDED.name,
               location_id = EXCLUDED.location_id,
               key_hash = EXCLUDED.key_hash`,
          [dev.id, dev.name, dev.location_id, keyHash]
        );
      }

      // 4. Sample Rules
      const rules = [
        {
          id: 'rule-temp-high',
          name: 'High Temperature Threshold (> 80°C)',
          type: 'threshold',
          config: JSON.stringify({ field: 'temperature', operator: '>', value: 80 }),
          scope: JSON.stringify({ type: 'all' }),
          severity: 'critical',
          enabled: true,
          cooldown: 0,
        },
        {
          id: 'rule-device-absence',
          name: 'Device Silence Absence (> 60s)',
          type: 'absence',
          config: JSON.stringify({ timeout_seconds: 60 }),
          scope: JSON.stringify({ type: 'all' }),
          severity: 'warning',
          enabled: true,
          cooldown: 0,
        },
        {
          id: 'rule-device-error',
          name: 'Hardware Error Alert (device.error)',
          type: 'event_type',
          config: JSON.stringify({ event_type: 'device.error' }),
          scope: JSON.stringify({ type: 'all' }),
          severity: 'critical',
          enabled: true,
          cooldown: 0,
        },
      ];

      for (const r of rules) {
        await client.query(
          `INSERT INTO rules (id, name, rule_type, config, scope, severity, enabled, cooldown)
           VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE 
           SET name = EXCLUDED.name,
               rule_type = EXCLUDED.rule_type,
               config = EXCLUDED.config,
               scope = EXCLUDED.scope,
               severity = EXCLUDED.severity,
               enabled = EXCLUDED.enabled,
               cooldown = EXCLUDED.cooldown`,
          [r.id, r.name, r.type, r.config, r.scope, r.severity, r.enabled, r.cooldown]
        );
      }
    });

    logger.info('Database seeded successfully with operational entities');
  } catch (err) {
    logger.error({ err }, 'Failed to seed database');
    throw err;
  } finally {
    await pool.end();
  }
}
