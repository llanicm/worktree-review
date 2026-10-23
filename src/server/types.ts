// The server's internal records: what it keeps in memory and persists. The shapes it sends to
// the page are in ../shared/api.ts.
import type {
  AgentRef, CleanedEntry, CodeReview, Comment, DiffStats, DirtyFile, DirtyKind, PRState,
  Review, Reviewer, Session, UnmatchedCommit, WorktreeError,
} from '../shared/api.ts';

export interface Repo {
  root: string;
  commonDir: string;
  name: string;
  gh: { owner: string; name: string } | null;
  defaultBase: string;
}

/** A pull request as GitHub's GraphQL API returns it. */
export interface PRNode {
  number: number;
  state: PRState;
  isDraft: boolean;
  url: string;
  title: string;
  headRefOid: string;
  mergedAt: string | null;
  baseRefName: string;
}

export interface SessionRecord extends Session {
  pid: number;
  worktreePaths: string[];
  scannedSize: number;
  scannedAt: number;
  /** Its subagents that are still running. */
  agents: AgentRecord[];
}

export interface AgentRecord {
  agentId: string;
  description: string;
  agentType: string;
  worktreePaths: string[];
  scannedSize: number;
  scannedAt: number;
}

/** The in-memory record of a worktree; the page gets a trimmed copy (Worktree). */
export interface WorktreeRecord {
  id: string;
  path: string;
  repoKey: string;
  repoName: string;
  isMain: boolean;
  branch: string | null;
  detached: boolean;
  locked: boolean;
  head?: string;
  commitTime?: number;
  stackBase?: string | null;
  fingerprint: string | null;
  dirty: number;
  dirtyFiles: DirtyFile[];
  dirtyKind?: DirtyKind | null;
  untracked?: number;
  lastActivity: number;
  ahead: number;
  stats: DiffStats | null;
  baseRef?: string;
  baseSource?: string;
  mergeBase?: string | null;
  baseError?: string | null;
  nextCheck: number;
  sessions: SessionRecord[];
  agents: AgentRef[];
  sessionSig?: string;
  pr?: PRNode | null;
  headInMerged: boolean | null;
  unmatched?: UnmatchedCommit[] | null;
  /** Commits no remote has. */
  unpushed?: number;
  /** For a detached HEAD, commits on no ref at all. */
  orphaned?: number;
  checking?: Promise<void> | null;
  error?: WorktreeError | null;
  /** What's happening to it right now, e.g. "cleanup" or "remove". */
  busy?: string | null;
  snap?: { fp: string | null; tree: string };
  /** Results of git work for the current fingerprint, keyed by what was computed. Cleared when the fingerprint changes. */
  memo?: { fp: string | null; results: Map<string, Promise<unknown>> };
}

/** What state.json keeps per worktree. */
export interface WorktreeState {
  path: string;
  baseOverride?: string | null;
  reviewedTree?: string;
  reviewedFp?: string | null;
  reviewedAt?: number;
  /** file -> content hash, for files ticked as viewed. */
  viewed: Record<string, string>;
}

/** The persisted state.json. */
export interface State {
  installedAt: number;
  onboardedAt?: number | null;
  worktrees: Record<string, WorktreeState>;
  comments: Comment[];
  reviews: Review[];
  cleaned: CleanedEntry[];
  /** Folders of removed worktrees still being deleted in the background. */
  trash: string[];
  /** wtId -> each reviewer's last review. */
  codeReviews: Record<string, Partial<Record<Reviewer, CodeReview>>>;
}
