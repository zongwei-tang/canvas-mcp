// More student-side tools: a generic page reader, assignment info, regrade requests, group members, account, enrollment.
//
// Write endpoints, from Gradescope's own frontend (2026-11):
//   POST  <regrade_requests_path>                 regrade_request[student_comment], regrade_request[question_submission_id]
//   PATCH <regrade_requests_path>/<id>            same fields, edits an existing request
//   POST  <many_ownerships_path>                  user_ids[]=...  (add group members)
//   DELETE <ownerships_path>/<ownership id>       remove a group member
//   POST  /student_memberships                    student_membership[course_entry_code]  (enroll with an entry code)
//   POST  <assignment post url>                   submission[method]=github, submission[repository]=<GitHub repo id>,
//                                                 submission[uid], submission[revision]=<branch>  (submit from GitHub)
import * as cheerio from "cheerio";
import { Buffer } from "node:buffer";
import {
  csrfFrom,
  ensureSession,
  findAssignment,
  flashMessages,
  forgetAssignmentsCache,
  getPage,
  gsFetch,
  submissionIdFrom,
} from "./gs-submit.js";
import { downloadBinary, resolveSubmissionId, submissionJson, type SubmissionRef } from "./gs-student.js";

const BASE = "https://www.gradescope.com";
const HOST = new URL(BASE).host;

const XHR = (csrf: string, referer: string) => ({
  "X-CSRF-Token": csrf,
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Referer: referer,
});

// Strip data a page carries that should not flow into the model: the class roster and any tokens.
function sanitize(v: any, depth = 0): any {
  if (depth > 40) return "[…]";
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "course_members") out.course_members_count = Array.isArray(x) ? x.length : null;
      else if (/token|password|secret|session_key/i.test(k)) out[k] = "[removed]";
      else out[k] = sanitize(x, depth + 1);
    }
    return out;
  }
  return v;
}

// ---------------- generic page reader ----------------

// GET requests to these paths change state (log out, start OAuth, unlink accounts) and must never be followed.
const BLOCKED_PATH = /^\/(logout|login|signup|auth\b|auth\/|identities|github_authentication|bitbucket_authentication|gitlab|saml|sso|password|reset_password|users\/password)/i;

function checkPath(raw: string) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    throw new Error('path must be a Gradescope path starting with a single "/", e.g. /courses/123 (no scheme or host).');
  }
  const url = new URL(raw, BASE);
  if (url.host !== HOST) throw new Error("Only www.gradescope.com pages can be read.");
  if (BLOCKED_PATH.test(url.pathname) || /logout/i.test(url.pathname)) {
    throw new Error(`Refusing to open ${url.pathname}: that page changes the session or account (log out, sign-in, linked accounts).`);
  }
  return url.pathname + url.search;
}

