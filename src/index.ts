// src/index.ts

export interface Env {
  VENDOR: KVNamespace;     // KV für vendor Bundles
  CLAIMS: KVNamespace;     // KV für claims + mints
  UPSTREAM_RPC: string;    // "https://api.mainnet-beta.solana.com"
  BACKUP_RPC: string;      // "https://solana.publicnode.com"
  ALLOWED_ORIGINS: string; // CSV Domains
  ALLOWED_HEADERS: string; // CSV Header
  CREATOR_PUBKEY: string;  // Base58 (nur Info/Guard)
  MAX_INDEX: string;       // z.B. "9999"
}

/* ------------------ utils ------------------ */
const b58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const json = (data: unknown, status = 200, extra?: HeadersInit) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(extra || {})
    }
  });

async function readJson<T = any>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

function parseMaxIndex(env: Env): number {
  const m = Number(env.MAX_INDEX ?? "0");
  return Number.isFinite(m) && m >= 0 ? Math.floor(m) : 0;
}

/* ------------------ CORS ------------------ */
function cors(env: Env) {
  const origins = (env.ALLOWED_ORIGINS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const headers = (env.ALLOWED_HEADERS || "content-type,accept")
    .split(",")
    .map(s => s.trim());

  function allowFor(origin: string): string {
    if (!origins.length) return "*";
    return origins.includes(origin) ? origin : origins[0] || "*";
  }

  return {
    preflight(req: Request) {
      if (req.method !== "OPTIONS") return null;
      const origin = req.headers.get("Origin") || "";
      const allow = allowFor(origin);
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": allow,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": headers.join(","),
          "Access-Control-Max-Age": "86400",
          "Vary": "Origin"
        }
      });
    },
    wrap(res: Response, req: Request) {
      const origin = req.headers.get("Origin") || "";
      const allow = allowFor(origin);
      const h = new Headers(res.headers);
      h.set("Access-Control-Allow-Origin", allow);
      h.append("Vary", "Origin");
      return new Response(res.body, { status: res.status, headers: h });
    }
  };
}

/* -------------- vendor (optional) -------------- */
async function handleVendor(path: string, env: Env): Promise<Response> {
  const key = path.replace(/^\/vendor\//, "");
  if (!key) return new Response("missing key", { status: 400 });

  // 1) KV
  const fromKv = await env.VENDOR.get(key, { type: "arrayBuffer" });
  if (fromKv) {
    return new Response(fromKv, {
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "X-Vendor-Source": `kv:${key}`
      }
    });
  }

  // 2) CDN → KV (UMD der v3.x – nur falls du es jemals brauchst)
  const candidates = [
    "https://cdn.jsdelivr.net/npm/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.js",
    "https://unpkg.com/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.js",
    "https://cdn.jsdelivr.net/npm/@metaplex-foundation/mpl-token-metadata@3.3.0/dist/index.umd.js",
    "https://unpkg.com/@metaplex-foundation/mpl-token-metadata@3.3.0/dist/index.umd.js"
  ];

  let lastErr: any = null;
  for (const url of candidates) {
    try {
      const r = await fetch(url, { cf: { cacheTtl: 3600 } });
      if (!r.ok) throw new Error(`fetch ${url} -> ${r.status}`);
      const buf = await r.arrayBuffer();
      await env.VENDOR.put(key, buf as unknown as ArrayBuffer, {
        expirationTtl: 60 * 60 * 24 * 7 // 7 Tage
      });
      return new Response(buf, {
        headers: {
          "content-type": "application/javascript; charset=utf-8",
          "X-Vendor-Source": `cdn:${url}`
        }
      });
    } catch (e) {
      lastErr = e;
    }
  }
  return new Response(
    `vendor fetch failed: ${String(lastErr?.message || lastErr)}`,
    { status: 502 }
  );
}

/* -------------- Mints -------------- */
type MintRow = {
  id: number;
  mint: string;
  wallet?: string;
  sig: string;
  ts: number;
  collection?: string;
  name?: string;
  uri?: string;
};

