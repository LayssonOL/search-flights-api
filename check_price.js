/**
 * check-price-watches
 * ------------------------------------------------------------
 * Run on a schedule (cron). For every registered watch:
 *   1. Re-search Duffel for the same route/dates
 *   2. Compare cheapest offer to last_seen_price / target_price
 *   3. Email the user via Resend if it dropped
 *   4. Update last_seen_price in Redis
 *
 * Run with: node check-price-watches.js
 * Requires: npm install node-fetch (or Node 18+, which has fetch built in)
 * Env vars:
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 *   DUFFEL_API_KEY
 *   RESEND_API_KEY
 */

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const DUFFEL_API_KEY = process.env.DUFFEL_API_KEY;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function redisGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  return data.result ? JSON.parse(data.result) : null;
}

async function redisSet(key, value) {
  await fetch(`${UPSTASH_URL}/set/${key}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: JSON.stringify(value),
  });
}

async function redisSmembers(setKey) {
  const res = await fetch(`${UPSTASH_URL}/smembers/${setKey}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const data = await res.json();
  return data.result || [];
}

async function searchCheapestOffer(watch) {
  const slices = [
    {
      origin: watch.origin,
      destination: watch.destination,
      departure_date: watch.departure_date,
    },
  ];
  if (watch.return_date) {
    slices.push({
      origin: watch.destination,
      destination: watch.origin,
      departure_date: watch.return_date,
    });
  }

  const res = await fetch(
    "https://api.duffel.com/air/offer_requests?return_offers=true",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "Duffel-Version": "v2",
        Authorization: `Bearer ${DUFFEL_API_KEY}`,
      },
      body: JSON.stringify({
        data: {
          cabin_class: watch.cabin_class,
          passengers: [{ type: "adult" }],
          slices,
        },
      }),
    }
  );

  if (!res.ok) return null;
  const data = await res.json();
  const offers = data.data?.offers || [];
  if (offers.length === 0) return null;

  return offers.reduce((min, o) =>
    parseFloat(o.total_amount) < parseFloat(min.total_amount) ? o : min
  );
}

async function sendPriceDropEmail(watch, newPrice) {
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: "Flight Scout <onboarding@resend.dev>",
      to: [watch.email],
      subject: `Price drop: ${watch.origin} to ${watch.destination}`,
      html: `<p>Good news — the price for <strong>${watch.origin} to ${watch.destination}</strong> on ${watch.departure_date} just dropped to <strong>$${newPrice}</strong>.</p>`,
    }),
  });
}

async function run() {
  const watchIds = await redisSmembers("watch:index");
  console.log(`Checking ${watchIds.length} watches...`);

  for (const id of watchIds) {
    const watch = await redisGet(`watch:${id}`);
    if (!watch) continue;

    const cheapest = await searchCheapestOffer(watch);
    if (!cheapest) continue;

    const newPrice = parseFloat(cheapest.total_amount);
    const previousPrice = watch.last_seen_price;
    const targetPrice = watch.target_price;

    const droppedFromLastSeen = previousPrice !== null && newPrice < previousPrice;
    const hitTarget = targetPrice !== null && newPrice <= targetPrice;

    if (droppedFromLastSeen || hitTarget) {
      console.log(`Price drop for watch ${id}: $${newPrice}`);
      await sendPriceDropEmail(watch, newPrice);
    }

    await redisSet(`watch:${id}`, { ...watch, last_seen_price: newPrice });
  }
}

run().then(() => console.log("Done.")).catch(console.error);
