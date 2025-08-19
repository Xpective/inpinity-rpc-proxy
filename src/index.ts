// src/index.ts
import type { KVNamespace, RequestInitCfProperties } from '@cloudflare/workers-types';

/* ========================= ENV ========================= */
export interface Env {
  // RPC Upstreams
  UPSTREAM_RPC: string;                         // z.B. https://api.mainnet-beta.solana.com
  BACKUP_RPC?: string;                          // z.B. https://solana.publicnode.com

  // CORS
  ALLOWED_ORIGINS?: string;                     // CSV: https://inpinity.online,https://mint.inpinity.online,https://*.pages.dev
  ALLOWED_HEADERS?: string;                     // CSV: content-type,solana-client,accept,accept-language

  // Claims
  CLAIMS: KVNamespace;                          // KV-Binding (muss im wrangler.toml stehen)
  REMOTE_CLAIMS_URL?: string;                   // optional externer JSON-Endpunkt {claimed:[...]}

  // Optionales Gate für /relay (reine String-Prüfung, kein Signing)
  CREATOR_PUBKEY?: string;                      // z.B. GEFoNL...
}

/* ========================= CORS ========================= */
const parseList = (s?: string) => (s || '').split(',').map(x => x.trim()).filter(Boolean);

function pickOrigin(req: Request, allow: string[]) {
  const o = req.headers.get('Origin') || '';
  if (!allow.length) return '*';
  // einfache Wildcard-Unterstützung für *.pages.dev
  const isAllowed = allow.some(a => {
    if (a === '*') return true;
    if (a.includes('*')) {
      const re = new RegExp('^' + a.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
      return re.test(o);
    }
    return a === o;
  });
  if (isAllowed) return o || allow[0];
  return allow[0];
}

function corsHeaders(origin: string, ctype = 'application/json', extra?: Record<string, string>) {
  return {
    'Content-Type': ctype,
    'Access-Control-Allow-Origin': origin,
    'Vary': 'Origin, Accept-Encoding',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,solana-client,accept,accept-language',
    'Access-Control-Max-Age': '86400',
    ...extra,
  };
}

const json = (data: unknown, origin: string, status = 200, extraHdr?: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: corsHeaders(origin, 'application/json', extraHdr) });

const text = (msg: string, origin: string, status = 200, extraHdr?: Record<string, string>) =>
  new Response(msg, { status, headers: corsHeaders(origin, 'text/plain', extraHdr) });

/* ========================= RPC-Forward ========================= */
const isRetryable = (s: number) => s === 403 || s === 429 || (s >= 500 && s <= 599);

async function rpcOnce(endpoint: string, body: unknown): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function rpcForward(env: Env, body: unknown): Promise<Response> {
  try {
    const r = await rpcOnce(env.UPSTREAM_RPC, body);
    if (!isRetryable(r.status)) return r;
  } catch { /* fallthrough to backup */ }

  if (env.BACKUP_RPC) {
    try {
      return await rpcOnce(env.BACKUP_RPC, body);
    } catch {
      return new Response('UPSTREAM+BACKUP error', { status: 599 });
    }
  }
  return new Response('UPSTREAM error', { status: 599 });
}

/* ========================= Blockhash-Mini-Cache ========================= */
let _lastBlockhash = '';
let _lastBlockTs = 0;
const BLOCKHASH_TTL_MS = 10_000;

async function getLatestBlockhash(env: Env): Promise<string> {
  const now = Date.now();
  if (_lastBlockhash && now - _lastBlockTs < BLOCKHASH_TTL_MS) return _lastBlockhash;

  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getLatestBlockhash',
    params: [{ commitment: 'finalized' }],
  };
  const r = await rpcForward(env, body);
  if (!r.ok) throw new Error(`RPC ${r.status}`);
  const j = await r.json<any>();
  const bh = j?.result?.value?.blockhash || j?.result?.blockhash;
  if (!bh) throw new Error('No blockhash');
  _lastBlockhash = bh;
  _lastBlockTs = now;
  return bh;
}

/* ========================= Claims (KV + optional Remote) ========================= */
async function getClaims(env: Env): Promise<number[]> {
  if (env.REMOTE_CLAIMS_URL) {
    try {
      const r = await fetch(env.REMOTE_CLAIMS_URL, {
        cf: { cacheTtl: 60, cacheEverything: true } as RequestInitCfProperties,
      });
      if (r.ok) {
        const d = await r.json<any>();
        if (Array.isArray(d)) return d;
        if (Array.isArray(d?.claimed)) return d.claimed;
      }
    } catch { /* ignore */ }
  }
  const raw = await env.CLAIMS.get('claimed');
  if (!raw) return [];
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (Array.isArray(j?.claimed)) return j.claimed;
  } catch { /* ignore */ }
  return [];
}

async function addClaim(env: Env, idx: number): Promise<'created' | 'exists'> {
  const arr = await getClaims(env);
  if (arr.includes(idx)) return 'exists';
  arr.push(idx);
  await env.CLAIMS.put('claimed', JSON.stringify(arr));
  return 'created';
}

/* ========================= Body-Guard ========================= */
const MAX_BODY_BYTES = 512 * 1024; // 512 KB

async function readJsonSafe<T = any>(req: Request): Promise<T> {
  const len = Number(req.headers.get('content-length') || 0);
  if (len && len > MAX_BODY_BYTES) throw new Error('Payload too large');
  return req.json() as Promise<T>;
}

