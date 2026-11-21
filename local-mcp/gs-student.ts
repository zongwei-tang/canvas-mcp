// Student-side tools: upcoming deadlines, grade details, autograder results, submission history, submission files.
//
// Data sources, from Gradescope's own frontend (2026-11):
//   GET /courses/:c/assignments/:a                       redirects to the active submission when one exists
//   GET .../submissions/:s.json?content=react             AssignmentSubmissionViewer props: questions, question_submissions
//                                                         (score, evaluations, annotations), rubric_items (present = applied),
//                                                         autograder_results, pdf_attachment, paths
//   ... &only_keys[]=past_submissions                     submission history (id, created_at, score, active, activate_path)
//   ... &only_keys[]=text_files&only_keys[]=file_comments code files (content.render holds the text) and line comments
//   POST <activate_path> (form, authenticity_token)       make an older submission the active one
import { csrfFrom, ensureSession, getPage, gsFetch } from "./gs-submit.js";
import { Buffer } from "node:buffer";

const BASE = "https://www.gradescope.com";

// Run async work over items with a small concurrency limit (be gentle with Gradescope).
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

const num = (v: any) => (v === null || v === undefined || v === "" ? null : Number(v));

// ---------------- upcoming deadlines ----------------

const isSubmitted = (status: string | null, grade: number | null) =>
  grade !== null || (!!status && !/no submission|not submitted/i.test(status) && /submitted|graded/i.test(status));

export async function upcomingDeadlines(
  gs: any,
  args: { days?: number; include_submitted?: boolean; include_inactive_courses?: boolean; course_ids?: string[] },
) {
  await ensureSession(gs);
  const days = args.days ?? 14;
  const now = Date.now();
  const horizon = now + days * 24 * 3600 * 1000;

  const all = await gs.getGradescopeCourses();
  if (!all) throw new Error("Could not read the Gradescope course list.");
  let courses: any[] = Object.values(all.student || {});
  if (args.course_ids?.length) {
    courses = courses.filter((c) => args.course_ids!.includes(String(c.id)));
  } else if (!args.include_inactive_courses && courses.some((c) => c.active)) {
    courses = courses.filter((c) => c.active);
  }

  const failed: string[] = [];
  const perCourse = await mapLimit(courses, 4, async (c) => {
    const assignments = await gs.getGradescopeAssignments(String(c.id));
    if (!assignments) {
      failed.push(c.name || String(c.id));
      return [];
    }
    return assignments.map((a: any) => ({ course: c, a }));
  });

  const items: any[] = [];
  const overdue: any[] = [];
  for (const { course, a } of perCourse.flat()) {
    const due = a.due_date ? new Date(a.due_date).getTime() : null;
    const late = a.late_due_date ? new Date(a.late_due_date).getTime() : null;
    const released = !a.release_date || new Date(a.release_date).getTime() <= now;
    if (due === null || !released) continue;
    const submitted = isSubmitted(a.submissions_status, a.grade);
    if (submitted && !args.include_submitted) continue;
    // Upcoming: regular deadline inside the window, or past due but the late deadline is still open.
    const upcoming = due >= now && due <= horizon;
    const lateOpen = due < now && late !== null && late >= now;
    if (!upcoming && !lateOpen) continue;
    const target = upcoming ? due : late!;
    // Past due with a late deadline beyond the window (often the end of term): list separately.
    (lateOpen && late! > horizon ? overdue : items).push({
      course: course.name,
      course_id: String(course.id),
      assignment: a.name,
      assignment_id: a.assignment_id,
      due_date: new Date(due).toISOString(),
      late_due_date: late ? new Date(late).toISOString() : null,
      only_late_window_open: lateOpen,
      hours_left: Math.round(((target - now) / 3600000) * 10) / 10,
      status: a.submissions_status,
      submitted,
      url: a.assignment_id ? `${BASE}/courses/${course.id}/assignments/${a.assignment_id}` : null,
    });
  }
  items.sort((x, y) => x.hours_left - y.hours_left);
  overdue.sort((x, y) => x.hours_left - y.hours_left);
  return {
    now: new Date(now).toISOString(),
    window_days: days,
    courses_checked: courses.map((c) => c.name),
    ...(failed.length ? { courses_failed: failed } : {}),
    deadlines: items,
    ...(overdue.length ? { past_due_late_submission_still_open: overdue } : {}),
  };
}

// ---------------- submission data ----------------

export interface SubmissionRef {
  course_id: string;
  assignment_id: string;
  submission_id?: string;
}

// The assignment page redirects a student who has submitted to their active submission.
export async function resolveSubmissionId(gs: any, ref: SubmissionRef): Promise<string> {
  if (ref.submission_id) return String(ref.submission_id);
  const res = await gsFetch(gs, `/courses/${ref.course_id}/assignments/${ref.assignment_id}`);
  const id = (res.headers.get("location") || "").match(/\/assignments\/\d+\/submissions\/(\d+)/)?.[1];
  await res.body?.cancel();
  if (!id) {
    throw new Error(
      `No submission found for assignment ${ref.assignment_id} in course ${ref.course_id}. It may not have been submitted yet, or the IDs may be wrong.`,
    );
  }
  return id;
}

