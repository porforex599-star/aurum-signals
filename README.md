# Aurum Analysis

Premium market-analysis subscription service — XAUUSD, EURUSD, BTCUSD analysis from TradingView Pine Script indicators.

## Status

🚧 **Early MVP scaffold** — static frontend with an access gate (Option A); live data still mocked

## What's here

- `index.html` — Landing page with pricing ($20/week, $60/month)
- `room.html` — Live analysis room with TradingView widget embedded + mock analysis cards, behind an access gate
- `vercel.json` — Vercel deploy config

## Local preview

Just open the files in your browser — no build step needed.

```bash
# Or serve with any static server
npx serve .
# Open http://localhost:3000
```

> Note: the room's access gate calls the aurum-crm Supabase Auth endpoint and the
> aurum-customers `wallet-subscriptions` edge function. Local file/`localhost`
> preview will show the **login overlay**; passing the gate requires a real
> aurum-crm session with an active `aurum_analysis` subscription.

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to vercel.com → "Add New Project" → import the repo
3. Framework preset: **Other** (it's plain static HTML)
4. Click Deploy
5. Your live URL will be `https://aurum-signals.vercel.app` (or your custom domain)

## Tech stack

| Layer | Tool |
|---|---|
| Frontend | HTML + Tailwind CDN + Vanilla JS |
| Charts | TradingView Advanced Chart Widget (free) |
| Auth | Supabase Auth (aurum-crm project) |
| Entitlement | `wallet-subscriptions` edge fn (aurum-customers) → checks active `aurum_analysis` sub |
| Database | Supabase Postgres |
| Realtime | Supabase Realtime + Presence (planned) |
| Push | Web Push API + Service Worker (PWA) (planned) |
| Payment | Handled on aurumlive.com (Railway Wallet API) |
| Analysis source | TradingView Pine Script → webhook → Supabase Edge Function (planned) |

## Access gate (Option A)

`room.html` is gated before render:

1. Reads the aurum-crm session from this origin's `localStorage`
   (`sb-jdelizsmiwpushoeafen-auth-token`).
2. **No session** → inline login overlay (aurum-crm Supabase Auth).
3. **Has session** → POST `wallet-subscriptions` with the aurum-crm bearer;
   require an `active`, non-expired row with `product_type === 'aurum_analysis'`.
4. **No active subscription** → "subscribe first" screen linking to
   `aurumlive.com/package`.

The gate fails closed (the room stays hidden) on any error. It re-checks the
subscription every 5 minutes to soft-kick a session whose subscription lapses.

The aurum-crm anon key embedded in `room.html` is a **publishable** key (public
by design), not a secret.

## Next steps (in order)

1. **Realtime feed** — replace mock data with a live Supabase subscription
2. **tv-webhook Edge Function** — receive TradingView alerts, INSERT analysis rows
3. **Presence** — track who's online + viewing each analysis card
4. **Push notifications** — service worker + VAPID keys + send on new analysis
5. **Token handoff (Option B)** — short-lived handoff from aurumlive.com to skip
   the second login
6. **Pine Script indicator** — overlay with hline() for key level / target zone /
   risk level (publish on TradingView)

## Mock data

The 3 analysis cards shown in `room.html` are hardcoded in the `MOCK_SIGNALS`
constant inside the `<script>` block (internal identifier — not user-visible).
Replace with a live Supabase subscription once the backend feed is ready.

## TradingView Webhook setup (when backend ready)

In TradingView alert settings, paste this webhook URL:

```
https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/tv-webhook
```

Alert message body (internal field names):

```json
{
  "symbol": "{{ticker}}",
  "direction": "{{strategy.order.action}}",
  "entry": {{close}},
  "tp": {{plot_0}},
  "sl": {{plot_1}},
  "timeframe": "{{interval}}",
  "timestamp": "{{time}}"
}
```

## License

Proprietary © 2026 AURUM AI
