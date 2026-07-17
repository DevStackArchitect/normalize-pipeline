import { describe, expect, it } from 'vitest';
import { RazorpayPayment, createRazorpayAdapter, mapPayment } from '../src/adapters/razorpay';
import { validateAndUpsertBatch } from '../src/sync/upsert';
import { makeFakePool } from './helpers';

const paymentJson: RazorpayPayment = {
  id: 'pay_webhook_1',
  entity: 'payment',
  amount: 4200,
  currency: 'inr',
  created_at: 1767225600,
  description: 'Test payment',
};

describe('webhook path vs sync path', () => {
  it('maps an event envelope and a bare payment to the same normalized record', () => {
    const adapter = createRazorpayAdapter('rzp_test_dummy', 'dummy_secret');
    const viaEnvelope = adapter.mapWebhookPayload({
      entity: 'event',
      account_id: 'acc_demo',
      event: 'payment.captured',
      contains: ['payment'],
      payload: { payment: { entity: paymentJson } },
    });
    const viaBarePayment = adapter.mapWebhookPayload(paymentJson);
    const viaSyncMapper = mapPayment(paymentJson);

    expect(viaEnvelope).toEqual([viaSyncMapper]);
    expect(viaBarePayment).toEqual([viaSyncMapper]);
  });

  it('writes identical rows through the single upsert code path', async () => {
    const adapter = createRazorpayAdapter('rzp_test_dummy', 'dummy_secret');
    const webhookRecords = adapter.mapWebhookPayload({
      entity: 'event',
      payload: { payment: { entity: paymentJson } },
    });
    const syncRecords = [mapPayment(paymentJson)];

    const webhookRun = makeFakePool();
    await validateAndUpsertBatch(webhookRun.pool, webhookRecords, 'razorpay');
    const syncRun = makeFakePool();
    await validateAndUpsertBatch(syncRun.pool, syncRecords, 'razorpay');

    const webhookWrites = webhookRun.captured.filter((q) => q.text.includes('INSERT INTO records'));
    const syncWrites = syncRun.captured.filter((q) => q.text.includes('INSERT INTO records'));

    expect(webhookWrites).toEqual(syncWrites);
    expect(webhookWrites).toHaveLength(1);
    expect(webhookWrites[0]?.text).toContain('ON CONFLICT (source, external_id) DO UPDATE');
  });

  it('rejects garbage webhook payloads into quarantine instead of throwing', async () => {
    const adapter = createRazorpayAdapter('rzp_test_dummy', 'dummy_secret');
    const mapped = adapter.mapWebhookPayload({ entity: 'payment', description: 'no id at all' });
    const { pool, captured } = makeFakePool();
    const result = await validateAndUpsertBatch(pool, mapped, 'razorpay');
    expect(result).toEqual({ upserted: 0, rejected: 1 });
    expect(captured.filter((q) => q.text.includes('rejected_records'))).toHaveLength(1);
  });
});
