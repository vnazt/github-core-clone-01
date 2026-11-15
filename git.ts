// The git object model and packfile machinery: SHA-1 objects (blob/tree/commit/tag), tree and
// commit parsing and building, reachability walks, pack reading (plain, OFS_DELTA and REF_DELTA
// entries) and pack writing (plain objects, no deltas). Node built-ins only: node:crypto for
// SHA-1 and node:zlib for the deflate streams git packs are made of.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_BY_CODE: Readonly<Record<number, GitObjType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
} as never;

const CODE_BY_TYPE: Readonly<Record<GitObjType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };

export function hashObject(type: GitObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** One repository's object database: every object it holds, by id. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  put(type: GitObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObject(oid: string, object: GitObject): void {
    if (!this.objects.has(oid)) this.objects.set(oid, object);
  }
}

// ---------------------------------------------------------------- trees and commits

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();
const commitParseCache = new WeakMap<Buffer, CommitInfo>();

export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeParseCache.get(data);
  if (cached !== undefined) return cached;
  const entries = parseTreeFresh(data);
  treeParseCache.set(data, entries);
  return entries;
}

function parseTreeFresh(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order of the name, a directory compared as if it ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function serializeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const mode = entry.mode === '040000' ? '40000' : entry.mode;
    parts.push(Buffer.from(`${mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const cached = commitParseCache.get(data);
  if (cached !== undefined) return cached;
  const info = parseCommitFresh(data);
  commitParseCache.set(data, info);
  return info;
}

function parseCommitFresh(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

/** The epoch seconds a commit's committer line carries (0 when unparseable). */
export function commitEpoch(data: Buffer): number {
  const { committer } = parseCommit(data);
  const match = / (\d+) [+-]\d{4}$/.exec(committer.trim());
  return match ? Number(match[1]) : 0;
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const out: TagInfo = { object: '', type: '', tag: '', tagger: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

/** Peel an object id to the commit it ultimately names (through tags), or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------- reachability

/** Every object reachable from the given tips (commits walk parents; trees recurse; tags peel). */
export function reachableSet(store: ObjectStore, tips: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const info = parseCommit(object.data);
      stack.push(info.tree, ...info.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` through commit parents (inclusive). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/**
 * The commit generations below a set of tips: commit oid -> its shortest distance (in parent
 * steps) from the nearest tip. Tips are generation 0.
 */
export function commitGenerations(store: ObjectStore, tips: readonly string[]): Map<string, number> {
  const generations = new Map<string, number>();
  let frontier = [...new Set(tips)];
  for (const tip of frontier) generations.set(tip, 0);
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: string[] = [];
    for (const oid of frontier) {
      const object = store.get(oid);
      if (object?.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (!generations.has(parent)) {
          generations.set(parent, depth);
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return generations;
}

/**
 * The objects a fetch sends: everything reachable from `tips`, minus everything in `exclude`,
 * with commit traversal optionally limited to `maxGeneration` parent steps from the tips (the
 * shallow depth). Commits at exactly the limit are included; their parents are not walked.
 */
export function fetchObjectSet(
  store: ObjectStore,
  tips: readonly string[],
  exclude: ReadonlySet<string>,
  maxGeneration: number | null,
): { objects: Set<string>; boundary: Set<string> } {
  const out = new Set<string>();
  const boundary = new Set<string>();
  const generations = maxGeneration === null ? null : commitGenerations(store, tips);
  const includedCommits = new Set<string>();
  // Commits first (generation-limited), then the trees and blobs they name.
  const commitStack: string[] = [];
  for (const tip of tips) {
    const object = store.get(tip);
    if (object?.type === 'tag') {
      // A wanted tag: include it and walk to its commit below.
      if (!exclude.has(tip)) out.add(tip);
      const commit = peelToCommit(store, tip);
      if (commit !== null) commitStack.push(commit);
    } else if (object?.type === 'commit') {
      commitStack.push(tip);
    }
  }
  const seenCommits = new Set<string>();
  while (commitStack.length > 0) {
    const oid = commitStack.pop() as string;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = store.get(oid);
    if (object?.type !== 'commit') continue;
    const generation = generations?.get(oid) ?? 0;
    if (maxGeneration !== null && generation > maxGeneration) continue;
    includedCommits.add(oid);
    if (!exclude.has(oid)) out.add(oid);
    const info = parseCommit(object.data);
    if (maxGeneration !== null && generation === maxGeneration) {
      if (info.parents.length > 0) boundary.add(oid);
      continue; // do not walk parents past the shallow cut
    }
    for (const parent of info.parents) commitStack.push(parent);
  }
  // Trees and blobs of the included commits (and of any included tags' targets).
  const stack: string[] = [];
  for (const oid of includedCommits) {
    const object = store.get(oid);
    if (object?.type === 'commit') stack.push(parseCommit(object.data).tree);
  }
  for (const oid of out) {
    const object = store.get(oid);
    if (object?.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = store.get(target);
      if (targetObject?.type === 'tree' || targetObject?.type === 'blob') stack.push(target);
    }
  }
  const seenTrees = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenTrees.has(oid)) continue;
    seenTrees.add(oid);
    const object = store.get(oid);
    if (object === undefined) continue;
    if (!exclude.has(oid)) out.add(oid);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
  return { objects: out, boundary };
}

/** A commit history walk from a tip, newest first (committer time, then discovery order). */
export function commitHistory(store: ObjectStore, tip: string, limit: number): string[] {
  const seen = new Set<string>();
  const out: Array<{ oid: string; epoch: number; order: number }> = [];
  const stack = [tip];
  let order = 0;
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object?.type !== 'commit') continue;
    seen.add(oid);
    out.push({ oid, epoch: commitEpoch(object.data), order: order++ });
    stack.push(...parseCommit(object.data).parents);
  }
  out.sort((a, b) => b.epoch - a.epoch || a.order - b.order);
  return out.slice(0, limit).map((entry) => entry.oid);
}

/** Flatten a tree (recursively) into path -> {mode, oid}; `prefix` is the path so far. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const object = store.get(treeOid);
  if (object?.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      for (const [childPath, child] of flattenTree(store, entry.oid, path)) out.set(childPath, child);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/** Build (and store) a tree hierarchy from a flat path -> {mode, oid} map; returns the root tree id. */
export function buildTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    dirs: Map<string, Node>;
    files: Map<string, { mode: string; oid: string }>;
  }
  const root: Node = { dirs: new Map(), files: new Map() };
  for (const [path, file] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() });
      node = node.dirs.get(part) as Node;
    }
    node.files.set(parts[parts.length - 1] as string, file);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return store.put('tree', serializeTree(entries));
  };
  return build(root);
}

