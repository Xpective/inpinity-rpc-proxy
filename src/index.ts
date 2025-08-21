// src/index.ts  (Minimal, klammert sicher korrekt)

export interface Env {
  VENDOR: KVNamespace;     // KV für vendor Bundles
  CLAIMS: KVNamespace;     // KV für claims + mints
  UPSTREAM_RPC: string;    // "https://api.mainnet-beta.solana.com"
  BACKUP_RPC: string;      // "https://solana.publicnode.com"
  ALLOWED_ORIGINS: string; // CSV Domains
  ALLOWED_HEADERS: string; // CSV Header
  CREATOR_PUBKEY: string;  // Base58
  MAX_INDEX: string;       // z.B. "9999"
}

function cors(env: Env) {
  const origins = (env.ALLOWED_ORIGINS || "").split(",").map(s=>s.trim()).filter(Boolean);
  const headers = (env.ALLOWED_HEADERS || "content-type,accept").split(",").map(s=>s.trim());
  return {
    preflight(req: Request) {
      if (req.method !== "OPTIONS") return null;
      const origin = req.headers.get("Origin") || "";
      const allow = origins.length===0 || origins.includes(origin) ? origin : origins[0] || "*";
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": allow,
          "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
          "Access-Control-Allow-Headers": headers.join(","),
          "Vary": "Origin"
        }
      });
    },
    wrap(res: Response, req: Request) {
      const origin = req.headers.get("Origin") || "";
      const allow = origins.length===0 || origins.includes(origin) ? origin : origins[0] || "*";
      const h = new Headers(res.headers);
      h.set("Access-Control-Allow-Origin", allow);
      h.append("Vary","Origin");
      return new Response(res.body, { status: res.status, headers: h });
    }
  };
}

// ---------- /vendor/mpl-token-metadata-umd.js ----------
async function handleVendor(path: string, env: Env): Promise<Response> {
  const key = path.replace(/^\/vendor\//, "");
  if (!key) return new Response("missing key", { status: 400 });

  // 1) Versuche aus KV
  const fromKv = await env.VENDOR.get(key, { type: "stream" });
  if (fromKv) {
    return new Response(fromKv, {
      headers: { "content-type":"application/javascript; charset=utf-8", "X-Vendor-Source": `kv:${key}` }
    });
  }

  // 2) Hole von CDN (einmalig), speichere in KV
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
      await env.VENDOR.put(key, buf as unknown as ReadableStream, { expirationTtl: 60 * 60 * 24 * 7 }); // 7 Tage
      return new Response(buf, {
        headers: { "content-type":"application/javascript; charset=utf-8", "X-Vendor-Source": `cdn:${url}` }
      });
    } catch (e) {
      lastErr = e;
    }
  }
  return new Response(`vendor fetch failed: ${String(lastErr?.message || lastErr)}`, { status: 502 });
}

// ---------- /mints (POST), /mints/by-id, /mints/by-wallet, /mints, /mints/count ----------
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

async function handleMints(req: Request, env: Env, url: URL): Promise<Response> {
  const method = req.method;
  const pathname = url.pathname;

  if (method === "POST" && pathname === "/mints") {
    const j = await req.json().catch(() => null);
    if (!j || typeof j !== "object") return new Response('{"ok":false}', { status: 400 });
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
    const keyById = `mints:id:${row.id}`;
    const keyWalletIdx = row.wallet ? `mints:wallet:${row.wallet}:${row.ts}:${row.sig}` : "";
    await env.CLAIMS.put(keyById, JSON.stringify(row));
    if (keyWalletIdx) await env.CLAIMS.put(keyWalletIdx, JSON.stringify(row));
    const keyFeed = `mints:feed:${row.ts}:${row.sig}`;
    await env.CLAIMS.put(keyFeed, JSON.stringify(row));
    return new Response(JSON.stringify({ ok: true, item: row }), { headers: { "content-type":"application/json" } });
  }

  if (method === "GET" && pathname === "/mints/by-id") {
    const id = Number(url.searchParams.get("id") || "-1");
    const key = `mints:id:${id}`;
    const v = await env.CLAIMS.get(key);
    return new Response(JSON.stringify({ item: v ? JSON.parse(v) : null }), { headers: { "content-type":"application/json" } });
  }

  if (method === "GET" && pathname === "/mints/by-wallet") {
    const wallet = String(url.searchParams.get("wallet") || "");
    const limit = Number(url.searchParams.get("limit") || "10");
    if (!wallet) return new Response(JSON.stringify({ items: [], list_complete: true }), { headers: { "content-type":"application/json" } });
    // KV list prefix
    const prefix = `mints:wallet:${wallet}:`;
    const list = await env.CLAIMS.list({ prefix, limit });
    const items: MintRow[] = [];
    for (const k of list.keys) {
      const v = await env.CLAIMS.get(k.name);
      if (v) items.push(JSON.parse(v));
    }
    // Neueste zuerst
    items.sort((a,b)=>b.ts - a.ts);
    return new Response(JSON.stringify({ items, cursor: null, list_complete: true }), { headers: { "content-type":"application/json" } });
  }

  if (method === "GET" && pathname === "/mints") {
    const limit = Number(url.searchParams.get("limit") || "10");
    const prefix = `mints:feed:`;
    const list = await env.CLAIMS.list({ prefix, limit });
    const items: MintRow[] = [];
    for (const k of list.keys) {
      const v = await env.CLAIMS.get(k.name);
      if (v) items.push(JSON.parse(v));
    }
    items.sort((a,b)=>b.ts - a.ts);
    return new Response(JSON.stringify({ items, cursor: null, list_complete: true }), { headers: { "content-type":"application/json" } });
  }

  if (method === "GET" && pathname === "/mints/count") {
    const list = await env.CLAIMS.list({ prefix: "mints:feed:" });
    return new Response(JSON.stringify({ count: list.keys.length }), { headers: { "content-type":"application/json" } });
  }

  return new Response("not found", { status: 404 });
}

// ---------- /claims (GET, POST) ----------
async function handleClaims(req: Request, env: Env, url: URL): Promise<Response> {
  if (req.method === "GET") {
    const list = await env.CLAIMS.list({ prefix: "claim:" });
    const out: number[] = [];
    for (const k of list.keys) {
      const id = Number(k.name.split(":")[1] || "-1");
      if (id >= 0) out.push(id);
    }
    out.sort((a,b)=>a-b);
    return new Response(JSON.stringify({ claimed: out }), { headers: { "content-type":"application/json" } });
  }
  if (req.method === "POST") {
    const j = await req.json().catch(()=>null);
    const i = Number(j?.index ?? -1);
    if (!Number.isInteger(i) || i < 0) return new Response("bad index", { status: 400 });
    const key = `claim:${i}`;
    const existed = await env.CLAIMS.get(key);
    if (existed) return new Response(null, { status: 409 });
    await env.CLAIMS.put(key, "1");
    return new Response(null, { status: 200 });
  }
  return new Response("not found", { status: 404 });
}

// ---------- RPC passthrough ----------
async function handleRpc(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  for (const target of [env.UPSTREAM_RPC, env.BACKUP_RPC]) {
    try {
      const r = await fetch(target, {
        method: "POST",
        headers: { "content-type":"application/json" },
        body
      });
      if (r.ok) return new Response(r.body, { headers: r.headers });
    } catch {}
  }
  return new Response(JSON.stringify({ error: "rpc unavailable" }), { status: 502, headers: { "content-type":"application/json" } });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { preflight, wrap } = cors(env);

    const pf = preflight(req);
    if (pf) return pf;

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
    return new Response("ok");
  }
} satisfies ExportedHandler<Env>;