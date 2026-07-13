// Thin GitHub REST client scoped to the one repo. Server-side ONLY — the
// fine-grained PAT must never reach a client bundle; nothing here is imported
// by client components (they talk to /api/*).

export type Which = "base" | "design";

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly stale = false,
  ) {
    super(message);
  }
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] || fallback;
  if (!v) throw new GitHubError(`${name} is not configured`, 500);
  return v;
}

export function repoConfig(): { repo: string; branch: string; paths: Record<Which, string> } {
  return {
    repo: env("GITHUB_REPO", "s0shaheen/job-hq"),
    branch: env("GITHUB_BRANCH", "main"),
    paths: {
      base: env("RESUME_PATH", "resume/base.yaml"),
      design: env("DESIGN_PATH", "resume/design.yaml"),
    },
  };
}

async function gh(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hq-resume-editor",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
}

async function ghMessage(res: Response, ctx: string): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: string };
    detail = body.message ?? "";
  } catch {
    /* non-JSON error body */
  }
  return `GitHub ${ctx} failed (${res.status})${detail ? `: ${detail}` : ""}`;
}

function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export async function getFile(which: Which): Promise<{ content: string; sha: string; path: string }> {
  const { repo, branch, paths } = repoConfig();
  const path = paths[which];
  const res = await gh(`/repos/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
  if (!res.ok) throw new GitHubError(await ghMessage(res, `GET ${path}`), res.status);
  const body = (await res.json()) as { type?: string; content?: string; sha?: string };
  if (Array.isArray(body) || body.type !== "file" || !body.content || !body.sha) {
    throw new GitHubError(`${path} is not a regular file on ${branch}`, 422);
  }
  return { content: Buffer.from(body.content, "base64").toString("utf-8"), sha: body.sha, path };
}

export async function putFile(
  which: Which,
  content: string,
  sha: string,
  message: string,
): Promise<{ fileSha: string; commitSha: string; commitUrl: string }> {
  const { repo, branch, paths } = repoConfig();
  const path = paths[which];
  const res = await gh(`/repos/${repo}/contents/${encodePath(path)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf-8").toString("base64"),
      sha,
      branch,
    }),
  });
  if (!res.ok) {
    const msg = await ghMessage(res, `PUT ${path}`);
    // 409, or 422 mentioning the sha, means our blob sha is no longer HEAD's —
    // someone else committed since the client loaded. Caller tells the user to reload.
    const stale = res.status === 409 || (res.status === 422 && /sha/i.test(msg));
    throw new GitHubError(msg, stale ? 409 : res.status, stale);
  }
  const body = (await res.json()) as {
    content?: { sha?: string };
    commit?: { sha?: string; html_url?: string };
  };
  if (!body.content?.sha || !body.commit?.sha) throw new GitHubError("PUT returned an unexpected shape", 502);
  return { fileSha: body.content.sha, commitSha: body.commit.sha, commitUrl: body.commit.html_url ?? "" };
}

export type RunStatus = {
  found: boolean;
  runCount: number;
  status?: string; // queued | in_progress | completed | waiting | requested | pending
  conclusion?: string | null; // success | failure | cancelled | ...
  htmlUrl?: string;
  workflowName?: string;
};

/**
 * Workflow runs whose head commit is `headSha`. When several workflows fire on
 * the same push, prefer the render one by name/path heuristics, else the first.
 */
export async function runForSha(headSha: string): Promise<RunStatus> {
  const { repo } = repoConfig();
  const res = await gh(`/repos/${repo}/actions/runs?head_sha=${encodeURIComponent(headSha)}&per_page=20`);
  if (!res.ok) throw new GitHubError(await ghMessage(res, "GET actions/runs"), res.status);
  const body = (await res.json()) as {
    workflow_runs?: Array<{ name?: string; path?: string; status?: string; conclusion?: string | null; html_url?: string }>;
  };
  const runs = body.workflow_runs ?? [];
  if (runs.length === 0) return { found: false, runCount: 0 };
  const pick = runs.find((r) => /render|resume|cv/i.test(`${r.name ?? ""} ${r.path ?? ""}`)) ?? runs[0];
  return {
    found: true,
    runCount: runs.length,
    status: pick.status ?? "queued",
    conclusion: pick.conclusion ?? null,
    htmlUrl: pick.html_url,
    workflowName: pick.name,
  };
}
