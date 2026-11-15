// app.ts — the HTTP router: auth, request ids, and dispatch to the four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP) over one shared Forge store. main.ts owns the lifecycle.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { routeRest, type HttpResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack, type GitHttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

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
  if (result.rawBody !== undefined) {
    sendBuffer(res, requestId, result.status, result.rawBody, result.rawType ?? 'application/octet-stream', result.headers ?? {});
    return;
  }
  if (result.status === 204 || result.body === undefined) {
    res.writeHead(result.status, { 'x-github-request-id': requestId, ...(result.headers ?? {}) });
    res.end();
    return;
  }
  sendJson(res, requestId, result.status, result.body, result.headers ?? {});
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

async function handle(forge: Forge, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requestId = nextRequestId();
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    sendJson(res, requestId, 400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}`;

  // The env's boot check: no auth, always available.
  if (method === 'GET' && path === '/healthz') {
    sendJson(res, requestId, 200, { ok: true });
    return;
  }

  const body = await readBody(req);

  if (!authorized(req)) {
    sendJson(res, requestId, 401, { message: 'Bad credentials' });
    return;
  }

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
    const result = routeRest(forge, { method, segments, query: url.searchParams, body: parsedBody, base });
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
      const service = url.searchParams.get('service') ?? '';
      sendGitResult(res, requestId, infoRefs(repo, service, req.headers['git-protocol'] ?? null));
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
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handle(forge, req, res).catch(() => {
      try {
        if (!res.headersSent) sendJson(res, nextRequestId(), 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
}
