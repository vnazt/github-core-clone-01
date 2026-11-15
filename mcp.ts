// mcp.ts — the Model Context Protocol surface: JSON-RPC 2.0 over Streamable HTTP at POST /mcp.
//
// Both protocol eras are served: the 2026-07-28 revision answers `server/discover` (no handshake),
// and the handshake era answers `initialize` + `notifications/initialized`. The tools act on the
// same Forge store as REST and GraphQL, so an object created here is the same object everywhere.

import { VIEWER } from './scenario.ts';
import type { Forge, IssueRec, PullRec, RepoRec } from './store.ts';
import { issueJson, mergePullRequest, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

function tool(name: string, description: string, properties: Record<string, string>, required: string[]): ToolDef {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(Object.entries(properties).map(([key, text]) => [key, { type: key === 'private' ? 'boolean' : 'string', description: text }])),
      required,
    },
  };
}

/** The tool list is a frozen constant: two tools/list calls answer byte-for-byte identical. */
export const TOOLS: readonly ToolDef[] = Object.freeze([
  tool('create_repo', 'Create a new repository for the authenticated user.', {
    name: 'Repository name',
    owner: 'Repository owner login (defaults to the authenticated user)',
    description: 'Repository description',
    private: 'Whether the repository is private',
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', {
    owner: 'Repository owner login',
    repo: 'Repository name',
  }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    title: 'Issue title',
    body: 'Issue body',
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List issues in a repository.', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    state: 'Filter by state: open, closed, or all',
  }, ['owner', 'repo']),
  tool('create_pull_request', 'Create a pull request in a repository.', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    title: 'Pull request title',
    body: 'Pull request body',
    head: 'Head branch name',
    base: 'Base branch name',
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('merge_pull_request', 'Merge a pull request.', {
    owner: 'Repository owner login',
    repo: 'Repository name',
    pull_number: 'Pull request number',
  }, ['owner', 'repo', 'pull_number']),
]);