export async function submissionJson(gs: any, ref: SubmissionRef, onlyKeys: string[] = []) {
  const submissionId = await resolveSubmissionId(gs, ref);
  const path = `/courses/${ref.course_id}/assignments/${ref.assignment_id}/submissions/${submissionId}`;
  const qs = new URLSearchParams({ content: "react" });
  for (const k of onlyKeys) qs.append("only_keys[]", k);
  const res = await gsFetch(gs, `${path}.json?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Gradescope returned ${res.status} for submission ${submissionId}. Check the course, assignment and submission IDs.`);
  }
  return { submissionId, path, data: (await res.json()) as any };
}

function summarizeAutograder(ar: any) {
  if (!ar) return null;
  const tests: any[] = ar.tests || [];
  const failed = tests.filter((t) => t.status === "failed" || (t.max_score != null && Number(t.score) < Number(t.max_score)));
  return { score: num(ar.score), tests: tests.length, failed_tests: failed.length, error_code: ar.error_code || null };
}

// ---------------- grade details ----------------

export async function submissionDetails(gs: any, args: SubmissionRef) {
  const { submissionId, path, data: d } = await submissionJson(gs, args);
  const sub = d.assignment_submission || {};
  const rubricByQuestion = new Map<number, any[]>();
  for (const r of d.rubric_items || []) {
    if (!rubricByQuestion.has(r.question_id)) rubricByQuestion.set(r.question_id, []);
    rubricByQuestion.get(r.question_id)!.push(r);
  }
  const qsById = new Map<number, any>((d.question_submissions || []).map((q: any) => [q.question_id, q]));

  const questions = (d.questions || []).map((q: any) => {
    const qs = qsById.get(q.id) || {};
    const rubric = (rubricByQuestion.get(q.id) || [])
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((r) => ({ description: r.description, points: num(r.weight), applied: !!r.present }));
    const adjustments = (qs.evaluations || [])
      .filter((e: any) => num(e.points) || e.comments)
      .map((e: any) => ({ points: num(e.points), comment: e.comments || null }));
    const annotations = (qs.annotations || [])
      .map((a: any) => ({ page: a.page_number ?? a.page ?? null, text: a.content ?? a.text ?? a.comment ?? null }))
      .filter((a: any) => a.text);
    return {
      question: q.full_index ?? String(q.index ?? ""),
      title: q.title,
      max_points: num(q.weight),
      score: num(qs.score),
      scoring: q.scoring_type || null,
      rubric_items: rubric,
      ...(adjustments.length ? { grader_adjustments: adjustments } : {}),
      ...(annotations.length ? { annotations } : {}),
      // Annotation fields are not confirmed against live data; if none mapped, pass the records through.
      ...(!annotations.length && qs.annotations?.length ? { annotations_raw: qs.annotations } : {}),
      ...(qs.data?.pages ? { pages: qs.data.pages } : {}),
    };
  });

  const regrades = (d.regrade_requests || []).map((r: any) => {
    const flat: Record<string, any> = {};
    for (const [k, v] of Object.entries(r)) if (v === null || typeof v !== "object") flat[k] = v;
    return flat;
  });

  return {
    assignment: d.assignment?.title,
    submission_format: d.assignment?.submission_format,
    // Wall-clock time in the course's timezone (Gradescope sends it without an offset).
    due_date_course_local: d.assignment?.due_date || null,
    course_timezone: d.assignment?.timezone?.identifier || null,
    total_points: num(d.assignment?.total_points),
    submission_id: submissionId,
    submitted_at: sub.created_at || null,
    late: sub.lateness_in_words || null,
    active: sub.active ?? null,
    grades_visible: !!d.grades_visible,
    total_score: num(sub.score),
    questions,
    autograder: summarizeAutograder(d.autograder_results),
    regrade_requests_open: !!d.assignment?.regrade_requests_open,
    ...(regrades.length ? { regrade_requests: regrades } : {}),
    url: BASE + path,
    note: d.grades_visible ? undefined : "Grades are not published yet; scores shown may be partial or autograder-only.",
  };
}

// ---------------- autograder results ----------------

// "unprocessed"/"processing" mean the autograder is still running; match whole words only.
const autograderDone = (status: string) => /^processed$/i.test(status) || /fail|error/i.test(status);