/* ========================= WORKER HANDLER ========================= */
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const allow = parseList(env.ALLOWED_ORIGINS) || [];
    const origin = pickOrigin(req, allow);

    // Header mit optionalen Custom-Allow-Headers
    const baseHdr = corsHeaders(origin);
    if (env.ALLOWED_HEADERS) baseHdr['Access-Control-Allow-Headers'] = parseList(env.ALLOWED_HEADERS).join(',');

    // Preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: baseHdr });
    }

    // Health / Info
    if (url.pathname === '/' || url.pathname === '/health') {
      return text('OK: inpinity-rpc-proxy', origin);
    }
    if (url.pathname === '/config') {
      return json({
        upstream: env.UPSTREAM_RPC,
        backup: env.BACKUP_RPC || null,
        allowed_origins: env.ALLOWED_ORIGINS || '',
        creator: env.CREATOR_PUBKEY || null,
      }, origin);
    }
    if (url.pathname === '/debug') {
      return json({ now: Date.now(), blockhash_cache: { value: _lastBlockhash, age_ms: Date.now() - _lastBlockTs } }, origin);
    }

    /* -------- /rpc : JSON-RPC Proxy -------- */
    if (url.pathname === '/rpc' && req.method === 'POST') {
      let body: any;
      try { body = await readJsonSafe(req); }
      catch { return text('Bad JSON or too large', origin, 400); }
      const resp = await rpcForward(env, body);
      const data = await resp.text();
      return new Response(data, { status: resp.status, headers: corsHeaders(origin, 'application/json') });
    }

    /* -------- /latest-blockhash -------- */
    if (url.pathname === '/latest-blockhash' && req.method === 'GET') {
      try {
        const bh = await getLatestBlockhash(env);
        return json({ blockhash: bh }, origin);
      } catch (e: any) {
        return json({ error: String(e?.message || e) }, origin, 502);
      }
    }

    /* -------- /simulate : simulateTransaction(base64) -------- */
    if (url.pathname === '/simulate' && req.method === 'POST') {
      type SimReq = { tx: string; sigVerify?: boolean; replaceRecentBlockhash?: boolean; };
      let body: SimReq;
      try { body = await readJsonSafe<SimReq>(req); }
      catch { return text('Bad JSON or too large', origin, 400); }
      if (!body?.tx) return text('Missing tx (base64)', origin, 400);

      const rpcBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'simulateTransaction',
        params: [
          body.tx,
          {
            sigVerify: !!body.sigVerify,
            replaceRecentBlockhash: body.replaceRecentBlockhash !== false,
            commitment: 'processed',
          }
        ]
      };
      const r = await rpcForward(env, rpcBody);
      const data = await r.text();
      return new Response(data, { status: r.status, headers: corsHeaders(origin, 'application/json') });
    }

    /* -------- /relay : sendRawTransaction(+optional confirm) -------- */
    if (url.pathname === '/relay' && req.method === 'POST') {
      type RelayReq = {
        tx: string;
        skipPreflight?: boolean;
        maxRetries?: number;
        preflightCommitment?: 'processed'|'confirmed'|'finalized';
        confirm?: boolean;
        confirmCommitment?: 'processed'|'confirmed'|'finalized';
        requireCreator?: boolean;
        signer?: string; // Base58 public key des ersten Signers (Client meldet das)
      };
      let body: RelayReq;
      try { body = await readJsonSafe<RelayReq>(req); }
      catch { return text('Bad JSON or too large', origin, 400); }
      if (!body?.tx) return text('Missing tx (base64)', origin, 400);

      // optionales Gate
      if (body.requireCreator) {
        const need = (env.CREATOR_PUBKEY || '').trim();
        const got  = (body.signer || '').trim();
        if (!need) return text('CREATOR_PUBKEY not configured', origin, 412);
        if (!got || got !== need) return text('Forbidden: signer is not creator', origin, 403);
      }

      // senden
      const sendBody = {
        jsonrpc: '2.0',
        id: 1,
        method: 'sendRawTransaction',
        params: [
          body.tx,
          {
            skipPreflight: !!body.skipPreflight,
            maxRetries: typeof body.maxRetries === 'number' ? body.maxRetries : undefined,
            preflightCommitment: body.preflightCommitment || 'processed',
          }
        ]
      };
      const sendResp = await rpcForward(env, sendBody);
      const sendJson = await sendResp.json<any>().catch(() => ({}));
      if (!sendResp.ok || sendJson?.error) {
        return json({ error: sendJson?.error || `sendRawTransaction failed ${sendResp.status}` }, origin, 502);
      }
      const signature = sendJson?.result;

      if (body.confirm) {
        const bh = await getLatestBlockhash(env).catch(() => undefined);
        const confBody = {
          jsonrpc: '2.0',
          id: 1,
          method: 'confirmTransaction',
          params: [
            { signature, ...(bh ? { blockhash: bh } : {}) },
            body.confirmCommitment || 'confirmed',
          ]
        };
        const confResp = await rpcForward(env, confBody);
        const confJson = await confResp.json<any>().catch(() => ({}));
        return json({ signature, confirm: confJson?.result ?? null }, origin);
      }

      return json({ signature }, origin);
    }

    /* -------- /claims : GET/POST (mit Duplikatschutz) -------- */
    if (url.pathname === '/claims') {
      if (req.method === 'GET') {
        const claimed = await getClaims(env);
        return json({ claimed }, origin);
      }
      if (req.method === 'POST') {
        try {
          const { index } = await readJsonSafe<{ index?: unknown }>(req);
          if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
            return text('Invalid index', origin, 400);
          }
          const res = await addClaim(env, index);
          if (res === 'exists') return json({ error: 'already claimed' }, origin, 409);
          return json({ ok: true }, origin);
        } catch {
          return text('Bad JSON or too large', origin, 400);
        }
      }
      return text('Method not allowed', origin, 405);
    }

    // 404
    return text('Not found', origin, 404);
  }
};