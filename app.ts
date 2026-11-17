// app.ts — the HTTP router: auth, request ids, and dispatch to the four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP) over one shared Forge store. main.ts owns the lifecycle.
//
// Perf shape (the benchmark's read/push workloads are long runs of sequential requests):
// bodyless GETs never touch the body reader, the path is split by hand instead of paying
// for a URL parse per request, and GET answers are memoized against a mutation generation
// — every non-GET request advances the generation, so a cached answer can only ever be
// replayed while the store is exactly as it was when the answer was produced.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { routeRest, type HttpResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack, type GitHttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Whether the request can carry a body worth reading (a GET with neither length nor encoding has none). */
function mayHaveBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined && length !== '0') return true;
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const method = req.method ?? 'GET';
  return method !== 'GET' && method !== 'HEAD';
}

interface SerializedResult {
  status: number;
  body: Buffer;
  contentType: string;
  headers: Record<string, string>;
}

/** The wire form of a REST result, or null when the answer is an empty body. */
function serializeHttpResult(result: HttpResult): SerializedResult | null {
  if (result.rawBody !== undefined) {
    return { status: result.status, body: result.rawBody, contentType: result.rawType ?? 'application/octet-stream', headers: result.headers ?? {} };
  }
  if (result.status === 204 || result.body === undefined) return null;
  return { status: result.status, body: Buffer.from(`${JSON.stringify(result.body)}\n`, 'utf8'), contentType: JSON_TYPE, headers: result.headers ?? {} };
}

function sendBuffer(res: ServerResponse, requestId: string, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, requestId: string, status: number, body: unknown, headers: Record<string, string> = {}): void {
  sendBuffer(res, requestId, status, Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), JSON_TYPE, headers);
}

function sendHttpResult(res: ServerResponse, requestId: string, result: HttpResult): void {
  const serialized = serializeHttpResult(result);
  if (serialized === null) {
    res.writeHead(result.status, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendBuffer(res, requestId, serialized.status, serialized.body, serialized.contentType, serialized.headers);
}

function sendGitResult(res: ServerResponse, requestId: string, result: GitHttpResult): void {
  sendBuffer(res, requestId, result.status, result.body, result.contentType, {
    'cache-control': 'no-cache, max-age=0, must-revalidate',
    expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
    pragma: 'no-cache',
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** GET answers memoized per mutation generation (see the header note). */
interface GetCache {
  generation: number;
  entries: Map<string, SerializedResult>;
}

async function handle(forge: Forge, cache: GetCache, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const queryIndex = rawUrl.indexOf('?');
  const path = queryIndex < 0 ? rawUrl : rawUrl.slice(0, queryIndex);
  const query = new URLSearchParams(queryIndex < 0 ? '' : rawUrl.slice(queryIndex + 1));
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}`;

  // The env's boot check: no auth, always available.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, requestId, 200, { ok: true });
    return;
  }

  // Any state-changing verb invalidates every memoized GET answer up front.
  const isGet = method === 'GET';
  if (!isGet) {
    cache.generation += 1;
    cache.entries.clear();
  }

  const body = mayHaveBody(req) ? await readBody(req) : EMPTY_BODY;
  if (!mayHaveBody(req)) req.resume();

  if (!authorized(req)) {
    sendJson(res, requestId, 401, { message: 'Bad credentials' });
    return;
  }

  const cacheKey = isGet ? `${cache.generation}|${host}|${rawUrl}` : null;
  if (cacheKey !== null) {
    const hit = cache.entries.get(cacheKey);
    if (hit !== undefined) {
      sendBuffer(res, requestId, hit.status, hit.body, hit.contentType, hit.headers);
      return;
    }
  }
  const memoize = (serialized: SerializedResult): void => {
    if (cacheKey === null || serialized.status !== 200) return;
    if (cache.entries.size >= 1024) cache.entries.clear();
    cache.entries.set(cacheKey, serialized);
  };

  // MCP: the handler parses the raw body itself (a malformed body answers -32700).
  if (path === '/mcp') {
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
      return;
    }
    const reply = handleMcp(forge, base, body.toString('utf8'));
    if (reply.bodyText === '') {
      res.writeHead(reply.status, { 'x-github-request-id': requestId });
      res.end();
      return;
    }
    sendBuffer(res, requestId, reply.status, Buffer.from(reply.bodyText, 'utf8'), JSON_TYPE);
    return;
  }

  // GraphQL v4.
  if (path === '/api/graphql' || path === '/graphql') {
    if (method !== 'POST') {
      sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      sendJson(res, requestId, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    const reply = handleGraphQL({ forge, base }, parsed);
    sendJson(res, requestId, reply.status, reply.body);
    return;
  }

  // REST v3.
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    const restPath = path.slice('/api/v3'.length);
    const segments = restPath.split('/').filter((segment) => segment !== '').map(decodeSegment);
    let parsedBody: unknown;
    if (body.length > 0) {
      try {
        parsedBody = JSON.parse(body.toString('utf8')) as unknown;
      } catch {
        sendJson(res, requestId, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }
    const result = routeRest(forge, { method, segments, query, body: parsedBody, base });
    if (isGet) {
      const serialized = serializeHttpResult(result);
      if (serialized === null) {
        res.writeHead(result.status, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
        res.end();
        return;
      }
      memoize(serialized);
      sendBuffer(res, requestId, serialized.status, serialized.body, serialized.contentType, serialized.headers);
      return;
    }
    sendHttpResult(res, requestId, result);
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1] as string);
    const name = decodeSegment(gitMatch[2] as string);
    const action = gitMatch[3] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) {
      sendBuffer(res, requestId, 404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
      return;
    }
    if (action === 'info/refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      const result = infoRefs(repo, service, req.headers['git-protocol'] ?? null);
      if (result.status === 200) {
        memoize({ status: result.status, body: result.body, contentType: result.contentType, headers: {} });
        sendBuffer(res, requestId, result.status, result.body, result.contentType, {
          'cache-control': 'no-cache, max-age=0, must-revalidate',
          expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
          pragma: 'no-cache',
        });
        return;
      }
      sendGitResult(res, requestId, result);
      return;
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      sendGitResult(res, requestId, uploadPack(repo, body));
      return;
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      sendGitResult(res, requestId, receivePack(repo, body));
      return;
    }
    sendJson(res, requestId, 405, { message: 'Method Not Allowed' });
    return;
  }

  sendJson(res, requestId, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const cache: GetCache = { generation: 0, entries: new Map() };
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(forge, cache, req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, nextRequestId(), 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
}