async function listAllKeys(kv: KVNamespace, prefix: string, limit = 1000) {
  const keys: string[] = [];
  let cursor: string | undefined = undefined;

  do {
    const page = await kv.list({ prefix, limit, cursor });
    for (const k of page.keys) keys.push(k.name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return keys;
}
declare global { interface Env { HMAC_SECRET: string } }

async function hmacValid(env: Env, body: string, sig: string | null) {
  if (!env.HMAC_SECRET) return true; // falls du es optional lassen willst
  if (!sig) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(env.HMAC_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(body));
  const hex = Array.from(new Uint8Array(mac)).map(b => b.toString(16).padStart(2,"0")).join("");
  // akzeptiere hex oder "sha256=..."-Format
  return sig === hex || sig === `sha256=${hex}`;
}
async function rateLimit(kv: KVNamespace, ip: string, bucket = "rl", limit = 60, windowSec = 60) {
  const key = `${bucket}:${ip}:${Math.floor(Date.now()/ (windowSec*1000))}`;
  const cur = Number(await kv.get(key)) || 0;
  if (cur >= limit) return false;
  await kv.put(key, String(cur + 1), { expirationTtl: windowSec + 5 });
  return true;
}

// vor schreibenden Endpoints:
const ip = req.headers.get("cf-connecting-ip") || "0.0.0.0";
if (!(await rateLimit(env.CLAIMS, ip))) return new Response("rate limit", { status: 429 });
// in handleMints (POST /mints) ganz oben:
if (method === "POST" && pathname === "/mints") {
  const raw = await req.text();
  const ok = await hmacValid(env, raw, req.headers.get("X-Signature"));
  if (!ok) return json({ ok: false, error: "bad signature" }, 401);
  const j = JSON.parse(raw);
async function handleMints(req: Request, env: Env, url: URL): Promise<Response> {
  const method = req.method;
  const pathname = url.pathname;

  // POST /mints  -> Row schreiben + Indexe
  if (method === "POST" && pathname === "/mints") {
    const j = await readJson<any>(req);
    if (!j || typeof j !== "object") return json({ ok: false }, 400);

    const row: MintRow = {
      id: Number(j.id),
      mint: String(j.mint),
      wallet: j.wallet ? String(j.wallet) : undefined,
      sig: String(j.sig),
      ts: Date.now(),
      collection: j.collection ? String(j.collection) : undefined,
      name: j.name ? String(j.name) : undefined,
      uri: j.uri ? String(j.uri) : undefined
    };

    if (!Number.isInteger(row.id) || row.id < 0) return json({ ok: false, error: "bad id" }, 400);
    if (!row.mint) return json({ ok: false, error: "bad mint" }, 400);
    if (!row.sig) return json({ ok: false, error: "bad sig" }, 400);

    const keyById = `mints:id:${row.id}`;
    const keyFeed = `mints:feed:${row.ts}:${row.sig}`;
    await env.CLAIMS.put(keyById, JSON.stringify(row));
    await env.CLAIMS.put(keyFeed, JSON.stringify(row));

    if (row.wallet) {
      const keyWalletIdx = `mints:wallet:${row.wallet}:${row.ts}:${row.sig}`;
      await env.CLAIMS.put(keyWalletIdx, JSON.stringify(row));
    }

    return json({ ok: true, item: row });
  }

  // GET /mints/by-id?id=123
  if (method === "GET" && pathname === "/mints/by-id") {
    const id = Number(url.searchParams.get("id") || "-1");
    if (!Number.isInteger(id) || id < 0) return json({ item: null });
    const key = `mints:id:${id}`;
    const v = await env.CLAIMS.get(key);
    return json({ item: v ? JSON.parse(v) : null });
  }

  // GET /mints/by-wallet?wallet=...&limit=10
  if (method === "GET" && pathname === "/mints/by-wallet") {
    const wallet = String(url.searchParams.get("wallet") || "");
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || "10")));
    if (!wallet) return json({ items: [], list_complete: true });

    // Sammeln (paginiert), dann schneiden
    const keys = await listAllKeys(env.CLAIMS, `mints:wallet:${wallet}:`, 1000);
    const items: MintRow[] = [];
    for (const k of keys) {
      const v = await env.CLAIMS.get(k);
      if (v) items.push(JSON.parse(v));
    }
    items.sort((a, b) => b.ts - a.ts);
    return json({ items: items.slice(0, limit), cursor: null, list_complete: true });
  }

  // GET /mints?limit=10  (Feed, neueste zuerst)
  if (method === "GET" && pathname === "/mints") {
    const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit") || "10")));
    const keys = await listAllKeys(env.CLAIMS, "mints:feed:", 1000);
    const items: MintRow[] = [];
    for (const k of keys) {
      const v = await env.CLAIMS.get(k);
      if (v) items.push(JSON.parse(v));
    }
    items.sort((a, b) => b.ts - a.ts);
    return json({ items: items.slice(0, limit), cursor: null, list_complete: true });
  }

  // GET /mints/count
  if (method === "GET" && pathname === "/mints/count") {
    const keys = await listAllKeys(env.CLAIMS, "mints:feed:", 1000);
    return json({ count: keys.length });
  }

  return new Response("not found", { status: 404 });
}

