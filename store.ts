// The forge's world: one in-memory store shared by the git, REST, GraphQL and MCP surfaces, so
// an object created on one surface is the same object on every other. Repositories carry their
// own git object database and refs beside their issues, labels and pull requests. Issue and
// pull-request numbers share one per-repository sequence, as GitHub's do.
//
// Time: the store never reads the wall clock for a stored value. A logical clock starts at
// MAKEFUN_TRIAL_NOW when the trial provides one (else the scenario epoch) and advances one
// second per stamp, so two runs of one trial stamp identically and ordering is monotonic.

import {
  ObjectStore,
  buildCommit,
  buildTreeFromFiles,
  flattenTree,
  parseCommit,
  type GitObject,
} from './git.ts';
import { VIEWER, type ScenarioUser } from './scenario.ts';

const FALLBACK_EPOCH_SEC = 1_735_689_600; // 2025-01-01T00:00:00Z, wire.ts SCENARIO_EPOCH_SEC

function trialBaseEpoch(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
    const asNumber = Number(raw);
    if (Number.isFinite(asNumber) && asNumber > 0) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
  }
  return FALLBACK_EPOCH_SEC;
}

export class LogicalClock {
  #base: number;
  #tick = 0;

  constructor() {
    this.#base = trialBaseEpoch();
  }

  /** The next stamp, in epoch seconds; strictly increasing across the process. */
  nextEpoch(): number {
    const value = this.#base + this.#tick;
    this.#tick += 1;
    return value;
  }

  /** Peek at the current stamp without advancing (for values that must not move time). */
  peekEpoch(): number {
    return this.#base + this.#tick;
  }
}

export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

/** A git author/committer line for the viewer at the given epoch. */
export function identLine(user: ScenarioUser, epochSec: number): string {
  return `${user.name} <${user.email}> ${epochSec} +0000`;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  author: ScenarioUser;
  createdEpoch: number;
  updatedEpoch: number;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  author: ScenarioUser;
  createdEpoch: number;
  updatedEpoch: number;
  comments: CommentRec[];
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  merged: boolean;
  mergedEpoch: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  author: ScenarioUser;
  createdEpoch: number;
  updatedEpoch: number;
  comments: CommentRec[];
}

export type NumberedRec = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdEpoch: number;
  updatedEpoch: number;
  store: ObjectStore;
  /** Full ref name -> object id, e.g. refs/heads/main. HEAD is the default branch's ref. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests by number (one shared sequence). */
  numbered: Map<number, NumberedRec>;
  nextNumber: number;
  /** The tip commit of a branch, or undefined when the branch does not exist. */
  branchTip(branch: string): string | undefined;
}

export class Forge {
  readonly clock = new LogicalClock();
  readonly repos = new Map<string, RepoRec>();
  #nextRepoId = 1;
  #nextObjectId = 1;

  static key(owner: string, name: string): string {
    return `${owner.toLowerCase()}/${name.toLowerCase()}`;
  }

  getRepo(owner: string, name: string): RepoRec | undefined {
    return this.repos.get(Forge.key(owner, name));
  }

  createRepo(owner: string, name: string, init: { description?: string; private?: boolean }): RepoRec | 'exists' {
    const key = Forge.key(owner, name);
    if (this.repos.has(key)) return 'exists';
    const now = this.clock.nextEpoch();
    const repo: RepoRec = {
      id: this.#nextRepoId++,
      owner,
      name,
      description: init.description ?? '',
      private: init.private ?? false,
      defaultBranch: 'main',
      createdEpoch: now,
      updatedEpoch: now,
      store: new ObjectStore(),
      refs: new Map(),
      labels: new Map(),
      numbered: new Map(),
      nextNumber: 1,
      branchTip(branch: string): string | undefined {
        return this.refs.get(`refs/heads/${branch}`);
      },
    };
    this.repos.set(key, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Forge.key(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): RepoRec[] {
    return [...this.repos.values()].filter((repo) => repo.owner === VIEWER.login);
  }

  allocObjectId(): number {
    return this.#nextObjectId++;
  }

  // ------------------------------------------------------------ git helpers on a repo

  headRef(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  branchTip(repo: RepoRec, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  /** The tree id a ref or sha names (through commits and tags), or undefined. */
  treeOf(repo: RepoRec, oid: string): string | undefined {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = repo.store.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return parseCommit(object.data).tree;
      if (object.type === 'tag') {
        const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
        if (match === null) return undefined;
        current = match[1] as string;
        continue;
      }
      if (object.type === 'tree') return current;
      return undefined;
    }
    return undefined;
  }

  /** Flat path -> {mode, oid} for a ref's tip tree (empty map for an unborn/empty ref). */
  filesAt(repo: RepoRec, oid: string | undefined): Map<string, { mode: string; oid: string }> {
    if (oid === undefined) return new Map();
    const tree = this.treeOf(repo, oid);
    if (tree === undefined) return new Map();
    return flattenTree(repo.store, tree);
  }

  /**
   * Commit a flat file map onto a branch: builds the trees, writes a commit whose parent is the
   * branch tip (if any), moves the ref, and returns the commit id.
   */
  commitFiles(
    repo: RepoRec,
    branch: string,
    files: ReadonlyMap<string, { mode: string; oid: string }>,
    message: string,
    author: ScenarioUser = VIEWER,
  ): string {
    const tree = buildTreeFromFiles(repo.store, files);
    const parent = this.branchTip(repo, branch);
    const epoch = this.clock.nextEpoch();
    const ident = identLine(author, epoch);
    const commitData = buildCommit({
      tree,
      parents: parent === undefined ? [] : [parent],
      author: ident,
      committer: ident,
      message,
    });
    const oid = repo.store.put('commit', commitData);
    repo.refs.set(`refs/heads/${branch}`, oid);
    repo.updatedEpoch = epoch;
    return oid;
  }

  /** A loose object lookup exposed for the protocol layer. */
  object(repo: RepoRec, oid: string): GitObject | undefined {
    return repo.store.get(oid);
  }
}