export async function autograderResults(
  gs: any,
  args: SubmissionRef & { only_failed?: boolean; max_output_chars?: number; wait_seconds?: number },
) {
  const maxChars = args.max_output_chars ?? 2000;
  const deadline = Date.now() + Math.min(Math.max(args.wait_seconds ?? 0, 0), 120) * 1000;
  const keys = ["assignment", "assignment_submission", "autograder_results"];
  let r = await submissionJson(gs, args, keys);
  // A fresh code submission is "unprocessed"/"processing" until the autograder finishes.
  while (!r.data.autograder_results && !autograderDone(r.data.assignment_submission?.status || "") && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 5000));
    r = await submissionJson(gs, { ...args, submission_id: r.submissionId }, keys);
  }
  const { submissionId, path, data: d } = r;
  const status = d.assignment_submission?.status || null;
  const ar = d.autograder_results;
  if (!ar) {
    const running = !autograderDone(status || "");
    return {
      assignment: d.assignment?.title,
      submission_id: submissionId,
      status,
      autograder_results: null,
      note: running
        ? "The autograder has not finished yet. Call again later, or pass wait_seconds to wait for it."
        : "This submission has no autograder results (the assignment may not use an autograder).",
      url: BASE + path,
    };
  }
  const cut = (s: any) => (typeof s === "string" && s.length > maxChars ? s.slice(0, maxChars) + `\n… [${s.length - maxChars} more characters]` : s ?? null);
  let tests = (ar.tests || []).map((t: any) => ({
    number: t.number ?? null,
    name: t.name,
    status: t.status ?? null,
    score: num(t.score),
    max_score: num(t.max_score),
    output: cut(t.output),
  }));
  const failedCount = tests.filter((t: any) => t.status === "failed" || (t.max_score !== null && (t.score ?? 0) < t.max_score)).length;
  if (args.only_failed) tests = tests.filter((t: any) => t.status === "failed" || (t.max_score !== null && (t.score ?? 0) < t.max_score));
  return {
    assignment: d.assignment?.title,
    submission_id: submissionId,
    status,
    score: num(ar.score),
    total_points: num(d.assignment?.total_points),
    tests_total: (ar.tests || []).length,
    tests_failed: failedCount,
    output: cut(ar.output),
    ...(ar.stdout && ar.stdout_shown_to_students ? { stdout: cut(ar.stdout) } : {}),
    ...(ar.error_code ? { error_code: ar.error_code } : {}),
    tests,
    url: BASE + path,
  };
}

// ---------------- submission history ----------------

export async function submissionHistory(gs: any, args: SubmissionRef) {
  const { submissionId, data: d } = await submissionJson(gs, args, ["past_submissions"]);
  const past: any[] = d.past_submissions || [];
  // Gradescope lists newest first; number them oldest = 1 like the UI's history modal.
  const sorted = [...past].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return {
    course_id: args.course_id,
    assignment_id: args.assignment_id,
    count: past.length,
    submissions: sorted
      .map((s, i) => ({
        number: i + 1,
        submission_id: String(s.id),
        submitted_at: s.created_at,
        score: num(s.score),
        active: !!s.active,
        can_activate: !!s.can_activate,
        submitters: (s.owners || []).map((o: any) => o.name),
        url: s.show_path ? BASE + s.show_path : null,
      }))
      .reverse(),
    viewed_submission_id: submissionId,
  };
}

