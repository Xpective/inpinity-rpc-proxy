// src/index.ts
import type { KVNamespace, RequestInitCfProperties } from '@cloudflare/workers-types';

/* ========================= ENV ========================= */
export interface Env {
  UPSTREAM_RPC: string;
  BACKUP_RPC?: string;

  ALLOWED_ORIGINS?: string;
  ALLOWED_HEADERS?: string;

  CLAIMS: KVNamespace;
  REMOTE_CLAIMS_URL?: string;

  CREATOR_PUBKEY?: string;
  MAX_INDEX?: string;
}

/* ========================= CORS helpers ========================= */
const parseList = (s?: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

function pickOrigin(req: Request, allow: string[]) {
  const o = req.headers.get('Origin') || '';
  if (!allow.length) return '*';
  const isAllowed = allow.some(a => {
    if (a === '*') return true;
    if (a.includes('*')) {
      const re = new RegExp('^' + a.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return re.test(o);
    }
    return a === o;
  });
  return isAllowed ? (o || allow[0]) : (allow[0] || '*');
}

function baseCorsHeaders(origin: string, ctype = 'application/json', extra?: Record<string, string>) {
  return {
    'Content-Type': ctype,
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin, Accept-Encoding',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS,HEAD',
    // Der konkrete Allow-Headers-Wert wird später im fetch() je nach ENV überschrieben:
    'Access-Control-Allow-Headers': 'content-type,solana-client,accept,accept-language',
    'Access-Control-Max-Age': '86400',
    ...(extra || {}),
  };
}

/* ========================= RPC forward ========================= */
const isRetryable = (s: number) => s === 403 || s === 429 || (s >= 500 && s <= 599);

async function rpcOnce(endpoint: string, body: unknown): Promise<Response> {
  return fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

async function rpcForward(env: Env, body: unknown): Promise<Response> {
  try {
    const r = await rpcOnce(env.UPSTREAM_RPC, body);
    if (!isRetryable(r.status)) return r;
  } catch {}
  if (env.BACKUP_RPC) {
    try { return await rpcOnce(env.BACKUP_RPC, body); } catch { return new Response('UPSTREAM+BACKUP error', { status: 599 }); }
  }
  return new Response('UPSTREAM error', { status: 599 });
}

/* ========================= Blockhash mini cache ========================= */
let _lastBlockhash = '';
let _lastBlockTs = 0;
const BLOCKHASH_TTL_MS = 10_000;

async function getLatestBlockhash(env: Env): Promise<string> {
  const now = Date.now();
  if (_lastBlockhash && now - _lastBlockTs < BLOCKHASH_TTL_MS) return _lastBlockhash;
  const body = { jsonrpc: '2.0', id: 1, method: 'getLatestBlockhash', params: [{ commitment: 'finalized' }] };
  const r = await rpcForward(env, body);
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const j = await r.json();
  const bh = j?.result?.value?.blockhash || j?.result?.blockhash;
  if (!bh) throw new Error('No blockhash');
  _lastBlockhash = bh; _lastBlockTs = now; return bh;
}

/* ========================= Claims (KV + optional remote) ========================= */
async function getClaims(env: Env): Promise<number[]> {
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const r = await fetch(env.REMOTE_CLAIMS_URL, { cf: { cacheTtl: 60, cacheEverything: true } as RequestInitCfProperties } as RequestInit);
      if (r.ok) {
        const d = await r.json();
        if (Array.isArray(d)) return d;
        if (Array.isArray((d as any)?.claimed)) return (d as any).claimed;
      }
    } catch {}
  }
  const raw = await env.CLAIMS.get('claimed');
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (Array.isArray((j as any)?.claimed)) return (j as any).claimed;
  } catch {}
  return [];
}

async function saveClaims(env: Env, arr: number[]) { await env.CLAIMS.put('claimed', JSON.stringify(arr)); }

async function addClaim(env: Env, idx: number): Promise<'created' | 'exists'> {
  const arr = await getClaims(env);
  if (arr.includes(idx)) return 'exists';
  arr.push(idx); await saveClaims(env, arr); return 'created';
}

/* ========================= Body guard ========================= */
const MAX_BODY_BYTES = 512 * 1024;

async function readJsonSafe<T = any>(req: Request): Promise<T> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len && len > MAX_BODY_BYTES) throw new Error('Payload too large');
  return req.json() as Promise<T>;
}

