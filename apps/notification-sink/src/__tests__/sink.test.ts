import { describe, it, expect, beforeEach } from 'vitest';
import { buildNotificationSink } from '../index.js';

describe('Notification Sink Server', () => {
  let app: ReturnType<typeof buildNotificationSink>;

  beforeEach(() => {
    app = buildNotificationSink();
  });

  it('receives webhook and stores notification with idempotency key, exposes GET /received', async () => {
    const payload = {
      incident_id: '123e4567-e89b-12d3-a456-426614174000',
      rule_name: 'High Temperature Critical',
      device_id: 'dev-001',
    };

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'Idempotency-Key': 'outbox-key-1',
      },
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.duplicate).toBe(false);
    expect(body.idempotency_key).toBe('outbox-key-1');
    const firstReceivedId = body.received_id;

    // Verify stored via GET /received
    const listRes = await app.inject({
      method: 'GET',
      url: '/received',
    });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(list.total).toBe(1);
    expect(list.notifications[0].idempotencyKey).toBe('outbox-key-1');
    expect(list.notifications[0].body).toEqual(payload);

    // Duplicate submission with same Idempotency-Key
    const dupRes = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: {
        'Idempotency-Key': 'outbox-key-1',
      },
      payload,
    });
    expect(dupRes.statusCode).toBe(200);
    const dupBody = dupRes.json();
    expect(dupBody.status).toBe('ok');
    expect(dupBody.duplicate).toBe(true);
    expect(dupBody.received_id).toBe(firstReceivedId);

    // Verify still exactly 1 notification in GET /received
    const listResAfterDup = await app.inject({
      method: 'GET',
      url: '/received',
    });
    expect(listResAfterDup.json().total).toBe(1);
  });

  it('admin mode simulation: ok, fail, slow', async () => {
    // 1. Set mode to "fail"
    const failAdminRes = await app.inject({
      method: 'POST',
      url: '/admin/mode',
      payload: { mode: 'fail' },
    });
    expect(failAdminRes.statusCode).toBe(200);
    expect(failAdminRes.json().mode).toBe('fail');

    const failReq = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { test: true },
    });
    expect(failReq.statusCode).toBe(503);
    expect(failReq.json().error).toContain('Simulation outage: Sink failure mode active');

    // 2. Set mode to "slow"
    const slowAdminRes = await app.inject({
      method: 'POST',
      url: '/admin/mode',
      payload: { mode: 'slow', slow_delay_ms: 100 },
    });
    expect(slowAdminRes.statusCode).toBe(200);
    expect(slowAdminRes.json().mode).toBe('slow');

    const startMs = Date.now();
    const slowReq = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { test: true },
    });
    const elapsed = Date.now() - startMs;
    expect(slowReq.statusCode).toBe(200);
    expect(elapsed).toBeGreaterThanOrEqual(90);

    // 3. Set mode back to "ok"
    const okAdminRes = await app.inject({
      method: 'POST',
      url: '/admin/mode',
      payload: { mode: 'ok' },
    });
    expect(okAdminRes.statusCode).toBe(200);
    expect(okAdminRes.json().mode).toBe('ok');

    const okReq = await app.inject({
      method: 'POST',
      url: '/webhook',
      payload: { test: true },
    });
    expect(okReq.statusCode).toBe(200);
  });
});
