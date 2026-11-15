// The REST v3 surface: repositories, branches, commits, contents, labels, issues, comments and
// pull requests, in GitHub's shapes and status discipline. Everything reads and writes the one
// Forge store, so git pushes, contents commits and API objects are views of the same state.

import { VIEWER, labelColor, type ScenarioUser } from './scenario.ts';
import { Forge, identLine, isoOf, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFiles,
  commitHistory,
  isAncestor,
  parseCommit,
  peelToCommit,
} from './git.ts';

export interface HttpResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  rawBody?: Buffer;
  rawType?: string;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): HttpResult => ({ status, body, headers });
export const notFound = (): HttpResult => json(404, { message: 'Not Found' });
const validationFailed = (message: string): HttpResult =>
  json(422, { message: 'Validation Failed', errors: [{ resource: 'Forge', code: 'custom', message }] });

// ---------------------------------------------------------------- shared shapes

const userJsonCache = new Map<string, Record<string, unknown>>();

export function userJson(user: ScenarioUser, base: string): Record<string, unknown> {
  const key = `${user.id}|${base}`;
  const cached = userJsonCache.get(key);
  if (cached !== undefined) return cached;
  const built = userJsonFresh(user, base);
  userJsonCache.set(key, built);
  return built;
}

function userJsonFresh(user: ScenarioUser, base: string): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: nodeId('User', user.id),
    avatar_url: '',
    gravatar_id: '',
    url: `${base}/api/v3/users/${user.login}`,
    html_url: `${base}/${user.login}`,
    type: 'User',
    site_admin: false,
    name: user.name,
    email: user.email,
  };
}

const nodeIdCache = new Map<string, string>();

export function nodeId(type: string, id: number): string {
  const key = `${type}:${id}`;
  const cached = nodeIdCache.get(key);
  if (cached !== undefined) return cached;
  const built = Buffer.from(key, 'utf8').toString('base64');
  if (nodeIdCache.size >= 50_000) nodeIdCache.clear();
  nodeIdCache.set(key, built);
  return built;
}

export function repoJson(repo: RepoRec, base: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: nodeId('Repository', repo.id),
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userJson(VIEWER, base),
    html_url: `${base}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${fullName}`,
    git_url: `git://${base.replace(/^https?:\/\//, '')}/${fullName}.git`,
    clone_url: `${base}/${fullName}.git`,
    created_at: isoOf(repo.createdEpoch),
    updated_at: isoOf(repo.updatedEpoch),
    pushed_at: isoOf(repo.updatedEpoch),
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
  };
}

function labelJson(repo: RepoRec, name: string, base: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: stableLabelId(repo.id, name),
    node_id: nodeId('Label', stableLabelId(repo.id, name)),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? labelColor(name),
    default: false,
    description: label?.description ?? null,
  };
}

function stableLabelId(repoId: number, name: string): number {
  let hash = repoId * 1_000_003;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 100_000_000;
}

const issueJsonCache = new Map<string, Record<string, unknown>>();

export function issueJson(forge: Forge, repo: RepoRec, rec: IssueRec, base: string): Record<string, unknown> {
  // An issue's JSON changes only when the record does; the read benchmark hammers one
  // issue thousands of times, so the built object is shared until it changes.
  const key = `${repo.id}:${rec.id}:${rec.updatedEpoch}:${rec.comments.length}:${rec.labels.join(',')}:${base}`;
  const cached = issueJsonCache.get(key);
  if (cached !== undefined) return cached;
  const built = issueJsonFresh(forge, repo, rec, base);
  if (issueJsonCache.size >= 20_000) issueJsonCache.clear();
  issueJsonCache.set(key, built);
  return built;
}

