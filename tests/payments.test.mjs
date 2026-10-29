import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentsHub, verifyStripeSignature } from "../payments/hub.mjs";

async function setup(t, review_mode="owner") {
  const root = await mkdtemp(join(tmpdir(), "sync30-payments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "orders.json");
  const hub = await new PaymentsHub(file).init();
  await hub.upsertProduct({
    app_id: "future-app", sku: "premium-once", stripe_price_id: "price_12345678",
    currency: "eur", amount_cents: 299, review_mode
  });
  let count = 0;
  const fetchFn = async (url, req) => {
    count++;
    assert.equal(url, "https://api.stripe.com/v1/checkout/sessions");
    assert.equal(req.method, "POST");
    assert.match(req.headers.authorization, /^Bearer sk_test_/);
    return {
      ok: true, json: async () => ({ id: "cs_test_12345678" + count,
        url: "https://checkout.stripe.com/c/pay/cs_test_12345678" + count })
    };
  };
  async function start() {
    return hub.startCheckout({
      app_id: "future-app", sku: "premium-once", account_id: "customer-123"
    }, { secretKey: "sk_test_fake_for_offline_test_only",
      successUrl: "https://example.test/success",
      cancelUrl: "https://example.test/cancel", fetchFn });
  }
  const success = (order_id, number = count) => ({
    id: "evt_abcdefgh" + number, type: "checkout.session.completed",
    data: { object: {
      id: "cs_test_12345678" + number, client_reference_id: order_id,
      payment_status: "paid", mode: "payment", currency: "eur",
      amount_total: 299, payment_intent: "pi_fakepayment" + number
    } }
  });
  return { hub, file, start, success };
}
test("Stripe signatures: raw bytes, timestamp and constant-time comparison", () => {
  const body = Buffer.from('{"id":"evt_abcdefgh1"}');
  const secret = "whsec_test_123456789";
  const timestamp = 1793270000;
  const signature = createHmac("sha256", secret).update(String(timestamp) + ".").update(body).digest("hex");
  assert.equal(verifyStripeSignature(body, "t=" + timestamp + ",v1=" + signature, secret, timestamp), true);
  assert.equal(verifyStripeSignature(Buffer.from("edited"), "t=" + timestamp + ",v1=" + signature, secret, timestamp), false);
  assert.equal(verifyStripeSignature(body, "t=" + timestamp + ",v1=" + signature, secret, timestamp + 301), false);
  assert.equal(verifyStripeSignature(body, "t=" + timestamp + ",v1=" + "0".repeat(64), secret, timestamp), false);
});
test("attempt is not a completed payment or active license", async t => {
  const { hub, start } = await setup(t);
  const order = await start();
  assert.equal(order.status, "pending");
  assert.match(order.checkout_url, /^https:\/\/checkout\.stripe\.com\//);
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, []);
  assert.deepEqual(hub.getReviewQueue(), []);
});
test("real paid event then owner confirmation enables license, full refund revokes it", async t => {
  const { hub, start, success, file } = await setup(t);
  const order = await start();
  const confirmed = success(order.order_id);
  assert.deepEqual(await hub.acceptVerifiedStripeEvent(confirmed), {
    duplicate: false, type: confirmed.type, matched: true
  });
  assert.equal(hub.getReviewQueue().length, 1);
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, []);
  assert.equal((await hub.reviewPaidOrder({ order_id: order.order_id,
    decision: "approve", reviewer_id: "owner-chk" })).approval_status, "approved");
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, ["premium-once"]);
  assert.equal((await hub.acceptVerifiedStripeEvent(confirmed)).duplicate, true);
  const restored = await new PaymentsHub(file).init();
  assert.deepEqual(restored.getLicenses("future-app", "customer-123").active_skus, ["premium-once"]);
  await restored.acceptVerifiedStripeEvent({
    id: "evt_refund1234", type: "charge.refunded",
    data: { object: { payment_intent: "pi_fakepayment1",
      amount: 299, amount_refunded: 299 } }
  });
  assert.deepEqual(restored.getLicenses("future-app", "customer-123").active_skus, []);
});
test("owner cannot approve unpaid, denied or mismatched checkouts", async t => {
  const { hub, start, success } = await setup(t);
  const order = await start();
  await assert.rejects(hub.reviewPaidOrder({
    order_id: order.order_id, decision: "approve", reviewer_id: "owner-chk"
  }), /order_not_reviewable/);
  const wrong = success(order.order_id);
  wrong.data.object.amount_total = 999;
  await assert.rejects(hub.acceptVerifiedStripeEvent(wrong), /checkout_total_mismatch/);
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, []);
  await hub.acceptVerifiedStripeEvent(success(order.order_id));
  await hub.reviewPaidOrder({ order_id: order.order_id, decision: "deny", reviewer_id: "owner-chk" });
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, []);
  await assert.rejects(hub.reviewPaidOrder({
    order_id: order.order_id, decision: "approve", reviewer_id: "owner-chk"
  }), /order_not_reviewable/);
});
test("automatic review requires paid event, no manual phone approval", async t => {
  const { hub, start, success } = await setup(t, "automatic");
  const order = await start();
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, []);
  await hub.acceptVerifiedStripeEvent(success(order.order_id));
  assert.deepEqual(hub.getLicenses("future-app", "customer-123").active_skus, ["premium-once"]);
  assert.deepEqual(hub.getReviewQueue(), []);
});