export async function activateSubmission(gs: any, args: SubmissionRef & { submission_id: string; dry_run?: boolean }) {
  if (!args.submission_id) throw new Error("submission_id is required: pick one from get_gradescope_submission_history.");
  const { data: d } = await submissionJson(gs, args, ["past_submissions"]);
  const target = (d.past_submissions || []).find((s: any) => String(s.id) === String(args.submission_id));
  if (!target) throw new Error(`Submission ${args.submission_id} is not in this assignment's history.`);
  if (target.active) return { already_active: true, submission_id: String(target.id) };
  if (!target.can_activate || !target.activate_path) throw new Error("Gradescope does not allow activating this submission.");
  const summary = { submission_id: String(target.id), submitted_at: target.created_at, score: num(target.score) };
  if (args.dry_run) return { dry_run: true, would_post_to: target.activate_path, ...summary };

  const $ = await getPage(gs, `/courses/${args.course_id}/assignments/${args.assignment_id}/submissions/${target.id}`);
  const res = await gsFetch(gs, target.activate_path, {
    method: "POST",
    body: new URLSearchParams({ authenticity_token: csrfFrom($) }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/courses/${args.course_id}/assignments/${args.assignment_id}` },
  });
  await res.body?.cancel();
  if (res.status >= 400) throw new Error(`Gradescope rejected the activation (HTTP ${res.status}).`);
  gs.config?.cache?.storage?.delete?.(`gradescope_assignments_${args.course_id}`);
  // Confirm from the source of truth rather than trusting the redirect.
  const after = await submissionJson(gs, args, ["past_submissions"]);
  const nowActive = (after.data.past_submissions || []).find((s: any) => s.active);
  return { activated: String(nowActive?.id) === String(target.id), active_submission_id: nowActive ? String(nowActive.id) : null, ...summary };
}

// ---------------- submission files ----------------

const MAX_EMBED_BYTES = 10 * 1024 * 1024;

// GET a Gradescope path that may redirect to signed storage, and return the raw bytes.
export async function downloadBinary(gs: any, pathOrUrl: string) {
  let res = /^https?:/.test(pathOrUrl) && !pathOrUrl.startsWith(BASE) ? await fetch(pathOrUrl, { redirect: "follow" }) : await gsFetch(gs, pathOrUrl);
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.get("location"); hop++) {
    const loc = new URL(res.headers.get("location")!, BASE);
    await res.body?.cancel();
    res = loc.origin === BASE ? await gsFetch(gs, loc.pathname + loc.search) : await fetch(loc, { redirect: "follow" });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: (res.headers.get("content-type") || "").split(";")[0] };
}

export async function submissionFiles(
  gs: any,
  args: SubmissionRef & { include_content?: boolean; max_chars_per_file?: number; max_total_chars?: number; embed_pdf?: "none" | "original" | "graded"; embed_zip?: boolean; embed_binary_files?: boolean },
) {
  const includeContent = args.include_content ?? true;
  const maxChars = args.max_chars_per_file ?? 50_000;
  let budget = args.max_total_chars ?? 200_000;
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "assignment_submission", "pdf_attachment", "paths", "text_files", "file_comments"]);
  const result: any = { assignment: d.assignment?.title, submission_id: submissionId, submission_format: d.assignment?.submission_format };
  const blobs: { uri: string; mimeType: string; blob: string }[] = [];
  const images: { data: string; mimeType: string }[] = [];

  const textFiles: any[] = d.text_files || [];
  const comments: any[] = d.file_comments || [];
  // The comment record's link to its file is not confirmed against live data, so try the likely fields.
  const commentFor = (c: any, f: any) => c.text_file_id === f.id || c.file_id === f.id || (c.path && c.path === f.path);
  if (textFiles.length) {
    const unmatched = comments.filter((c) => !textFiles.some((f) => commentFor(c, f)));
    if (unmatched.length) result.other_file_comments = unmatched;
    result.files = textFiles.map((f) => {
      const render = f.content?.render;
      // content.type is "text_file" for source code; "image_file" and "error" (too large / not displayable)
      // carry no file text in render, so they must not be shown as the file's contents.
      const kind = f.content?.type ?? "text_file";
      let text = typeof render === "string" && kind === "text_file" ? render : null;
      // Large projects: stop inlining once the total budget is spent; the rest get download links.
      if (text !== null && includeContent) {
        if (budget <= 0) text = null;
        else budget -= Math.min(text.length, maxChars);
      }
      return {
        path: f.path,
        bytes: f.file_size ?? null,
        content_type: f.content_type ?? null,
        language: f.content?.language ?? null,
        ...(kind !== "text_file" ? { kind, ...(kind === "error" && typeof render === "string" ? { gradescope_note: render } : {}) } : {}),
        ...(includeContent && text !== null
          ? { content: text.length > maxChars ? text.slice(0, maxChars) + `\n… [${text.length - maxChars} more characters]` : text }
          : {}),
        // Signed S3 link that works without logging in; it expires after a short time.
        ...(text === null || !includeContent ? { download_url: f.file?.url || f.url || null } : {}),
        comments: comments
          .filter((c) => commentFor(c, f))
          .map((c) => ({ line: c.line_number ?? c.line ?? null, text: c.content ?? c.text ?? c.comment ?? null })),
      };
    });

    // Optionally attach the non-text files themselves: images as image content, anything else as a file resource.
    if (args.embed_binary_files) {
      let total = 0;
      let count = 0;
      for (const [i, f] of textFiles.entries()) {
        if ((f.content?.type ?? "text_file") === "text_file") continue;
        const entry = result.files[i];
        const url = f.file?.url || f.url;
        if (!url) continue;
        if (count >= 10 || total >= 15 * 1024 * 1024) {
          entry.attachment = "skipped: attachment limit reached (10 files / 15 MB per call)";
          continue;
        }
        if ((f.file_size ?? 0) > MAX_EMBED_BYTES) {
          entry.attachment = `skipped: ${f.file_size} bytes is over the 10 MB limit; use download_url`;
          continue;
        }
        const { bytes, mimeType } = await downloadBinary(gs, url);
        const img = sniffImageType(bytes);
        if (img && bytes.length <= MAX_IMAGE_BYTES) images.push({ data: Buffer.from(bytes).toString("base64"), mimeType: img });
        else blobs.push({ uri: url.split("?")[0], mimeType: img || f.content_type || mimeType || "application/octet-stream", blob: Buffer.from(bytes).toString("base64") });
        entry.attachment = `${img && bytes.length <= MAX_IMAGE_BYTES ? "image" : "file"} attached (${bytes.length} bytes)`;
        total += bytes.length;
        count++;
      }
    }
  }

  const pdf = d.pdf_attachment;
  if (pdf) {
    result.pdf = {
      filename: pdf.filename || null,
      page_count: pdf.page_count ?? null,
      status: pdf.status_string ?? null,
      // Signed S3 link to the uploaded PDF; works without logging in and expires after a short time.
      original_url: d.paths?.original_file_path || pdf.url || null,
      graded_pdf: d.paths?.graded_pdf_path ? "available: pass embed_pdf=\"graded\" to receive it (the link itself needs a Gradescope login)" : null,
    };
    const which = args.embed_pdf ?? "none";
    if (which !== "none") {
      let res =
        which === "graded"
          ? await gsFetch(gs, d.paths.graded_pdf_path)
          : await fetch(d.paths?.original_file_path || pdf.url, { redirect: "follow" });
      // gsFetch does not follow redirects; the graded PDF may be served from a signed storage URL.
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        res = await fetch(res.headers.get("location")!, { redirect: "follow" });
      }
      if (!res.ok) throw new Error(`Downloading the ${which} PDF failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_EMBED_BYTES) throw new Error(`The ${which} PDF is ${bytes.length} bytes, over the ${MAX_EMBED_BYTES}-byte embed limit. Use original_url instead.`);
      blobs.push({ uri: `${BASE}${path}#${which}`, mimeType: "application/pdf", blob: Buffer.from(bytes).toString("base64") });
      result.pdf.embedded = `${which} (${bytes.length} bytes, attached as a resource)`;
    }
  }

  // The whole submission as a zip (the website's "Download Submission"), when the course allows export.
  const zipPath = d.paths?.submission_zip_path;
  result.zip = zipPath && d.assignment_submission?.export_allowed ? "available: pass embed_zip=true to attach it" : "not available for this submission";
  if (args.embed_zip) {
    if (!zipPath || !d.assignment_submission?.export_allowed) throw new Error("This course does not allow downloading this submission as a zip.");
    const { bytes, mimeType } = await downloadBinary(gs, zipPath);
    if (bytes.length > MAX_EMBED_BYTES) throw new Error(`The zip is ${bytes.length} bytes, over the ${MAX_EMBED_BYTES}-byte attachment limit.`);
    blobs.push({ uri: `${BASE}${zipPath}`, mimeType: /zip/.test(mimeType) ? mimeType : "application/zip", blob: Buffer.from(bytes).toString("base64") });
    result.zip = `attached as a resource (${bytes.length} bytes)`;
  }

  if (!result.files && !result.pdf) result.note = "This submission has no downloadable files (it may be an online assignment).";
  result.url = BASE + path;
  return { result, blobs, images };
}

