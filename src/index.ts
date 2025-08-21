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
  // GET /claims  -> liefert NUR ein Array [0,2,999,...]  (damit app.js Fast-Path greift)
  if (req.method === "GET") {
    const keys = await listAllKeys(env.CLAIMS, "claim:", 2000);
    const out: number[] = [];
    for (const k of keys) {
      // Schlüssel-Format: claim:<id>
      const parts = k.split(":");
      const id = Number(parts[1] || "-1");
      if (Number.isInteger(id) && id >= 0) out.push(id);
    }
    out.sort((a, b) => a - b);
    return json(out); // <- nacktes Array!
  }

  // POST /claims { index: number }
  if (req.method === "POST") {
    const j = await readJson<{ index: number }>(req);
    const i = Number(j?.index ?? -1);
    if (!Number.isInteger(i) || i < 0) return new Response("bad index", { status: 400 });

    const maxIndex = parseMaxIndex(env);
    if (i > maxIndex) return new Response("index out of range", { status: 400 });

    const key = `claim:${i}`;
    const existed = await env.CLAIMS.get(key);
    if (existed) return new Response(null, { status: 409 });

    await env.CLAIMS.put(key, "1");
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
} satisfies ExportedHandler<Env>;