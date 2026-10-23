// The HTTP API between the server and the page. Both sides import these types, so a change
// to a response shape fails to compile wherever it's used. Types only: nothing here ships.

// ---------- config ----------

export type Editor = 'vscode' | 'cursor' | 'windsurf' | 'zed' | 'none';

/** Who runs a code review: the CodeRabbit CLI, or Claude Code's built-in /code-review. */
export type Reviewer = 'coderabbit' | 'claude';

/** Claude Code's --effort levels, cheapest first. */
export type ReviewEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface Config {
  /** Extra folders whose immediate children are scanned for repos. */
  roots: string[];
  /** Extra repo paths to always include. */
  extraRepos: string[];
  /** Remove a worktree automatically once its PR merges (only when safe). */
  autoCleanup: boolean;
  /** Worktrees touched within this many days count as "recent". */
  recentDays: number;
  prPollMinutes: number;
  /** Target of "open" links. */
  editor: Editor;
  /** The effort preselected when starting a Claude code review. */
  reviewEffort: ReviewEffort;
}

// ---------- worktrees ----------

export type PRState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PullRequest {
  number: number;
  state: PRState;
  isDraft: boolean;
  url: string;
  title: string;
  mergedAt: string | null;
  /** The branch it merges into. */
  baseRefName: string;
}

export type SessionStatus = 'busy' | 'idle' | 'shell' | 'unknown' | (string & {});

export interface SessionRef {
  sessionId: string;
  name: string;
  status: SessionStatus;
}

export interface Session extends SessionRef {
  cwd?: string;
}

/** A subagent a session started that is still running. */
export interface AgentRef {
  agentId: string;
  description: string;
  agentType: string;
  /** The session that started it, which may be working somewhere else. */
  parent: SessionRef;
}

export type WorktreeErrorKind = 'broken-link' | 'submodules' | 'dirty' | 'locked' | 'other';

export interface WorktreeError {
  kind: WorktreeErrorKind;
  message: string;
  detail: string;
}

/** What kind of uncommitted changes a worktree has, which decides whether removing it could lose work. */
export type DirtyKind = 'deleted-only' | 'lockfile-only' | 'work';

export interface DirtyFile {
  /** Two-letter `git status --porcelain` code, e.g. " M", "??". */
  xy: string;
  file: string;
}

export interface UnmatchedCommit {
  sha: string;
  subject: string;
}

export interface CleanupStatus {
  /** merged: its PR merged. idle: no PR merged, and only ever removed by hand. */
  kind: 'merged' | 'idle';
  eligible: boolean;
  /** Why it can't be removed. */
  reasons: string[];
  /** Worth knowing, but doesn't block removal. */
  notes: string[];
  /** Whether the branch is deleted along with the worktree. */
  branchSafe: boolean;
  /** Whether "Remove anyway" can override every reason. */
  forceable: boolean;
  dirty: { kind: DirtyKind | null; count: number; files: DirtyFile[] } | null;
  unmatched: UnmatchedCommit[];
  /** Whether it's removed automatically. */
  auto: boolean;
}

export type ReviewStatus = 'running' | 'done' | 'failed' | 'cancelled';

export interface CodeReviewSummary {
  status: ReviewStatus;
  startedAt: number;
  finishedAt: number | null;
  heartbeatAt: number;
  open: number;
  total: number;
  /** Changes whenever a finding's status changes. */
  sig: string;
  /** The files have changed since the review, so its line numbers may be off. */
  stale: boolean;
}

export interface DiffStats {
  files: number;
  add: number;
  del: number;
}

export interface Worktree {
  id: string;
  path: string;
  repoName: string;
  branch: string | null;
  head: string | undefined;
  isMain: boolean;
  locked: boolean;
  detached: boolean;
  /** Changes whenever its HEAD, base or working tree changes. */
  fingerprint: string | null;
  /** Number of uncommitted entries. */
  dirty: number;
  lastActivity: number;
  ahead: number;
  stats: DiffStats | null;
  baseRef: string | undefined;
  baseSource: string | undefined;
  baseError: string | null | undefined;
  pr: PullRequest | null;
  sessions: SessionRef[];
  /** Subagents working here, e.g. one started with `isolation: "worktree"`. */
  agents: AgentRef[];
  cleanup: CleanupStatus | null;
  error: WorktreeError | null;
  /** What's happening to it right now, e.g. "cleanup" or "remove". */
  busy: string | null;
  dirtyKind: DirtyKind | null;
  /** Each reviewer's latest review. */
  codeReviews: Partial<Record<Reviewer, CodeReviewSummary>>;
  review: { reviewedAt: number | null; needsReview: boolean };
  comments: { draft: number; waiting: number; open: number; sig: string };
}

// ---------- background jobs ----------

export interface JobItem {
  id: string;
  branch: string | null;
  path: string;
}