// ---------------- submission page images ----------------
// Gradescope stores each page of an uploaded PDF (or each uploaded photo) as an image with a signed
// storage URL. Returning them as MCP image content lets the model look at the submission itself.

const MAX_IMAGE_BYTES = 4_500_000;

function sniffImageType(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function submissionPages(
  gs: any,
  args: SubmissionRef & { pages?: number[]; questions?: string[]; size?: "full" | "thumbnail"; max_pages?: number },
) {
  const maxPages = Math.min(Math.max(args.max_pages ?? 4, 1), 12);
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "pdf_attachment", "image_attachments", "questions", "question_submissions"]);
  const pdfPages: any[] = (d.pdf_attachment?.pages || []).filter((p: any) => !p.deleted && !p.missing_placeholder);
  const imagePages: any[] = (d.image_attachments || []).filter((p: any) => p.url || p.file?.url);
  const all = (pdfPages.length ? pdfPages : imagePages)
    .map((p: any, i: number) => ({ number: Number(p.number ?? i + 1), url: p.url || p.file?.url, thumb: p.thumb_url || null, width: p.width ?? null, height: p.height ?? null }))
    .sort((a, b) => a.number - b.number);
  if (!all.length) {
    throw new Error(`Submission ${submissionId} has no page images (it may be a code or online submission). Use download_gradescope_submission_files instead.`);
  }

  // Which pages each question was matched to, so pages can be picked by question.
  const qById = new Map<number, any>((d.questions || []).map((q: any) => [q.id, q]));
  const pagesByQuestion: Record<string, number[]> = {};
  for (const qs of d.question_submissions || []) {
    const q = qById.get(qs.question_id);
    if (q && Array.isArray(qs.data?.pages)) pagesByQuestion[String(q.full_index)] = qs.data.pages.map(Number);
  }

  let wanted: number[] = [];
  if (args.questions?.length) {
    for (const key of args.questions) {
      const k = String(key).trim().replace(/^q(?:uestion)?\s*/i, "");
      if (!pagesByQuestion[k]) throw new Error(`Question "${key}" has no matched pages. Matched questions: ${Object.keys(pagesByQuestion).join(", ") || "none"}.`);
      wanted.push(...pagesByQuestion[k]);
    }
  } else if (args.pages?.length) {
    wanted = args.pages.map(Number);
  } else {
    wanted = all.map((p) => p.number);
  }
  wanted = [...new Set(wanted)].sort((a, b) => a - b);
  const missing = wanted.filter((n) => !all.some((p) => p.number === n));
  if (missing.length) throw new Error(`Page(s) ${missing.join(", ")} do not exist; the submission has ${all.length} pages.`);
  const chosen = all.filter((p) => wanted.includes(p.number)).slice(0, maxPages);

  const images: { data: string; mimeType: string }[] = [];
  const returned: any[] = [];
  for (const p of chosen) {
    const url = args.size === "thumbnail" && p.thumb ? p.thumb : p.url;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      await res.body?.cancel();
      returned.push({ page: p.number, error: `download failed: HTTP ${res.status}` });
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) {
      returned.push({ page: p.number, skipped: `image is ${bytes.length} bytes; ask for size "thumbnail"` });
      continue;
    }
    // Storage serves pages as binary/octet-stream; MCP image content needs the real type, so sniff it.
    const mimeType = sniffImageType(bytes) || (res.headers.get("content-type") || "").split(";")[0];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mimeType)) {
      returned.push({ page: p.number, skipped: `not a supported image type (${mimeType || "unknown"})` });
      continue;
    }
    images.push({ data: Buffer.from(bytes).toString("base64"), mimeType });
    returned.push({ page: p.number, bytes: bytes.length, mimeType });
  }
  return {
    result: {
      assignment: d.assignment?.title,
      submission_id: submissionId,
      page_count: all.length,
      pages_by_question: pagesByQuestion,
      returned,
      ...(wanted.length > chosen.length ? { more_pages: wanted.filter((n) => !chosen.some((c) => c.number === n)), note: `Only ${maxPages} pages per call; ask for the rest with pages.` } : {}),
      note_on_marks: "These are the pages as uploaded. Grader marks are listed per question by get_gradescope_submission; the graded PDF with marks drawn in is available via download_gradescope_submission_files with embed_pdf=\"graded\".",
      url: BASE + path,
    },
    images,
  };
}

