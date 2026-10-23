import path from 'node:path';
import type { CodeReview, Finding, ReviewEffort } from '../shared/api.ts';
import { addSnippet, assertIdle, beginReview, runReview } from './code-review.ts';
import { config, isEffort } from './config.ts';
import { httpError } from './exec.ts';
import { claudeBin, getIntegrations } from './integrations.ts';
import type { WorktreeRecord } from './types.ts';
import { asStr, newId, rec } from './util.ts';
import { refreshWorktree } from './worktrees.ts';

// ---------- Claude code reviews ----------
// Runs Claude Code's built-in /code-review skill in the worktree as a separate, headless session.


const SEVERITIES = ['critical', 'major', 'minor', 'info'];

// The structured output Claude is asked for; --json-schema makes the CLI hold it to this.
const SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          startLine: { type: 'integer' },
          endLine: { type: 'integer' },
          severity: { type: 'string', enum: SEVERITIES },
          title: { type: 'string' },
          comment: { type: 'string' },
          suggestion: { type: 'string', description: 'Replacement code, when there is an obvious fix' },
        },
        required: ['file', 'startLine', 'severity', 'title', 'comment'],
      },
    },
  },
  required: ['findings'],
};

const prompt = (base: string): string => `Run the code-review skill (Skill tool, args: "${base}") on this worktree: its changes against ${base}, \
including uncommitted and untracked files. Don't change any files. Then return every finding it reports as structured output, \
with file paths relative to the repository root and line numbers in the current version of each file.`;

// The server inherits the environment of the session whose hook started it. These would tie the reviewer to that session.
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|SESSION_ATTENDED|CHILD_SESSION|MESSAGING_\w+))$/;
const reviewerEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([k]) => !SESSION_VARS.test(k)));

/** A one-line account of what the reviewer is doing, from a tool call. */
function activity(wt: WorktreeRecord, name: string, input: Record<string, unknown>): string {
  const file = asStr(input.file_path);
  if (name === 'Skill') return 'Starting the review';
  if (name === 'Read' && file) return `Reading ${path.relative(wt.path, path.resolve(wt.path, file))}`;
  if (name === 'Bash') return `Running ${(asStr(input.command) || '').split('\n')[0]?.slice(0, 80)}`;
  if (name === 'Grep' || name === 'Glob') return 'Searching the code';
  if (name === 'Task' || name === 'Agent') return asStr(input.description) || 'Starting a sub-agent';
  if (name === 'StructuredOutput') return 'Writing up findings';
  return name;
}

function toFinding(wt: WorktreeRecord, v: unknown): Finding {
  const o = rec(v);
  const raw = asStr(o.file) || '';
  const start = Number(o.startLine) || null;
  const severity = String(o.severity || 'info').toLowerCase();
  return {
    id: newId('f'),
    source: 'claude',
    severity: SEVERITIES.includes(severity) ? severity : 'info',
    file: path.isAbsolute(raw) ? path.relative(wt.path, raw) : raw,
    startLine: start,
    endLine: Number(o.endLine) || start,
    title: asStr(o.title) || '',
    comment: asStr(o.comment) || '',
    codegen: '',
    suggestions: asStr(o.suggestion) || '',
    status: 'open',
  };
}

export async function startClaudeReview(wt: WorktreeRecord, effort: ReviewEffort = config.reviewEffort): Promise<CodeReview> {
  assertIdle(wt, 'claude');
  if (!isEffort(effort)) throw httpError(400, `Unknown effort: ${String(effort)}`);
  const integ = await getIntegrations();
  if (!integ.claude.cliVersion) throw httpError(409, 'The claude CLI was not found. See Settings.');
  await refreshWorktree(wt);
  const base = wt.baseRef;
  if (!base) throw httpError(409, 'This worktree has nothing to compare with yet.');
  const review = beginReview(wt, 'claude', { effort, costUsd: null });
  let reported = false;
  runReview(wt, review, claudeBin(), [
    '-p', prompt(base),
    // Leaves out the user's own skills (a personal "code-review" would shadow the built-in one), plugins and hooks, this plugin's too.
    '--safe-mode',
    '--no-session-persistence',
    '--effort', effort,
    '--disallowed-tools', 'Edit Write NotebookEdit',
    '--output-format', 'stream-json', '--verbose',
    '--json-schema', JSON.stringify(SCHEMA),
  ], {
    env: reviewerEnv(),
    onEvent: (ev) => {
      if (ev.type === 'assistant') {
        const content = rec(ev.message).content;
        for (const c of Array.isArray(content) ? content : []) {
          const block = rec(c);
          if (block.type === 'tool_use') review.message = activity(wt, asStr(block.name) || '', rec(block.input));
        }
      } else if (ev.type === 'result') {
        reported = true;
        if (typeof ev.total_cost_usd === 'number') review.costUsd = ev.total_cost_usd;
        const findings = rec(ev.structured_output).findings;
        if (ev.is_error || ev.subtype !== 'success') review.error = asStr(ev.result) || `Claude stopped early (${asStr(ev.subtype) || 'error'}).`;
        else if (!Array.isArray(findings)) review.error = "Claude finished without reporting its findings in a form this page can show.";
        else review.findings = findings.map((f) => addSnippet(wt, toFinding(wt, f)));
      }
    },
    finish: () => { if (!reported) review.error ||= 'Claude exited without a result.'; },
  });
  return review;
}