function pageText($: cheerio.CheerioAPI, root: any) {
  const el = root.clone();
  el.find("script, style, noscript, svg, template, [aria-hidden='true'], .js-dropzonePreviewTemplate").remove();
  el.find("br").replaceWith("\n");
  el.find("p, div, li, tr, h1, h2, h3, h4, h5, h6, section, header, footer, table, dt, dd, label").each((_: number, e: any) => {
    $(e).append("\n");
  });
  el.find("td, th").each((_: number, e: any) => {
    $(e).append(" | ");
  });
  return el
    .text()
    .split("\n")
    .map((l: string) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export async function readPage(
  gs: any,
  args: { path: string; component?: string; include_props?: boolean; max_chars?: number },
) {
  await ensureSession(gs);
  const maxChars = Math.min(Math.max(args.max_chars ?? 60_000, 2_000), 200_000);
  let path = checkPath(args.path);
  let res: Response | null = null;
  const redirects: string[] = [];
  for (let hop = 0; hop < 5; hop++) {
    res = await gsFetch(gs, path, { headers: { Accept: path.includes(".json") ? "application/json" : "text/html,application/json" } });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers.get("location") || "";
    await res.body?.cancel();
    const next = new URL(loc, BASE);
    if (next.host !== HOST) return { path, status: res.status, redirected_off_site_to: next.origin, note: "The page redirects outside Gradescope; not followed." };
    path = checkPath(next.pathname + next.search);
    redirects.push(path);
  }
  const ct = res!.headers.get("content-type") || "";
  const base = { path, status: res!.status, ...(redirects.length ? { redirected_to: path } : {}) };

  if (/json/.test(ct)) {
    const data = sanitize(await res!.json().catch(() => null));
    let s = JSON.stringify(data);
    const truncated = s.length > maxChars;
    if (truncated) s = s.slice(0, maxChars);
    return { ...base, content_type: "json", ...(truncated ? { truncated: true, json_text: s } : { json: data }) };
  }
  if (!/html/.test(ct)) {
    const bytes = (await res!.arrayBuffer()).byteLength;
    return { ...base, content_type: ct, bytes, note: "Not a web page; use download_gradescope_submission_files for submission files." };
  }

  const $ = cheerio.load(await res!.text());
  $('meta[name="csrf-token"], meta[name="csrf-param"]').remove();
  const components = $("[data-react-class]")
    .map((_, e) => {
      const name = $(e).attr("data-react-class") || "";
      if (name === "SessionTimeoutManager") return null;
      if (args.component && name !== args.component) return null;
      let props: any = null;
      try {
        props = sanitize(JSON.parse($(e).attr("data-react-props") || "null"));
      } catch {}
      return { component: name, props };
    })
    .get()
    .filter(Boolean);
  const forms = $("form")
    .map((_, f) => ({
      method: ($(f).find('input[name="_method"]').attr("value") || $(f).attr("method") || "get").toUpperCase(),
      action: $(f).attr("action") || null,
      fields: [...new Set($(f).find("input, select, textarea").map((_, i) => $(i).attr("name")).get().filter((n) => n && n !== "authenticity_token" && n !== "utf8"))],
    }))
    .get();
  const links: { text: string; href: string }[] = [];
  const seen = new Set<string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href")!;
    if (!/^\/(?!\/)/.test(href) && !href.startsWith(BASE)) return;
    if (seen.has(href) || /logout/i.test(href)) return;
    seen.add(href);
    links.push({ text: $(a).text().trim().replace(/\s+/g, " ").slice(0, 80), href });
  });
  const root = $("main").length ? $("main").first() : $("body");
  let text = pageText($, root);

  const out: any = {
    ...base,
    title: $("title").text().trim(),
    text,
    links: links.slice(0, 150),
    forms,
    ...(args.include_props === false ? { components: components.map((c: any) => c.component) } : { components }),
  };
  let size = JSON.stringify(out).length;
  if (size > maxChars) {
    // Trim the biggest parts first: component props, then text.
    if (args.include_props !== false && components.length) {
      out.components = components.map((c: any) => {
        const s = JSON.stringify(c.props);
        return s.length > maxChars / 2 ? { component: c.component, props_truncated: s.slice(0, Math.floor(maxChars / 2)) } : c;
      });
      size = JSON.stringify(out).length;
    }
    if (size > maxChars) {
      out.text = text.slice(0, Math.max(1000, text.length - (size - maxChars)));
      out.truncated = true;
    }
  }
  return out;
}

// ---------------- assignment info ----------------

export async function assignmentInfo(gs: any, args: { course_id: string; assignment_id: string }) {
  await ensureSession(gs);
  const { course_id, assignment_id } = args;
  const $ = await getPage(gs, `/courses/${course_id}`);
  const btn = $(`.js-submitAssignment[data-assignment-id="${assignment_id}"]`).first();
  const fromButton = btn.length
    ? {
        title: btn.attr("data-assignment-title") || null,
        submission_format: btn.attr("data-submission-format") || null,
        ready_for_submission: btn.attr("data-ready-for-submission") !== "false",
        late_submission_warning: btn.attr("data-show-late-submission-warning") === "true",
        leaderboard_enabled: btn.attr("data-leaderboard-enabled") === "true",
        submission_methods: (() => {
          const raw = btn.attr("data-submission-methods");
          try {
            return raw ? JSON.parse(raw) : null;
          } catch {
            return raw || null;
          }
        })(),
        template_url: btn.attr("data-template-url") || null,
      }
    : null;

  const all = await gs.getGradescopeAssignments(course_id);
  const row = (all || []).find((a: any) => String(a.assignment_id) === String(assignment_id)) || null;

  let submissionId: string | null = null;
  try {
    submissionId = await resolveSubmissionId(gs, { course_id, assignment_id });
  } catch {}
  let fromSubmission: any = null;
  if (submissionId) {
    const { data } = await submissionJson(gs, { course_id, assignment_id, submission_id: submissionId }, ["assignment", "assignment_submission"]);
    const a = data.assignment || {};
    fromSubmission = {
      title: a.title,
      submission_format: a.submission_format,
      total_points: a.total_points != null ? Number(a.total_points) : null,
      // Gradescope gives this one as wall-clock time in the course's timezone, without an offset.
      due_date_course_local: a.due_date || null,
      submission_allowed: a.submission_allowed ?? null,
      resubmit_allowed: a.resubmit_allowed ?? null,
      late_submission_warning: a.show_late_submission_warning ?? null,
      group_size: a.group_size ?? null,
      group_members_updatable: a.group_members_updatable ?? null,
      time_limit_minutes: a.time_limit_in_minutes ?? null,
      time_remaining_minutes: a.time_remaining_in_minutes ?? null,
      regrade_requests_open: a.regrade_requests_open ?? null,
      regrade_request_window: { start: a.regrade_request_start || null, end: a.regrade_request_end || null },
      leaderboard_enabled: a.leaderboard_enabled ?? null,
      submission_methods: a.enabled_submission_methods || null,
      template_url: a.template_url || null,
      show_answers: a.show_answers ?? null,
      course_timezone: a.timezone?.identifier || null,
    };
  }
  if (!fromButton && !fromSubmission && !row) {
    throw new Error(`Assignment ${assignment_id} was not found in course ${course_id}.`);
  }
  return {
    course_id,
    assignment_id,
    ...(row ? { name: row.name, release_date: row.release_date, due_date: row.due_date, late_due_date: row.late_due_date, status: row.submissions_status, grade: row.grade, max_grade: row.max_grade } : {}),
    open_for_submission: !!fromButton,
    has_submission: !!submissionId,
    submission_id: submissionId,
    ...(fromButton || {}),
    ...(fromSubmission || {}),
    url: `${BASE}/courses/${course_id}/assignments/${assignment_id}`,
  };
}

