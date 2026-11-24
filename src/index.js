import { DurableObject } from 'cloudflare:workers';

const TTL_MS = 150_000;
const MAX_CHECK_UUIDS = 100;
const UUID_HEX_RE = /^[0-9a-f]{32}$/;

function normalizeUuid(raw) {
  if (typeof raw !== 'string') return null;
  const clean = raw.trim().toLowerCase().replace(/-/g, '');
  return UUID_HEX_RE.test(clean) ? clean : null;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export class PresenceRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.online = new Map();
    this.lastPrune = 0;
  }

  pruneExpired(now) {
    if (now - this.lastPrune < 15_000 && this.online.size < 2000) {
      return;
    }
    this.lastPrune = now;
    for (const [uuid, expiresAt] of this.online.entries()) {
      if (expiresAt <= now) {
        this.online.delete(uuid);
      }
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    this.pruneExpired(now);

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/health')) {
      return jsonResponse({ ok: true, onlineCount: this.online.size });
    }

    if (request.method === 'POST' && url.pathname === '/heartbeat') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
      }
      const uuid = normalizeUuid(body && body.uuid);
      if (!uuid) {
        return jsonResponse({ ok: false, error: 'invalid_uuid' }, 400);
      }
      this.online.set(uuid, now + TTL_MS);
      return jsonResponse({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/leave') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
      }
      const uuid = normalizeUuid(body && body.uuid);
      if (uuid) {
        this.online.delete(uuid);
      }
      return jsonResponse({ ok: true });
    }

    if (request.method === 'GET' && url.pathname === '/check') {
      const raw = url.searchParams.get('uuids') || '';
      const parts = raw ? raw.split(',') : [];
      const online = [];
      const limit = Math.min(parts.length, MAX_CHECK_UUIDS);
      for (let i = 0; i < limit; i++) {
        const uuid = normalizeUuid(parts[i]);
        if (!uuid) continue;
        const expiresAt = this.online.get(uuid);
        if (expiresAt && expiresAt > now) {
          online.push(uuid);
        } else if (expiresAt !== undefined) {
          this.online.delete(uuid);
        }
      }
      return jsonResponse({ online });
    }

    return jsonResponse({ ok: false, error: 'not_found' }, 404);
  }
}

export default {
  async fetch(request, env) {
    const id = env.PRESENCE_ROOM.idFromName('global');
    const stub = env.PRESENCE_ROOM.get(id);
    return stub.fetch(request);
  },
};