/** The empty tree's id (a repository with no files yet). */
export const EMPTY_TREE_OID = hashObject('tree', Buffer.alloc(0));

// ---------------------------------------------------------------- packfiles

interface PackEntry {
  type: GitObjType;
  data: Buffer;
  offset: number;
}

/** Inflate the zlib stream starting at `offset`; returns its bytes and the offset just past it. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const targetSize = readSize();
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) if (op & (1 << bit)) copyOffset |= (delta[offset++] as number) << (8 * bit);
      for (let bit = 0; bit < 3; bit += 1) if (op & (0x10 << bit)) copySize |= (delta[offset++] as number) << (8 * bit);
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op > 0) {
      delta.copy(out, written, offset, offset + op);
      offset += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} bytes, expected ${targetSize}`);
  return out;
}

/**
 * Read a whole packfile into resolved objects. `resolveBase` supplies objects the pack's
 * REF_DELTA entries name but the pack does not carry (a thin pack); OFS_DELTA bases are always
 * inside the pack. Returns the objects in pack order.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Array<{ oid: string; object: GitObject }> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const entries: Array<{ offset: number; typeCode: number; data: Buffer; baseOffset?: number; baseOid?: string }> = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++] as number;
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++] as number;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === 6) {
      byte = pack[offset++] as number;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++] as number;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error(`pack entry at ${entryOffset} declares ${size} bytes, inflated to ${inflated.data.length}`);
    offset = inflated.next;
    byOffset.set(entryOffset, entries.length);
    entries.push({ offset: entryOffset, typeCode, data: inflated.data, baseOffset, baseOid });
  }
  if (offset !== trailerStart) throw new Error(`pack entries end at ${offset}, trailer starts at ${trailerStart}`);
  const resolved = new Map<number, GitObject>();
  const resolveEntry = (index: number): GitObject => {
    const cached = resolved.get(index);
    if (cached !== undefined) return cached;
    const entry = entries[index] as (typeof entries)[number];
    let object: GitObject;
    if (entry.typeCode === 6 || entry.typeCode === 7) {
      let base: GitObject | undefined;
      if (entry.typeCode === 6) {
        const baseIndex = byOffset.get(entry.baseOffset as number);
        if (baseIndex === undefined) throw new Error('ofs-delta base is not in the pack');
        base = resolveEntry(baseIndex);
      } else {
        const baseIndex = entries.findIndex((candidate, candidateIndex) => {
          if (candidate.typeCode === 6 || candidate.typeCode === 7) return false;
          return hashObject(candidateType(candidate), candidate.data) === entry.baseOid;
        });
        if (baseIndex >= 0) base = resolveEntry(baseIndex);
        else base = resolveBase?.(entry.baseOid as string);
      }
      if (base === undefined) throw new Error('delta base is unavailable');
      object = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      object = { type: TYPE_BY_CODE[entry.typeCode] as GitObjType, data: entry.data };
    }
    resolved.set(index, object);
    return object;
  };
  const candidateType = (entry: (typeof entries)[number]): GitObjType => TYPE_BY_CODE[entry.typeCode] as GitObjType;
  const out: Array<{ oid: string; object: GitObject }> = [];
  for (let index = 0; index < entries.length; index += 1) {
    const object = resolveEntry(index);
    out.push({ oid: hashObject(object.type, object.data), object });
  }
  return out;
}

/** Write a packfile of plain objects (no deltas), in the order given. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const code = CODE_BY_TYPE[object.type];
    let size = object.data.length;
    const first = size & 0x0f;
    size >>= 4;
    const bytes: number[] = [];
    let byte = (code << 4) | first;
    while (size > 0) {
      bytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    bytes.push(byte);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- pkt-lines

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

export function pktEncode(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = data.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Decode a complete pkt-line buffer; trailing partial data is an error. */
export function pktDecode(buffer: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      out.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      out.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      out.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3) {
      offset += 4; // a legacy no-op packet
    } else {
      if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return out;
}

/** Frame pack bytes as sideband band-1 pkt-lines (with an optional band-2 progress line first). */
export function sidebandFrame(pack: Buffer, progress?: string): Buffer {
  const parts: Buffer[] = [];
  if (progress !== undefined && progress !== '') {
    const line = Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')]);
    parts.push(pktEncode(line));
  }
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, Math.min(offset + CHUNK, pack.length));
    parts.push(pktEncode(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    parts.push(pktEncode(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}
