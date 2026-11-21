// Read-only regression check for the Gradescope MCP server, against a real account.
//
//   bun local-mcp/test-readonly.ts
//
// Reads GRADESCOPE_EMAIL / GRADESCOPE_PASSWORD from local-mcp/credentials.env (gitignored). It calls every
// read tool, and the write tools only with dry_run, using IDs it discovers from the account. It prints
// pass/fail per tool and never prints grades, file contents or page images. Exits 1 if anything fails.
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url).pathname;
for (const line of readFileSync(`${here}credentials.env`, "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[m[1]] = v;
}
if (!process.env.GRADESCOPE_EMAIL || !process.env.GRADESCOPE_PASSWORD) {
  console.error("Fill in GRADESCOPE_EMAIL and GRADESCOPE_PASSWORD in local-mcp/credentials.env first.");
  process.exit(2);
}
process.env.SKIP_SERVE = Bun.env.SKIP_SERVE = "1";
process.env.ACCESS_TOKEN = Bun.env.ACCESS_TOKEN = "localtest";
const { handleRequest } = await import("./gs-server.ts");

let id = 0;
async function rpc(method: string, params?: any) {
  const res = await handleRequest(new Request("http://local/localtest/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }));
  return ((await res.json()) as any).result;
}
async function call(name: string, args: any = {}) {
  const r = await rpc("tools/call", { name, arguments: args });
  const first = r?.content?.[0]?.text ?? "";
  if (r?.isError) return { ok: false, error: first };
  try {
    return { ok: true, json: JSON.parse(first), parts: r.content };
  } catch {
    return { ok: false, error: first };
  }
}

const results: { tool: string; ok: boolean; note: string }[] = [];
async function check(tool: string, args: any, expect: (r: any) => string | true, skip?: string) {
  if (skip) return results.push({ tool, ok: true, note: `skipped: ${skip}` });
  const t0 = Date.now();
  const r = await call(tool, args);
  let verdict: string | true = r.ok ? true : `error: ${String(r.error).slice(0, 160)}`;
  if (r.ok) {
    try {
      verdict = expect(r);
    } catch (e) {
      verdict = `check threw: ${(e as Error).message}`;
    }
  }
  results.push({ tool, ok: verdict === true, note: `${verdict === true ? "ok" : verdict} (${Date.now() - t0} ms)` });
  return r;
}

const tools = ((await rpc("tools/list")).tools as any[]).map((t) => t.name);

// Discover IDs from the account.
const courses = await call("get_gradescope_courses");
const active = Object.values<any>(courses.json?.student || {}).filter((c) => c.active);
let course: any = null;
let codeSub: any = null;
let pdfSub: any = null;
let openAssignment: any = null;
for (const c of active) {
  const page = await call("get_gradescope_page", { path: `/courses/${c.id}`, include_props: false });
  const links: string[] = (page.json?.links || []).map((l: any) => l.href).filter((h: string) => /\/assignments\/\d+\/submissions\/\d+$/.test(h));
  for (const l of links) {
    const [, cid, aid, sid] = l.match(/\/courses\/(\d+)\/assignments\/(\d+)\/submissions\/(\d+)/)!;
    if (codeSub && pdfSub) break;
    const info = await call("get_gradescope_assignment_info", { course_id: cid, assignment_id: aid });
    const fmt = info.json?.submission_format;
    if (fmt === "code" && !codeSub) codeSub = { course_id: cid, assignment_id: aid, submission_id: sid };
    if ((fmt === "variable_length" || fmt === "fixed_length") && !pdfSub) pdfSub = { course_id: cid, assignment_id: aid, submission_id: sid };
  }
  course ??= c;
  if (codeSub && pdfSub) break;
}
{
  const due = await call("get_gradescope_upcoming_deadlines", { days: 60 });
  openAssignment = due.json?.deadlines?.[0] || due.json?.past_due_late_submission_still_open?.[0] || null;
}
const C = course ? String(course.id) : "";

await check("get_gradescope_courses", {}, (r) => (Object.keys(r.json.student || {}).length ? true : "no student courses"));
await check("get_gradescope_course_by_name", { course_name: course?.name || "x" }, (r) => (r.json.id || r.json.matches ? true : "no match"), course ? undefined : "no course");
await check("get_gradescope_assignments", { course_id: C }, (r) => (Array.isArray(r.json) ? true : "not a list"), course ? undefined : "no course");
await check("get_gradescope_assignment_by_name", { course_id: C, assignment_name: "a" }, () => true, course ? undefined : "no course");
await check("get_gradescope_assignment_info", codeSub || pdfSub, (r) => (r.json.submission_format ? true : "no format"), codeSub || pdfSub ? undefined : "no submission");
await check("get_gradescope_upcoming_deadlines", {}, (r) => (Array.isArray(r.json.deadlines) ? true : "no deadlines list"));
await check("get_gradescope_grades", {}, (r) => (r.json.snapshot && Array.isArray(r.json.courses) ? true : "missing snapshot"));
await check("get_gradescope_account", {}, (r) => (r.json.name ? true : "no name"));
await check("get_gradescope_regrade_requests", { course_id: C }, (r) => (Array.isArray(r.json.requests) ? true : "no list"), course ? undefined : "no course");
await check("get_gradescope_page", { path: `/courses/${C}` }, (r) => (r.json.title && !JSON.stringify(r.json).includes('"course_members":[') ? true : "missing title or roster leaked"), course ? undefined : "no course");
await check("get_gradescope_page", { path: "/logout" }, () => "should have been refused").then(() => {
  const last = results.pop()!;
  results.push({ tool: "get_gradescope_page (refuses /logout)", ok: last.note.startsWith("error: Error: Refusing"), note: last.note });
});
for (const [label, sub] of [["code", codeSub], ["pdf", pdfSub]] as const) {
  const skip = sub ? undefined : `no ${label} submission found`;
  await check(`get_gradescope_submission [${label}]`.replace(/ \[.*/, ""), sub, (r) => (Array.isArray(r.json.questions) ? true : "no questions"), skip);
  await check("get_gradescope_submission_history", sub, (r) => (r.json.count >= 1 ? true : "empty history"), skip);
  await check("download_gradescope_submission_files", { ...sub, max_chars_per_file: 50 }, (r) => (r.json.files || r.json.pdf ? true : "no files"), skip);
  await check("get_gradescope_group_members", sub, (r) => (Array.isArray(r.json.members) ? true : "no members"), skip);
}
await check("get_gradescope_autograder_results", codeSub, (r) => ("tests" in r.json || r.json.note ? true : "no tests"), codeSub ? undefined : "no code submission");
await check("rerun_gradescope_autograder", { ...codeSub, dry_run: true }, (r) => (r.json.dry_run ? true : "not a dry run"), codeSub ? undefined : "no code submission");
await check("gradescope_autograder_ssh", codeSub, (r) => ("ssh_disabled_reason" in r.json ? true : "no status"), codeSub ? undefined : "no code submission");
await check("get_gradescope_submission_pages", { ...pdfSub, pages: [1], size: "thumbnail" }, (r) => (r.parts.some((p: any) => p.type === "image" && /^image\//.test(p.mimeType)) ? true : "no image returned"), pdfSub ? undefined : "no pdf submission");
await check("match_gradescope_pages", pdfSub, (r) => (Array.isArray(r.json.questions) ? true : "no questions"), pdfSub ? undefined : "no pdf submission");
await check("activate_gradescope_submission", { ...codeSub, dry_run: true }, (r) => (r.json.dry_run || r.json.already_active ? true : "unexpected"), codeSub ? undefined : "no code submission");
await check("update_gradescope_group_members", { ...codeSub, add_emails: ["nobody@example.invalid"], dry_run: true }, () => "should reject an unknown email").then(() => {
  const last = results.pop()!;
  results.push({ tool: "update_gradescope_group_members (rejects unknown email)", ok: /No student|cannot be changed|skipped/.test(last.note), note: last.note });
});
await check("enroll_gradescope_course", { entry_code: "ABC123", dry_run: true }, (r) => (r.json.dry_run ? true : "not a dry run"));
await check("get_gradescope_status", {}, (r) => (r.json.logged_in ? true : `not logged in: ${r.json.error}`));
await check("get_gradescope_feedback_summary", { course_id: C }, (r) => (Array.isArray(r.json.assignments) ? true : "no list"), course ? undefined : "no course");
{
  const pl = await rpc("prompts/list");
  const names = (pl?.prompts || []).map((p: any) => p.name);
  results.push({ tool: "prompts/list", ok: names.length >= 3, note: names.join(", ") || "no prompts" });
}
await check("search_gradescope_assignments", { query: "a" }, (r) => (Array.isArray(r.json.matches) ? true : "no matches list"));
await check("export_gradescope_deadlines_calendar", { days: 30 }, (r) => (/^BEGIN:VCALENDAR/.test(r.json.ics) && /END:VCALENDAR\r\n$/.test(r.json.ics) ? true : "not an iCalendar file"));
await check("add_gradescope_ssh_public_key", { public_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDryRunOnlyNotARealKey000000000000000000 test", dry_run: true }, (r) => (r.json.dry_run ? true : "not a dry run"));
{
  const hist = codeSub ? await call("get_gradescope_submission_history", codeSub) : null;
  const multi = hist?.json?.count >= 2;
  await check("compare_gradescope_submissions", { course_id: codeSub?.course_id, assignment_id: codeSub?.assignment_id, max_chars: 2000 }, (r) => (Array.isArray(r.json.files) ? true : "no files"), multi ? undefined : "code submission has a single version");
}
{
  const info = openAssignment ? await call("get_gradescope_assignment_info", { course_id: openAssignment.course_id, assignment_id: openAssignment.assignment_id }) : null;
  const has = !!info?.json?.template_url;
  await check(
    "get_gradescope_assignment_info (template attachment)",
    { course_id: openAssignment?.course_id, assignment_id: openAssignment?.assignment_id, embed_template: true },
    (r) => (r.parts.some((p: any) => p.type === "resource" && p.resource?.blob) ? true : "no attachment"),
    has ? undefined : "open assignment has no template",
  );
}
await check("list_gradescope_repositories", {}, (r) => (Array.isArray(r.json.repositories) ? true : "no list"));
await check(
  "submit_gradescope_assignment",
  { course_id: openAssignment?.course_id, assignment_id: openAssignment?.assignment_id, files: [{ text: "regression dry run" }], dry_run: true },
  () => true,
  openAssignment ? undefined : "no open assignment",
).then(() => {
  const last = results.pop()!;
  // A text file is valid for code assignments and rejected for PDF ones; either way the tool must answer cleanly.
  results.push({ tool: "submit_gradescope_assignment (dry run)", ok: /^(ok|skipped)/.test(last.note) || last.note.includes("not a PDF"), note: last.note });
});

const covered = new Set(results.map((r) => r.tool.split(" ")[0]));
for (const t of tools) if (!covered.has(t) && t !== "request_gradescope_regrade") results.push({ tool: t, ok: false, note: "not covered by this script" });

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.tool}  ${r.note}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? `, ${failed} failed` : ""}. request_gradescope_regrade is left out: a dry run needs a graded submission with regrades open.`);
process.exit(failed ? 1 : 0);
