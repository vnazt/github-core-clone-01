// The GraphQL v4 surface: a small but real GraphQL engine (lexer, parser, validator,
// executor) over the same Forge store the REST and git surfaces use. It implements the
// documents gh and github-mcp-server send: viewer and repository reads, issue and pull
// request connections with cursor paging, the createIssue / closeIssue / addComment /
// createPullRequest / mergePullRequest mutations, node(id:) round-trips, batched
// operations, and the __type introspection gh feature-detects with.

import { VIEWER, type ScenarioUser } from './scenario.ts';
import { Forge, isoOf, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { nodeId, changedFiles, mergePullRequest, mergeTrees } from './rest.ts';
import { commitHistory, parseCommit } from './git.ts';

// ---------------------------------------------------------------- lexer and parser

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'punct'; value: string }
  | { kind: 'spread' }
  | { kind: 'eof' };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread' });
      i += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1] as string;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'u' ? String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16)) : esc;
          j += esc === 'u' ? 6 : 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j] as string)) j += 1;
      const text = source.slice(i, j);
      tokens.push(text.includes('.') || /[eE]/.test(text) ? { kind: 'float', value: Number(text) } : { kind: 'int', value: parseInt(text, 10) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: Value }>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string | null; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

class Parser {
  #tokens: Token[];
  #pos = 0;

  constructor(source: string) {
    this.#tokens = lex(source);
  }

  #peek(): Token {
    return this.#tokens[this.#pos] as Token;
  }

  #next(): Token {
    return this.#tokens[this.#pos++] as Token;
  }

  #expectPunct(value: string): void {
    const token = this.#next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}`);
  }

  #skipPunct(value: string): boolean {
    const token = this.#peek();
    if (token.kind === 'punct' && token.value === value) {
      this.#pos += 1;
      return true;
    }
    return false;
  }

  #expectName(): string {
    const token = this.#next();
    if (token.kind !== 'name') throw new Error('expected a name');
    return token.value;
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selection: SelectionNode[] }>();
    while (this.#peek().kind !== 'eof') {
      const token = this.#peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.#parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.#next();
        let name: string | null = null;
        if (this.#peek().kind === 'name') name = this.#expectName();
        if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '(') this.#skipVariableDefinitions();
        this.#skipDirectives();
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', name, selection: this.#parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.#next();
        const fragName = this.#expectName();
        const onToken = this.#next();
        if (onToken.kind !== 'name' || onToken.value !== 'on') throw new Error('expected on in fragment');
        const typeCondition = this.#expectName();
        this.#skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.#parseSelectionSet() });
        continue;
      }
      throw new Error('unexpected token in document');
    }
    return { operations, fragments };
  }

  #skipVariableDefinitions(): void {
    this.#expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.#next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  #skipDirectives(): void {
    while (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '@') {
      this.#next();
      this.#expectName();
      if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '(') {
        this.#expectPunct('(');
        let depth = 1;
        while (depth > 0) {
          const token = this.#next();
          if (token.kind === 'eof') throw new Error('unterminated directive');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  #parseSelectionSet(): SelectionNode[] {
    this.#expectPunct('{');
    const out: SelectionNode[] = [];
    while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '}')) {
      out.push(this.#parseSelection());
    }
    this.#expectPunct('}');
    return out;
  }

  #parseSelection(): SelectionNode {
    const token = this.#peek();
    if (token.kind === 'spread') {
      this.#next();
      const next = this.#peek();
      if (next.kind === 'name' && next.value === 'on') {
        this.#next();
        const typeCondition = this.#expectName();
        this.#skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.#parseSelectionSet() };
      }
      const name = this.#expectName();
      this.#skipDirectives();
      return { kind: 'spread', name };
    }
    let name = this.#expectName();
    let alias: string | null = null;
    if (this.#skipPunct(':')) {
      alias = name;
      name = this.#expectName();
    }
    const args: Array<{ name: string; value: Value }> = [];
    if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '(') {
      this.#expectPunct('(');
      while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === ')')) {
        const argName = this.#expectName();
        this.#expectPunct(':');
        args.push({ name: argName, value: this.#parseValue() });
      }
      this.#expectPunct(')');
    }
    this.#skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '{') {
      selection = this.#parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }

  #parseValue(): Value {
    const token = this.#next();
    switch (token.kind) {
      case 'string':
        return { kind: 'string', value: token.value };
      case 'int':
        return { kind: 'int', value: token.value };
      case 'float':
        return { kind: 'float', value: token.value };
      case 'name':
        if (token.value === 'true') return { kind: 'boolean', value: true };
        if (token.value === 'false') return { kind: 'boolean', value: false };
        if (token.value === 'null') return { kind: 'null' };
        return { kind: 'enum', value: token.value };
      case 'punct':
        if (token.value === '$') return { kind: 'variable', name: this.#expectName() };
        if (token.value === '[') {
          const items: Value[] = [];
          while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === ']')) items.push(this.#parseValue());
          this.#expectPunct(']');
          return { kind: 'list', items };
        }
        if (token.value === '{') {
          const fields: Array<{ name: string; value: Value }> = [];
          while (!(this.#peek().kind === 'punct' && (this.#peek() as { value: string }).value === '}')) {
            const fieldName = this.#expectName();
            this.#expectPunct(':');
            fields.push({ name: fieldName, value: this.#parseValue() });
          }
          this.#expectPunct('}');
          return { kind: 'object', fields };
        }
        throw new Error(`unexpected ${token.value} in value`);
      default:
        throw new Error('unexpected token in value');
    }
  }
}

// ---------------------------------------------------------------- values and ids

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const at = text.indexOf(':');
    if (at < 0) return null;
    return { type: text.slice(0, at), key: text.slice(at + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the schema model

/** Field lists per object type, for introspection and validation. */
const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'search', 'rateLimit', 'organization', 'user'],
  Mutation: ['createIssue', 'closeIssue', 'reopenIssue', 'addComment', 'createPullRequest', 'mergePullRequest', 'updateIssue', 'updatePullRequest'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'isViewer', 'createdAt', 'updatedAt', 'company', 'location', 'bio'],
  Organization: ['id', 'databaseId', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'isFork', 'isArchived', 'isDisabled',
    'viewerPermission', 'hasIssuesEnabled', 'hasPullRequestsEnabled', 'defaultBranchRef', 'issue', 'issues', 'pullRequest',
    'pullRequests', 'labels', 'url', 'createdAt', 'updatedAt', 'pushedAt', 'visibility', 'stargazerCount', 'forkCount',
    'primaryLanguage', 'licenseInfo', 'parent', 'isTemplate', 'homepageUrl',
  ],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  Commit: ['id', 'oid', 'abbreviatedOid', 'message', 'messageHeadline', 'author', 'committer', 'committedDate', 'authoredDate', 'parents', 'tree', 'url', 'history'],
  GitActor: ['name', 'email', 'date', 'avatarUrl', 'user'],
  Tree: ['id', 'oid', 'entries', 'url'],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'bodyHTML', 'state', 'author', 'editor', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'closed', 'locked', 'url', 'repository', 'milestone', 'assignees', 'participants',
    'viewerCanUpdate', 'viewerCanReact', 'reactionGroups', 'timelineItems',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'bodyText', 'state', 'author', 'labels', 'comments', 'files', 'commits',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'headRef', 'baseRef', 'headRepository', 'baseRepository',
    'mergeable', 'merged', 'mergedAt', 'mergedBy', 'mergeCommit', 'isDraft', 'createdAt', 'updatedAt', 'closedAt', 'closed',
    'locked', 'url', 'repository', 'milestone', 'assignees', 'viewerCanUpdate', 'additions', 'deletions', 'changedFiles',
  ],
  Label: ['id', 'name', 'color', 'description', 'url', 'isDefault'],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'editor', 'createdAt', 'updatedAt', 'url', 'issue', 'pullRequest'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommitConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  UserConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  LabelEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  CommitEdge: ['node', 'cursor'],
  UserEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used', 'nodeCount'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  ReopenIssuePayload: ['clientMutationId', 'issue'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  __Type: ['name', 'kind', 'description', 'fields', 'inputFields', 'interfaces', 'enumValues', 'possibleTypes', 'ofType', 'specifiedByURL'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
  __Directive: ['name', 'description', 'locations', 'args'],
};

const ENUM_TYPES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

/** The field's result type name for nested resolution. */
function fieldType(typeName: string, fieldName: string): string {
  if (fieldName === '__typename') return 'String';
  if (fieldName === '__type' || fieldName === '__schema') return fieldName === '__type' ? '__Type' : '__Schema';
  const key = `${typeName}.${fieldName}`;
  const map: Record<string, string> = {
    'Query.viewer': 'User',
    'Query.repository': 'Repository',
    'Query.node': 'Node',
    'Query.user': 'User',
    'Query.organization': 'Organization',
    'Query.rateLimit': 'RateLimit',
    'Mutation.createIssue': 'CreateIssuePayload',
    'Mutation.closeIssue': 'CloseIssuePayload',
    'Mutation.reopenIssue': 'ReopenIssuePayload',
    'Mutation.addComment': 'AddCommentPayload',
    'Mutation.createPullRequest': 'CreatePullRequestPayload',
    'Mutation.mergePullRequest': 'MergePullRequestPayload',
    'Mutation.updateIssue': 'UpdateIssuePayload',
    'Mutation.updatePullRequest': 'UpdatePullRequestPayload',
    'Repository.owner': 'User',
    'Repository.defaultBranchRef': 'Ref',
    'Repository.issue': 'Issue',
    'Repository.issues': 'IssueConnection',
    'Repository.pullRequest': 'PullRequest',
    'Repository.pullRequests': 'PullRequestConnection',
    'Repository.labels': 'LabelConnection',
    'Repository.parent': 'Repository',
    'Ref.target': 'Commit',
    'Ref.repository': 'Repository',
    'Commit.author': 'GitActor',
    'Commit.committer': 'GitActor',
    'Commit.tree': 'Tree',
    'Commit.parents': 'CommitConnection',
    'Commit.history': 'CommitConnection',
    'Issue.author': 'User',
    'Issue.editor': 'User',
    'Issue.labels': 'LabelConnection',
    'Issue.comments': 'IssueCommentConnection',
    'Issue.repository': 'Repository',
    'Issue.assignees': 'UserConnection',
    'PullRequest.author': 'User',
    'PullRequest.labels': 'LabelConnection',
    'PullRequest.comments': 'IssueCommentConnection',
    'PullRequest.files': 'PullRequestChangedFileConnection',
    'PullRequest.commits': 'CommitConnection',
    'PullRequest.repository': 'Repository',
    'PullRequest.headRepository': 'Repository',
    'PullRequest.baseRepository': 'Repository',
    'PullRequest.mergedBy': 'User',
    'PullRequest.mergeCommit': 'Commit',
    'PullRequest.headRef': 'Ref',
    'PullRequest.baseRef': 'Ref',
    'IssueComment.author': 'User',
    'IssueComment.editor': 'User',
    'IssueComment.issue': 'Issue',
    'IssueComment.pullRequest': 'PullRequest',
    'CreateIssuePayload.issue': 'Issue',
    'CloseIssuePayload.issue': 'Issue',
    'ReopenIssuePayload.issue': 'Issue',
    'AddCommentPayload.commentEdge': 'IssueCommentEdge',
    'AddCommentPayload.subject': 'Node',
    'CreatePullRequestPayload.pullRequest': 'PullRequest',
    'MergePullRequestPayload.pullRequest': 'PullRequest',
    'IssueConnection.nodes': 'Issue',
    'PullRequestConnection.nodes': 'PullRequest',
    'LabelConnection.nodes': 'Label',
    'IssueCommentConnection.nodes': 'IssueComment',
    'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
    'CommitConnection.nodes': 'Commit',
    'UserConnection.nodes': 'User',
    'IssueEdge.node': 'Issue',
    'PullRequestEdge.node': 'PullRequest',
    'LabelEdge.node': 'Label',
    'IssueCommentEdge.node': 'IssueComment',
    'PullRequestChangedFileEdge.node': 'PullRequestChangedFile',
    'CommitEdge.node': 'Commit',
    'UserEdge.node': 'User',
    '__Type.fields': '__Field',
    '__Type.enumValues': '__EnumValue',
    '__Type.inputFields': '__InputValue',
    '__Type.ofType': '__Type',
    '__Type.possibleTypes': '__Type',
    '__Type.interfaces': '__Type',
    '__Field.args': '__InputValue',
    '__Field.type': '__Type',
    '__InputValue.type': '__Type',
    '__Schema.types': '__Type',
    '__Schema.queryType': '__Type',
    '__Schema.mutationType': '__Type',
    '__Schema.subscriptionType': '__Type',
    '__Schema.directives': '__Directive',
    '__Directive.args': '__InputValue',
  };
  return map[key] ?? 'String';
}

// ---------------------------------------------------------------- runtime values

interface Ctx {
  forge: Forge;
  base: string;
}

type Source =
  | { __type: 'User'; user: ScenarioUser }
  | { __type: 'Repository'; repo: RepoRec }
  | { __type: 'Issue'; repo: RepoRec; rec: IssueRec }
  | { __type: 'PullRequest'; repo: RepoRec; rec: PullRec }
  | { __type: 'Label'; repo: RepoRec; name: string }
  | { __type: 'IssueComment'; repo: RepoRec; number: number; comment: IssueRec['comments'][number] }
  | { __type: 'Ref'; repo: RepoRec; name: string }
  | { __type: 'Commit'; repo: RepoRec; oid: string }
  | { __type: 'GitActor'; name: string; email: string; epoch: number }
  | { __type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'Connection'; connType: string; items: Source[] }
  | { __type: 'Edge'; edgeType: string; node: Source; cursor: string }
  | { __type: 'PageInfo'; info: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null } }
  | { __type: 'RateLimit' }
  | { __type: string; [key: string]: unknown };

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function connection(connType: string, items: Source[], args: Record<string, unknown>): Source {
  const first = typeof args['first'] === 'number' ? (args['first'] as number) : null;
  const after = typeof args['after'] === 'string' ? (args['after'] as string) : null;
  let start = 0;
  if (after !== null) {
    try {
      const decoded = Buffer.from(after, 'base64').toString('utf8');
      const match = /^cursor:(\d+)$/.exec(decoded);
      if (match) start = Number(match[1]) + 1;
    } catch {
      start = 0;
    }
  }
  const sliced = first === null ? items.slice(start) : items.slice(start, start + first);
  const pageInfo: Source = {
    __type: 'PageInfo',
    info: {
      hasNextPage: start + sliced.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: sliced.length > 0 ? cursorOf(start) : null,
      endCursor: sliced.length > 0 ? cursorOf(start + sliced.length - 1) : null,
    },
  };
  return {
    __type: 'Connection',
    connType,
    items: sliced,
    edges: sliced.map((node, i) => ({ __type: 'Edge', edgeType: connType.replace('Connection', 'Edge'), node, cursor: cursorOf(start + i) }) as Source),
    pageInfo,
    totalCount: items.length,
  } as Source;
}

