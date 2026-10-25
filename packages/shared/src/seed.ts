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
    id: 'dev-001',
    name: 'Warehouse Sensor A',
    location_id: 'loc-warehouse-1',
    rawKey: 'key-dev-001-secret',
  },
  {
    id: 'dev-002',
    name: 'Warehouse Gateway B',
    location_id: 'loc-warehouse-1',
    rawKey: 'key-dev-002-secret',
  },
  {
    id: 'dev-003',
    name: 'Datacenter HVAC 1',
    location_id: 'loc-datacenter-1',
    rawKey: 'key-dev-003-secret',
  },
  {
    id: 'dev-004',
    name: 'Datacenter Rack Monitor',
    location_id: 'loc-datacenter-1',
    rawKey: 'key-dev-004-secret',
  },
  {
    id: 'dev-005',
    name: 'Datacenter Edge Node',
    location_id: 'loc-datacenter-1',
    rawKey: 'key-dev-005-secret',
  },
];

export async function runSeed(): Promise<void> {
  const pool = createDbPool();
  const sinkBase = process.env.NOTIFICATION_SINK_URL || 'http://notification-sink:4000/webhook';

  try {
    logger.info('Starting database seeding...');

    await withTransaction(pool, async (client) => {
      // 1. Exactly 2 Locations
      const locations = [
        {
          id: 'loc-warehouse-1',
          name: 'East Coast Warehouse',
          metadata: JSON.stringify({ region: 'us-east' }),
        },
        {
          id: 'loc-datacenter-1',
          name: 'Northern Datacenter',
          metadata: JSON.stringify({ region: 'us-central' }),
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

      // 2. Exactly 2 Operators (id, name, webhook_url, location_ids)
      const operators = [
        {
          id: 'op-alice',
          name: 'Alice Chen',
          email: 'alice@example.com',
          webhook_url: sinkBase,
          location_ids: ['loc-warehouse-1'],
          location_id: 'loc-warehouse-1',
        },
        {
          id: 'op-bob',
          name: 'Bob Smith',
          email: 'bob@example.com',
          webhook_url: sinkBase,
          location_ids: ['loc-datacenter-1'],
          location_id: 'loc-datacenter-1',
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

      // 3. Exactly 5 Devices (id, name, location_id, key_hash, last_seen_at, last_event_ts, created_at)
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

      // 4. Exactly 3 Sample Rules (temp > 80, absence 60s, event_type "device.error")
      const rules = [
        {
          id: 'rule-temp-high',
          name: 'High Temperature Critical (> 80°C)',
          type: 'threshold',
          config: JSON.stringify({ field: 'temperature', operator: '>', value: 80 }),
          scope: JSON.stringify({ type: 'all' }),
          severity: 'critical',
          enabled: true,
          cooldown: 0,
        },
        {
          id: 'rule-device-absence',
          name: 'Device Absence 60s',
          type: 'absence',
          config: JSON.stringify({ timeout_seconds: 60 }),
          scope: JSON.stringify({ type: 'all' }),
          severity: 'warning',
          enabled: true,
          cooldown: 0,
        },
        {
          id: 'rule-device-error',
          name: 'Device Error Alert (device.error)',
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
          `INSERT INTO rules (id, name, type, rule_type, config, scope, scope_type, severity, enabled, cooldown)
           VALUES ($1, $2, $3, $3, $4::jsonb, $5::jsonb, 'all', $6, $7, $8)
           ON CONFLICT (id) DO UPDATE 
           SET name = EXCLUDED.name,
               type = EXCLUDED.type,
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

    // Print API keys to console for easy operator access
    console.log('\n========================================================================');
    console.log('       APS SEEDED DEVICE CREDENTIALS (USE WITH BEARER AUTH)             ');
    console.log('========================================================================');
    for (const dev of SEED_DEVICES) {
      console.log(
        `  Device: ${dev.id.padEnd(10)} | Location: ${dev.location_id.padEnd(18)} | Bearer Key: ${dev.rawKey}`
      );
    }
    console.log('========================================================================\n');

    logger.info('Database seeded successfully.');
  } finally {
    await pool.end();
  }
}

// Allow direct execution
const isMain =
  process.argv[1] && (process.argv[1].endsWith('seed.ts') || process.argv[1].endsWith('seed.js'));

if (isMain) {
  runSeed().catch((err) => {
    logger.error({ err }, 'Seeding failed');
    process.exit(1);
  });
}
