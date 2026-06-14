// =====================================================================
// AURUM AI — Edge Function: aurum-gold-get-my-subscription-state
//
// Project: aurum-customers (etwlurpjrqlvrxgsbhkd)
// Phase C Step 3 (2026-06-14)
//
// Read-only companion to aurum-gold-submit-tv-username. The /room welcome
// popup (aurum-signals) calls this on load and then polls it every ~30s
// so the popup / banner can react as the Playwright grant bot advances a
// subscription through:
//
//   awaiting_username → pending_bot → active        (success)
//                                   → bot_failed     (needs support)
//   active            → expired                       (lapsed)
//
// Why an edge function (Option B, not a direct PostgREST read):
// aurum-signals authenticates against aurum-crm, but the subscriptions
// table lives in aurum-customers, whose PostgREST rejects aurum-crm JWTs
// (different JWT secrets — see wallet-subscriptions). So the browser can
// never satisfy the "Users read own subscriptions" RLS policy directly.
// We mirror the trust model of wallet-subscriptions / submit-tv-username:
//
//   1. Browser sends Authorization: Bearer <aurum-crm access_token>.
//   2. verifyCrmToken() validates it via aurum-crm /auth/v1/user and
//      returns the authoritative user_id.
//   3. We read with the service-role client, scoped to that user_id.
//      The client never passes a user_id — no enumeration surface.
//
// Auth:  Bearer = aurum-crm access token.
// Body:  none (GET) — POST also accepted for symmetry.
// 200:   { subscriptions: [ {
//            subscription_id, status, expires_at, plan_name, product_type,
//            tv_grant_status, tradingview_username, tv_expires_at,
//            tv_grant_notes, tv_days_remaining
//          } ] }   // aurum_analysis rows only, active first
// 401:   { error: 'missing_bearer' | 'invalid_token' }
// 500:   { error: 'db_error', message }
//
// NOTE: the helpers below are inlined so this function deploys standalone
// (via Supabase MCP) without the project's functions/_shared/aurum.ts.
// When mirrored into the xauusd-dashboard repo + deploy-edge-functions.yml
// they can be swapped for the shared imports used by its sibling fns.
// =====================================================================

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  return null;
}

const CUSTOMERS_URL = Deno.env.get("SUPABASE_URL") ?? "https://etwlurpjrqlvrxgsbhkd.supabase.co";
const CUSTOMERS_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CRM_URL = Deno.env.get("AURUM_CRM_URL") ?? "https://jdelizsmiwpushoeafen.supabase.co";
const CRM_ANON_KEY = Deno.env.get("AURUM_CRM_ANON_KEY") ?? "";

function bearerFromRequest(req: Request): string {
  const h = req.headers.get("authorization") || req.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : "";
}

// Trust the user_id in an aurum-crm token only if /auth/v1/user accepts it.
async function verifyCrmToken(token: string): Promise<{ id: string; email?: string } | null> {
  if (!token) return null;
  try {
    const res = await fetch(`${CRM_URL}/auth/v1/user`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${token}`,
        "apikey": CRM_ANON_KEY || token,
      },
    });
    if (!res.ok) return null;
    const u = await res.json();
    if (!u || typeof u.id !== "string") return null;
    return { id: u.id, email: u.email };
  } catch (_) {
    return null;
  }
}

let _adminClient: SupabaseClient | null = null;
function customersAdmin(): SupabaseClient {
  if (_adminClient) return _adminClient;
  _adminClient = createClient(CUSTOMERS_URL, CUSTOMERS_SERVICE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _adminClient;
}

interface PlanRow {
  name: string;
  product_type: string;
}
interface SubRow {
  id: string;
  status: string;
  expires_at: string | null;
  tv_grant_status: string | null;
  tradingview_username: string | null;
  tv_expires_at: string | null;
  tv_grant_notes: string | null;
  subscription_plans: PlanRow | null;
}

serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;

  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method_not_allowed" }, 405);
  }

  // --- Auth ---
  const token = bearerFromRequest(req);
  if (!token) return json({ error: "missing_bearer" }, 401);
  const user = await verifyCrmToken(token);
  if (!user) return json({ error: "invalid_token" }, 401);

  // --- Read this user's Aurum Analysis subscriptions + TV grant state ---
  const sb = customersAdmin();
  const { data: subs, error: subsErr } = await sb
    .from("subscriptions")
    .select(`
      id,
      status,
      expires_at,
      tv_grant_status,
      tradingview_username,
      tv_expires_at,
      tv_grant_notes,
      subscription_plans!inner (
        name,
        product_type
      )
    `)
    .eq("user_id", user.id)
    .eq("subscription_plans.product_type", "aurum_analysis");

  if (subsErr) {
    console.error("[get-my-subscription-state] select failed:", subsErr.message);
    return json({ error: "db_error", message: subsErr.message }, 500);
  }

  const now = Date.now();
  const rows = ((subs ?? []) as unknown as SubRow[]).map((s) => {
    const tvExpMs = s.tv_expires_at ? Date.parse(s.tv_expires_at) : 0;
    const tvDays = tvExpMs > 0 ? Math.max(0, Math.ceil((tvExpMs - now) / 86400000)) : null;
    return {
      subscription_id:      s.id,
      status:               s.status,
      expires_at:           s.expires_at,
      plan_name:            s.subscription_plans?.name ?? null,
      product_type:         s.subscription_plans?.product_type ?? null,
      tv_grant_status:      s.tv_grant_status,
      tradingview_username: s.tradingview_username,
      tv_expires_at:        s.tv_expires_at,
      tv_grant_notes:       s.tv_grant_notes,
      tv_days_remaining:    tvDays,
    };
  });

  // active first, then by latest subscription expiry — so the popup picks
  // the most relevant row when a user somehow has more than one.
  rows.sort((a, b) => {
    const sa = a.status === "active" ? 0 : 1;
    const sbk = b.status === "active" ? 0 : 1;
    if (sa !== sbk) return sa - sbk;
    const ax = a.expires_at ? Date.parse(a.expires_at) : 0;
    const bx = b.expires_at ? Date.parse(b.expires_at) : 0;
    return bx - ax;
  });

  return json({ subscriptions: rows });
});
