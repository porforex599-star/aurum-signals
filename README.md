# AURUM Signals

Premium trading signal subscription service — XAUUSD, EURUSD, BTCUSD signals from TradingView Pine Script indicators.

## Status

🚧 **Early MVP scaffold** — static frontend only, no backend yet

## What's here

- `index.html` — Landing page with pricing ($20/week, $60/month)
- `room.html` — Live signal room with TradingView widget embedded + mock signals
- `vercel.json` — Vercel deploy config

## Local preview

Just open the files in your browser — no build step needed.

```bash
# Or serve with any static server
npx serve .
# Open http://localhost:3000
```

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to vercel.com → "Add New Project" → import the repo
3. Framework preset: **Other** (it's plain static HTML)
4. Click Deploy
5. Your live URL will be `https://aurum-signals.vercel.app` (or your custom domain)

## Tech stack (planned)

| Layer | Tool |
|---|---|
| Frontend | HTML + Tailwind CDN + Vanilla JS |
| Charts | TradingView Advanced Chart Widget (free) |
| Auth | Supabase Auth |
| Database | Supabase Postgres |
| Realtime | Supabase Realtime + Presence |
| Push | Web Push API + Service Worker (PWA) |
| Payment | Stripe (now) → INET Payment (when integration done) |
| Signal source | TradingView Pine Script → webhook → Supabase Edge Function |

## Next steps (in order)

1. **Database schema** — create `signals`, `signal_subscribers`, `push_subscriptions`, `signal_reactions` tables in Supabase
2. **tv-webhook Edge Function** — receive TradingView alerts, INSERT into `signals`
3. **Auth + sub-guard** — Supabase Auth login, check subscription expiry, kick-out logic
4. **Realtime feed** — replace mock data with live Supabase subscription
5. **Presence** — track who's online + viewing each signal
6. **Push notifications** — service worker + VAPID keys + send on new signal
7. **Payment** — Stripe checkout for $20/week and $60/month plans
8. **Pine Script indicator** — overlay with hline() for Entry/TP/SL (publish on TradingView)

## Mock data

The 3 signals shown in `room.html` are hardcoded in the `MOCK_SIGNALS` constant inside the `<script>` block. Replace with live Supabase subscription once backend is ready.

## TradingView Webhook setup (when backend ready)

In TradingView alert settings, paste this webhook URL:

```
https://etwlurpjrqlvrxgsbhkd.supabase.co/functions/v1/tv-webhook
```

Alert message body:

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
