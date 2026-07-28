const ALLOWED_ORIGIN = 'chrome-extension://hnmilhngjfggfieamkielmmgjbnmmimp';
const MINIMUM_PAYOUT_CENTS = 100;
const MAXIMUM_PAYOUT_CENTS = 100_000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'authorization, content-type, idempotency-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function json(payload, status = 200, origin = ALLOWED_ORIGIN) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(origin),
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store'
    }
  });
}

function isAuthorized(request, env) {
  if (!env.PAYOUT_API_TOKEN) return false;
  return request.headers.get('Authorization') === `Bearer ${env.PAYOUT_API_TOKEN}`;
}

function validIdempotencyKey(value) {
  return typeof value === 'string' &&
    value.length >= 16 &&
    value.length <= 255 &&
    /^[A-Za-z0-9_-]+$/.test(value);
}

async function createStripePayout(env, amountCents, settlementId, installId) {
  const body = new URLSearchParams({
    amount: String(amountCents),
    currency: 'usd',
    'metadata[settlement_id]': settlementId,
    'metadata[install_id]': installId
  });
  const headers = {
    'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': settlementId
  };

  if (env.STRIPE_CONNECTED_ACCOUNT_ID) {
    headers['Stripe-Account'] = env.STRIPE_CONNECTED_ACCOUNT_ID;
  }

  const response = await fetch('https://api.stripe.com/v1/payouts', {
    method: 'POST',
    headers,
    body
  });
  const result = await response.json();

  if (!response.ok) {
    const message = result?.error?.message || 'Stripe rejected the payout.';
    throw new Error(message);
  }

  return result;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || ALLOWED_ORIGIN;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return json({
        ok: true,
        service: 'web-monetizer-payouts',
        payoutsEnabled: env.PAYOUTS_ENABLED === 'true',
        stripeConfigured: Boolean(env.STRIPE_SECRET_KEY)
      }, 200, origin);
    }

    if (request.method !== 'POST' || url.pathname !== '/api/payout') {
      return json({ error: 'Not found.' }, 404, origin);
    }

    if (!isAuthorized(request, env)) {
      return json({ error: 'Unauthorized.' }, 401, origin);
    }

    if (env.PAYOUTS_ENABLED !== 'true' || !env.STRIPE_SECRET_KEY) {
      return json({ error: 'Payout processing is not enabled.' }, 503, origin);
    }

    const idempotencyKey = request.headers.get('Idempotency-Key');
    if (!validIdempotencyKey(idempotencyKey)) {
      return json({ error: 'A valid idempotency key is required.' }, 400, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return json({ error: 'Invalid JSON.' }, 400, origin);
    }

    const amountCents = Math.round(Number(payload.netEarningsToAccount) * 100);
    if (
      !Number.isSafeInteger(amountCents) ||
      amountCents < MINIMUM_PAYOUT_CENTS ||
      amountCents > MAXIMUM_PAYOUT_CENTS
    ) {
      return json({ error: 'Payout amount is outside the allowed range.' }, 400, origin);
    }

    if (
      payload.settlementId !== idempotencyKey ||
      typeof payload.installId !== 'string' ||
      payload.installId.length < 16 ||
      payload.installId.length > 128
    ) {
      return json({ error: 'Invalid settlement metadata.' }, 400, origin);
    }

    try {
      const payout = await createStripePayout(
        env,
        amountCents,
        payload.settlementId,
        payload.installId
      );
      return json({
        accepted: true,
        payoutId: payout.id,
        status: payout.status,
        amount: payout.amount,
        currency: payout.currency
      }, 202, origin);
    } catch (error) {
      console.error('Stripe payout failed.', error);
      return json({ error: error.message }, 502, origin);
    }
  }
};