// ---------------- rerun autograder ----------------

export async function rerunAutograder(gs: any, args: SubmissionRef & { dry_run?: boolean; wait_seconds?: number }) {
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "assignment_submission", "paths", "autograder_results"]);
  const rerunPath = d.paths?.rerun_autograder_path;
  if (d.assignment?.submission_format !== "code" || !rerunPath) throw new Error("Only code submissions with an autograder can be rerun.");
  if (args.dry_run) return { dry_run: true, would_post_to: rerunPath, assignment: d.assignment?.title, submission_id: submissionId, current_score: num(d.autograder_results?.score) };
  const $ = await getPage(gs, path);
  const res = await gsFetch(gs, rerunPath, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfFrom($), "X-Requested-With": "XMLHttpRequest", Accept: "application/json", Referer: BASE + path },
  });
  const t = await res.text();
  if (res.status === 401 || res.status === 403) throw new Error("Gradescope does not let students rerun the autograder for this assignment.");
  if (!res.ok) throw new Error(`Rerunning the autograder failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  if (!args.wait_seconds) return { rerun_started: true, submission_id: submissionId, next_step: "Call get_gradescope_autograder_results with wait_seconds to see the new results." };
  return { rerun_started: true, ...(await autograderResults(gs, { ...args, submission_id: submissionId, wait_seconds: args.wait_seconds })) };
}

// ---------------- autograder SSH debugging ----------------
// paths.ssh_session_path: GET lists sessions (the user's own has userId), POST starts one.
// Gradescope needs a public key on the account (paths.new_public_key_path) and the course must allow it.

export async function autograderSsh(gs: any, args: SubmissionRef & { action?: "status" | "start"; dry_run?: boolean }) {
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "paths", "ssh_settings", "current_user"]);
  const sshPath = d.paths?.ssh_session_path;
  const disabled = d.ssh_settings?.disabled_reason || null;
  if (!sshPath) throw new Error("This submission has no autograder SSH option.");
  const listRes = await gsFetch(gs, sshPath, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
  const sessions: any = listRes.ok ? await listRes.json().catch(() => []) : (await listRes.body?.cancel(), []);
  const mine = (Array.isArray(sessions) ? sessions : []).find((s: any) => (s.userId ?? s.user_id) === d.current_user?.id) || null;
  const status = { assignment: d.assignment?.title, submission_id: submissionId, ssh_disabled_reason: disabled, session: mine ? sanitizeSession(mine) : null };
  if ((args.action ?? "status") === "status") return status;
  if (disabled) throw new Error(`SSH debugging is not available: ${disabled}.`);
  if (args.dry_run) return { dry_run: true, would_post_to: sshPath, ...status };
  const $ = await getPage(gs, path);
  const res = await gsFetch(gs, sshPath, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfFrom($), "X-Requested-With": "XMLHttpRequest", Accept: "application/json", Referer: BASE + path },
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`Starting the SSH session failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  let started: any = null;
  try {
    started = JSON.parse(t);
  } catch {}
  return { ssh_started: true, session: started ? sanitizeSession(started) : null, next_step: 'Call again with action "status" until the session shows connection details.' };
}