/* -------------- Claims -------------- */
async function handleClaims(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "GET") {
    // wie gehabt: nacktes Array – aber effizienter mit Cursor:
    const out: number[] = [];
    let cursor: string | undefined = undefined;
    do {
      const page = await env.CLAIMS.list({ prefix: "claim:", limit: 1000, cursor });
      for (const k of page.keys) {
        const id = Number(k.name.split(":")[1] || "-1");
        if (Number.isInteger(id) && id >= 0) out.push(id);
      }
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    out.sort((a, b) => a - b);
    // ETag
    const tag = `"c-${out.length}-${out[0] ?? 0}-${out[out.length-1] ?? 0}"`;
    if (req.headers.get("If-None-Match") === tag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(out), {
      status: 200,
      headers: { "content-type":"application/json; charset=utf-8", "ETag": tag }
    });
  }

  if (req.method === "POST") {
    const j = await readJson<{ index: number }>(req);
    const i = Number(j?.index ?? -1);
    const max = parseMaxIndex(env);
    if (!Number.isInteger(i) || i < 0 || i > max) return new Response("bad index", { status: 400 });

    // 1) DO-Lock (atomar)
    const id = env.MINT_GUARD.idFromName(`claim:${i}`);
    const stub = env.MINT_GUARD.get(id);
    const lockRes = await stub.fetch("https://do/lock", { method: "POST" });
    if (lockRes.status === 409) return new Response(null, { status: 409 });

    // 2) KV-Index für schnelles GET /claims
    await env.CLAIMS.put(`claim:${i}`, "1");

    return new Response(null, { status: 200 });
  }

  return new Response("not found", { status: 404 });
}

/* -------------- RPC passthrough -------------- */
async function handleRpc(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  for (const target of [env.UPSTREAM_RPC, env.BACKUP_RPC]) {
    try {
      const r = await fetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body
      });
      if (r.ok) {
        // Proxy Headers + Body weiterreichen
        const h = new Headers(r.headers);
        // Sicherheitshalber CORS nicht vom Upstream übernehmen
        h.delete("access-control-allow-origin");
        return new Response(r.body, { status: r.status, headers: h });
      }
    } catch {
      // versuch nächsten
    }
  }
  return json({ error: "rpc unavailable" }, 502);
}
export class MintGuard {
  private state: DurableObjectState;
  constructor(state: DurableObjectState, _env: Env) { this.state = state; }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const method = req.method;

    // Der Name des DO ist "claim:<index>" (idFromName in Router)
    // Wir speichern nur ein Flag "claimed" = 1.
    if (method === "POST" && url.pathname === "/lock") {
      const existed = await this.state.storage.get<number>("claimed");
      if (existed === 1) return new Response(null, { status: 409 });
      await this.state.storage.put("claimed", 1);
      return new Response(null, { status: 200 });
    }

    if (method === "GET" && url.pathname === "/status") {
      const existed = await this.state.storage.get<number>("claimed");
      return new Response(JSON.stringify({ claimed: existed === 1 }), {
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("not found", { status: 404 });
  }
}
/* -------------- Router -------------- */
export default {
  async fetch(req, env): Promise<Response> {
    // Sanity Checks
    if (env.CREATOR_PUBKEY && !b58.test(env.CREATOR_PUBKEY)) {
      console.warn("CREATOR_PUBKEY invalid base58");
    }

    const url = new URL(req.url);
    const { preflight, wrap } = cors(env);

    // CORS preflight
    const pf = preflight(req);
    if (pf) return pf;

    // Routes
    if (url.pathname.startsWith("/vendor/")) {
      return wrap(await handleVendor(url.pathname, env), req);
    }
    if (url.pathname === "/mints" || url.pathname.startsWith("/mints/")) {
      return wrap(await handleMints(req, env, url), req);
    }
    if (url.pathname === "/claims") {
      return wrap(await handleClaims(req, env, url), req);
    }
    if (url.pathname === "/rpc") {
      return wrap(await handleRpc(req, env), req);
    }
    if (url.pathname === "/health") {
      return wrap(json({ ok: true, ts: Date.now() }), req);
    }

    // Default
    return wrap(new Response("ok"), req);
  }
  function securityHeaders(res: Response) {
  const h = new Headers(res.headers);
  h.set("Referrer-Policy", "no-referrer");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Permissions-Policy", "geolocation=(), payment=()");
  h.set("Content-Security-Policy",
    "default-src 'none'; img-src https: data:; media-src https:; connect-src https:; script-src 'none'; style-src 'none';");
  return new Response(res.body, { status: res.status, headers: h });
}
async function handleStats(env: Env): Promise<Response> {
  let total = 0, first = 0, last = 0;
  let cursor: string | undefined;
  do {
    const page = await env.CLAIMS.list({ prefix: "mints:feed:", limit: 1000, cursor });
    total += page.keys.length;
    if (page.keys.length) {
      const tsFirst = Number(page.keys[0].name.split(":")[2] || "0");
      const tsLast  = Number(page.keys[page.keys.length-1].name.split(":")[2] || "0");
      first = first ? Math.min(first, tsFirst) : tsFirst;
      last = Math.max(last, tsLast);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  const max = parseMaxIndex(env);
  const claimedKeys = await env.CLAIMS.list({ prefix: "claim:", limit: 1 });
  // schneller Count (ungefähr): hole nur Cursor, dann iterativ – hier simpel:
  const claimedAll = await listAllKeys(env.CLAIMS, "claim:", 1000);
  const claimed = claimedAll.length;

  return json({ minted_feed: total, claimed, remaining: (max+1) - claimed, first, last });
}
// im Router ganz unten: return securityHeaders(wrap(response, req));
} satisfies ExportedHandler<Env>;