// ---------------------------------------------------------------- errors

class GqlError extends Error {}

// ---------------------------------------------------------------- resolvers

function findRepoById(forge: Forge, id: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

function findNumberedById(forge: Forge, id: number): { repo: RepoRec; rec: IssueRec | PullRec } | undefined {
  for (const repo of forge.repos.values()) {
    for (const rec of repo.numbered.values()) if (rec.id === id) return { repo, rec };
  }
  return undefined;
}

function nodeSource(ctx: Ctx, id: string): Source | null {
  const decoded = decodeGlobalId(id);
  if (decoded === null) return null;
  const numeric = Number(decoded.key);
  switch (decoded.type) {
    case 'Repository': {
      const repo = Number.isInteger(numeric) ? findRepoById(ctx.forge, numeric) : undefined;
      return repo === undefined ? null : { __type: 'Repository', repo };
    }
    case 'Issue': {
      const found = Number.isInteger(numeric) ? findNumberedById(ctx.forge, numeric) : undefined;
      return found !== undefined && found.rec.kind === 'issue' ? { __type: 'Issue', repo: found.repo, rec: found.rec } : null;
    }
    case 'PullRequest': {
      const found = Number.isInteger(numeric) ? findNumberedById(ctx.forge, numeric) : undefined;
      return found !== undefined && found.rec.kind === 'pull' ? { __type: 'PullRequest', repo: found.repo, rec: found.rec } : null;
    }
    case 'User': {
      const user = [VIEWER].find((candidate) => candidate.id === numeric);
      return user === undefined ? null : { __type: 'User', user };
    }
    default:
      return null;
  }
}

function mergeableOf(ctx: Ctx, repo: RepoRec, rec: PullRec): string {
  if (rec.merged || rec.state === 'closed') return 'UNKNOWN';
  const head = repo.branchTip(rec.headRef);
  const base = repo.branchTip(rec.baseRef);
  if (head === undefined || base === undefined) return 'UNKNOWN';
  return mergeTrees(ctx.forge, repo, base, head) === null ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------- field resolution

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function resolveField(ctx: Ctx, typeName: string, source: Source | null, field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  if (field === '__typename') return typeName;
  if (typeName === 'Query' || typeName === 'Mutation') return resolveRoot(ctx, typeName, field, args);
  if (source === null) return null;

  // Introspection and payload sources carry their fields as plain properties.
  const raw = source as unknown as Record<string, unknown>;
  if (raw['__type'] === '__Type') {
    const name = raw['name'] as string;
    switch (field) {
      case 'name': return name;
      case 'kind': return typeKind(name);
      case 'description': return null;
      case 'fields': return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }) as unknown as Source);
      case 'inputFields': return [];
      case 'interfaces': return [];
      case 'enumValues': return (ENUM_TYPES[name] ?? []).map((valueName) => ({ __type: '__EnumValue', name: valueName }) as unknown as Source);
      case 'possibleTypes': return null;
      case 'ofType': return null;
      case 'specifiedByURL': return null;
      default: return null;
    }
  }
  if (raw['__type'] === '__Field') {
    switch (field) {
      case 'name': return raw['name'];
      case 'description': return null;
      case 'args': return [];
      case 'type': return typeSource('String') as unknown as Source;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return null;
    }
  }
  if (raw['__type'] === '__EnumValue') {
    switch (field) {
      case 'name': return raw['name'];
      case 'description': return null;
      case 'isDeprecated': return false;
      case 'deprecationReason': return null;
      default: return null;
    }
  }
  if (raw['__type'] === '__Schema') {
    switch (field) {
      case 'types': return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_TYPES)].map((name) => typeSource(name)).filter((s) => s !== null) as unknown as Source[];
      case 'queryType': return typeSource('Query') as unknown as Source;
      case 'mutationType': return typeSource('Mutation') as unknown as Source;
      case 'subscriptionType': return null;
      case 'directives': return [];
      default: return null;
    }
  }
  if (raw['__type'] === 'Tree') {
    switch (field) {
      case 'oid': return raw['oid'];
      case 'id': return nodeId('Tree', 0);
      case 'entries': return [];
      default: return null;
    }
  }
  if (typeName.endsWith('Payload')) {
    const value = raw[field];
    return value === undefined ? null : value;
  }

  switch (source.__type) {
    case 'User': {
      const user = source.user;
      switch (field) {
        case 'id': return nodeId('User', user.id);
        case 'databaseId': return user.id;
        case 'login': return user.login;
        case 'name': return user.name;
        case 'email': return user.email;
        case 'url': return `${ctx.base}/${user.login}`;
        case 'avatarUrl': return '';
        case 'isViewer': return user.id === VIEWER.id;
        case 'createdAt':
        case 'updatedAt': return isoOf(forge.clock.peekEpoch());
        default: return null;
      }
    }
    case 'Repository': {
      const repo = source.repo;
      switch (field) {
        case 'id': return nodeId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { __type: 'User', user: VIEWER } as Source;
        case 'description': return repo.description;
        case 'isPrivate': return repo.private;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'isDisabled': return false;
        case 'isTemplate': return false;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasPullRequestsEnabled': return true;
        case 'visibility': return repo.private ? 'PRIVATE' : 'PUBLIC';
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        case 'licenseInfo': return null;
        case 'parent': return null;
        case 'homepageUrl': return null;
        case 'url': return `${ctx.base}/${repo.owner}/${repo.name}`;
        case 'createdAt': return isoOf(repo.createdEpoch);
        case 'updatedAt':
        case 'pushedAt': return isoOf(repo.updatedEpoch);
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          return tip === undefined ? null : ({ __type: 'Ref', repo, name: repo.defaultBranch } as Source);
        }
        case 'issue': {
          const number = num(args['number']);
          const rec = number === undefined ? undefined : repo.numbered.get(number);
          return rec?.kind === 'issue' ? ({ __type: 'Issue', repo, rec } as Source) : null;
        }
        case 'issues': {
          let items = [...repo.numbered.values()].filter((rec): rec is IssueRec => rec.kind === 'issue');
          const states = args['states'];
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s).toLowerCase());
            items = items.filter((rec) => wanted.includes(rec.state));
          }
          const orderBy = (args['orderBy'] ?? {}) as Record<string, unknown>;
          const direction = str(orderBy['direction']) ?? 'DESC';
          items.sort((a, b) => a.createdEpoch - b.createdEpoch || a.number - b.number);
          if (direction === 'DESC') items.reverse();
          const labelFilter = args['labels'];
          if (Array.isArray(labelFilter)) {
            const wanted = labelFilter.map(String);
            items = items.filter((rec) => wanted.every((label) => rec.labels.includes(label)));
          }
          return connection('IssueConnection', items.map((rec) => ({ __type: 'Issue', repo, rec }) as Source), args);
        }
        case 'pullRequest': {
          const number = num(args['number']);
          const rec = number === undefined ? undefined : repo.numbered.get(number);
          return rec?.kind === 'pull' ? ({ __type: 'PullRequest', repo, rec } as Source) : null;
        }
        case 'pullRequests': {
          let items = [...repo.numbered.values()].filter((rec): rec is PullRec => rec.kind === 'pull');
          const states = args['states'];
          if (Array.isArray(states)) {
            const wanted = states.map((s) => String(s));
            items = items.filter((rec) => wanted.includes(rec.merged ? 'MERGED' : rec.state.toUpperCase()));
          } else {
            items = items.filter((rec) => rec.state === 'open');
          }
          items.sort((a, b) => b.number - a.number);
          return connection('PullRequestConnection', items.map((rec) => ({ __type: 'PullRequest', repo, rec }) as Source), args);
        }
        case 'labels': {
          const items = [...repo.labels.keys()].sort().map((name) => ({ __type: 'Label', repo, name }) as Source);
          return connection('LabelConnection', items, args);
        }
        default: return null;
      }
    }
    case 'Ref': {
      const repo = source.repo;
      const tip = repo.branchTip(source.name) ?? repo.refs.get(`refs/tags/${source.name}`);
      switch (field) {
        case 'id': return nodeId('Ref', repo.id * 1_000_000 + source.name.length);
        case 'name': return source.name;
        case 'prefix': return 'refs/heads/';
        case 'repository': return { __type: 'Repository', repo } as Source;
        case 'target': return tip === undefined ? null : ({ __type: 'Commit', repo, oid: tip } as Source);
        default: return null;
      }
    }
    case 'Commit': {
      const repo = source.repo;
      const object = repo.store.get(source.oid);
      const info = object?.type === 'commit' ? parseCommit(object.data) : null;
      const ident = (line: string): Source => {
        const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line.trim());
        return {
          __type: 'GitActor',
          name: match?.[1] ?? '',
          email: match?.[2] ?? '',
          epoch: match ? Number(match[3]) : 0,
        } as Source;
      };
      switch (field) {
        case 'id': return nodeId('Commit', source.oid.split('').reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 0) >>> 0);
        case 'oid': return source.oid;
        case 'abbreviatedOid': return source.oid.slice(0, 7);
        case 'message': return info?.message ?? '';
        case 'messageHeadline': return (info?.message ?? '').split('\n')[0] ?? '';
        case 'author': return info ? ident(info.author) : null;
        case 'committer': return info ? ident(info.committer) : null;
        case 'committedDate': return info ? isoOf(Number(/ (\d+) [+-]\d{4}$/.exec(info.committer.trim())?.[1] ?? 0)) : null;
        case 'authoredDate': return info ? isoOf(Number(/ (\d+) [+-]\d{4}$/.exec(info.author.trim())?.[1] ?? 0)) : null;
        case 'tree': return info ? ({ __type: 'Tree', repo, oid: info.tree } as unknown as Source) : null;
        case 'url': return `${ctx.base}/${repo.owner}/${repo.name}/commit/${source.oid}`;
        case 'parents':
        case 'history': {
          const list = field === 'parents' ? (info?.parents ?? []) : commitHistory(repo.store, source.oid, 10_000);
          return connection('CommitConnection', list.map((oid) => ({ __type: 'Commit', repo, oid }) as Source), args);
        }
        default: return null;
      }
    }
    case 'GitActor': {
      switch (field) {
        case 'name': return source.name;
        case 'email': return source.email;
        case 'date': return isoOf(source.epoch);
        case 'avatarUrl': return '';
        case 'user': return source.email === VIEWER.email ? ({ __type: 'User', user: VIEWER } as Source) : null;
        default: return null;
      }
    }
    case 'Issue': {
      const { repo, rec } = source;
      switch (field) {
        case 'id': return nodeId('Issue', rec.id);
        case 'databaseId': return rec.id;
        case 'number': return rec.number;
        case 'title': return rec.title;
        case 'body':
        case 'bodyText': return rec.body ?? '';
        case 'bodyHTML': return rec.body ?? '';
        case 'state': return rec.state.toUpperCase();
        case 'author': return { __type: 'User', user: rec.author } as Source;
        case 'editor': return null;
        case 'labels': return connection('LabelConnection', rec.labels.map((name) => ({ __type: 'Label', repo, name }) as Source), args);
        case 'comments': return connection('IssueCommentConnection', rec.comments.map((comment) => ({ __type: 'IssueComment', repo, number: rec.number, comment }) as Source), args);
        case 'createdAt': return isoOf(rec.createdEpoch);
        case 'updatedAt': return isoOf(rec.updatedEpoch);
        case 'closedAt': return rec.state === 'closed' ? isoOf(rec.updatedEpoch) : null;
        case 'closed': return rec.state === 'closed';
        case 'locked': return false;
        case 'url': return `${ctx.base}/${repo.owner}/${repo.name}/issues/${rec.number}`;
        case 'repository': return { __type: 'Repository', repo } as Source;
        case 'milestone': return null;
        case 'assignees': return connection('UserConnection', [], args);
        case 'participants': return connection('UserConnection', [{ __type: 'User', user: rec.author } as Source], args);
        case 'viewerCanUpdate': return true;
        case 'viewerCanReact': return true;
        case 'reactionGroups': return [];
        case 'timelineItems': return connection('IssueCommentConnection', rec.comments.map((comment) => ({ __type: 'IssueComment', repo, number: rec.number, comment }) as Source), args);
        default: return null;
      }
    }
    case 'PullRequest': {
      const { repo, rec } = source;
      const headSha = repo.branchTip(rec.headRef) ?? rec.headSha;
      const baseSha = rec.merged ? rec.baseSha : (repo.branchTip(rec.baseRef) ?? rec.baseSha);
      switch (field) {
        case 'id': return nodeId('PullRequest', rec.id);
        case 'databaseId': return rec.id;
        case 'number': return rec.number;
        case 'title': return rec.title;
        case 'body':
        case 'bodyText': return rec.body ?? '';
        case 'state': return rec.merged ? 'MERGED' : rec.state.toUpperCase();
        case 'author': return { __type: 'User', user: rec.author } as Source;
        case 'labels': return connection('LabelConnection', [], args);
        case 'comments': return connection('IssueCommentConnection', rec.comments.map((comment) => ({ __type: 'IssueComment', repo, number: rec.number, comment }) as Source), args);
        case 'headRefName': return rec.headRef;
        case 'baseRefName': return rec.baseRef;
        case 'headRefOid': return headSha;
        case 'baseRefOid': return baseSha;
        case 'headRef': return repo.refs.has(`refs/heads/${rec.headRef}`) ? ({ __type: 'Ref', repo, name: rec.headRef } as Source) : null;
        case 'baseRef': return repo.refs.has(`refs/heads/${rec.baseRef}`) ? ({ __type: 'Ref', repo, name: rec.baseRef } as Source) : null;
        case 'headRepository':
        case 'baseRepository': return { __type: 'Repository', repo } as Source;
        case 'mergeable': return mergeableOf(ctx, repo, rec);
        case 'merged': return rec.merged;
        case 'mergedAt': return rec.merged ? isoOf(rec.mergedEpoch as number) : null;
        case 'mergedBy': return rec.merged ? ({ __type: 'User', user: VIEWER } as Source) : null;
        case 'mergeCommit': return rec.mergeCommitSha === null ? null : ({ __type: 'Commit', repo, oid: rec.mergeCommitSha } as Source);
        case 'isDraft': return false;
        case 'createdAt': return isoOf(rec.createdEpoch);
        case 'updatedAt': return isoOf(rec.updatedEpoch);
        case 'closedAt': return rec.state === 'closed' ? isoOf(rec.updatedEpoch) : null;
        case 'closed': return rec.state === 'closed';
        case 'locked': return false;
        case 'url': return `${ctx.base}/${repo.owner}/${repo.name}/pull/${rec.number}`;
        case 'repository': return { __type: 'Repository', repo } as Source;
        case 'milestone': return null;
        case 'assignees': return connection('UserConnection', [], args);
        case 'viewerCanUpdate': return true;
        case 'files': {
          const files = changedFiles(forge, repo, baseSha, headSha);
          const items = files.map((file) => ({
            __type: 'PullRequestChangedFile',
            path: file.path,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }) as Source);
          return connection('PullRequestChangedFileConnection', items, args);
        }
        case 'commits': {
          const list = commitHistory(repo.store, headSha, 250);
          return connection('CommitConnection', list.map((oid) => ({ __type: 'Commit', repo, oid }) as Source), args);
        }
        case 'additions': return changedFiles(forge, repo, baseSha, headSha).reduce((sum, file) => sum + file.additions, 0);
        case 'deletions': return changedFiles(forge, repo, baseSha, headSha).reduce((sum, file) => sum + file.deletions, 0);
        case 'changedFiles': return changedFiles(forge, repo, baseSha, headSha).length;
        default: return null;
      }
    }
    case 'Label': {
      const label = source.repo.labels.get(source.name);
      switch (field) {
        case 'id': return nodeId('Label', labelIdOf(source.repo.id, source.name));
        case 'name': return source.name;
        case 'color': return label?.color ?? 'ededed';
        case 'description': return label?.description ?? null;
        case 'url': return `${ctx.base}/${source.repo.owner}/${source.repo.name}/labels/${encodeURIComponent(source.name)}`;
        case 'isDefault': return false;
        default: return null;
      }
    }
    case 'IssueComment': {
      const comment = source.comment;
      switch (field) {
        case 'id': return nodeId('IssueComment', comment.id);
        case 'databaseId': return comment.id;
        case 'body':
        case 'bodyText': return comment.body;
        case 'author': return { __type: 'User', user: comment.author } as Source;
        case 'editor': return null;
        case 'createdAt': return isoOf(comment.createdEpoch);
        case 'updatedAt': return isoOf(comment.updatedEpoch);
        case 'url': return `${ctx.base}/${source.repo.owner}/${source.repo.name}/issues/${source.number}#issuecomment-${comment.id}`;
        case 'issue': {
          const rec = source.repo.numbered.get(source.number);
          return rec?.kind === 'issue' ? ({ __type: 'Issue', repo: source.repo, rec } as Source) : null;
        }
        case 'pullRequest': {
          const rec = source.repo.numbered.get(source.number);
          return rec?.kind === 'pull' ? ({ __type: 'PullRequest', repo: source.repo, rec } as Source) : null;
        }
        default: return null;
      }
    }
    case 'PullRequestChangedFile': {
      switch (field) {
        case 'path': return source.path;
        case 'additions': return source.additions;
        case 'deletions': return source.deletions;
        case 'changeType': return source.changeType;
        case 'viewerViewedState': return 'UNVIEWED';
        default: return null;
      }
    }
    case 'Connection': {
      switch (field) {
        case 'nodes': return source.items;
        case 'edges': return source.edges;
        case 'pageInfo': return source.pageInfo;
        case 'totalCount': return source.totalCount;
        default: return null;
      }
    }
    case 'Edge': {
      switch (field) {
        case 'node': return source.node;
        case 'cursor': return source.cursor;
        default: return null;
      }
    }
    case 'PageInfo': {
      switch (field) {
        case 'hasNextPage': return source.info.hasNextPage;
        case 'hasPreviousPage': return source.info.hasPreviousPage;
        case 'startCursor': return source.info.startCursor;
        case 'endCursor': return source.info.endCursor;
        default: return null;
      }
    }
    case 'RateLimit': {
      switch (field) {
        case 'limit': return 5000;
        case 'cost': return 1;
        case 'remaining': return 4999;
        case 'used': return 1;
        case 'nodeCount': return 0;
        case 'resetAt': return isoOf(forge.clock.peekEpoch() + 3600);
        default: return null;
      }
    }
    default:
      return null;
  }
}