/* ========================= Vendor helper ========================= */
async function fetchCached(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url, { cf: { cacheTtl: 86400, cacheEverything: true } as RequestInitCfProperties } as RequestInit);
    if (!r.ok) return null;
    return await r.arrayBuffer();
  } catch { return null; }
}

/* ========================= Worker ========================= */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const allow = parseList(env.ALLOWED_ORIGINS) || [];
    const origin = pickOrigin(req, allow);

    // kleine lokale Helfer, damit ALLOWED_HEADERS aus ENV auch wirklich gilt
    const cors = (ctype = 'application/json', extra?: Record<string, string>) => {
      const h = baseCorsHeaders(origin, ctype, extra);
      if (env.ALLOWED_HEADERS) h['Access-Control-Allow-Headers'] = env.ALLOWED_HEADERS;
      return h;
    };
    const json = (data: unknown, status = 200, extraHdr?: Record<string, string>) =>
      new Response(JSON.stringify(data), { status, headers: cors('application/json', extraHdr) });
    const text = (msg: string, status = 200, extraHdr?: Record<string, string>) =>
      new Response(msg, { status, headers: cors('text/plain', extraHdr) });

    // Preflight
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

    // Health/Info
    if (url.pathname === '/' || url.pathname === '/health') return text('OK: inpi-proxy-nft');
    if (url.pathname === '/config') {
      return json({
        upstream: env.UPSTREAM_RPC,
        backup: env.BACKUP_RPC || null,
        allowed_origins: env.ALLOWED_ORIGINS || '',
        creator: env.CREATOR_PUBKEY || null,
        max_index: Number(env.MAX_INDEX || '9999'),
      });
    }
    if (url.pathname === '/debug') {
      return json({ now: Date.now(), blockhash_cache: { value: _lastBlockhash, age_ms: Date.now() - _lastBlockTs } });
    }

    /* -------- VENDOR: Metaplex mpl-token-metadata UMD -------- */
    if (url.pathname === '/vendor/mpl-token-metadata-umd.js') {
      const sources = [
        'https://cdn.jsdelivr.net/npm/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.js',
        'https://unpkg.com/@metaplex-foundation/mpl-token-metadata@3.4.0/dist/index.umd.js',
      ];
      for (const s of sources) {
        const body = await fetchCached(s);
        if (body) {
          return new Response(body, {
            status: 200,
            headers: cors('application/javascript', { 'Cache-Control': 'public, max-age=86400', 'X-Vendor-Source': s }),
          });
        }
      }
      return text('vendor fetch failed', 502);
    }

    /* -------- VENDOR: optional web3.js IIFE -------- */
    if (url.pathname === '/vendor/web3js.js') {
      const sources = [
        'https://cdn.jsdelivr.net/npm/@solana/web3.js@1.95.3/lib/index.iife.min.js',
        'https://unpkg.com/@solana/web3.js@1.95.3/lib/index.iife.min.js',
      ];
      for (const s of sources) {
        const body = await fetchCached(s);
        if (body) {
          return new Response(body, {
            status: 200,
            headers: cors('application/javascript', { 'Cache-Control': 'public, max-age=86400', 'X-Vendor-Source': s }),
          });
        }
      }
      return text('vendor fetch failed', 502);
    }

    /* -------- VENDOR: optional spl-token IIFE -------- */
    if (url.pathname === '/vendor/spl-token.js') {
      const sources = [
        'https://cdn.jsdelivr.net/npm/@solana/spl-token@0.4.9/dist/index.iife.js',
        'https://unpkg.com/@solana/spl-token@0.4.9/dist/index.iife.js',
      ];
      for (const s of sources) {
        const body = await fetchCached(s);
        if (body) {
          return new Response(body, {
            status: 200,
            headers: cors('application/javascript', { 'Cache-Control': 'public, max-age=86400', 'X-Vendor-Source': s }),
          });
        }
      }
      return text('vendor fetch failed', 502);
    }

    /* -------- JSON-RPC proxy -------- */
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any;
      try { body = await readJsonSafe(req); } catch { return text('Bad JSON or too large', 400); }
      const resp = await rpcForward(env, body);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: cors('application/json') });
    }

    /* -------- latest-blockhash -------- */
    if (url.pathname === '/latest-blockhash' && req.method === 'GET') {
      try { return json({ blockhash: await getLatestBlockhash(env) }); }
      catch (e: any) { return json({ error: String(e?.message || e) }, 502); }
    }

    /* -------- simulate -------- */
    if (url.pathname === '/simulate' && req.method === 'POST') {
      type SimReq = { tx: string; sigVerify?: boolean; replaceRecentBlockhash?: boolean; };
      let body: SimReq;
      try { body = await readJsonSafe<SimReq>(req); } catch { return text('Bad JSON or too large', 400); }
      if (!body?.tx) return text('Missing tx (base64)', 400);
      const rpcBody = {
        jsonrpc: '2.0', id: 1, method: 'simulateTransaction',
        params: [body.tx, { sigVerify: !!body.sigVerify, replaceRecentBlockhash: body.replaceRecentBlockhash !== false, commitment: 'processed' }]
      };
      const r = await rpcForward(env, rpcBody);
      const data = await r.text();
      return new Response(data, { status: r.status, headers: cors('application/json') });
    }

    /* -------- relay -------- */
    if (url.pathname === '/relay' && req.method === 'POST') {
      type RelayReq = {
        tx: string; skipPreflight?: boolean; maxRetries?: number;
        preflightCommitment?: 'processed'|'confirmed'|'finalized';
        confirm?: boolean; confirmCommitment?: 'processed'|'confirmed'|'finalized';
        requireCreator?: boolean; signer?: string;
      };
      let body: RelayReq;
      try { body = await readJsonSafe<RelayReq>(req); } catch { return text('Bad JSON or too large', 400); }
      if (!body?.tx) return text('Missing tx (base64)', 400);

      if (body.requireCreator) {
        const need = (env.CREATOR_PUBKEY || '').trim();
        const got  = (body.signer || '').trim();
        if (!need) return text('CREATOR_PUBKEY not configured', 412);
        if (!got || got !== need) return text('Forbidden: signer is not creator', 403);
      }

      const sendBody = {
        jsonrpc: '2.0', id: 1, method: 'sendRawTransaction',
        params: [ body.tx, { skipPreflight: !!body.skipPreflight, maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined, preflightCommitment: body.preflightCommitment || 'processed' } ]
      };
      const sendResp = await rpcForward(env, sendBody);
      const sendJson = await sendResp.json().catch(() => ({}));
      if (!sendResp.ok || (sendJson as any)?.error) {
        return json({ error: (sendJson as any)?.error || `sendRawTransaction failed ${sendResp.status}` }, 502);
      }
      const signature = (sendJson as any)?.result;

      if (body.confirm) {
        const bh = await getLatestBlockhash(env).catch(() => undefined);
        const confBody = { jsonrpc: '2.0', id: 1, method: 'confirmTransaction', params: [ { signature, ...(bh ? { blockhash: bh } : {}) }, body.confirmCommitment || 'confirmed' ] };
        const confResp = await rpcForward(env, confBody);
        const confJson = await confResp.json().catch(() => ({}));
        return json({ signature, confirm: (confJson as any)?.result ?? null });
      }
      return json({ signature });
    }

    /* -------- claims -------- */
    if (url.pathname === '/claims') {
      if (req.method === 'HEAD') return new Response(null, { status: 200, headers: cors() });
      if (req.method === 'GET') {
        const claimed = await getClaims(env);
        const tag = `W/"c${claimed.length}-${claimed[0] ?? -1}-${claimed[claimed.length-1] ?? -1}"`;
        return new Response(JSON.stringify({ claimed }), { status: 200, headers: cors('application/json', { ETag: tag }) });
      }
      if (req.method === 'POST') {
        try {
          const { index } = await readJsonSafe<{ index?: unknown }>(req);
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return text('Invalid index', 400);
          const res = await addClaim(env, index);
          return res === 'exists' ? json({ error: 'already claimed' }, 409) : json({ ok: true });
        } catch { return text('Bad JSON or too large', 400); }
      }
      return text('Method not allowed', 405);
    }

    if (url.pathname === '/claims/stats' && req.method === 'GET') {
      const max = Number(env.MAX_INDEX || '9999');
      const claimed = await getClaims(env);
      const set = new Set<number>(claimed);
      const freeCount = (max + 1) - set.size;
      return json({ max_index: max, claimed_count: set.size, free_count: freeCount });
    }

    if (url.pathname === '/claims/free' && req.method === 'GET') {
      const max = Number(env.MAX_INDEX || '9999');
      const claimed = new Set<number>(await getClaims(env));
      const free: number[] = [];
      for (let i = 0; i <= max; i++) if (!claimed.has(i)) free.push(i);
      return json({ free });
    }

    // 404
    return text('Not found', 404);
  }
} satisfies ExportedHandler<Env>;