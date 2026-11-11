import { createHash, createSign } from "node:crypto";

/**
 * Adaptateur Google Play réutilisable dans CHK Paiements.
 * Aucune clé Google dans les APK. Toutes les validations interrogent Google.
 * Utilisé derrière la terminaison HTTPS dédiée (sidecar toujours loopback).
 */
const ALLOWED = Object.freeze({
  "com.chk.blocnote": "blocnote_premium_lifetime",
  "com.chk.rushstudio": "rush_premium"
});
const sha = s => createHash("sha256").update(s, "utf8").digest("hex");
const jwtPart = o => Buffer.from(JSON.stringify(o)).toString("base64url");

export class GooglePlayVerifier {
  constructor(options = {}) {
    const env = options.env || process.env;
    this.fetchFn = options.fetchFn || fetch;
    this.enabled = options.enabled === undefined ?
      env.CHK_GOOGLE_PLAY_BILLING_ENABLED === "true" : options.enabled;
    this.serviceAccount = options.serviceAccount;
    if (this.serviceAccount === undefined) {
      try { this.serviceAccount = JSON.parse(env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || "null"); }
      catch { this.serviceAccount = null; }
    }
    this.cachedOAuth = {token:"",expiresAt:0};
    this.googleApi = options.googleApi || "https://androidpublisher.googleapis.com";
    this.oauthApi = options.oauthApi || "https://oauth2.googleapis.com/token";
  }

  configured() {
    return this.enabled && typeof this.serviceAccount?.client_email === "string"
      && typeof this.serviceAccount?.private_key === "string"
      && this.serviceAccount.private_key.includes("PRIVATE KEY");
  }

  async oauthToken() {
    if (!this.configured()) throw new Error("google_play_not_configured");
    if (this.cachedOAuth.token && Date.now() < this.cachedOAuth.expiresAt) return this.cachedOAuth.token;
    const now = Math.floor(Date.now() / 1000);
    const claim = {
      iss: this.serviceAccount.client_email,
      scope: "https://www.googleapis.com/auth/androidpublisher",
      aud: this.oauthApi,
      iat: now, exp: now + 3000
    };
    const unsigned = jwtPart({alg:"RS256",typ:"JWT"}) + "." + jwtPart(claim);
    const signature = createSign("RSA-SHA256").update(unsigned).sign(
      this.serviceAccount.private_key.replace(/\\n/g, "\n"), "base64url");
    const response = await this.fetchFn(this.oauthApi, {
      method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},
      body:new URLSearchParams({
        grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion:unsigned+"."+signature
      }).toString(),
      signal:AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error("oauth_not_available");
    const json = await response.json();
    if (typeof json.access_token !== "string" || json.access_token.length < 10)
      throw new Error("oauth_invalid_response");
    this.cachedOAuth = {
      token:json.access_token,
      expiresAt:Date.now()+Math.min(Number(json.expires_in)||3000,3000)*1000-60000
    };
    return this.cachedOAuth.token;
  }

  async ready() {
    if (!this.configured()) return false;
    try { return Boolean(await this.oauthToken()); } catch { return false; }
  }

  validateInput(body) {
    const {packageName,productId,purchaseToken} = body || {};
    if (typeof packageName !== "string" || typeof productId !== "string"
       || ALLOWED[packageName] !== productId) throw new Error("invalid_product");
    if (typeof purchaseToken !== "string" || purchaseToken.length < 20
       || purchaseToken.length > 4096 || !/^[A-Za-z0-9._:=\\-]+$/.test(purchaseToken))
       throw new Error("invalid_purchase_token");
    return {packageName,productId,purchaseToken};
  }

  async verify(body) {
    const {packageName,productId,purchaseToken} = this.validateInput(body);
    const bearer = await this.oauthToken();
    const url = this.googleApi + "/androidpublisher/v3/applications/"
      + encodeURIComponent(packageName) + "/purchases/productsv2/tokens/"
      + encodeURIComponent(purchaseToken);
    const response = await this.fetchFn(url,{
      method:"GET",
      headers:{authorization:"Bearer "+bearer,accept:"application/json"},
      signal:AbortSignal.timeout(10000)
    });
    if (response.status === 404 || response.status === 400) return {
      verified:false,packageName,productId,code:"token_not_found",tokenHash:sha(purchaseToken)
    };
    if (!response.ok) throw new Error("google_play_request_failed_"+response.status);
    const item = await response.json();
    const purchased = item.purchaseStateContext?.purchaseState === "PURCHASED";
    const correct = Array.isArray(item.productLineItem)
      && item.productLineItem.some(x => x.productId === productId
          && x.productOfferDetails?.consumptionState !== "CONSUMPTION_STATE_CONSUMED");
    const valid = purchased && correct;
    return {
      verified:valid, packageName, productId, tokenHash:sha(purchaseToken),
      state:item.purchaseStateContext?.purchaseState || "UNKNOWN",
      acknowledged:item.acknowledgementState === "ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED",
      // Éviter de supposer un prix ou une monnaie : Google Play peut varier selon le pays.
      orderId:typeof item.orderId==="string" ? item.orderId.slice(0,96) : null
    };
  }
}