function sanitizeSession(s: any) {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(s || {})) if (v === null || typeof v !== "object") out[k] = v;
  return out;
}

// ---------------- compare two submissions ----------------
// What changed between two submissions of the same assignment: per-file unified diffs of the text files,
// score change, and which autograder tests changed status or score.

// Myers O(ND) line diff -> list of [op, line] with op " ", "-" or "+".
function diffLines(a: string[], b: string[]): [string, string][] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[max + k - 1] < v[max + k + 1]) ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        // Backtrack through the saved frontiers to recover the edit script.
        const out: [string, string][] = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const prevK = kk === -dd || (kk !== dd && pv[max + kk - 1] < pv[max + kk + 1]) ? kk + 1 : kk - 1;
          const px = pv[max + prevK];
          const py = px - prevK;
          while (cx > px && cy > py) out.push([" ", a[--cx]]), cy--;
          if (cx === px) out.push(["+", b[--cy]]);
          else out.push(["-", a[--cx]]);
        }
        while (cx > 0 && cy > 0) out.push([" ", a[--cx]]), cy--;
        return out.reverse();
      }
    }
  }
  return [];
}

export function unifiedDiff(path: string, before: string, after: string, context = 3) {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const lines: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let added = 0;
  let removed = 0;
  let i = 0;
  let aLine = 1;
  let bLine = 1;
  while (i < ops.length) {
    if (ops[i][0] === " ") {
      i++;
      aLine++;
      bLine++;
      continue;
    }
    // Start a hunk with up to `context` lines before the first change.
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length && (ops[end][0] !== " " || end - lastChange <= context * 2)) {
      if (ops[end][0] !== " ") lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const back = i - start;
    let as = aLine - back;
    let bs = bLine - back;
    let ac = 0;
    let bc = 0;
    const body: string[] = [];
    for (let j = start; j < end; j++) {
      const [op, text] = ops[j];
      body.push(op + text);
      if (op !== "+") ac++;
      if (op !== "-") bc++;
      if (op === "+") added++;
      if (op === "-") removed++;
    }
    lines.push(`@@ -${as},${ac} +${bs},${bc} @@`, ...body);
    for (let j = i; j < end; j++) {
      if (ops[j][0] !== "+") aLine++;
      if (ops[j][0] !== "-") bLine++;
    }
    i = end;
  }
  return { diff: lines.join("\n"), added, removed };
}

export async function compareSubmissions(
  gs: any,
  args: { course_id: string; assignment_id: string; base_submission_id?: string; head_submission_id?: string; max_chars?: number },
) {
  const maxChars = args.max_chars ?? 60_000;
  const hist = await submissionHistory(gs, { course_id: args.course_id, assignment_id: args.assignment_id });
  const subs: any[] = hist.submissions; // newest first
  if (subs.length < 2 && !(args.base_submission_id && args.head_submission_id)) throw new Error("This assignment has only one submission; there is nothing to compare.");
  const head = args.head_submission_id ? subs.find((s) => s.submission_id === String(args.head_submission_id)) : subs.find((s) => s.active) || subs[0];
  if (!head) throw new Error(`Submission ${args.head_submission_id} is not in this assignment's history.`);
  const base = args.base_submission_id
    ? subs.find((s) => s.submission_id === String(args.base_submission_id))
    : subs.find((s) => s.number === head.number - 1);
  if (!base) throw new Error(args.base_submission_id ? `Submission ${args.base_submission_id} is not in this assignment's history.` : "The head submission is the first one; pass base_submission_id.");

  const keys = ["assignment", "assignment_submission", "text_files", "autograder_results"];
  const [A, B] = await Promise.all([
    submissionJson(gs, { ...args, submission_id: base.submission_id }, keys),
    submissionJson(gs, { ...args, submission_id: head.submission_id }, keys),
  ]);
  const filesOf = (d: any) => new Map<string, string | null>((d.text_files || []).map((f: any) => [f.path, typeof f.content?.render === "string" ? f.content.render : null]));
  const fa = filesOf(A.data);
  const fb = filesOf(B.data);
  const paths = [...new Set([...fa.keys(), ...fb.keys()])].sort();
  const files: any[] = [];
  let budget = maxChars;
  for (const p of paths) {
    const x = fa.get(p);
    const y = fb.get(p);
    if (!fa.has(p)) files.push({ path: p, change: "added", lines: y?.split("\n").length ?? null });
    else if (!fb.has(p)) files.push({ path: p, change: "removed", lines: x?.split("\n").length ?? null });
    else if (x === null || y === null) files.push({ path: p, change: x === y ? "unchanged" : "binary file, not compared" });
    else if (x === y) files.push({ path: p, change: "unchanged" });
    else {
      const u = unifiedDiff(p, x, y);
      const entry: any = { path: p, change: "modified", lines_added: u.added, lines_removed: u.removed };
      if (budget > 0) {
        entry.diff = u.diff.length > budget ? u.diff.slice(0, budget) + "\n… [diff truncated]" : u.diff;
        budget -= u.diff.length;
      } else entry.diff = "[omitted: max_chars reached]";
      files.push(entry);
    }
  }

  const testsOf = (d: any) => new Map<string, any>((d.autograder_results?.tests || []).map((t: any) => [String(t.number ?? "") + " " + t.name, t]));
  const ta = testsOf(A.data);
  const tb = testsOf(B.data);
  const testChanges: any[] = [];
  for (const k of new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(k);
    const y = tb.get(k);
    if (!x || !y) testChanges.push({ test: k.trim(), change: x ? "test removed" : "test added", score: num(y?.score), status: y?.status ?? null });
    else if (num(x.score) !== num(y.score) || x.status !== y.status) testChanges.push({ test: k.trim(), before: { score: num(x.score), status: x.status ?? null }, after: { score: num(y.score), status: y.status ?? null } });
  }

  return {
    assignment: B.data.assignment?.title,
    base: { submission_id: base.submission_id, number: base.number, submitted_at: base.submitted_at, score: base.score },
    head: { submission_id: head.submission_id, number: head.number, submitted_at: head.submitted_at, score: head.score, active: head.active },
    score_change: base.score != null && head.score != null ? Math.round((head.score - base.score) * 1000) / 1000 : null,
    files_changed: files.filter((f) => f.change !== "unchanged").length,
    files,
    ...(ta.size || tb.size ? { autograder_test_changes: testChanges } : {}),
  };
}