// ---------------- regrade requests ----------------

export async function listRegradeRequests(gs: any, args: { course_id: string }) {
  await ensureSession(gs);
  const $ = await getPage(gs, `/courses/${args.course_id}/regrade_requests`);
  const table = $("table").first();
  const headers = table.find("thead th").map((_, th) => $(th).text().trim().toLowerCase().replace(/\s+/g, "_")).get();
  const requests = table
    .find("tbody tr")
    .map((_, tr) => {
      const cells = $(tr).find("td, th");
      if (cells.length < 2) return null;
      const row: Record<string, any> = {};
      cells.each((i, td) => {
        row[headers[i] || `col${i}`] = $(td).text().trim().replace(/\s+/g, " ");
      });
      const link = $(tr).find("a[href]").first().attr("href");
      if (link) row.url = link.startsWith("http") ? link : BASE + link;
      return row;
    })
    .get()
    .filter(Boolean);
  return { course_id: args.course_id, count: requests.length, requests };
}

const questionKey = (s: string) => String(s).trim().replace(/^q(?:uestion)?\s*/i, "");

export async function requestRegrade(
  gs: any,
  args: SubmissionRef & { question: string; comment: string; update_existing?: boolean; dry_run?: boolean },
) {
  if (!args.comment || !args.comment.trim()) throw new Error("comment is required: explain to the grader why the question should be regraded.");
  const { submissionId, path, data: d } = await submissionJson(gs, args);
  const a = d.assignment || {};
  if (!a.regrade_requests_open) throw new Error(`Regrade requests are not open for "${a.title}".`);
  const now = Date.now();
  if (a.regrade_request_start && new Date(a.regrade_request_start).getTime() > now) throw new Error(`Regrade requests open at ${a.regrade_request_start}.`);
  if (a.regrade_request_end && new Date(a.regrade_request_end).getTime() < now) throw new Error(`Regrade requests closed at ${a.regrade_request_end}.`);

  const questions: any[] = d.questions || [];
  const key = questionKey(args.question);
  const q =
    questions.find((x) => String(x.full_index) === key) ||
    questions.find((x) => (x.title || "").toLowerCase() === String(args.question).trim().toLowerCase());
  const qsub = q && (d.question_submissions || []).find((s: any) => s.question_id === q.id);
  if (!q || !qsub) {
    const valid = (d.question_submissions || [])
      .map((s: any) => questions.find((x) => x.id === s.question_id))
      .filter(Boolean)
      .map((x: any) => `${x.full_index} (${x.title})`);
    throw new Error(`Question "${args.question}" not found in this submission. Valid questions: ${valid.join("; ")}`);
  }
  const existing = (d.regrade_requests || [])
    .filter((r: any) => r.question_submission_id === qsub.id)
    .sort((x: any, y: any) => new Date(y.created_at || 0).getTime() - new Date(x.created_at || 0).getTime())[0];
  const flat = (r: any) => Object.fromEntries(Object.entries(r).filter(([, v]) => v === null || typeof v !== "object"));
  if (existing && !args.update_existing) {
    return { already_requested: true, question: q.full_index, existing_request: flat(existing), note: "Pass update_existing: true to replace the comment on this request." };
  }

  const url = existing ? `${d.paths.regrade_requests_path}/${existing.id}` : d.paths.regrade_requests_path;
  const method = existing ? "PATCH" : "POST";
  const summary = { assignment: a.title, question: q.full_index, question_title: q.title, current_score: qsub.score != null ? Number(qsub.score) : null, action: existing ? "update existing request" : "create request" };
  if (args.dry_run) return { dry_run: true, would_send: `${method} ${url}`, ...summary, comment: args.comment };

  const $ = await getPage(gs, path);
  const body = new URLSearchParams({ "regrade_request[student_comment]": args.comment, "regrade_request[question_submission_id]": String(qsub.id) });
  const res = await gsFetch(gs, url, { method, body, headers: XHR(csrfFrom($), BASE + path) });
  const textBody = await res.text();
  if (res.status === 403) throw new Error("Gradescope refused the regrade request (403): requests may be closed for this question.");
  if (!res.ok) throw new Error(`Regrade request failed: HTTP ${res.status} ${textBody.slice(0, 200)}`);
  const after = await submissionJson(gs, { ...args, submission_id: submissionId }, ["regrade_requests"]);
  const saved = (after.data.regrade_requests || []).find((r: any) => r.question_submission_id === qsub.id);
  return { submitted: !!saved, ...summary, request: saved ? flat(saved) : null, url: BASE + path };
}

