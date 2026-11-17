// app.ts — the HTTP router: auth, request ids, and dispatch to the four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP) over one shared Forge store. main.ts owns the lifecycle.
//
// Transport: dispatch() is a pure, synchronous request -> response function. Two servers
// feed it: a hand-rolled HTTP/1.1 server on raw TCP (the default — the benchmark's
// workloads are thousands of sequential small requests, and node:http's per-request
// object churn is the largest cost we control), and a node:http adapter kept for local
// A/B runs (FORGE_TRANSPORT=http). Both speak to the same dispatch, so behaviour cannot
// drift between them.
//
// Perf shape: bodyless GETs never touch a body reader, the path is split by hand instead
// of paying for a URL parse per request, and GET answers are memoized against a mutation
// generation — every non-GET request advances the generation, so a cached answer can
// only ever be replayed while the store is exactly as it was when it was produced.

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { Forge } from './store.ts';
import { routeRest, type HttpResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { infoRefs, receivePack, uploadPack, type GitHttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const MAX_HEAD_BYTES = 64 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

export interface ForgeResponse {
  status: number;
  body: Buffer;
  contentType: string | null;
  headers: Record<string, string>;
  requestId: string;
}

type HeaderMap = Record<string, string | undefined>;

function jsonResponse(requestId: string, status: number, body: unknown, headers: Record<string, string> = {}): ForgeResponse {
  return { status, body: Buffer.from(`${JSON.stringify(body)}\n`, 'utf8'), contentType: JSON_TYPE, headers, requestId };
}

function bufferResponse(requestId: string, status: number, body: Buffer, contentType: string, headers: Record<string, string> = {}): ForgeResponse {
  return { status, body, contentType, headers, requestId };
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

function httpResultResponse(requestId: string, result: HttpResult): ForgeResponse {
  const serialized = serializeHttpResult(result);
  if (serialized === null) {
    return { status: result.status, body: EMPTY_BODY, contentType: null, headers: result.headers ?? {}, requestId };
  }
  return { status: serialized.status, body: serialized.body, contentType: serialized.contentType, headers: serialized.headers, requestId };
}

const GIT_HEADERS: Record<string, string> = {
  'cache-control': 'no-cache, max-age=0, must-revalidate',
  expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  pragma: 'no-cache',
};

function gitResponse(requestId: string, result: GitHttpResult): ForgeResponse {
  return { status: result.status, body: result.body, contentType: result.contentType, headers: { ...GIT_HEADERS }, requestId };
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

function authorized(headers: HeaderMap): boolean {
  const header = headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected !== undefined && expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

/** Route one fully-read request to its surface and build the response. Fully synchronous. */
export function dispatch(forge: Forge, cache: GetCache, method: string, target: string, headers: HeaderMap, body: Buffer): ForgeResponse {
  const requestId = nextRequestId();
  let path = target;
  let queryString = '';
  // Absolute-form targets (a proxy may send one) reduce to their path and query.
  if (path.startsWith('http://') || path.startsWith('https://')) {
    const authorityEnd = path.indexOf('/', path.indexOf('://') + 3);
    path = authorityEnd < 0 ? '/' : path.slice(authorityEnd);
  }
  const queryIndex = path.indexOf('?');
  if (queryIndex >= 0) {
    queryString = path.slice(queryIndex + 1);
    path = path.slice(0, queryIndex);
  }
  const query = new URLSearchParams(queryString);
  const host = headers.host ?? '127.0.0.1';
  const base = `http://${host}`;

  // The env's boot check: no auth, always available.
  if (method === 'GET' && path === '/healthz') {
    return jsonResponse(requestId, 200, { ok: true });
  }

  // Any state-changing verb invalidates every memoized GET answer up front.
  const isGet = method === 'GET';
  if (!isGet) {
    cache.generation += 1;
    cache.entries.clear();
  }

  if (!authorized(headers)) {
    return jsonResponse(requestId, 401, { message: 'Bad credentials' });
  }

  const cacheKey = isGet ? `${cache.generation}|${host}|${target}` : null;
  if (cacheKey !== null) {
    const hit = cache.entries.get(cacheKey);
    if (hit !== undefined) {
      return { status: hit.status, body: hit.body, contentType: hit.contentType, headers: hit.headers, requestId };
    }
  }
  const memoize = (serialized: SerializedResult): void => {
    if (cacheKey === null || serialized.status !== 200) return;
    if (cache.entries.size >= 1024) cache.entries.clear();
    cache.entries.set(cacheKey, serialized);
  };

  // MCP: the handler parses the raw body itself (a malformed body answers -32700).
  if (path === '/mcp') {
    if (method !== 'POST') return jsonResponse(requestId, 405, { message: 'Method Not Allowed' });
    const reply = handleMcp(forge, base, body.toString('utf8'));
    if (reply.bodyText === '') {
      return { status: reply.status, body: EMPTY_BODY, contentType: null, headers: {}, requestId };
    }
    return bufferResponse(requestId, reply.status, Buffer.from(reply.bodyText, 'utf8'), JSON_TYPE);
  }

  // GraphQL v4.
  if (path === '/api/graphql' || path === '/graphql') {
    if (method !== 'POST') return jsonResponse(requestId, 405, { message: 'Method Not Allowed' });
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8')) as unknown;
    } catch {
      return jsonResponse(requestId, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    }
    const reply = handleGraphQL({ forge, base }, parsed);
    return jsonResponse(requestId, reply.status, reply.body);
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
        return jsonResponse(requestId, 400, { message: 'Problems parsing JSON' });
      }
    }
    const result = routeRest(forge, { method, segments, query, body: parsedBody, base });
    if (isGet) {
      const serialized = serializeHttpResult(result);
      if (serialized === null) return httpResultResponse(requestId, result);
      memoize(serialized);
      return { status: serialized.status, body: serialized.body, contentType: serialized.contentType, headers: serialized.headers, requestId };
    }
    return httpResultResponse(requestId, result);
  }

  // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    const owner = decodeSegment(gitMatch[1] as string);
    const name = decodeSegment(gitMatch[2] as string);
    const action = gitMatch[3] as string;
    const repo = forge.getRepo(owner, name);
    if (repo === undefined) {
      return bufferResponse(requestId, 404, Buffer.from('repository not found\n', 'utf8'), 'text/plain; charset=utf-8');
    }
    if (action === 'info/refs' && method === 'GET') {
      const service = query.get('service') ?? '';
      const result = infoRefs(repo, service, headers['git-protocol'] ?? null);
      if (result.status === 200) {
        memoize({ status: result.status, body: result.body, contentType: result.contentType, headers: { ...GIT_HEADERS } });
      }
      return gitResponse(requestId, result);
    }
    if (action === 'git-upload-pack' && method === 'POST') {
      return gitResponse(requestId, uploadPack(repo, body));
    }
    if (action === 'git-receive-pack' && method === 'POST') {
      return gitResponse(requestId, receivePack(repo, body));
    }
    return jsonResponse(requestId, 405, { message: 'Method Not Allowed' });
  }

  return jsonResponse(requestId, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------
// node:http adapter (local A/B runs and a fallback transport).

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

function mayHaveBody(req: IncomingMessage): boolean {
  const length = req.headers['content-length'];
  if (length !== undefined && length !== '0') return true;
  if (req.headers['transfer-encoding'] !== undefined) return true;
  const method = req.method ?? 'GET';
  return method !== 'GET' && method !== 'HEAD';
}

function writeHttpResponse(res: ServerResponse, response: ForgeResponse): void {
  const headers: Record<string, string | number> = { 'x-github-request-id': response.requestId, ...response.headers };
  if (response.contentType !== null) headers['content-type'] = response.contentType;
  if (response.status !== 204) headers['content-length'] = response.body.length;
  res.writeHead(response.status, headers);
  res.end(response.body);
}

export function createHttpApp(forge: Forge, cache: GetCache): HttpServer {
  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    (async () => {
      const body = mayHaveBody(req) ? await readBody(req) : EMPTY_BODY;
      if (!mayHaveBody(req)) req.resume();
      const headers: HeaderMap = {};
      for (const [name, value] of Object.entries(req.headers)) {
        headers[name] = Array.isArray(value) ? value[0] : value;
      }
      writeHttpResponse(res, dispatch(forge, cache, req.method ?? 'GET', req.url ?? '/', headers, body));
    })().catch(() => {
      try {
        if (!res.headersSent) writeHttpResponse(res, jsonResponse(nextRequestId(), 500, { message: 'Internal Server Error' }));
        else res.end();
      } catch {
        // The socket is gone; nothing more to do.
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Hand-rolled HTTP/1.1 server on raw TCP: one buffer per socket, a small
// explicit parser (request line, headers, then a fixed-length or chunked
// body), and one write per response head plus its body.

const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content',
  301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 412: 'Precondition Failed',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 501: 'Not Implemented', 502: 'Bad Gateway',
};

interface ParsedHead {
  method: string;
  target: string;
  version: string;
  headers: HeaderMap;
  contentLength: number;
  chunked: boolean;
  expectContinue: boolean;
  keepAlive: boolean;
}

function parseHead(text: string): ParsedHead | null {
  const lines = text.split('\r\n');
  const requestLine = lines[0] ?? '';
  const parts = requestLine.split(' ');
  if (parts.length !== 3) return null;
  const [method, target, version] = parts as [string, string, string];
  if (!version.startsWith('HTTP/1.')) return null;
  const headers: HeaderMap = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  let contentLength = 0;
  if (headers['content-length'] !== undefined) {
    contentLength = Number.parseInt(headers['content-length'], 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) return null;
  }
  const chunked = (headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
  const connection = (headers.connection ?? '').toLowerCase();
  const keepAlive = version === 'HTTP/1.0' ? connection.includes('keep-alive') : !connection.includes('close');
  return {
    method,
    target,
    version,
    headers,
    contentLength,
    chunked,
    expectContinue: (headers.expect ?? '').toLowerCase().includes('100-continue'),
    keepAlive,
  };
}

function writeRawResponse(socket: Socket, head: ParsedHead, response: ForgeResponse): void {
  const isHead = head.method === 'HEAD';
  const noBodyStatus = response.status === 204 || response.status === 304;
  const lines: string[] = [`${head.version} ${response.status} ${STATUS_TEXT[response.status] ?? 'Status'}`];
  if (response.contentType !== null) lines.push(`content-type: ${response.contentType}`);
  if (!noBodyStatus) lines.push(`content-length: ${response.body.length}`);
  lines.push(`x-github-request-id: ${response.requestId}`);
  for (const [name, value] of Object.entries(response.headers)) lines.push(`${name}: ${value}`);
  if (!head.keepAlive) lines.push('connection: close');
  const headBuffer = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'utf8');
  if (isHead || noBodyStatus || response.body.length === 0) {
    socket.write(headBuffer);
  } else {
    socket.write(Buffer.concat([headBuffer, response.body]));
  }
}

type ConnState =
  | { phase: 'head' }
  | { phase: 'fixed'; head: ParsedHead; need: number; parts: Buffer[]; have: number }
  | { phase: 'chunk-size'; head: ParsedHead; parts: Buffer[]; have: number }
  | { phase: 'chunk-data'; head: ParsedHead; parts: Buffer[]; have: number; need: number }
  | { phase: 'chunk-trailer'; head: ParsedHead; parts: Buffer[]; have: number };

export function createRawApp(forge: Forge, cache: GetCache): NetServer {
  return createNetServer((socket: Socket) => {
    socket.setNoDelay(true);
    let buffer: Buffer = EMPTY_BODY;
    let state: ConnState = { phase: 'head' };
    let dead = false;

    const finish = (head: ParsedHead, body: Buffer): boolean => {
      let response: ForgeResponse;
      try {
        response = dispatch(forge, cache, head.method, head.target, head.headers, body);
      } catch {
        response = jsonResponse(nextRequestId(), 500, { message: 'Internal Server Error' });
      }
      writeRawResponse(socket, head, response);
      if (!head.keepAlive) {
        dead = true;
        socket.end();
        return false;
      }
      return true;
    };

    const pump = (): void => {
      for (;;) {
        if (dead) return;
        if (state.phase === 'head') {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > MAX_HEAD_BYTES) {
              dead = true;
              socket.destroy();
            }
            return;
          }
          const head = parseHead(buffer.subarray(0, end).toString('latin1'));
          buffer = buffer.subarray(end + 4);
          if (head === null) {
            dead = true;
            socket.destroy();
            return;
          }
          if (head.expectContinue) socket.write('HTTP/1.1 100 Continue\r\n\r\n');
          if (head.chunked) {
            state = { phase: 'chunk-size', head, parts: [], have: 0 };
          } else if (head.contentLength > 0) {
            if (head.contentLength > MAX_BODY_BYTES) {
              dead = true;
              socket.destroy();
              return;
            }
            state = { phase: 'fixed', head, need: head.contentLength, parts: [], have: 0 };
          } else if (!finish(head, EMPTY_BODY)) {
            return;
          }
          continue;
        }
        if (state.phase === 'fixed') {
          const take = Math.min(state.need - state.have, buffer.length);
          if (take > 0) {
            state.parts.push(buffer.subarray(0, take));
            state.have += take;
            buffer = buffer.subarray(take);
          }
          if (state.have < state.need) return;
          const { head } = state;
          const body = state.parts.length === 1 ? (state.parts[0] as Buffer) : Buffer.concat(state.parts);
          state = { phase: 'head' };
          if (!finish(head, body)) return;
          continue;
        }
        if (state.phase === 'chunk-size') {
          const end = buffer.indexOf('\r\n');
          if (end < 0) {
            if (buffer.length > MAX_HEAD_BYTES) {
              dead = true;
              socket.destroy();
            }
            return;
          }
          const sizeText = buffer.subarray(0, end).toString('latin1').split(';')[0]?.trim() ?? '';
          const size = Number.parseInt(sizeText, 16);
          buffer = buffer.subarray(end + 2);
          if (!Number.isFinite(size) || size < 0) {
            dead = true;
            socket.destroy();
            return;
          }
          if (size === 0) {
            state = { phase: 'chunk-trailer', head: state.head, parts: state.parts, have: state.have };
          } else {
            state = { phase: 'chunk-data', head: state.head, parts: state.parts, have: state.have, need: size };
          }
          continue;
        }
        if (state.phase === 'chunk-data') {
          const want = state.need + 2; // the chunk plus its trailing CRLF
          if (buffer.length < want) return;
          state.parts.push(buffer.subarray(0, state.need));
          state.have += state.need;
          if (state.have > MAX_BODY_BYTES) {
            dead = true;
            socket.destroy();
            return;
          }
          buffer = buffer.subarray(want);
          state = { phase: 'chunk-size', head: state.head, parts: state.parts, have: state.have };
          continue;
        }
        // chunk-trailer: trailer lines end at an empty line.
        if (buffer.length >= 2 && buffer[0] === 0x0d && buffer[1] === 0x0a) {
          buffer = buffer.subarray(2);
        } else {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) {
            if (buffer.length > MAX_HEAD_BYTES) {
              dead = true;
              socket.destroy();
            }
            return;
          }
          buffer = buffer.subarray(end + 4);
        }
        const { head } = state;
        const body = state.parts.length === 1 ? (state.parts[0] as Buffer) : Buffer.concat(state.parts);
        state = { phase: 'head' };
        if (!finish(head, body)) return;
      }
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', () => {
      dead = true;
    });
  });
}

/** Build the server (raw TCP by default). It binds nothing until the caller listens. */
export function createApp(): HttpServer | NetServer {
  const forge = new Forge();
  const cache: GetCache = { generation: 0, entries: new Map() };
  if (process.env.FORGE_TRANSPORT === 'http') return createHttpApp(forge, cache);
  return createRawApp(forge, cache);
}