// ---------------- feedback across a course ----------------
// Every graded submission in a course, reduced to where points were lost: the question, its score, the rubric
// items applied, and the grader's adjustments and comments. Useful for review and for spotting regrade candidates.

export async function feedbackSummary(gs: any, args: { course_id: string; only_lost_points?: boolean; assignment_ids?: string[] }) {
  await ensureSession(gs);
  const onlyLost = args.only_lost_points ?? true;
  const $ = await getPage(gs, `/courses/${args.course_id}`);
  const refs = new Map<string, string>();
  $('a[href*="/submissions/"]').each((_, a) => {
    const m = ($(a).attr("href") || "").match(/\/assignments\/(\d+)\/submissions\/(\d+)/);
    if (m && (!args.assignment_ids?.length || args.assignment_ids.includes(m[1]))) refs.set(m[1], m[2]);
  });
  const entries = [...refs.entries()];
  const results = await mapLimit(entries, 4, async ([assignment_id, submission_id]) => {
    try {
      return await submissionDetails(gs, { course_id: args.course_id, assignment_id, submission_id });
    } catch (err) {
      return { error: (err as Error).message, assignment_id };
    }
  });
  const assignments: any[] = [];
  let earned = 0;
  let possible = 0;
  for (const r of results as any[]) {
    if (r.error) {
      assignments.push({ assignment_id: r.assignment_id, error: r.error });
      continue;
    }
    if (!r.grades_visible) continue;
    const lost = r.questions
      .filter((q: any) => q.max_points != null && q.score != null && q.score < q.max_points)
      .map((q: any) => ({
        question: q.question,
        title: q.title,
        score: q.score,
        max_points: q.max_points,
        lost: Math.round((q.max_points - q.score) * 1000) / 1000,
        rubric_applied: q.rubric_items.filter((x: any) => x.applied).map((x: any) => `${x.description} (${x.points})`),
        ...(q.grader_adjustments ? { grader_adjustments: q.grader_adjustments } : {}),
        ...(q.annotations ? { annotations: q.annotations } : {}),
      }));
    if (r.total_score != null && r.total_points != null) {
      earned += r.total_score;
      possible += r.total_points;
    }
    if (onlyLost && !lost.length) continue;
    assignments.push({
      assignment: r.assignment,
      submission_id: r.submission_id,
      score: r.total_score,
      total_points: r.total_points,
      regrade_requests_open: r.regrade_requests_open,
      questions_with_lost_points: lost,
      url: r.url,
    });
  }
  assignments.sort((a, b) => (b.questions_with_lost_points?.reduce((s: number, q: any) => s + q.lost, 0) ?? 0) - (a.questions_with_lost_points?.reduce((s: number, q: any) => s + q.lost, 0) ?? 0));
  return {
    course_id: args.course_id,
    graded_submissions_checked: entries.length,
    total: { earned: Math.round(earned * 1000) / 1000, possible: Math.round(possible * 1000) / 1000 },
    assignments,
    note: "Sorted by points lost. regrade_requests_open shows where request_gradescope_regrade can still be used.",
  };
}