// ---------------- group members ----------------

async function groupState(gs: any, ref: SubmissionRef) {
  const r = await submissionJson(gs, ref, ["assignment", "ownerships", "course_members", "current_user", "paths"]);
  const d = r.data;
  const roster = new Map<number, any>((d.course_members || []).map((m: any) => [m.id, m]));
  const members = (d.ownerships || []).map((o: any) => {
    const m = roster.get(o.user_id) || {};
    return { name: m.name || null, email: m.email || null, user_id: o.user_id, ownership_id: o.id, active: !!o.active, uploader: !!o.uploader, is_you: o.user_id === d.current_user?.id };
  });
  return { ...r, members, roster, currentUserId: d.current_user?.id };
}

export async function groupMembers(gs: any, args: SubmissionRef) {
  const { submissionId, data: d, members } = await groupState(gs, args);
  const a = d.assignment || {};
  return {
    assignment: a.title,
    submission_id: submissionId,
    group_size_limit: a.group_size ?? null,
    members_updatable: !!a.group_members_updatable,
    members,
  };
}

export async function updateGroupMembers(
  gs: any,
  args: SubmissionRef & { add_emails?: string[]; remove_emails?: string[]; dry_run?: boolean },
) {
  const add = (args.add_emails || []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const remove = (args.remove_emails || []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!add.length && !remove.length) throw new Error("Pass add_emails and/or remove_emails.");
  const { submissionId, path, data: d, members, roster, currentUserId } = await groupState(gs, args);
  const a = d.assignment || {};
  if (!a.group_members_updatable) throw new Error(`Group members cannot be changed for "${a.title}".`);

  // Exact email match only: adding the wrong classmate shares your submission with them.
  const byEmail = new Map<string, any>();
  for (const m of roster.values()) if (m.email) byEmail.set(String(m.email).toLowerCase(), m);
  const toAdd: any[] = [];
  const skipped: string[] = [];
  const notFound: string[] = [];
  for (const e of add) {
    const m = byEmail.get(e);
    if (!m) notFound.push(e);
    else if (members.some((x: any) => x.user_id === m.id)) skipped.push(`${e} (already in the group)`);
    else toAdd.push(m);
  }
  if (notFound.length) throw new Error(`No student in this course has the email: ${notFound.join(", ")}. Emails must match exactly.`);

  const toRemove: any[] = [];
  for (const e of remove) {
    const m = members.find((x: any) => (x.email || "").toLowerCase() === e);
    if (!m) skipped.push(`${e} (not in the group)`);
    else if (m.is_you) throw new Error("Refusing to remove yourself: you would lose access to this submission. Do it on the Gradescope website if you mean it.");
    else if (m.uploader) throw new Error(`Refusing to remove ${e}: they uploaded the submission.`);
    else toRemove.push(m);
  }
  const finalCount = members.length + toAdd.length - toRemove.length;
  if (a.group_size && finalCount > Number(a.group_size)) throw new Error(`The group would have ${finalCount} members; the limit is ${a.group_size}.`);

  const plan = {
    assignment: a.title,
    add: toAdd.map((m) => ({ name: m.name, email: m.email })),
    remove: toRemove.map((m) => ({ name: m.name, email: m.email })),
    ...(skipped.length ? { skipped } : {}),
    resulting_group_size: finalCount,
  };
  if (args.dry_run || (!toAdd.length && !toRemove.length)) return { dry_run: !!args.dry_run, ...plan };

  const $ = await getPage(gs, path);
  const headers = XHR(csrfFrom($), BASE + path);
  if (toAdd.length) {
    const body = new URLSearchParams();
    for (const m of toAdd) body.append("user_ids[]", String(m.id));
    const res = await gsFetch(gs, d.paths.many_ownerships_path, { method: "POST", body, headers });
    const t = await res.text();
    if (!res.ok) throw new Error(`Adding group members failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  for (const m of toRemove) {
    const res = await gsFetch(gs, `${d.paths.ownerships_path}/${m.ownership_id}`, { method: "DELETE", headers });
    const t = await res.text();
    if (!res.ok) throw new Error(`Removing ${m.email} failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const after = await groupState(gs, { ...args, submission_id: submissionId });
  return { updated: true, ...plan, members: after.members };
}

// ---------------- account ----------------

export async function accountInfo(gs: any) {
  await ensureSession(gs);
  const $ = await getPage(gs, "/account/edit");
  const form = $('form[action="/account"]').first();
  const linked = $(".linkedAccount--name")
    .map((_, e) => $(e).text().trim().replace(/\s+/g, " "))
    .get();
  // Emails are listed in a table under the "Email Addresses" label; the primary one is starred.
  const emailGroup = form.find(".form--label").filter((_, e) => /email/i.test($(e).text())).first().closest(".form--group");
  const emails = emailGroup
    .find("tr")
    .map((_, tr) => ({ email: $(tr).find("td").first().text().trim(), primary: $(tr).find(".statusIndicator--primaryEmail").length > 0 }))
    .get()
    .filter((e) => e.email.includes("@"));
  return {
    name: form.find('input[name="user[name]"]').attr("value") || null,
    emails,
    student_id: form.find('input[name="user[sid]"]').attr("value") || null,
    locale: form.find('select[name="user[locale]"] option[selected]').attr("value") || null,
    linked_accounts: linked,
    url: `${BASE}/account/edit`,
  };
}

// ---------------- linked GitHub / Bitbucket repositories ----------------
// The code-submission modal's RepositorySelector reads GET /github_repositories?uid=&page=&per_page= ->
// {repositories, uid, uids}, and GET /github_repositories/:id/branches?uid=&page=&per_page= -> [{name, ...}].

async function getJson(gs: any, path: string) {
  const res = await gsFetch(gs, path, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new Error("Gradescope could not reach the linked GitHub/Bitbucket account. Link it under Account Settings > Linked Accounts on the Gradescope website first.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Gradescope returned ${res.status} for ${path.split("?")[0]}`);
  }
  return res.json() as Promise<any>;
}

type Service = "github" | "bitbucket";
const REPO_URL: Record<Service, string> = { github: "/github_repositories", bitbucket: "/bitbucket_projects" };
const SERVICE_NAME: Record<Service, string> = { github: "GitHub", bitbucket: "Bitbucket" };

// GitHub: {repositories, uid, uids}, paginated per linked account (uid).
// Bitbucket: {<uid>: [repos]} in one response; a repo's id and submitted value are its full_name.
export async function linkedRepositories(gs: any, service: Service = "github") {
  await ensureSession(gs);
  const repos: any[] = [];
  if (service === "bitbucket") {
    const r = await getJson(gs, REPO_URL.bitbucket);
    for (const [uid, list] of Object.entries<any>(r || {})) for (const x of list || []) repos.push({ ...x, uid: String(uid), id: x.full_name, pushed_at: x.updated_on });
    return repos;
  }
  const first = await getJson(gs, `${REPO_URL.github}?page=1&per_page=100`);
  const uids: string[] = first.uids?.length ? first.uids.map(String) : [String(first.uid)];
  for (const uid of uids) {
    for (let page = 1; page <= 20; page++) {
      const r = page === 1 && String(first.uid) === uid ? first : await getJson(gs, `${REPO_URL.github}?uid=${encodeURIComponent(uid)}&page=${page}&per_page=100`);
      const batch: any[] = r.repositories || [];
      for (const x of batch) repos.push({ ...x, uid: String(r.uid ?? uid) });
      if (batch.length < 100) break;
    }
  }
  return repos;
}

export async function repositoryBranches(gs: any, repo: { id: number | string; uid: string }, service: Service = "github") {
  const branches: any[] = [];
  if (service === "bitbucket") {
    const b: any[] = await getJson(gs, `${REPO_URL.bitbucket}/${repo.id}/branches?uid=${encodeURIComponent(repo.uid)}`);
    return (Array.isArray(b) ? b : []).map((x) => x.name);
  }
  for (let page = 1; page <= 20; page++) {
    const b: any[] = await getJson(gs, `${REPO_URL.github}/${repo.id}/branches?uid=${encodeURIComponent(repo.uid)}&page=${page}&per_page=100`);
    if (!Array.isArray(b) || b.length === 0) break;
    branches.push(...b);
    if (b.length < 100) break;
  }
  return branches.map((x) => x.name);
}

export async function findRepository(gs: any, fullName: string, service: Service = "github") {
  const want = fullName.trim().replace(/^https?:\/\/(github\.com|bitbucket\.org)\//i, "").replace(/\.git$/i, "").toLowerCase();
  const repos = await linkedRepositories(gs, service);
  const repo = repos.find((r) => String(r.full_name).toLowerCase() === want);
  if (!repo) {
    throw new Error(`${SERVICE_NAME[service]} repository "${fullName}" is not visible to Gradescope. Use list_gradescope_repositories to see the ones it can access.`);
  }
  return repo;
}

export async function listRepositories(gs: any, args: { service?: Service; repository?: string; query?: string }) {
  const service = args.service || "github";
  if (args.repository) {
    const repo = await findRepository(gs, args.repository, service);
    return { service, repository: repo.full_name, private: !!(repo.private ?? repo.is_private), default_branch: repo.default_branch || repo.mainbranch?.name || null, branches: await repositoryBranches(gs, repo, service) };
  }
  const q = (args.query || "").toLowerCase();
  const repos = (await linkedRepositories(gs, service))
    .filter((r) => !q || String(r.full_name).toLowerCase().includes(q))
    .sort((a, b) => new Date(b.pushed_at || 0).getTime() - new Date(a.pushed_at || 0).getTime())
    .map((r) => ({ repository: r.full_name, private: !!(r.private ?? r.is_private), default_branch: r.default_branch || r.mainbranch?.name || null, last_pushed: r.pushed_at || null }));
  return { service, count: repos.length, repositories: repos.slice(0, 200) };
}

// Submit a code assignment straight from a linked GitHub or Bitbucket repository and branch, like the website does.
export async function submitFromRepository(
  gs: any,
  args: { course_id: string; assignment_id: string; repository: { name: string; branch?: string; service?: Service }; leaderboard_name?: string; dry_run?: boolean },
) {
  const { course_id, assignment_id } = args;
  const service: Service = args.repository.service || "github";
  const { info, csrf, referer } = await findAssignment(gs, course_id, assignment_id);
  if (info.format !== "code") throw new Error(`"${info.title}" is not a code assignment; repository submission only works for code assignments.`);
  const repo = await findRepository(gs, args.repository.name, service);
  const branches = await repositoryBranches(gs, repo, service);
  const branch = args.repository.branch || repo.default_branch || repo.mainbranch?.name;
  if (!branch || !branches.includes(branch)) {
    throw new Error(`Branch "${branch}" not found in ${repo.full_name}. Branches: ${branches.slice(0, 30).join(", ")}`);
  }
  const summary = { assignment: info.title, kind: service, repository: repo.full_name, branch, late_submission: info.showLateWarning };
  if (args.dry_run) return { dry_run: true, would_post_to: info.postUrl, ...summary };

  const body = new URLSearchParams({
    utf8: "✓",
    authenticity_token: csrf,
    "submission[method]": service,
    // GitHub sends the numeric repository id; Bitbucket sends the full name.
    "submission[repository]": String(repo.id),
    "submission[uid]": String(repo.uid),
    "submission[revision]": branch,
  });
  if (args.leaderboard_name) body.append("submission[leaderboard_name]", args.leaderboard_name);
  const res = await gsFetch(gs, info.postUrl, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: referer } });
  forgetAssignmentsCache(gs, course_id);
  const location = res.headers.get("location") || "";
  const submissionId = submissionIdFrom(location);
  if (!submissionId) {
    let reasons: string[] = [];
    try {
      reasons = flashMessages(location ? await getPage(gs, location) : cheerio.load(await res.text()));
    } catch {}
    throw new Error(`Gradescope did not accept the ${SERVICE_NAME[service]} submission (HTTP ${res.status}). ${reasons.join(" ") || "No reason given."}`);
  }
  await res.body?.cancel();
  return {
    submitted: true,
    submission_id: submissionId,
    submission_url: `${BASE}/courses/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`,
    ...summary,
    next_step: "The autograder runs next; call get_gradescope_autograder_results with wait_seconds to see the results.",
  };
}

// ---------------- grades overview ----------------
// Every assignment's score across courses, plus a compact snapshot. Passing an earlier snapshot back
// reports what changed since then (new grades, changed scores, new submissions), since the server keeps no state.

// Unsubmitted assignments without a submit button have no ID on the course page; key those by name.
const snapKey = (courseId: any, a: { assignment_id?: any; name?: string }) => `${courseId}:${a.assignment_id || `name=${a.name}`}`;

export async function gradesOverview(gs: any, args: { course_ids?: string[]; include_inactive_courses?: boolean; previous_snapshot?: string }) {
  await ensureSession(gs);
  const all = await gs.getGradescopeCourses();
  if (!all) throw new Error("Could not read the Gradescope course list.");
  let courses: any[] = Object.values(all.student || {});
  if (args.course_ids?.length) courses = courses.filter((c) => args.course_ids!.includes(String(c.id)));
  else if (!args.include_inactive_courses && courses.some((c) => c.active)) courses = courses.filter((c) => c.active);

  const out: any[] = [];
  const snap: Record<string, [number | null, string | null]> = {};
  const failed: string[] = [];
  for (const c of courses) {
    const list = await gs.getGradescopeAssignments(String(c.id));
    if (!list) {
      failed.push(c.name);
      continue;
    }
    let earned = 0;
    let possible = 0;
    const rows = list.map((a: any) => {
      if (a.grade != null && a.max_grade != null) {
        earned += Number(a.grade);
        possible += Number(a.max_grade);
      }
      snap[snapKey(c.id, a)] = [a.grade ?? null, a.submissions_status ?? null];
      return { assignment: a.name, assignment_id: a.assignment_id, score: a.grade, max: a.max_grade, status: a.submissions_status, due_date: a.due_date };
    });
    out.push({ course: c.name, course_id: String(c.id), term: `${c.semester} ${c.year}`, graded_points: { earned: Math.round(earned * 100) / 100, possible: Math.round(possible * 100) / 100 }, assignments: rows });
  }

  let changes: any[] | undefined;
  if (args.previous_snapshot) {
    let prev: Record<string, [number | null, string | null]> = {};
    try {
      prev = JSON.parse(Buffer.from(args.previous_snapshot, "base64").toString("utf8"));
    } catch {
      throw new Error("previous_snapshot is not a snapshot returned by this tool.");
    }
    changes = [];
    const name = new Map<string, any>();
    for (const c of out) for (const a of c.assignments) name.set(snapKey(c.course_id, { assignment_id: a.assignment_id, name: a.assignment }), { course: c.course, assignment: a.assignment });
    for (const [k, [grade, status]] of Object.entries(snap)) {
      const before = prev[k];
      const label = name.get(k);
      if (!before) changes.push({ ...label, change: "new assignment", score: grade, status });
      else if (before[0] !== grade) changes.push({ ...label, change: before[0] == null ? "newly graded" : "score changed", before: before[0], score: grade });
      else if (before[1] !== status) changes.push({ ...label, change: "status changed", before: before[1], status });
    }
  }
  return {
    courses: out,
    ...(failed.length ? { courses_failed: failed } : {}),
    ...(changes ? { changes_since_snapshot: changes } : {}),
    snapshot: Buffer.from(JSON.stringify(snap)).toString("base64"),
    snapshot_note: "Pass snapshot back later as previous_snapshot to see what changed.",
  };
}

// ---------------- enroll ----------------

export async function enrollInCourse(gs: any, args: { entry_code: string; dry_run?: boolean }) {
  const code = String(args.entry_code || "").trim();
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) throw new Error("entry_code should be the short code from the instructor, e.g. 6 letters and digits.");
  await ensureSession(gs);
  if (args.dry_run) return { dry_run: true, would_post_to: "/student_memberships", entry_code: code, note: "A dry run cannot check whether the code is valid; only a real enrollment can." };
  const $ = await getPage(gs, "/account");
  const token = $('form[action="/student_memberships"] input[name="authenticity_token"]').attr("value") || csrfFrom($);
  const res = await gsFetch(gs, "/student_memberships", {
    method: "POST",
    body: new URLSearchParams({ utf8: "✓", authenticity_token: token, "student_membership[course_entry_code]": code }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/account` },
  });
  const loc = res.headers.get("location") || "";
  const html = await res.text();
  gs.config?.cache?.storage?.delete?.("gradescope_courses");
  const courseId = loc.match(/\/courses\/(\d+)/)?.[1];
  if (!courseId) {
    const reasons = flashMessages(cheerio.load(html));
    let followed: string[] = [];
    if (loc) {
      try {
        followed = flashMessages(await getPage(gs, loc));
      } catch {}
    }
    throw new Error(`Enrollment did not go through (HTTP ${res.status}). ${[...reasons, ...followed].join(" ") || "Check the entry code."}`);
  }
  const courses = await gs.getGradescopeCourses();
  const course = courses && Object.values<any>({ ...courses.student, ...courses.instructor }).find((c) => String(c.id) === courseId);
  return { enrolled: true, course_id: courseId, course: course ? { name: course.name, full_name: course.full_name, term: `${course.semester} ${course.year}` } : null, url: `${BASE}/courses/${courseId}` };
}

// ---------------- assignment template ----------------
// The blank template the instructor attached (often the problem set itself), as a file attachment.

export async function assignmentTemplate(gs: any, templateUrl: string) {
  const { bytes, mimeType } = await downloadBinary(gs, templateUrl);
  if (bytes.length > 10 * 1024 * 1024) throw new Error(`The template is ${bytes.length} bytes, over the 10 MB attachment limit; use template_url instead.`);
  const looksPdf = new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-");
  return { uri: templateUrl.split("?")[0], mimeType: looksPdf ? "application/pdf" : mimeType || "application/octet-stream", blob: Buffer.from(bytes).toString("base64"), bytes: bytes.length };
}

// ---------------- SSH public key ----------------
// Autograder SSH debugging needs a public key on the account: POST /public_keys with public_key[contents].

const PUBLIC_KEY = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;

export async function addSshPublicKey(gs: any, args: { public_key: string; dry_run?: boolean }) {
  const key = String(args.public_key || "").trim();
  if (/PRIVATE KEY/.test(key)) {
    throw new Error("That is a PRIVATE key. Never share it. Pass the public key instead: the one-line contents of the .pub file (starts with ssh-ed25519 or ssh-rsa).");
  }
  if (!PUBLIC_KEY.test(key)) throw new Error("public_key should be one line like: ssh-ed25519 AAAA... comment");
  await ensureSession(gs);
  const [type, , comment] = key.split(" ");
  const summary = { key_type: type, comment: comment || null, fingerprint_hint: key.split(" ")[1].slice(-12) };
  if (args.dry_run) return { dry_run: true, would_post_to: "/public_keys", ...summary };
  const $ = await getPage(gs, "/public_keys/new");
  const token = $('form[action="/public_keys"] input[name="authenticity_token"]').attr("value") || csrfFrom($);
  const res = await gsFetch(gs, "/public_keys", {
    method: "POST",
    body: new URLSearchParams({ utf8: "✓", authenticity_token: token, "public_key[contents]": key }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/public_keys/new` },
  });
  const loc = res.headers.get("location") || "";
  const html = await res.text();
  if (res.status >= 300 && res.status < 400 && !/\/public_keys\/new/.test(loc)) {
    return { added: true, ...summary, next_step: 'Use gradescope_autograder_ssh with action "start" on a code submission.' };
  }
  const reasons = flashMessages(cheerio.load(html));
  throw new Error(`Gradescope did not accept the key (HTTP ${res.status}). ${reasons.join(" ") || "It may already be on the account, or be malformed."}`);
}

// ---------------- search assignments across courses ----------------

export async function searchAssignments(gs: any, args: { query: string; include_inactive_courses?: boolean }) {
  const q = String(args.query || "").trim().toLowerCase();
  if (!q) throw new Error("query is required.");
  await ensureSession(gs);
  const all = await gs.getGradescopeCourses();
  if (!all) throw new Error("Could not read the Gradescope course list.");
  let courses: any[] = [...Object.values<any>(all.student || {}), ...Object.values<any>(all.instructor || {})];
  if (!args.include_inactive_courses && courses.some((c) => c.active)) courses = courses.filter((c) => c.active);
  const hits: any[] = [];
  for (const c of courses) {
    const list = await gs.getGradescopeAssignments(String(c.id));
    for (const a of list || []) {
      if (!String(a.name || "").toLowerCase().includes(q)) continue;
      hits.push({ course: c.name, course_id: String(c.id), assignment: a.name, assignment_id: a.assignment_id || null, due_date: a.due_date, status: a.submissions_status, score: a.grade, max: a.max_grade });
    }
  }
  return { query: args.query, courses_searched: courses.length, count: hits.length, matches: hits };
}

// ---------------- deadlines as a calendar file ----------------

const icsEscape = (s: string) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
const icsTime = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
// Lines longer than 75 octets are folded, as RFC 5545 requires.
const fold = (line: string) => line.match(/.{1,73}/g)!.join("\r\n ");

export async function deadlinesCalendar(
  gs: any,
  args: { days?: number; include_submitted?: boolean; include_inactive_courses?: boolean; course_ids?: string[]; reminder_minutes?: number },
) {
  const { upcomingDeadlines } = await import("./gs-student.js");
  const res: any = await upcomingDeadlines(gs, { days: args.days ?? 60, include_submitted: args.include_submitted ?? true, include_inactive_courses: args.include_inactive_courses, course_ids: args.course_ids });
  const items = [...res.deadlines, ...(res.past_due_late_submission_still_open || [])];
  const stamp = icsTime(new Date());
  const alarm = args.reminder_minutes ?? 24 * 60;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//gradescope-mcp//deadlines//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Gradescope deadlines"];
  for (const d of items) {
    const due = new Date(d.only_late_window_open ? d.late_due_date : d.due_date);
    const start = new Date(due.getTime() - 30 * 60 * 1000);
    const title = `${d.course}: ${d.assignment}${d.only_late_window_open ? " (late deadline)" : ""}${d.submitted ? " ✓" : ""}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:gradescope-${d.course_id}-${d.assignment_id || icsEscape(d.assignment)}-${d.only_late_window_open ? "late" : "due"}@gradescope-mcp`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(due)}`,
      fold(`SUMMARY:${icsEscape(title)}`),
      ...(d.url ? [fold(`URL:${d.url}`)] : []),
      fold(`DESCRIPTION:${icsEscape(`Due ${due.toISOString()}${d.late_due_date ? `; late deadline ${d.late_due_date}` : ""}. Status: ${d.status ?? "unknown"}.`)}`),
      ...(alarm > 0 ? ["BEGIN:VALARM", "ACTION:DISPLAY", fold(`DESCRIPTION:${icsEscape(title)}`), `TRIGGER:-PT${Math.round(alarm)}M`, "END:VALARM"] : []),
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return { events: items.length, window_days: res.window_days, ics: lines.join("\r\n") + "\r\n", note: "Save ics as a .ics file and open it, or import it into Google Calendar / Apple Calendar." };
}
