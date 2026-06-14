# Supabase Edge Functions referenced by aurum-signals

This directory mirrors edge functions that the static `/room` frontend
(`room.html`) depends on. The functions themselves are owned and CI-deployed
by the **xauusd-dashboard** repo (project `aurum-customers` /
`etwlurpjrqlvrxgsbhkd`). The copy here exists so the aurum-signals PR that
consumes a function is self-documenting.

## `aurum-gold-get-my-subscription-state` (Phase C Step 3 — NEW)

Read-only companion to the existing `aurum-gold-submit-tv-username`. The
`/room` welcome popup calls it on load and polls it every ~30s so the popup /
grant banner can follow the Playwright bot:
`awaiting_username → pending_bot → active | bot_failed`, and `active → expired`.

### Why an edge function (Option B, not a direct PostgREST read)

`aurum-signals` authenticates against **aurum-crm**, but the `subscriptions`
table lives in **aurum-customers**, whose PostgREST rejects aurum-crm JWTs
(different JWT secrets — same reason `wallet-subscriptions` exists). The
`subscriptions` table *does* carry an RLS policy
`Users read own subscriptions` (`auth.uid() = user_id`), but the browser can
never satisfy it directly because the aurum-crm token isn't valid there. So we
mirror the trust model of `wallet-subscriptions` / `aurum-gold-submit-tv-username`:

1. Browser sends `Authorization: Bearer <aurum-crm access_token>`.
2. The function validates it via aurum-crm `/auth/v1/user` → authoritative `user_id`.
3. It reads with the service-role client, scoped to that `user_id`
   (the client never passes a `user_id` — no enumeration surface).

### Contract

- `POST` (or `GET`), `Authorization: Bearer <aurum-crm access token>`, no body.
- `200 → { subscriptions: [{ subscription_id, status, expires_at, plan_name,
  product_type, tv_grant_status, tradingview_username, tv_expires_at,
  tv_grant_notes, tv_days_remaining }] }` — `aurum_analysis` rows only,
  active first.
- `401 → { error: 'missing_bearer' | 'invalid_token' }`
- `500 → { error: 'db_error', message }`

### Deployment status

Deployed live to `aurum-customers` (`etwlurpjrqlvrxgsbhkd`), `verify_jwt=false`
(custom aurum-crm bearer auth, like its siblings).

**Follow-up owned by xauusd-dashboard:** commit
`supabase/functions/aurum-gold-get-my-subscription-state/index.ts` into that
repo and add `aurum-gold-get-my-subscription-state` to
`.github/workflows/deploy-edge-functions.yml` so CI redeploys keep it in sync.
The source can be refactored there to import the shared
`functions/_shared/aurum.ts` helpers (this standalone copy inlines them so it
deploys cleanly on its own).
