// Client-only types: what app.js derives from the API responses in src/shared/api.ts.
import type {
  BaseChoices, BlameResponse, CodeReview, FileBlame, Comment, DiffResponse, DirListing, Finding, Integrations, PublicState, Review, ReviewEffort, Reviewer, ReviewStatus,
} from '../shared/api.ts';

// ---------- parsed diffs ----------

export interface DiffLine {
  t: 'add' | 'del' | 'ctx';
  text: string;
  /** Old line number (del, ctx). */
  o?: number;
  /** New line number (add, ctx). */
  n?: number;
}

export interface Hunk {
  header: string;
  oldNo: number;
  newNo: number;
  lines: DiffLine[];
}

export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed';

export interface RawFile {
  raw: string[];
  hunks: Hunk[];
  oldPath: string;
  newPath: string;
  status: FileStatus;
  binary: boolean;
  add: number;
  del: number;
}

export interface DiffFile extends RawFile {
  path: string;
  hash: string;
  lineCount: number;
  generated: boolean;
}

/** A file as shown on the page: which commit it belongs to (null outside By commit), and a key unique across commits. */
export interface ViewFile extends DiffFile {
  commit: string | null;
  commitN?: number;
  uncommitted?: boolean;
  uid: string;
}

/** One section of the By commit view: a commit, or the uncommitted changes (n 0, no sha). */
export interface CommitGroup {
  n: number;
  sha: string | null;
  subject: string;
  author?: string;
  time?: number;
  body?: string;
  truncated?: boolean;
  files: ViewFile[];
}

// ---------- state ----------

export type DiffMode = 'full' | 'since' | 'commits';

export interface View {
  wtId: string;
  diff: DiffResponse;
  files: ViewFile[];
  groups: CommitGroup[] | null;
  comments: Comment[];
  reviews: Review[];
  commentSig: string;
  crSig: string | undefined;
  blame: BlameResponse | null;
  codeReviews?: Partial<Record<Reviewer, CodeReview>>;
  /** Open findings by "file|new|line" anchor. */
  crByAnchor?: Map<string, Finding[]>;
  headerSig?: string;
  /** The "Comments on files not in this view" panel as last rendered, so in-place patches know whether it changed. */
  orphanHtml?: string;
}

export interface Picker {
  hidden: boolean;
  data?: DirListing | null;
}

export type Page = 'settings' | 'welcome' | 'cleanup';

export interface State {
  st: PublicState | null;          // server state
  selId: string | null;
  mode: DiffMode | null;
  view: View | null;
  seq: number;
  editors: Map<string, string>;    // editor key -> text
  focusEk: string | null;
  toggled: Map<string, boolean>;   // file uid -> collapsed?
  forceRender: Set<string>;
  filter: string;
  showOlder: boolean;
  showCleaned: boolean;
  stale: boolean;
  summaries: Record<string, string>; // wtId -> review summary draft; `${wtId}:target` -> target session
  prevStatus: Map<string, string>;
  page: Page | null;
  cleanSel: Map<string, boolean>;  // clean-up page: worktree id -> ticked
  shutCommits: Set<number>;        // collapsed commit sections in By commit view
  bases: Map<string, BaseChoices>;  // wtId -> "Compare with" choices
  basesLoading: Set<string>;
  baseOther: string | null;        // wtId showing the free-text base input
  blameOn: Set<string>;            // file uids showing the Blame column
  fileBlame: Map<string, FileBlame>; // `${fingerprint}:${path}` -> full-history blame
  openBodies: Set<number>;         // commit messages expanded past the clamp
  removeErrors: Record<string, string>; // wtId -> why the last removal failed
  seenJobs: Set<string>;           // finished jobs already handled
  integ: Integrations | null;      // integrations status from the server
  setupSig: string | null;
  // Set lazily, as before:
  hl?: number | null;              // commit number being highlighted
  scrollTo?: string | null;        // element id to scroll to after the next render
  picker?: Picker | null;
  prevCr?: Map<string, ReviewStatus | undefined>; // `${wtId} ${reviewer}` -> status
  reviewMenu?: string | null;      // wtId whose "Run code review" menu is open
  reviewPick?: { reviewer: Reviewer; effort: ReviewEffort | null } | null;
}

/** What the SharedWorker posts (mirrors src/web/worker/sse-worker.ts, which can't import from here). */
export type LiveMessage = { type: 'state'; data: string } | { type: 'error' };