export interface JobFailure extends JobItem {
  error: string;
  kind: WorktreeErrorKind | null;
}

export interface Job {
  id: string;
  kind: 'cleanup' | 'remove' | 'repair' | (string & {});
  title: string;
  total: number;
  done: number;
  current: (JobItem & { startedAt: number }) | null;
  ok: JobItem[];
  failed: JobFailure[];
  status: 'running' | 'done';
  startedAt: number;
  finishedAt: number | null;
  dismissed: boolean;
}

export interface CleanedEntry {
  path: string;
  branch: string | null;
  sha: string;
  repoRoot: string;
  how: 'auto' | 'manual' | 'forced';
  branchDeleted: boolean;
  branchKept: string | null;
  at: number;
  lostFiles?: string[];
  reason?: 'merged' | 'idle';
  pr: { number: number; url: string; title: string; state?: PRState } | null;
}

export interface CodeRabbitLogin {
  running: boolean;
  url: string | null;
  error: string | null;
  startedAt: number;
}

export interface RepoInfo {
  name: string;
  root: string;
  github: string | null;
}

/** GET /api/state, and every live update on /api/events. */
export interface PublicState {
  port: number;
  version: string;
  home: string;
  prError: string | null;
  config: Config;
  onboardedAt: number | null;
  repos: RepoInfo[];
  coderabbitLogin: CodeRabbitLogin | null;
  jobs: Job[];
  coderabbitReady: boolean;
  /** Whether the claude CLI was found, so Claude can run code reviews. */
  claudeReady: boolean;
  installedAt: number;
  sessions: Session[];
  cleaned: CleanedEntry[];
  worktrees: Worktree[];
}

// ---------- diffs ----------

export interface Commit {
  /** 1-based, oldest first. 0 means uncommitted changes. */
  n: number;
  sha: string;
  time: number;
  author: string;
  subject: string;
  body: string;
}

export interface CommitDiff extends Commit {
  diff: string;
  truncated: boolean;
}

interface DiffBase {
  sinceAvailable: boolean;
  reviewedAt: number | null;
  fingerprint: string | null;
  /** Tree object of the working tree, untracked files included. */
  tree: string;
  mergeBase: string;
  baseRef: string | undefined;
  baseSource: string | undefined;
  /** file -> content hash, for files ticked as viewed. */
  viewed: Record<string, string>;
}

/** GET /api/worktrees/:id/diff?mode=full|since */
export interface FullDiff extends DiffBase {
  mode: 'full' | 'since';
  commits: Commit[];
  /** file -> numbers of the commits that touched it (0 = uncommitted). */
  fileCommits: Record<string, number[]>;
  truncated: boolean;
  diff: string;
}

/** GET /api/worktrees/:id/diff?mode=commits */
export interface CommitsDiff extends DiffBase {
  mode: 'commits';
  commits: CommitDiff[];
  hiddenCommits: number;
  uncommitted: string;
}

export type DiffResponse = FullDiff | CommitsDiff;

/** [firstLine, lastLine, commitNumber]: a run of lines that one commit introduced (0 = uncommitted). */
export type BlameRun = [number, number, number];

/** GET /api/worktrees/:id/blame */
export interface BlameResponse {
  fingerprint: string | null;
  lines: Record<string, BlameRun[]>;
}

/** A commit that last changed some lines of a file, for the Blame view. */
export interface BlameCommit {
  /** 40 zeros when the lines aren't committed yet. */
  sha: string;
  author: string;
  time: number;
  summary: string;
  /** Its number on this branch (1-based), 0 when uncommitted, null when it's from before the branch. */
  n: number | null;
}

/** [firstLine, lastLine, sha]: lines of the working file that last changed in one commit. */
export type FileBlameRun = [number, number, string];

/** GET /api/worktrees/:id/blame/file?path=: full-history blame of one file as it is in the worktree. */
export interface FileBlame {
  file: string;
  fingerprint: string | null;
  commits: Record<string, BlameCommit>;
  runs: FileBlameRun[];
}

// ---------- comments & reviews ----------

export type CommentStatus = 'draft' | 'pending' | 'delivered' | 'resolved';
export type Side = 'old' | 'new';

export interface Reply {
  author: 'you' | 'claude' | (string & {});
  body: string;
  at: number;
}

export interface Comment {
  id: string;
  wtId: string;
  wtPath: string;
  file: string;
  line: number;
  side: Side;
  lineText: string;
  body: string;
  status: CommentStatus;
  createdAt: number;
  replies: Reply[];
  /** Set when the comment was made on one commit in By commit view. */
  commit?: string;
  commitSubject?: string;
  reviewId?: string;
  resolvedAt?: number;
  /** Set when it came from a code review finding. */
  fromFinding?: string;
  /** Set when it was handed to a Claude session. */
  deliveredTo?: DeliveredTo;
}