function issueJsonFresh(forge: Forge, repo: RepoRec, rec: IssueRec, base: string): Record<string, unknown> {
  void forge;
  return {
    id: rec.id,
    node_id: nodeId('Issue', rec.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${rec.number}`,
    repository_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${rec.number}/labels{/name}`,
    comments_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${rec.number}/comments`,
    events_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${rec.number}/events`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${rec.number}`,
    number: rec.number,
    state: rec.state,
    title: rec.title,
    body: rec.body ?? '',
    user: userJson(rec.author, base),
    labels: rec.labels.map((name) => labelJson(repo, name, base)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: rec.comments.length,
    created_at: isoOf(rec.createdEpoch),
    updated_at: isoOf(rec.updatedEpoch),
    closed_at: rec.state === 'closed' ? isoOf(rec.updatedEpoch) : null,
    author_association: 'OWNER',
  };
}

export function pullJson(forge: Forge, repo: RepoRec, rec: PullRec, base: string): Record<string, unknown> {
  const repoRef = (ref: string, sha: string): Record<string, unknown> => ({
    label: `${repo.owner}:${ref}`,
    ref,
    sha,
    user: userJson(VIEWER, base),
    repo: repoJson(repo, base),
  });
  return {
    id: rec.id,
    node_id: nodeId('PullRequest', rec.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${rec.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${rec.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${rec.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${rec.number}.patch`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${rec.number}`,
    number: rec.number,
    state: rec.state,
    title: rec.title,
    body: rec.body ?? '',
    user: userJson(rec.author, base),
    labels: [],
    locked: false,
    created_at: isoOf(rec.createdEpoch),
    updated_at: isoOf(rec.updatedEpoch),
    closed_at: rec.state === 'closed' ? isoOf(rec.updatedEpoch) : null,
    merged_at: rec.merged ? isoOf(rec.mergedEpoch as number) : null,
    merge_commit_sha: rec.mergeCommitSha,
    merged: rec.merged,
    head: repoRef(rec.headRef, rec.headSha),
    base: repoRef(rec.baseRef, rec.baseSha),
    author_association: 'OWNER',
    draft: false,
  };
}

function commentJson(repo: RepoRec, issueNumber: number, comment: { id: number; body: string; author: ScenarioUser; createdEpoch: number; updatedEpoch: number }, base: string): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: nodeId('IssueComment', comment.id),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${repo.owner}/${repo.name}/issues/${issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`,
    body: comment.body,
    user: userJson(comment.author, base),
    created_at: isoOf(comment.createdEpoch),
    updated_at: isoOf(comment.updatedEpoch),
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------- pagination

interface Page {
  page: number;
  perPage: number;
}

function pageOf(query: URLSearchParams): Page {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: Page, urlFor: (page: number) => string): { slice: T[]; headers: Record<string, string> } {
  const totalPages = Math.max(1, Math.ceil(items.length / page.perPage));
  const start = (page.page - 1) * page.perPage;
  const slice = items.slice(start, start + page.perPage);
  const links: string[] = [];
  if (page.page < totalPages) {
    links.push(`<${urlFor(page.page + 1)}>; rel="next"`);
    links.push(`<${urlFor(totalPages)}>; rel="last"`);
  }
  if (page.page > 1) {
    links.push(`<${urlFor(page.page - 1)}>; rel="prev"`);
    links.push(`<${urlFor(1)}>; rel="first"`);
  }
  return { slice, headers: links.length > 0 ? { link: links.join(', ') } : {} };
}

// ---------------------------------------------------------------- the router

export interface RestRequest {
  method: string;
  /** Path segments after /api/v3, decoded. */
  segments: string[];
  query: URLSearchParams;
  body: unknown;
  base: string;
}

function bodyObject(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function stringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

export function routeRest(forge: Forge, req: RestRequest): HttpResult {
  const { segments, method } = req;
  const base = req.base;

  // Root and meta.
  if (segments.length === 0 && method === 'GET') {
    return json(
      200,
      {
        current_user_url: `${base}/api/v3/user`,
        repository_url: `${base}/api/v3/repos/{owner}/{repo}`,
        issue_search_url: `${base}/api/v3/search/issues?q={query}`,
        rate_limit_url: `${base}/api/v3/rate_limit`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return json(200, { verifiable_password_authentication: false, installed_version: '1.0.0' });
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    return json(200, userJson(VIEWER, base));
  }

  // POST /user/repos, GET /user/repos.
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(forge, req);
    if (method === 'GET') {
      const page = pageOf(req.query);
      const all = forge.viewerRepos().map((repo) => repoJson(repo, base));
      const { slice, headers } = paginate(all, page, (p) => `${base}/api/v3/user/repos?per_page=${page.perPage}&page=${p}`);
      return json(200, slice, headers);
    }
    return notFound();
  }

  // Everything under /repos/{owner}/{repo}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const repo = forge.getRepo(owner, name);
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return repo === undefined ? notFound() : json(200, repoJson(repo, base));
      if (repo === undefined) return notFound();
      if (method === 'PATCH') {
        const body = bodyObject(req.body);
        const description = stringField(body, 'description');
        if (description !== undefined) repo.description = description;
        const priv = body['private'];
        if (typeof priv === 'boolean') repo.private = priv;
        const newName = stringField(body, 'name');
        if (newName !== undefined && newName !== repo.name) {
          if (forge.getRepo(repo.owner, newName) !== undefined) return validationFailed('name already exists on this account');
          forge.repos.delete(Forge.key(repo.owner, repo.name));
          repo.name = newName;
          forge.repos.set(Forge.key(repo.owner, repo.name), repo);
        }
        repo.updatedEpoch = forge.clock.nextEpoch();
        return json(200, repoJson(repo, base));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(owner, name);
        return { status: 204 };
      }
      return notFound();
    }

    if (repo === undefined) return notFound();
    return routeRepo(forge, repo, rest, req);
  }

  return notFound();
}

function createRepo(forge: Forge, req: RestRequest): HttpResult {
  const body = bodyObject(req.body);
  const name = stringField(body, 'name');
  if (name === undefined || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return validationFailed('name is invalid');
  }
  const created = forge.createRepo(VIEWER.login, name, {
    description: stringField(body, 'description') ?? '',
    private: typeof body['private'] === 'boolean' ? (body['private'] as boolean) : false,
  });
  if (created === 'exists') {
    return json(422, {
      message: 'Validation Failed',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  return json(201, repoJson(created, req.base));
}

function routeRepo(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): HttpResult {
  const { method, base } = req;
  const head = rest[0] as string;

  if (head === 'branches' && method === 'GET') {
    if (rest.length === 1) {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      const page = pageOf(req.query);
      const { slice, headers } = paginate(branches, page, (p) => `${base}/api/v3/repos/${repo.owner}/${repo.name}/branches?per_page=${page.perPage}&page=${p}`);
      return json(200, slice, headers);
    }
    const branchName = rest.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branchName}`);
    if (sha === undefined) return notFound();
    return json(200, { name: branchName, commit: { sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}` }, protected: false });
  }

  if (head === 'commits' && method === 'GET' && rest.length === 1) {
    const shaParam = req.query.get('sha');
    let tip: string | undefined;
    if (shaParam === null || shaParam === '') tip = repo.branchTip(repo.defaultBranch);
    else if (repo.refs.has(`refs/heads/${shaParam}`)) tip = repo.refs.get(`refs/heads/${shaParam}`);
    else if (repo.store.has(shaParam)) tip = shaParam;
    else return notFound();
    if (tip === undefined) return json(200, []);
    const perPage = Math.max(1, Math.min(100, Number(req.query.get('per_page') ?? '30') || 30));
    const page = Math.max(1, Number(req.query.get('page') ?? '1') || 1);
    const history = commitHistory(repo.store, tip, 10_000);
    const items = history.map((oid) => commitJson(repo, oid, base));
    const { slice, headers } = paginate(items, { page, perPage }, (p) => `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits?per_page=${perPage}&page=${p}`);
    return json(200, slice, headers);
  }

  if (head === 'git' && rest[1] === 'refs' && method === 'POST' && rest.length === 2) {
    const body = bodyObject(req.body);
    const ref = stringField(body, 'ref');
    const sha = stringField(body, 'sha');
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return validationFailed('ref and sha are required');
    if (!repo.store.has(sha)) return validationFailed('sha does not name an object in this repository');
    if (repo.refs.has(ref)) return validationFailed('Reference already exists');
    repo.refs.set(ref, sha);
    repo.updatedEpoch = forge.clock.nextEpoch();
    return json(201, {
      ref,
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref.slice('refs/'.length)}`,
      object: { type: repo.store.get(sha)?.type ?? 'commit', sha, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}` },
    });
  }

  if (head === 'contents') {
    return routeContents(forge, repo, rest.slice(1).join('/'), req);
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const body = bodyObject(req.body);
      const name = stringField(body, 'name');
      if (name === undefined || name === '') return validationFailed('name is required');
      if (repo.labels.has(name)) return json(422, { message: 'Validation Failed', errors: [{ resource: 'Label', code: 'already_exists', field: 'name', message: 'name already exists on this repository' }] });
      repo.labels.set(name, {
        name,
        color: (stringField(body, 'color') ?? labelColor(name)).replace(/^#/, ''),
        description: stringField(body, 'description') ?? null,
      });
      return json(201, labelJson(repo, name, base));
    }
    if (rest.length === 1 && method === 'GET') {
      return json(200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name, base)));
    }
    return notFound();
  }

  if (head === 'issues') return routeIssues(forge, repo, rest.slice(1), req);
  if (head === 'pulls') return routePulls(forge, repo, rest.slice(1), req);

  return notFound();
}