function labelIdOf(repoId: number, name: string): number {
  let hash = repoId * 1_000_003;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return hash % 100_000_000;
}

function resolveRoot(ctx: Ctx, rootType: 'Query' | 'Mutation', field: string, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  if (rootType === 'Query') {
    switch (field) {
      case 'viewer': return { __type: 'User', user: VIEWER } as Source;
      case 'repository': {
        const owner = str(args['owner']);
        const name = str(args['name']);
        if (owner === undefined || name === undefined) return null;
        const repo = forge.getRepo(owner, name);
        return repo === undefined ? null : ({ __type: 'Repository', repo } as Source);
      }
      case 'node': {
        const id = str(args['id']);
        return id === undefined ? null : nodeSource(ctx, id);
      }
      case 'nodes': {
        const ids = args['ids'];
        if (!Array.isArray(ids)) return [];
        return ids.map((id) => (typeof id === 'string' ? nodeSource(ctx, id) : null));
      }
      case 'user': {
        const login = str(args['login']);
        return login === VIEWER.login ? ({ __type: 'User', user: VIEWER } as Source) : null;
      }
      case 'organization': return null;
      case 'rateLimit': return { __type: 'RateLimit' } as Source;
      case 'search': return connection('SearchResultItemConnection' in TYPE_FIELDS ? 'UserConnection' : 'UserConnection', [], args);
      default: return null;
    }
  }
  // Mutations.
  const input = (args['input'] ?? {}) as Record<string, unknown>;
  switch (field) {
    case 'createIssue': {
      const repoId = decodeGlobalId(str(input['repositoryId']) ?? '');
      const repo = repoId !== null && repoId.type === 'Repository' ? findRepoById(forge, Number(repoId.key)) : undefined;
      if (repo === undefined) throw new GqlError('repository not found for createIssue');
      const title = str(input['title']) ?? '';
      const now = forge.clock.nextEpoch();
      const rec: IssueRec = {
        kind: 'issue',
        id: forge.allocObjectId(),
        number: repo.nextNumber++,
        title,
        body: str(input['body']) ?? '',
        state: 'open',
        labels: [],
        author: VIEWER,
        createdEpoch: now,
        updatedEpoch: now,
        comments: [],
      };
      if (Array.isArray(input['labelIds'])) {
        for (const labelId of input['labelIds']) {
          const decoded = decodeGlobalId(String(labelId));
          if (decoded?.type !== 'Label') continue;
          for (const name of repo.labels.keys()) {
            if (labelIdOf(repo.id, name) === Number(decoded.key)) rec.labels.push(name);
          }
        }
      }
      repo.numbered.set(rec.number, rec);
      return { __type: 'CreateIssuePayload', clientMutationId: str(input['clientMutationId']) ?? null, issue: { __type: 'Issue', repo, rec } as Source } as Source;
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const decoded = decodeGlobalId(str(input['issueId']) ?? '');
      const found = decoded !== null && decoded.type === 'Issue' ? findNumberedById(forge, Number(decoded.key)) : undefined;
      if (found === undefined || found.rec.kind !== 'issue') throw new GqlError('issue not found');
      found.rec.state = field === 'closeIssue' ? 'closed' : 'open';
      found.rec.updatedEpoch = forge.clock.nextEpoch();
      return {
        __type: field === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload',
        clientMutationId: str(input['clientMutationId']) ?? null,
        issue: { __type: 'Issue', repo: found.repo, rec: found.rec } as Source,
      } as Source;
    }
    case 'addComment': {
      const decoded = decodeGlobalId(str(input['subjectId']) ?? '');
      const found = decoded !== null ? findNumberedById(forge, Number(decoded.key)) : undefined;
      if (found === undefined) throw new GqlError('subject not found for addComment');
      const now = forge.clock.nextEpoch();
      const comment = { id: forge.allocObjectId(), body: str(input['body']) ?? '', author: VIEWER, createdEpoch: now, updatedEpoch: now };
      found.rec.comments.push(comment);
      found.rec.updatedEpoch = now;
      const node: Source = { __type: 'IssueComment', repo: found.repo, number: found.rec.number, comment };
      return {
        __type: 'AddCommentPayload',
        clientMutationId: str(input['clientMutationId']) ?? null,
        commentEdge: { __type: 'Edge', edgeType: 'IssueCommentEdge', node, cursor: cursorOf(found.rec.comments.length - 1) } as Source,
        subject: found.rec.kind === 'issue' ? ({ __type: 'Issue', repo: found.repo, rec: found.rec } as Source) : ({ __type: 'PullRequest', repo: found.repo, rec: found.rec } as Source),
      } as Source;
    }
    case 'createPullRequest': {
      const repoId = decodeGlobalId(str(input['repositoryId']) ?? '');
      const repo = repoId !== null && repoId.type === 'Repository' ? findRepoById(forge, Number(repoId.key)) : undefined;
      if (repo === undefined) throw new GqlError('repository not found for createPullRequest');
      const headRef = str(input['headRefName']) ?? '';
      const baseRef = str(input['baseRefName']) ?? '';
      const headSha = repo.branchTip(headRef);
      const baseSha = repo.branchTip(baseRef);
      if (headSha === undefined || baseSha === undefined) throw new GqlError('head or base branch does not exist');
      const now = forge.clock.nextEpoch();
      const rec: PullRec = {
        kind: 'pull',
        id: forge.allocObjectId(),
        number: repo.nextNumber++,
        title: str(input['title']) ?? '',
        body: str(input['body']) ?? '',
        state: 'open',
        merged: false,
        mergedEpoch: null,
        mergeCommitSha: null,
        headRef,
        headSha,
        baseRef,
        baseSha,
        author: VIEWER,
        createdEpoch: now,
        updatedEpoch: now,
        comments: [],
      };
      repo.numbered.set(rec.number, rec);
      return { __type: 'CreatePullRequestPayload', clientMutationId: str(input['clientMutationId']) ?? null, pullRequest: { __type: 'PullRequest', repo, rec } as Source } as Source;
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(str(input['pullRequestId']) ?? '');
      const found = decoded !== null && decoded.type === 'PullRequest' ? findNumberedById(forge, Number(decoded.key)) : undefined;
      if (found === undefined || found.rec.kind !== 'pull') throw new GqlError('pull request not found');
      const result = mergePullRequest(forge, found.repo, found.rec);
      if (result === 'conflict' || result === 'gone') throw new GqlError('pull request is not mergeable');
      return { __type: 'MergePullRequestPayload', clientMutationId: str(input['clientMutationId']) ?? null, pullRequest: { __type: 'PullRequest', repo: found.repo, rec: found.rec } as Source } as Source;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------- introspection sources

interface TypeSource {
  __type: '__Type';
  name: string;
}

function typeKind(name: string): string {
  if (name in ENUM_TYPES) return 'ENUM';
  if (name in TYPE_FIELDS) return 'OBJECT';
  if (['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'HTML', 'GitObjectID', 'Base64String'].includes(name)) return 'SCALAR';
  if (name.endsWith('Input')) return 'INPUT_OBJECT';
  return 'OBJECT';
}

function typeSource(name: string): TypeSource | null {
  if (!(name in TYPE_FIELDS) && !(name in ENUM_TYPES) && typeKind(name) !== 'SCALAR') return null;
  return { __type: '__Type', name };
}

// ---------------------------------------------------------------- validation

function validateSelections(
  typeName: string,
  selections: readonly SelectionNode[],
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>,
  errors: string[],
): void {
  const fields = TYPE_FIELDS[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      validateSelections(selection.typeCondition ?? typeName, selection.selection, fragments, errors);
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = fragments.get(selection.name);
      if (fragment !== undefined) validateSelections(fragment.typeCondition ?? typeName, fragment.selection, fragments, errors);
      continue;
    }
    if (selection.name === '__typename' || selection.name === '__type' || selection.name === '__schema') {
      continue;
    }
    if (fields !== undefined && !fields.includes(selection.name)) {
      errors.push(`Field '${selection.name}' doesn't exist on type '${typeName}'`);
      continue;
    }
    if (selection.selection !== null) {
      validateSelections(fieldType(typeName, selection.name), selection.selection, fragments, errors);
    }
  }
}

// ---------------------------------------------------------------- execution

interface ExecEnv {
  ctx: Ctx;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selection: SelectionNode[] }>;
}

function isSource(value: unknown): value is Source {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

function executeSelections(env: ExecEnv, typeName: string, source: Source | null, selections: readonly SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || (source !== null && source.__type === selection.typeCondition)) {
        Object.assign(out, executeSelections(env, selection.typeCondition ?? typeName, source, selection.selection));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = env.fragments.get(selection.name);
      if (fragment !== undefined) {
        Object.assign(out, executeSelections(env, fragment.typeCondition ?? typeName, source, fragment.selection));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const args: Record<string, unknown> = {};
    for (const arg of selection.args) args[arg.name] = resolveValue(arg.value, env.variables);
    out[key] = executeField(env, typeName, source, selection, args);
  }
  return out;
}

function executeField(env: ExecEnv, typeName: string, source: Source | null, field: FieldNode, args: Record<string, unknown>): unknown {
  if (field.name === '__typename') return source?.__type ?? typeName;
  if (field.name === '__type') {
    const name = str(args['name']);
    const found = name === undefined ? null : typeSource(name);
    if (found === null || field.selection === null) return null;
    return executeSelections(env, '__Type', found as unknown as Source, field.selection);
  }
  if (field.name === '__schema') {
    if (field.selection === null) return null;
    return executeSelections(env, '__Schema', { __type: '__Schema' } as unknown as Source, field.selection);
  }
  const value = resolveField(env.ctx, typeName, source, field.name, args);
  return completeValue(env, typeName, field, value);
}

function completeValue(env: ExecEnv, parentType: string, field: FieldNode, value: unknown): unknown {
  if (field.selection === null) return value ?? null;
  if (value === null || value === undefined) return null;
  const nestedType = fieldType(parentType, field.name);
  if (Array.isArray(value)) {
    return value.map((item) => (isSource(item) ? executeSelections(env, item.__type, item, field.selection as SelectionNode[]) : item));
  }
  if (isSource(value)) {
    return executeSelections(env, value.__type, value, field.selection);
  }
  void nestedType;
  return value;
}

// ---------------------------------------------------------------- the HTTP handler

export interface GraphQLReply {
  status: number;
  body: unknown;
}

function runOperation(ctx: Ctx, body: Record<string, unknown>): Record<string, unknown> {
  const query = str(body['query']);
  if (query === undefined) return { errors: [{ message: 'no query given' }] };
  const variables = (typeof body['variables'] === 'object' && body['variables'] !== null ? body['variables'] : {}) as Record<string, unknown>;
  const operationName = str(body['operationName']);
  let document: Document;
  try {
    document = new Parser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operationName !== undefined
    ? document.operations.find((op) => op.name === operationName) ?? document.operations[0]
    : document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const errors: string[] = [];
  validateSelections(rootType, operation.selection, document.fragments, errors);
  if (errors.length > 0) {
    return { data: null, errors: errors.map((message) => ({ message })) };
  }
  const env: ExecEnv = { ctx, variables, fragments: document.fragments };
  try {
    const data = executeSelections(env, rootType, null, operation.selection);
    return { data };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    throw err;
  }
}

export function handleGraphQL(ctx: Ctx, body: unknown): GraphQLReply {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => runOperation(ctx, (entry ?? {}) as Record<string, unknown>)) };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { errors: [{ message: 'request body must be a JSON object' }] } };
  }
  return { status: 200, body: runOperation(ctx, body as Record<string, unknown>) };
}