/** Which session a review or comment was delivered to; the fields are unset when the hook sent no session id. */
export interface DeliveredTo {
  sessionId?: string;
  name?: string;
}

export interface Review {
  id: string;
  wtId: string;
  wtPath: string;
  summary: string;
  commentIds: string[];
  /** Deliver to this session, or to whichever session works in the worktree when null. */
  targetSession: string | null;
  status: 'pending' | 'delivered' | 'cancelled';
  createdAt: number;
  deliveredAt?: number;
  deliveredTo?: DeliveredTo;
}

/** GET /api/worktrees/:id/comments */
export interface CommentsResponse {
  comments: Comment[];
  reviews: Review[];
}

export interface NewComment {
  wtId: string;
  file: string;
  line: number;
  side: Side;
  lineText?: string;
  body: string;
  commit?: string;
  commitSubject?: string;
}

// ---------- code reviews (CodeRabbit or Claude) ----------

export type FindingStatus = 'open' | 'sent' | 'dismissed';

export interface Finding {
  id: string;
  source: Reviewer;
  severity: string;
  file: string;
  startLine: number | null;
  endLine: number | null;
  title: string;
  comment: string;
  codegen: string;
  suggestions: string;
  status: FindingStatus;
  snippet?: string;
  commentId?: string;
}

export interface CodeRabbitUsage {
  limit: number;
  remaining: number;
  fullInMs: number;
  windowMs: number;
  repository: string;
}

export interface CodeReview {
  reviewer: Reviewer;
  status: ReviewStatus;
  startedAt: number;
  finishedAt: number | null;
  baseRef: string | undefined;
  fingerprint: string | null;
  findings: Finding[];
  reviewedFiles: string[];
  error: string | null;
  heartbeatAt: number;
  /** CodeRabbit's hourly allowance, as of the start. */
  usage: CodeRabbitUsage | null;
  /** Claude's effort level, and what the run cost as Claude Code reports it. */
  effort?: ReviewEffort;
  costUsd?: number | null;
  message?: string;
  /** Git's tree hash of the worktree's files when the review ran; see contentTree on the server. */
  contentTree?: string | null;
}

/** POST /api/worktrees/:id/code-review */
export interface StartCodeReview {
  reviewer: Reviewer;
  /** Claude only; the configured default when left out. */
  effort?: ReviewEffort;
}

/** GET /api/worktrees/:id/code-reviews */
export interface CodeReviewsResponse {
  reviews: Partial<Record<Reviewer, CodeReview>>;
  usage: CodeRabbitUsage | null;
}

// ---------- settings ----------

export interface Integrations {
  gh: { installed: boolean; version: string | null; authed: boolean; account: string | null };
  coderabbit: {
    installed: boolean;
    version: string | null;
    authed: boolean;
    user?: string;
    email?: string;
    org?: string | null;
    orgs?: string[];
    plan?: string | null;
    seat?: string | null;
  };
  coderabbitLogin: CodeRabbitLogin | null;
  /** `version` is this plugin's; `cliVersion` is the claude CLI's, null when it isn't found. */
  claude: { lastHookAt: number | null; sessions: number; version: string; cliVersion: string | null };
  node: string;
  dataDir: string;
  configPath: string;
}

export interface DirEntry {
  name: string;
  path: string;
  isRepo: boolean;
}

/** GET /api/fs?path= */
export interface DirListing {
  path: string;
  display: string;
  parent: string | null;
  isRepo: boolean;
  repoChildren: number;
  entries: DirEntry[];
}

export interface RepairResult {
  fixed: { path: string; branch: string | null }[];
  failed: { id: string; path: string; branch: string | null; error: string }[];
}

/** Body of the routes that just acknowledge. */
export interface Ok {
  ok: true;
}

/** GET /api/worktrees/:id/prompt */
export interface PromptResponse {
  text: string;
}

/** POST /api/worktrees/:id/code-review/:reviewer/send-all */
export interface SendAllResponse {
  sent: number;
}

/** POST /api/shutdown. `deferred` is set when a removal is still running, so the server stops after it. */
export interface ShutdownResponse {
  ok: true;
  deferred?: true;
}

/** POST /api/hook: the review text to hand to Claude, or null when there is none. */
export interface HookResponse {
  text: string | null;
}

/** POST /api/wait: a review for an idle session's waiter, or `done` when it should stop waiting. */
export interface WaitResponse {
  text: string | null;
  done: boolean;
}

/** GET /api/worktrees/:id/bases: the choices in the "Compare with" menu. */
export interface BaseChoices {
  /** Used when you haven't picked one. */
  automatic: { ref: string; source: string };
  /** In use now ("set by you" when picked). */
  current: { ref: string; source: string };
  /** Local branches, most recently committed first. */
  branches: string[];
  /** Remote-tracking branches, most recently committed first. */
  remotes: string[];
}

/** Body of every error response. */
export interface ApiError {
  error: string;
}