export interface McpReply {
  status: number;
  /** Empty string means an empty body (notifications). */
  bodyText: string;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, bodyText: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpReply {
  return { status, bodyText: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function numberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** Returns a JSON-RPC error reply for missing arguments, or null when all are present. */
function requireArgs(id: unknown, args: Record<string, unknown>, keys: string[]): McpReply | null {
  const missing = keys.filter((key) => args[key] === undefined || args[key] === '');
  if (missing.length === 0) return null;
  return rpcError(id, -32602, `missing required arguments: ${missing.join(', ')}`);
}

function callTool(forge: Forge, base: string, id: unknown, params: Record<string, unknown>): McpReply {
  const name = typeof params['name'] === 'string' ? params['name'] : '';
  const args = (typeof params['arguments'] === 'object' && params['arguments'] !== null ? params['arguments'] : {}) as Record<string, unknown>;
  switch (name) {
    case 'create_repo': {
      const missing = requireArgs(id, args, ['name']);
      if (missing !== null) return missing;
      const repoName = stringArg(args, 'name') as string;
      const created = forge.createRepo(VIEWER.login, repoName, {
        description: typeof args['description'] === 'string' ? args['description'] : '',
        private: args['private'] === true,
      });
      if (created === 'exists') return rpcResult(id, toolError(`repository ${VIEWER.login}/${repoName} already exists`));
      return rpcResult(id, toolOk(repoJson(created, base)));
    }
    case 'get_repo': {
      const missing = requireArgs(id, args, ['owner', 'repo']);
      if (missing !== null) return missing;
      const repo = forge.getRepo(stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === undefined) return rpcResult(id, toolError('repository not found'));
      return rpcResult(id, toolOk(repoJson(repo, base)));
    }
    case 'create_issue': {
      const missing = requireArgs(id, args, ['owner', 'repo', 'title']);
      if (missing !== null) return missing;
      const repo = forge.getRepo(stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === undefined) return rpcResult(id, toolError('repository not found'));
      const now = forge.clock.nextEpoch();
      const rec: IssueRec = {
        kind: 'issue',
        id: forge.allocObjectId(),
        number: repo.nextNumber++,
        title: stringArg(args, 'title') as string,
        body: typeof args['body'] === 'string' ? args['body'] : '',
        state: 'open',
        labels: [],
        author: VIEWER,
        createdEpoch: now,
        updatedEpoch: now,
        comments: [],
      };
      repo.numbered.set(rec.number, rec);
      return rpcResult(id, toolOk(issueJson(forge, repo, rec, base)));
    }
    case 'list_issues': {
      const missing = requireArgs(id, args, ['owner', 'repo']);
      if (missing !== null) return missing;
      const repo = forge.getRepo(stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === undefined) return rpcResult(id, toolError('repository not found'));
      const state = typeof args['state'] === 'string' ? args['state'] : 'open';
      const items = [...repo.numbered.values()]
        .filter((rec): rec is IssueRec => rec.kind === 'issue')
        .filter((rec) => state === 'all' || rec.state === state)
        .sort((a, b) => b.number - a.number)
        .map((rec) => issueJson(forge, repo, rec, base));
      return rpcResult(id, toolOk(items));
    }
    case 'create_pull_request': {
      const missing = requireArgs(id, args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return missing;
      const repo = forge.getRepo(stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === undefined) return rpcResult(id, toolError('repository not found'));
      const head = stringArg(args, 'head') as string;
      const baseRef = stringArg(args, 'base') as string;
      const headSha = repo.branchTip(head);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined) return rpcResult(id, toolError(`head branch ${head} does not exist`));
      if (baseSha === undefined) return rpcResult(id, toolError(`base branch ${baseRef} does not exist`));
      const now = forge.clock.nextEpoch();
      const rec: PullRec = {
        kind: 'pull',
        id: forge.allocObjectId(),
        number: repo.nextNumber++,
        title: stringArg(args, 'title') as string,
        body: typeof args['body'] === 'string' ? args['body'] : '',
        state: 'open',
        merged: false,
        mergedEpoch: null,
        mergeCommitSha: null,
        headRef: head,
        headSha,
        baseRef,
        baseSha,
        author: VIEWER,
        createdEpoch: now,
        updatedEpoch: now,
        comments: [],
      };
      repo.numbered.set(rec.number, rec);
      return rpcResult(id, toolOk(pullJson(forge, repo, rec, base)));
    }
    case 'merge_pull_request': {
      const missing = requireArgs(id, args, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return missing;
      const repo = forge.getRepo(stringArg(args, 'owner') as string, stringArg(args, 'repo') as string);
      if (repo === undefined) return rpcResult(id, toolError('repository not found'));
      const number = numberArg(args, 'pull_number');
      const rec = number === undefined ? undefined : repo.numbered.get(number);
      if (rec === undefined || rec.kind !== 'pull') return rpcResult(id, toolError('pull request not found'));
      if (rec.merged) return rpcResult(id, toolError('pull request is already merged'));
      const result = mergePullRequest(forge, repo, rec);
      if (result === 'conflict' || result === 'gone') return rpcResult(id, toolError('pull request is not mergeable'));
      return rpcResult(id, toolOk(pullJson(forge, repo, rec, base)));
    }
    default:
      return rpcError(id, -32602, `unknown tool: ${name}`);
  }
}

function dispatch(forge: Forge, base: string, request: Record<string, unknown>): McpReply {
  const id = request['id'];
  const method = typeof request['method'] === 'string' ? request['method'] : '';
  const params = (typeof request['params'] === 'object' && request['params'] !== null ? request['params'] : {}) as Record<string, unknown>;
  // Notifications carry no id and are never answered with a body.
  if (id === undefined) return { status: 202, bodyText: '' };
  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: {
          'io.modelcontextprotocol/serverInfo': SERVER_INFO,
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        },
      });
    case 'initialize': {
      const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call':
      return callTool(forge, base, id, params);
    default:
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/** Handle one POST /mcp body (raw text: a malformed body must answer -32700 itself). */
export function handleMcp(forge: Forge, base: string, rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (Array.isArray(parsed)) {
    const replies = parsed
      .map((entry) => dispatch(forge, base, (entry ?? {}) as Record<string, unknown>))
      .filter((reply) => reply.bodyText !== '');
    return { status: 200, bodyText: `[${replies.map((reply) => reply.bodyText).join(',')}]` };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  return dispatch(forge, base, parsed as Record<string, unknown>);
}
