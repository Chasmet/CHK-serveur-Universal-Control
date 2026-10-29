import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const keyPattern = /^[a-z0-9][a-z0-9_.-]{1,79}$/;
const accountPattern = /^[a-zA-Z0-9_.:-]{3,128}$/;
const eventPattern = /^evt_[a-zA-Z0-9]{8,}$/;
const sessionPattern = /^cs_(test|live)_[a-zA-Z0-9]+$/;
const pricePattern = /^price_[a-zA-Z0-9]+$/;
const intentId = value => typeof value === "string" ? value : value?.id || "";
const error = code => { const e = Error(code); e.code = code; return e; };
const productKey = (app, sku) => app + ":" + sku;

export function verifyStripeSignature(raw, header, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) return false;
  if (typeof header !== "string" || !Buffer.isBuffer(raw) || raw.length > 262144) return false;
  const chunks = header.split(",").map(x => x.trim().split("="));
  const timestamp = chunks.find(([k]) => k === "t")?.[1];
  const signatures = chunks.filter(([k]) => k === "v1").map(([,v]) => v);
  if (!/^\d{10,}$/.test(timestamp || "")) return false;
  if (Math.abs(nowSeconds - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(timestamp + ".").update(raw).digest();
  return signatures.some(sig => {
    if (!/^[a-f0-9]{64}$/i.test(sig || "")) return false;
    return timingSafeEqual(expected, Buffer.from(sig, "hex"));
  });
}

export class PaymentsHub {
  constructor(file) {
    this.file = file;
    this.state = { schema: 1, products: {}, orders: {}, events: {} };
    this.serial = Promise.resolve();
  }

  async init() {
    try {
      const loaded = JSON.parse(await readFile(this.file, "utf8"));
      if (loaded.schema !== 1 || !loaded.products || !loaded.orders || !loaded.events) throw error("invalid_payments_data");
      this.state = loaded;
    } catch (e) {
      if (e.code !== "ENOENT") throw e; // never overwrite corrupt production data
    }
    return this;
  }

  async mutate(fn) {
    const job = this.serial.then(async () => {
      const result = await fn(this.state);
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + "." + randomUUID() + ".tmp";
      await writeFile(tmp, JSON.stringify(this.state), { mode: 0o600 });
      await rename(tmp, this.file);
      return result;
    });
    this.serial = job.catch(() => {});
    return job;
  }

  async upsertProduct(input) {
    const { app_id, sku, stripe_price_id, currency = "eur", amount_cents, active = true, review_mode = "automatic" } = input || {};
    if (!keyPattern.test(app_id || "") || !keyPattern.test(sku || "")) throw error("invalid_product_identity");
    if (!pricePattern.test(stripe_price_id || "")) throw error("invalid_stripe_price");
    if (typeof currency !== "string" || !/^[a-z]{3}$/.test(currency)) throw error("invalid_currency");
    if (!Number.isSafeInteger(amount_cents) || amount_cents < 50 || amount_cents > 100000000) throw error("invalid_amount");
    if (typeof active !== "boolean") throw error("invalid_status");
    if (!["automatic", "owner"].includes(review_mode)) throw error("invalid_review_mode");
    return this.mutate(state => {
      const product = { app_id, sku, stripe_price_id, currency, amount_cents, active, review_mode, updated_at: Date.now() };
      state.products[productKey(app_id, sku)] = product;
      return product;
    });
  }

  listProducts() { return Object.values(this.state.products); }

  async startCheckout(input, { secretKey, successUrl, cancelUrl, fetchFn = fetch } = {}) {
    const { app_id, sku, account_id } = input || {};
    if (!keyPattern.test(app_id || "") || !keyPattern.test(sku || "") || !accountPattern.test(account_id || "")) throw error("invalid_checkout_identity");
    if (!secretKey?.startsWith("sk_test_") && !secretKey?.startsWith("sk_live_")) throw error("stripe_not_configured");
    for (const dest of [successUrl, cancelUrl]) {
      if (!/^https:\/\/[^/]+\/.+/.test(dest || "")) throw error("invalid_checkout_redirect");
    }
    const product = this.state.products[productKey(app_id, sku)];
    if (!product?.active) throw error("product_not_available");

    const order = await this.mutate(state => {
      const id = randomUUID();
      const record = { id, app_id, sku, account_id, price_id: product.stripe_price_id,
        status: "creating", approval_status: product.review_mode === "owner" ? "awaiting_payment" : "not_required",
        created_at: Date.now(), stripe_session: "", payment_intent: "" };
      state.orders[id] = record;
      return { ...record };
    });
    try {
      const body = new URLSearchParams({
        mode: "payment", "line_items[0][price]": product.stripe_price_id,
        "line_items[0][quantity]": "1", client_reference_id: order.id,
        "metadata[order_id]": order.id, success_url: successUrl, cancel_url: cancelUrl
      });
      const reply = await fetchFn("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { authorization: "Bearer " + secretKey, "content-type": "application/x-www-form-urlencoded",
          "idempotency-key": order.id },
        body: body.toString(), redirect: "error", signal: AbortSignal.timeout(15000)
      });
      if (!reply.ok) throw error("stripe_checkout_failed");
      const session = await reply.json();
      if (!sessionPattern.test(session.id || "") || !/^https:\/\/checkout\.stripe\.com\//.test(session.url || ""))
        throw error("invalid_stripe_response");
      await this.mutate(state => {
        state.orders[order.id].stripe_session = session.id;
        state.orders[order.id].status = "pending";
      });
      return { order_id: order.id, status: "pending", checkout_url: session.url };
    } catch (e) {
      await this.mutate(state => { if (state.orders[order.id]?.status === "creating") state.orders[order.id].status = "error"; });
      throw e;
    }
  }

  async acceptVerifiedStripeEvent(event) {
    if (!eventPattern.test(event?.id || "")) throw error("invalid_event");
    if (typeof event.type !== "string" || !event.data?.object) throw error("invalid_event");
    return this.mutate(state => {
      if (state.events[event.id]) return { duplicate: true };
      const obj = event.data.object;
      const completed = ["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type);
      const failed = event.type === "checkout.session.async_payment_failed";
      const reversed = ["charge.refunded", "charge.dispute.created"].includes(event.type);
      let matched = null;
      if (completed || failed) {
        matched = Object.values(state.orders).find(order => order.stripe_session === obj.id);
        if (!matched) throw error("unknown_checkout_session");
        // The session must match the order created on our server.
        if (obj.client_reference_id !== matched.id) throw error("session_reference_mismatch");
        if (completed && obj.payment_status === "paid" && matched.status !== "refunded" && matched.status !== "disputed") {
          if (obj.mode !== "payment" || obj.currency !== state.products[productKey(matched.app_id, matched.sku)]?.currency ||
              obj.amount_total !== state.products[productKey(matched.app_id, matched.sku)]?.amount_cents) {
            throw error("checkout_total_mismatch");
          }
          matched.status = "paid";
          matched.payment_intent = intentId(obj.payment_intent);
          matched.paid_at = Date.now();
          if (matched.approval_status === "awaiting_payment") matched.approval_status = "pending";
        }
        if (failed && matched.status !== "paid") matched.status = "failed";
      } else if (reversed) {
        const pid = intentId(obj.payment_intent);
        if (pid && (event.type !== "charge.refunded" || (Number.isFinite(obj.amount) && obj.amount_refunded >= obj.amount))) {
          for (const order of Object.values(state.orders)) {
            if (order.payment_intent !== pid) continue;
            order.status = event.type === "charge.refunded" ? "refunded" : "disputed";
            order.revoked_at = Date.now();
          }
        }
      }
      state.events[event.id] = { type: event.type, received_at: Date.now(), matched: matched?.id || null };
      return { duplicate: false, type: event.type, matched: Boolean(matched) };
    });
  }

  getReviewQueue() {
    return Object.values(this.state.orders).filter(o => o.status === "paid" && o.approval_status === "pending")
      .map(o => ({ order_id: o.id, app_id: o.app_id, sku: o.sku, paid_at: o.paid_at, status: o.status }))
      .sort((a, b) => (b.paid_at || 0) - (a.paid_at || 0));
  }

  getActivity() {
    return Object.values(this.state.orders).map(o => ({ order_id: o.id, app_id: o.app_id,
      sku: o.sku, status: o.status, approval_status: o.approval_status, created_at: o.created_at,
      paid_at: o.paid_at || null })).sort((a, b) => b.created_at - a.created_at);
  }

  async reviewPaidOrder({ order_id, decision, reviewer_id }) {
    if (typeof order_id !== "string" || !/^[a-f0-9-]{36}$/.test(order_id)) throw error("invalid_order_id");
    if (!["approve", "deny"].includes(decision)) throw error("invalid_review_decision");
    if (!accountPattern.test(reviewer_id || "")) throw error("invalid_reviewer");
    return this.mutate(state => {
      const order = state.orders[order_id];
      if (!order || order.status !== "paid" || order.approval_status !== "pending") throw error("order_not_reviewable");
      order.approval_status = decision === "approve" ? "approved" : "denied";
      order.reviewed_by = reviewer_id;
      order.reviewed_at = Date.now();
      return { order_id, approval_status: order.approval_status };
    });
  }

  getLicenses(app_id, account_id) {
    if (!keyPattern.test(app_id || "") || !accountPattern.test(account_id || "")) throw error("invalid_license_query");
    const orders = Object.values(this.state.orders).filter(o => o.app_id === app_id && o.account_id === account_id);
    const active = [...new Set(orders.filter(o => o.status === "paid" &&
      ["approved", "not_required"].includes(o.approval_status)).map(o => o.sku))].sort();
    return { app_id, account_id, active_skus: active, checked_at: Date.now() };
  }
}
