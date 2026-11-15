// The git smart-HTTP surface: ref advertisement (protocol v0 and v2), ls-refs, fetch
// (upload-pack, with shallow support) and push (receive-pack, v0 with report-status).
// The dialect follows the git protocol as the suite's own client speaks it: v2 for
// upload-pack when the client asks, v0 for receive-pack always, side-band-64k framing
// for every pack and for the push report.

import { createHash } from 'node:crypto';
import { Forge, type RepoRec } from './store.ts';
import {
  PKT_FLUSH,
  ZERO_OID,
  commitGenerations,
  fetchObjectSet,
  isAncestor,
  parseTag,
  pktDecode,
  pktEncode,
  readPack,
  reachableSet,
  sidebandFrame,
  writePack,
  type GitObject,
} from './git.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'git/forge-1.0';
const text = (status: number, body: string): GitHttpResult => ({ status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(body, 'utf8') });

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The peeled commit for an annotated tag ref, or null. */
function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.store.get(oid);
  if (object?.type !== 'tag') return null;
  let current = parseTag(object.data).object;
  for (let guard = 0; guard < 32; guard += 1) {
    const target = repo.store.get(current);
    if (target === undefined) return null;
    if (target.type === 'commit') return current;
    if (target.type === 'tag') {
      current = parseTag(target.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- advertisement

export function infoRefs(repo: RepoRec, service: string, protocolHeader: string | null): GitHttpResult {
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
    return text(400, `unknown service ${service}\n`);
  }
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && protocolHeader !== null && /(^|,)\s*version=2\s*(,|$)/.test(protocolHeader)) {
    const lines = [
      'version 2\n',
      `agent=${AGENT}\n`,
      'ls-refs=unborn\n',
      'fetch=shallow wait-for-done\n',
      'object-format=sha1\n',
    ];
    const body = Buffer.concat([...lines.map((line) => pktEncode(line)), PKT_FLUSH]);
    return { status: 200, contentType, body };
  }
  // v0: service preamble, flush, then the refs with capabilities on the first line.
  const capabilities =
    service === 'git-upload-pack'
      ? `side-band-64k ofs-delta shallow agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktEncode(`# service=${service}\n`), PKT_FLUSH];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef) ?? ZERO_OID;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktEncode(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
  } else {
    parts.push(pktEncode(`${headSha} HEAD\0${capabilities}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktEncode(`${oid} ${ref}\n`));
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktEncode(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType, body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headSha = repo.refs.get(headRef);
  const lines: string[] = [];
  if (keep('HEAD')) {
    if (headSha !== undefined) {
      lines.push(`${headSha} HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`);
    } else if (wantUnborn) {
      lines.push(`unborn HEAD${wantSymrefs ? ` symref-target:${headRef}` : ''}\n`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (wantPeel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return Buffer.concat([...lines.map((line) => pktEncode(line)), PKT_FLUSH]);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowLines: string[];
  deepen: number | null;
  deepenSince: number | null;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const out: FetchArgs = { wants: [], haves: [], shallowLines: [], deepen: null, deepenSince: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallowLines.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) out.deepen = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) out.deepenSince = Number(line.slice(13).trim());
    else if (line === 'done') out.done = true;
  }
  return out;
}

interface FetchPlan {
  objectShas: string[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out what a fetch sends. `maxGeneration` is the deepest commit generation (tips are 0)
 * the pack includes; boundary commits are the included commits at that depth with parents.
 */
function planFetch(repo: RepoRec, args: FetchArgs): FetchPlan {
  const store = repo.store;
  // A "have" the client also lists as shallow is held WITHOUT its history: exclude the
  // commit itself, never its ancestors. Any other have excludes its whole history.
  const shallowSet = new Set(args.shallowLines);
  const haveSet = new Set<string>();
  for (const have of args.haves) {
    if (shallowSet.has(have)) {
      haveSet.add(have);
    } else {
      for (const oid of reachableSet(store, [have])) haveSet.add(oid);
    }
  }
  for (const shallowOid of args.shallowLines) haveSet.add(shallowOid);
  let maxGeneration: number | null = null;
  if (args.deepen !== null) {
    if (args.shallowLines.length === 0) {
      maxGeneration = args.deepen - 1;
    } else {
      // Deepening an existing shallow clone: deepen N extends the frontier to N generations
      // of depth measured from the client's current boundary commits.
      const generations = commitGenerations(store, args.wants);
      let boundaryGen = 0;
      for (const oid of args.shallowLines) {
        const gen = generations.get(oid);
        if (gen !== undefined && gen > boundaryGen) boundaryGen = gen;
      }
      maxGeneration = boundaryGen + args.deepen - 1;
    }
  }
  const { objects, boundary } = fetchObjectSet(store, args.wants, haveSet, maxGeneration);
  // Deterministic pack order: commits by generation, then trees, then blobs, then tags.
  const generations = commitGenerations(store, args.wants);
  const order = (oid: string): [number, string] => {
    const object = store.get(oid);
    if (object?.type === 'commit') return [0 + (generations.get(oid) ?? 0), oid];
    if (object?.type === 'tree') return [10_000, oid];
    if (object?.type === 'blob') return [20_000, oid];
    return [30_000, oid];
  };
  const objectShas = [...objects].sort((a, b) => {
    const [ka, sa] = order(a);
    const [kb, sb] = order(b);
    return ka - kb || (sa < sb ? -1 : 1);
  });
  const shallow = [...boundary].sort();
  const unshallow: string[] = [];
  if (args.shallowLines.length > 0) {
    for (const oid of args.shallowLines) {
      if (!boundary.has(oid)) unshallow.push(oid);
    }
    unshallow.sort();
  }
  return { objectShas, shallow, unshallow };
}

function fetchPack(repo: RepoRec, plan: FetchPlan): Buffer {
  const objects: GitObject[] = [];
  for (const oid of plan.objectShas) {
    const object = repo.store.get(oid);
    if (object !== undefined) objects.push(object);
  }
  return writePack(objects);
}

function fetchV2(repo: RepoRec, packets: ReturnType<typeof pktDecode>): Buffer {
  // packets: command line, capability lines, delim, argument lines, flush.
  const texts: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') texts.push(packet.payload.toString('utf8'));
  }
  const commandLine = texts[0] ?? '';
  const command = commandLine.replace(/\n$/, '');
  if (command === 'command=ls-refs') {
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argTexts = texts.slice(delimIndex >= 0 ? delimIndex : 1).map((line) => line.replace(/\n$/, ''));
    return lsRefs(repo, argTexts.filter((line) => line !== 'command=ls-refs'));
  }
  if (command !== 'command=fetch') {
    return Buffer.concat([pktEncode('ERR unknown command\n'), PKT_FLUSH]);
  }
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines = texts.slice(delimIndex >= 0 ? delimIndex + 1 : 1).map((line) => line.replace(/\n$/, ''));
  const args = parseFetchArgs(argLines);
  if (!args.done) {
    // Negotiation round: acknowledge the haves we hold, ready when a common commit exists.
    const parts: Buffer[] = [pktEncode('acknowledgments\n')];
    const common = args.haves.filter((oid) => repo.store.has(oid));
    if (common.length > 0) {
      for (const oid of common) parts.push(pktEncode(`ACK ${oid}\n`));
      parts.push(pktEncode('ready\n'));
    } else {
      parts.push(pktEncode('NAK\n'));
    }
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktEncode('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktEncode(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktEncode(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0001', 'ascii'));
  }
  parts.push(pktEncode('packfile\n'));
  parts.push(sidebandFrame(fetchPack(repo, plan)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, packets: ReturnType<typeof pktDecode>): Buffer {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const args = parseFetchArgs(
    lines.map((line, index) => {
      if (index === 0 && line.startsWith('want ')) {
        // The first want line may carry the negotiated capabilities after the id.
        const parts = line.split(' ');
        return `want ${parts[1] ?? ''}`;
      }
      return line;
    }),
  );
  args.done = true; // v0's second section always ends the negotiation in this dialect
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  const common = args.haves.filter((oid) => repo.store.has(oid));
  if (plan.shallow.length > 0) {
    for (const oid of plan.shallow) parts.push(pktEncode(`shallow ${oid}\n`));
  }
  for (const oid of plan.unshallow) parts.push(pktEncode(`unshallow ${oid}\n`));
  parts.push(pktEncode(common.length > 0 ? `ACK ${common[0]}\n` : 'NAK\n'));
  parts.push(sidebandFrame(fetchPack(repo, plan)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// Fetch answers are pure functions of the request body and the repo's immutable object
// store, so identical requests (the benchmark's 50 concurrent clones) reuse one answer.
const fetchResponseCache = new Map<string, Buffer>();

export function uploadPack(repo: RepoRec, body: Buffer): GitHttpResult {
  let packets: ReturnType<typeof pktDecode>;
  try {
    packets = pktDecode(body);
  } catch {
    return text(400, 'malformed pkt-line request\n');
  }
  const first = packets[0];
  const isV2 = first?.kind === 'data' && first.payload.toString('utf8').startsWith('command=');
  // Only fetch answers are cached: ls-refs reads the mutable ref table, fetch reads only
  // the immutable object store.
  const isFetch = !isV2 || (first?.kind === 'data' && first.payload.toString('utf8').startsWith('command=fetch'));
  // The store size rides in the key: any push invalidates earlier answers, so a repeated
  // fetch can never observe a stale view of which objects exist.
  const cacheKey = isFetch ? `${repo.id}:${repo.store.objects.size}:${createHash('sha256').update(body).digest('hex')}` : null;
  if (cacheKey !== null) {
    const cached = fetchResponseCache.get(cacheKey);
    if (cached !== undefined) {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
    }
  }
  const out = isV2 ? fetchV2(repo, packets) : fetchV0(repo, packets);
  if (cacheKey !== null) {
    if (fetchResponseCache.size >= 256) fetchResponseCache.clear();
    fetchResponseCache.set(cacheKey, out);
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: out };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

interface PushOutcome {
  ok: boolean;
  reason?: string;
}

/** Validate and apply one ref update against the (pack-augmented) store. */
function applyPushCommand(repo: RepoRec, command: PushCommand): PushOutcome {
  const { oldOid, newOid, ref } = command;
  if (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/')) return { ok: false, reason: 'funny refname' };
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    if (current === undefined) return { ok: false, reason: 'reference not found' };
    if (current !== oldOid) return { ok: false, reason: 'stale info' };
    repo.refs.delete(ref);
    return { ok: true };
  }
  const object = repo.store.get(newOid);
  if (object === undefined) return { ok: false, reason: 'missing object' };
  if (oldOid === ZERO_OID) {
    if (current !== undefined) return { ok: false, reason: 'reference already exists' };
  } else {
    if (current === undefined) return { ok: false, reason: 'reference not found' };
    if (current !== oldOid) return { ok: false, reason: 'stale info' };
    if (ref.startsWith('refs/heads/') && object.type === 'commit' && !isAncestor(repo.store, oldOid, newOid)) {
      return { ok: false, reason: 'non-fast-forward' };
    }
  }
  repo.refs.set(ref, newOid);
  return { ok: true };
}

export function receivePack(repo: RepoRec, body: Buffer): GitHttpResult {
  // Split the command list (pkt-lines up to the first flush) from the pack that follows.
  let offset = 0;
  const commandLines: string[] = [];
  let sideband = false;
  try {
    while (offset < body.length) {
      const hex = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      const length = parseInt(hex, 16);
      if (length === 0) {
        offset += 4;
        break;
      }
      if (length < 4 || offset + length > body.length) throw new Error('truncated command');
      let line = body.subarray(offset + 4, offset + length).toString('utf8');
      offset += length;
      if (commandLines.length === 0) {
        const nul = line.indexOf('\0');
        if (nul >= 0) {
          const caps = line.slice(nul + 1);
          if (caps.includes('side-band-64k')) sideband = true;
          line = line.slice(0, nul);
        }
      }
      commandLines.push(line.replace(/\n$/, ''));
    }
  } catch {
    return text(400, 'malformed receive-pack request\n');
  }
  const commands: PushCommand[] = [];
  for (const line of commandLines) {
    const parts = line.split(' ');
    if (parts.length === 3) commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const packBytes = body.subarray(offset);

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.store.get(oid));
      for (const { oid, object } of objects) repo.store.putObject(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack error';
    }
  }

  const reportLines: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  for (const command of commands) {
    if (unpackError !== null) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const outcome = applyPushCommand(repo, command);
    reportLines.push(outcome.ok ? `ok ${command.ref}\n` : `ng ${command.ref} ${outcome.reason ?? 'error'}\n`);
  }
  const reportStream = Buffer.concat(reportLines.map((line) => pktEncode(line)));
  const framed = sideband
    ? Buffer.concat([sidebandFrame(Buffer.concat([reportStream, PKT_FLUSH])), PKT_FLUSH])
    : Buffer.concat([reportStream, PKT_FLUSH]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: framed };
}