function commitJson(repo: RepoRec, oid: string, base: string): Record<string, unknown> {
  const object = repo.store.get(oid);
  const info = object?.type === 'commit' ? parseCommit(object.data) : null;
  const ident = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line.trim());
    if (match === null) return { name: '', email: '', date: isoOf(0) };
    return { name: match[1] as string, email: match[2] as string, date: isoOf(Number(match[3])) };
  };
  const authorIdent = info ? ident(info.author) : { name: '', email: '', date: isoOf(0) };
  const committerIdent = info ? ident(info.committer) : authorIdent;
  const userFor = (email: string): Record<string, unknown> | null =>
    email === VIEWER.email ? userJson(VIEWER, base) : null;
  return {
    sha: oid,
    node_id: nodeId('Commit', Math.abs(hashCode(oid))),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${oid}`,
    commit: {
      author: authorIdent,
      committer: committerIdent,
      message: info?.message ?? '',
      tree: { sha: info?.tree ?? ZERO_OID, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info?.tree ?? ZERO_OID}` },
      url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
      comment_count: 0,
    },
    author: userFor(authorIdent.email),
    committer: userFor(committerIdent.email),
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
  };
}

function hashCode(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) | 0;
  return hash;
}

// ---------------------------------------------------------------- contents

function routeContents(forge: Forge, repo: RepoRec, path: string, req: RestRequest): HttpResult {
  const { method, base } = req;
  if (method === 'GET') {
    const refParam = req.query.get('ref');
    let tip: string | undefined;
    if (refParam === null || refParam === '') tip = repo.branchTip(repo.defaultBranch);
    else if (repo.refs.has(`refs/heads/${refParam}`)) tip = repo.refs.get(`refs/heads/${refParam}`);
    else if (repo.refs.has(`refs/tags/${refParam}`)) tip = repo.refs.get(`refs/tags/${refParam}`);
    else if (repo.store.has(refParam)) tip = refParam;
    else return notFound();
    const files = forge.filesAt(repo, tip);
    if (path === '') {
      return json(200, dirListing(repo, files, '', base));
    }
    const file = files.get(path);
    if (file !== undefined) {
      const blob = repo.store.get(file.oid);
      const content = blob?.data ?? Buffer.alloc(0);
      return json(200, {
        type: 'file',
        encoding: 'base64',
        size: content.length,
        name: path.split('/').pop(),
        path,
        content: content.toString('base64'),
        sha: file.oid,
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`,
        html_url: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        download_url: `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
        _links: { self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.oid}`, html: `${base}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}` },
      });
    }
    const prefix = `${path}/`;
    const isDir = [...files.keys()].some((candidate) => candidate.startsWith(prefix));
    if (isDir) return json(200, dirListing(repo, files, path, base));
    return notFound();
  }

  if (method === 'PUT') {
    const body = bodyObject(req.body);
    const message = stringField(body, 'message');
    const contentB64 = stringField(body, 'content');
    if (message === undefined || contentB64 === undefined) return validationFailed('message and content are required');
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === undefined && branch !== repo.defaultBranch) return notFound();
    if (tip === undefined && repo.refs.size > 0 && !repo.refs.has(`refs/heads/${branch}`)) return notFound();
    const files = new Map(forge.filesAt(repo, tip));
    const existing = files.get(path);
    const shaParam = stringField(body, 'sha');
    if (existing !== undefined) {
      if (shaParam === undefined) return json(422, { message: 'Validation Failed', errors: [{ resource: 'Content', code: 'missing_field', field: 'sha', message: 'sha is required when updating a file' }] });
      if (shaParam !== existing.oid) return json(409, { message: `${path} has changed since ${shaParam}; the current sha is ${existing.oid}` });
    } else if (shaParam !== undefined) {
      return json(409, { message: `${path} does not exist at ${shaParam}` });
    }
    const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    const blobSha = repo.store.put('blob', data);
    files.set(path, { mode: '100644', oid: blobSha });
    const commitSha = forge.commitFiles(repo, branch, files, message);
    return json(existing !== undefined ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop(),
        path,
        sha: blobSha,
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
        git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`,
        html_url: `${base}/${repo.owner}/${repo.name}/blob/${branch}/${path}`,
        download_url: `${base}/${repo.owner}/${repo.name}/raw/${branch}/${path}`,
        _links: { self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobSha}`, html: `${base}/${repo.owner}/${repo.name}/blob/${branch}/${path}` },
      },
      commit: commitSummary(repo, commitSha, message, base),
    });
  }

  if (method === 'DELETE') {
    const body = bodyObject(req.body);
    const message = stringField(body, 'message');
    const shaParam = stringField(body, 'sha');
    if (message === undefined || shaParam === undefined) return validationFailed('message and sha are required');
    const branch = stringField(body, 'branch') ?? repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === undefined) return notFound();
    const files = new Map(forge.filesAt(repo, tip));
    const existing = files.get(path);
    if (existing === undefined) return notFound();
    if (existing.oid !== shaParam) return json(409, { message: `${path} has changed since ${shaParam}` });
    files.delete(path);
    const commitSha = forge.commitFiles(repo, branch, files, message);
    return json(200, { content: null, commit: commitSummary(repo, commitSha, message, base) });
  }

  return notFound();
}

function commitSummary(repo: RepoRec, sha: string, message: string, base: string): Record<string, unknown> {
  const object = repo.store.get(sha);
  const info = object?.type === 'commit' ? parseCommit(object.data) : null;
  return {
    sha,
    node_id: nodeId('Commit', Math.abs(hashCode(sha))),
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
    html_url: `${base}/${repo.owner}/${repo.name}/commit/${sha}`,
    author: { name: VIEWER.name, email: VIEWER.email, date: isoOf(repo.updatedEpoch) },
    committer: { name: VIEWER.name, email: VIEWER.email, date: isoOf(repo.updatedEpoch) },
    tree: { sha: info?.tree ?? ZERO_OID, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${info?.tree ?? ZERO_OID}` },
    message: info?.message ?? message,
    parents: (info?.parents ?? []).map((parent) => ({ sha: parent, url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${parent}` })),
  };
}

function dirListing(repo: RepoRec, files: ReadonlyMap<string, { mode: string; oid: string }>, dir: string, base: string): Record<string, unknown>[] {
  const prefix = dir === '' ? '' : `${dir}/`;
  const entries = new Map<string, { type: 'file' | 'dir'; oid: string; size: number }>();
  for (const [path, file] of files) {
    if (!path.startsWith(prefix)) continue;
    const tail = path.slice(prefix.length);
    const slash = tail.indexOf('/');
    if (slash < 0) {
      entries.set(tail, { type: 'file', oid: file.oid, size: repo.store.get(file.oid)?.data.length ?? 0 });
    } else {
      const dirName = tail.slice(0, slash);
      if (!entries.has(dirName)) {
        const treeOid = treeOidAt(repo, dir === '' ? dirName : `${dir}/${dirName}`, files);
        entries.set(dirName, { type: 'dir', oid: treeOid, size: 0 });
      }
    }
  }
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entry]) => {
      const entryPath = prefix + name;
      return {
        type: entry.type,
        size: entry.size,
        name,
        path: entryPath,
        sha: entry.oid,
        url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`,
        git_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.oid}`,
        html_url: `${base}/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
        download_url: entry.type === 'file' ? `${base}/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${entryPath}` : null,
        _links: { self: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${entryPath}`, git: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.type === 'dir' ? 'trees' : 'blobs'}/${entry.oid}`, html: `${base}/${repo.owner}/${repo.name}/${entry.type === 'dir' ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}` },
      };
    });
}

/** The tree id for a directory path, rebuilt from the flat file map (deterministic). */
function treeOidAt(repo: RepoRec, dirPath: string, files: ReadonlyMap<string, { mode: string; oid: string }>): string {
  const prefix = `${dirPath}/`;
  const sub = new Map<string, { mode: string; oid: string }>();
  for (const [path, file] of files) {
    if (path.startsWith(prefix)) sub.set(path.slice(prefix.length), file);
  }
  if (sub.size === 0) return ZERO_OID;
  return buildTreeFromFiles(repo.store, sub);
}

// ---------------------------------------------------------------- issues

function routeIssues(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): HttpResult {
  const { method, base } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const title = stringField(body, 'title');
      if (title === undefined || title === '') return validationFailed('title is required');
      const labels = Array.isArray(body['labels']) ? (body['labels'] as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) {
          return json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', code: 'custom', field: 'labels', message: `label ${JSON.stringify(label)} does not exist on this repository` }] });
        }
      }
      const now = forge.clock.nextEpoch();
      const rec: IssueRec = {
        kind: 'issue',
        id: forge.allocObjectId(),
        number: repo.nextNumber++,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        labels,
        author: VIEWER,
        createdEpoch: now,
        updatedEpoch: now,
        comments: [],
      };
      repo.numbered.set(rec.number, rec);
      return json(201, issueJson(forge, repo, rec, base));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let items = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
      if (state === 'open') items = items.filter((rec) => rec.state === 'open');
      else if (state === 'closed') items = items.filter((rec) => rec.state === 'closed');
      items.sort((a, b) => (sort === 'created' ? a.createdEpoch - b.createdEpoch || a.number - b.number : a.number - b.number));
      if (direction === 'desc') items.reverse();
      const page = pageOf(req.query);
      const { slice, headers } = paginate(items.map((rec) => issueJson(forge, repo, rec, base)), page, (p) => `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues?per_page=${page.perPage}&page=${p}`);
      return json(200, slice, headers);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const rec = repo.numbered.get(number);

  if (rest.length === 1) {
    if (rec === undefined) return notFound();
    if (method === 'GET') {
      return json(200, rec.kind === 'issue' ? issueJson(forge, repo, rec, base) : pullIssueView(forge, repo, rec, base));
    }
    if (method === 'PATCH') {
      const body = bodyObject(req.body);
      const title = stringField(body, 'title');
      if (title !== undefined) rec.title = title;
      const bodyText = stringField(body, 'body');
      if (bodyText !== undefined) rec.body = bodyText;
      const state = stringField(body, 'state');
      if (state === 'closed' || state === 'open') {
        rec.state = state;
        if (rec.kind === 'pull' && state === 'open') rec.merged = false;
      }
      if (rec.kind === 'issue' && Array.isArray(body['labels'])) {
        const labels = (body['labels'] as unknown[]).filter((x): x is string => typeof x === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return validationFailed(`label ${JSON.stringify(label)} does not exist`);
        rec.labels = labels;
      }
      rec.updatedEpoch = forge.clock.nextEpoch();
      return json(200, rec.kind === 'issue' ? issueJson(forge, repo, rec, base) : pullJson(forge, repo, rec, base));
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (rec === undefined) return notFound();
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const text = stringField(body, 'body');
      if (text === undefined) return validationFailed('body is required');
      const now = forge.clock.nextEpoch();
      const comment = { id: forge.allocObjectId(), body: text, author: VIEWER, createdEpoch: now, updatedEpoch: now };
      rec.comments.push(comment);
      rec.updatedEpoch = now;
      return json(201, commentJson(repo, rec.number, comment, base));
    }
    if (method === 'GET') {
      const page = pageOf(req.query);
      const all = rec.comments.map((comment) => commentJson(repo, rec.number, comment, base));
      const { slice, headers } = paginate(all, page, (p) => `${base}/api/v3/repos/${repo.owner}/${repo.name}/issues/${rec.number}/comments?per_page=${page.perPage}&page=${p}`);
      return json(200, slice, headers);
    }
    return notFound();
  }

  return notFound();
}

/** An issue-shaped view of a pull request (GitHub serves PRs under /issues too). */
function pullIssueView(forge: Forge, repo: RepoRec, rec: PullRec, base: string): Record<string, unknown> {
  const view = issueJson(forge, repo, {
    kind: 'issue',
    id: rec.id,
    number: rec.number,
    title: rec.title,
    body: rec.body,
    state: rec.state,
    labels: [],
    author: rec.author,
    createdEpoch: rec.createdEpoch,
    updatedEpoch: rec.updatedEpoch,
    comments: rec.comments,
  }, base);
  view['pull_request'] = {
    url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${rec.number}`,
    html_url: `${base}/${repo.owner}/${repo.name}/pull/${rec.number}`,
    diff_url: `${base}/${repo.owner}/${repo.name}/pull/${rec.number}.diff`,
    patch_url: `${base}/${repo.owner}/${repo.name}/pull/${rec.number}.patch`,
    merged_at: rec.merged ? isoOf(rec.mergedEpoch as number) : null,
  };
  return view;
}

// ---------------------------------------------------------------- pull requests

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Line counts of a text diff (LCS over lines; contents here are small). */
function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? (dp[i + 1][j + 1] as number) + 1 : Math.max(dp[i + 1][j] as number, dp[i][j + 1] as number);
    }
  }
  const common = dp[0][0] as number;
  return { additions: n - common, deletions: m - common };
}

/** The merge-base of two commits (the newest common ancestor), or null. */
export function mergeBase(forge: Forge, repo: RepoRec, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = repo.store.get(oid);
    if (object?.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = repo.store.get(oid);
    if (object?.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Files changed between two tips, compared at their merge-base (GitHub's three-dot diff). */
export function changedFiles(forge: Forge, repo: RepoRec, baseTip: string, headTip: string): ChangedFile[] {
  const base = mergeBase(forge, repo, baseTip, headTip) ?? baseTip;
  const baseFiles = forge.filesAt(repo, base);
  const headFiles = forge.filesAt(repo, headTip);
  const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
  const out: ChangedFile[] = [];
  for (const path of [...paths].sort()) {
    const oldFile = baseFiles.get(path);
    const newFile = headFiles.get(path);
    if (oldFile !== undefined && newFile !== undefined && oldFile.oid === newFile.oid) continue;
    const oldText = oldFile ? (repo.store.get(oldFile.oid)?.data.toString('utf8') ?? '') : '';
    const newText = newFile ? (repo.store.get(newFile.oid)?.data.toString('utf8') ?? '') : '';
    const counts = lineDiffCounts(oldText, newText);
    out.push({
      path,
      status: oldFile === undefined ? 'added' : newFile === undefined ? 'removed' : 'modified',
      oldOid: oldFile?.oid ?? null,
      newOid: newFile?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return out;
}

/**
 * Three-way merge of two tips over their merge-base, file by file. Returns the merged file map,
 * or null when both sides changed the same file differently (a conflict).
 */
export function mergeTrees(
  forge: Forge,
  repo: RepoRec,
  baseTip: string,
  headTip: string,
): Map<string, { mode: string; oid: string }> | null {
  const ancestor = mergeBase(forge, repo, baseTip, headTip);
  const ancestorFiles = ancestor === null ? new Map<string, { mode: string; oid: string }>() : forge.filesAt(repo, ancestor);
  const baseFiles = forge.filesAt(repo, baseTip);
  const headFiles = forge.filesAt(repo, headTip);
  const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  const out = new Map<string, { mode: string; oid: string }>();
  for (const path of paths) {
    const a = ancestorFiles.get(path);
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const same = (x?: { oid: string }, y?: { oid: string }): boolean => x?.oid === y?.oid;
    if (same(b, h)) {
      if (b !== undefined) out.set(path, b);
    } else if (same(a, b)) {
      if (h !== undefined) out.set(path, h);
    } else if (same(a, h)) {
      if (b !== undefined) out.set(path, b);
    } else {
      return null;
    }
  }
  return out;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha, or 'conflict'. */
export function mergePullRequest(forge: Forge, repo: RepoRec, rec: PullRec): string | 'conflict' | 'gone' {
  const headTip = repo.branchTip(rec.headRef);
  const baseTip = repo.branchTip(rec.baseRef);
  if (headTip === undefined || baseTip === undefined) return 'gone';
  const merged = mergeTrees(forge, repo, baseTip, headTip);
  if (merged === null) return 'conflict';
  const message = `${rec.title} (#${rec.number})\n`;
  const treeOid = buildTreeFromFiles(repo.store, merged);
  const epoch = forge.clock.nextEpoch();
  const ident = identLine(VIEWER, epoch);
  const commitData = buildCommit({ tree: treeOid, parents: [baseTip], author: ident, committer: ident, message });
  const sha = repo.store.put('commit', commitData);
  repo.refs.set(`refs/heads/${rec.baseRef}`, sha);
  rec.state = 'closed';
  rec.merged = true;
  rec.mergedEpoch = epoch;
  rec.mergeCommitSha = sha;
  rec.updatedEpoch = epoch;
  rec.baseSha = baseTip;
  rec.headSha = headTip;
  repo.updatedEpoch = epoch;
  return sha;
}

function routePulls(forge: Forge, repo: RepoRec, rest: string[], req: RestRequest): HttpResult {
  const { method, base } = req;

  if (rest.length === 0) {
    if (method === 'POST') {
      const body = bodyObject(req.body);
      const title = stringField(body, 'title');
      const head = stringField(body, 'head');
      const baseRef = stringField(body, 'base');
      if (title === undefined || head === undefined || baseRef === undefined) return validationFailed('title, head and base are required');
      const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
      const headSha = repo.branchTip(headBranch);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) return validationFailed('head or base branch does not exist');
      const now = forge.clock.nextEpoch();
      const rec: PullRec = {
        kind: 'pull',
        id: forge.allocObjectId(),
        number: repo.nextNumber++,
        title,
        body: stringField(body, 'body') ?? '',
        state: 'open',
        merged: false,
        mergedEpoch: null,
        mergeCommitSha: null,
        headRef: headBranch,
        headSha,
        baseRef,
        baseSha,
        author: VIEWER,
        createdEpoch: now,
        updatedEpoch: now,
        comments: [],
      };
      repo.numbered.set(rec.number, rec);
      return json(201, pullJson(forge, repo, rec, base));
    }
    if (method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let items = [...repo.numbered.values()].filter((rec): rec is PullRec => rec.kind === 'pull');
      if (state === 'open') items = items.filter((rec) => rec.state === 'open');
      else if (state === 'closed') items = items.filter((rec) => rec.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      const page = pageOf(req.query);
      const { slice, headers } = paginate(items.map((rec) => pullJson(forge, repo, refreshPull(forge, repo, rec), base)), page, (p) => `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls?per_page=${page.perPage}&page=${p}`);
      return json(200, slice, headers);
    }
    return notFound();
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return notFound();
  const found = repo.numbered.get(number);
  const rec = found?.kind === 'pull' ? found : undefined;

  if (rest.length === 1) {
    if (rec === undefined) return notFound();
    if (method === 'GET') return json(200, pullJson(forge, repo, refreshPull(forge, repo, rec), base));
    if (method === 'PATCH') {
      const body = bodyObject(req.body);
      const title = stringField(body, 'title');
      if (title !== undefined) rec.title = title;
      const text = stringField(body, 'body');
      if (text !== undefined) rec.body = text;
      const state = stringField(body, 'state');
      if (state === 'closed' || state === 'open') rec.state = state;
      rec.updatedEpoch = forge.clock.nextEpoch();
      return json(200, pullJson(forge, repo, rec, base));
    }
    return notFound();
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (rec === undefined) return notFound();
    const files = changedFiles(forge, repo, rec.baseSha, currentHeadSha(repo, rec));
    const page = pageOf(req.query);
    const items = files.map((file) => ({
      sha: file.newOid ?? file.oldOid ?? ZERO_OID,
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      blob_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${file.newOid ?? file.oldOid ?? ZERO_OID}`,
      raw_url: `${base}/${repo.owner}/${repo.name}/raw/${rec.headRef}/${file.path}`,
      contents_url: `${base}/api/v3/repos/${repo.owner}/${repo.name}/contents/${file.path}?ref=${rec.headRef}`,
      patch: patchFor(repo, file),
    }));
    const { slice, headers } = paginate(items, page, (p) => `${base}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${rec.number}/files?per_page=${page.perPage}&page=${p}`);
    return json(200, slice, headers);
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (rec === undefined) return notFound();
    if (rec.merged) return json(405, { message: 'Pull Request is not mergeable' });
    const result = mergePullRequest(forge, repo, rec);
    if (result === 'conflict') return json(405, { message: 'Pull Request is not mergeable' });
    if (result === 'gone') return json(405, { message: 'Pull Request is not mergeable' });
    return json(200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound();
}

function currentHeadSha(repo: RepoRec, rec: PullRec): string {
  return repo.branchTip(rec.headRef) ?? rec.headSha;
}

/** A pull view refreshed against the current branch tips (head/base shas move with pushes). */
export function refreshPull(forge: Forge, repo: RepoRec, rec: PullRec): PullRec {
  void forge;
  const head = repo.branchTip(rec.headRef);
  if (head !== undefined) rec.headSha = head;
  if (!rec.merged) {
    const base = repo.branchTip(rec.baseRef);
    if (base !== undefined) rec.baseSha = base;
  }
  return rec;
}

function patchFor(repo: RepoRec, file: ChangedFile): string {
  const oldText = file.oldOid ? (repo.store.get(file.oldOid)?.data.toString('utf8') ?? '') : '';
  const newText = file.newOid ? (repo.store.get(file.newOid)?.data.toString('utf8') ?? '') : '';
  const lines: string[] = [`--- a/${file.path}`, `+++ b/${file.path}`];
  for (const line of oldText.split('\n')) if (line !== '') lines.push(`-${line}`);
  for (const line of newText.split('\n')) if (line !== '') lines.push(`+${line}`);
  return lines.join('\n');
}

export { isAncestor, peelToCommit };
