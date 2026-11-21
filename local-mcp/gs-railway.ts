var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// gs-student.ts
var gs_student_exports = {};
__export(gs_student_exports, {
  activateSubmission: () => activateSubmission,
  autograderResults: () => autograderResults,
  autograderSsh: () => autograderSsh,
  compareSubmissions: () => compareSubmissions,
  downloadBinary: () => downloadBinary,
  feedbackSummary: () => feedbackSummary,
  rerunAutograder: () => rerunAutograder,
  resolveSubmissionId: () => resolveSubmissionId,
  submissionDetails: () => submissionDetails,
  submissionFiles: () => submissionFiles,
  submissionHistory: () => submissionHistory,
  submissionJson: () => submissionJson,
  submissionPages: () => submissionPages,
  unifiedDiff: () => unifiedDiff,
  upcomingDeadlines: () => upcomingDeadlines
});
import { Buffer as Buffer2 } from "node:buffer";
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    })
  );
  return out;
}
async function upcomingDeadlines(gs, args) {
  await ensureSession(gs);
  const days = args.days ?? 14;
  const now = Date.now();
  const horizon = now + days * 24 * 3600 * 1e3;
  const all = await gs.getGradescopeCourses();
  if (!all)
    throw new Error("Could not read the Gradescope course list.");
  let courses = Object.values(all.student || {});
  if (args.course_ids?.length) {
    courses = courses.filter((c) => args.course_ids.includes(String(c.id)));
  } else if (!args.include_inactive_courses && courses.some((c) => c.active)) {
    courses = courses.filter((c) => c.active);
  }
  const failed = [];
  const perCourse = await mapLimit(courses, 4, async (c) => {
    const assignments = await gs.getGradescopeAssignments(String(c.id));
    if (!assignments) {
      failed.push(c.name || String(c.id));
      return [];
    }
    return assignments.map((a) => ({ course: c, a }));
  });
  const items = [];
  const overdue = [];
  for (const { course, a } of perCourse.flat()) {
    const due = a.due_date ? new Date(a.due_date).getTime() : null;
    const late = a.late_due_date ? new Date(a.late_due_date).getTime() : null;
    const released = !a.release_date || new Date(a.release_date).getTime() <= now;
    if (due === null || !released)
      continue;
    const submitted = isSubmitted(a.submissions_status, a.grade);
    if (submitted && !args.include_submitted)
      continue;
    const upcoming = due >= now && due <= horizon;
    const lateOpen = due < now && late !== null && late >= now;
    if (!upcoming && !lateOpen)
      continue;
    const target = upcoming ? due : late;
    (lateOpen && late > horizon ? overdue : items).push({
      course: course.name,
      course_id: String(course.id),
      assignment: a.name,
      assignment_id: a.assignment_id,
      due_date: new Date(due).toISOString(),
      late_due_date: late ? new Date(late).toISOString() : null,
      only_late_window_open: lateOpen,
      hours_left: Math.round((target - now) / 36e5 * 10) / 10,
      status: a.submissions_status,
      submitted,
      url: a.assignment_id ? `${BASE}/courses/${course.id}/assignments/${a.assignment_id}` : null
    });
  }
  items.sort((x, y) => x.hours_left - y.hours_left);
  overdue.sort((x, y) => x.hours_left - y.hours_left);
  return {
    now: new Date(now).toISOString(),
    window_days: days,
    courses_checked: courses.map((c) => c.name),
    ...failed.length ? { courses_failed: failed } : {},
    deadlines: items,
    ...overdue.length ? { past_due_late_submission_still_open: overdue } : {}
  };
}
async function resolveSubmissionId(gs, ref) {
  if (ref.submission_id)
    return String(ref.submission_id);
  const res = await gsFetch(gs, `/courses/${ref.course_id}/assignments/${ref.assignment_id}`);
  const id = (res.headers.get("location") || "").match(/\/assignments\/\d+\/submissions\/(\d+)/)?.[1];
  await res.body?.cancel();
  if (!id) {
    throw new Error(
      `No submission found for assignment ${ref.assignment_id} in course ${ref.course_id}. It may not have been submitted yet, or the IDs may be wrong.`
    );
  }
  return id;
}
async function submissionJson(gs, ref, onlyKeys = []) {
  const submissionId = await resolveSubmissionId(gs, ref);
  const path = `/courses/${ref.course_id}/assignments/${ref.assignment_id}/submissions/${submissionId}`;
  const qs = new URLSearchParams({ content: "react" });
  for (const k of onlyKeys)
    qs.append("only_keys[]", k);
  const res = await gsFetch(gs, `${path}.json?${qs}`, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Gradescope returned ${res.status} for submission ${submissionId}. Check the course, assignment and submission IDs.`);
  }
  return { submissionId, path, data: await res.json() };
}
function summarizeAutograder(ar) {
  if (!ar)
    return null;
  const tests = ar.tests || [];
  const failed = tests.filter((t) => t.status === "failed" || t.max_score != null && Number(t.score) < Number(t.max_score));
  return { score: num(ar.score), tests: tests.length, failed_tests: failed.length, error_code: ar.error_code || null };
}
async function submissionDetails(gs, args) {
  const { submissionId, path, data: d } = await submissionJson(gs, args);
  const sub = d.assignment_submission || {};
  const rubricByQuestion = /* @__PURE__ */ new Map();
  for (const r of d.rubric_items || []) {
    if (!rubricByQuestion.has(r.question_id))
      rubricByQuestion.set(r.question_id, []);
    rubricByQuestion.get(r.question_id).push(r);
  }
  const qsById = new Map((d.question_submissions || []).map((q) => [q.question_id, q]));
  const questions = (d.questions || []).map((q) => {
    const qs = qsById.get(q.id) || {};
    const rubric = (rubricByQuestion.get(q.id) || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((r) => ({ description: r.description, points: num(r.weight), applied: !!r.present }));
    const adjustments = (qs.evaluations || []).filter((e) => num(e.points) || e.comments).map((e) => ({ points: num(e.points), comment: e.comments || null }));
    const annotations = (qs.annotations || []).map((a) => ({ page: a.page_number ?? a.page ?? null, text: a.content ?? a.text ?? a.comment ?? null })).filter((a) => a.text);
    return {
      question: q.full_index ?? String(q.index ?? ""),
      title: q.title,
      max_points: num(q.weight),
      score: num(qs.score),
      scoring: q.scoring_type || null,
      rubric_items: rubric,
      ...adjustments.length ? { grader_adjustments: adjustments } : {},
      ...annotations.length ? { annotations } : {},
      // Annotation fields are not confirmed against live data; if none mapped, pass the records through.
      ...!annotations.length && qs.annotations?.length ? { annotations_raw: qs.annotations } : {},
      ...qs.data?.pages ? { pages: qs.data.pages } : {}
    };
  });
  const regrades = (d.regrade_requests || []).map((r) => {
    const flat = {};
    for (const [k, v] of Object.entries(r))
      if (v === null || typeof v !== "object")
        flat[k] = v;
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
    ...regrades.length ? { regrade_requests: regrades } : {},
    url: BASE + path,
    note: d.grades_visible ? void 0 : "Grades are not published yet; scores shown may be partial or autograder-only."
  };
}
async function autograderResults(gs, args) {
  const maxChars = args.max_output_chars ?? 2e3;
  const deadline = Date.now() + Math.min(Math.max(args.wait_seconds ?? 0, 0), 120) * 1e3;
  const keys = ["assignment", "assignment_submission", "autograder_results"];
  let r = await submissionJson(gs, args, keys);
  while (!r.data.autograder_results && !autograderDone(r.data.assignment_submission?.status || "") && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 5e3));
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
      note: running ? "The autograder has not finished yet. Call again later, or pass wait_seconds to wait for it." : "This submission has no autograder results (the assignment may not use an autograder).",
      url: BASE + path
    };
  }
  const cut = (s) => typeof s === "string" && s.length > maxChars ? s.slice(0, maxChars) + `
\u2026 [${s.length - maxChars} more characters]` : s ?? null;
  let tests = (ar.tests || []).map((t) => ({
    number: t.number ?? null,
    name: t.name,
    status: t.status ?? null,
    score: num(t.score),
    max_score: num(t.max_score),
    output: cut(t.output)
  }));
  const failedCount = tests.filter((t) => t.status === "failed" || t.max_score !== null && (t.score ?? 0) < t.max_score).length;
  if (args.only_failed)
    tests = tests.filter((t) => t.status === "failed" || t.max_score !== null && (t.score ?? 0) < t.max_score);
  return {
    assignment: d.assignment?.title,
    submission_id: submissionId,
    status,
    score: num(ar.score),
    total_points: num(d.assignment?.total_points),
    tests_total: (ar.tests || []).length,
    tests_failed: failedCount,
    output: cut(ar.output),
    ...ar.stdout && ar.stdout_shown_to_students ? { stdout: cut(ar.stdout) } : {},
    ...ar.error_code ? { error_code: ar.error_code } : {},
    tests,
    url: BASE + path
  };
}
async function submissionHistory(gs, args) {
  const { submissionId, data: d } = await submissionJson(gs, args, ["past_submissions"]);
  const past = d.past_submissions || [];
  const sorted = [...past].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  return {
    course_id: args.course_id,
    assignment_id: args.assignment_id,
    count: past.length,
    submissions: sorted.map((s, i) => ({
      number: i + 1,
      submission_id: String(s.id),
      submitted_at: s.created_at,
      score: num(s.score),
      active: !!s.active,
      can_activate: !!s.can_activate,
      submitters: (s.owners || []).map((o) => o.name),
      url: s.show_path ? BASE + s.show_path : null
    })).reverse(),
    viewed_submission_id: submissionId
  };
}
async function activateSubmission(gs, args) {
  if (!args.submission_id)
    throw new Error("submission_id is required: pick one from get_gradescope_submission_history.");
  const { data: d } = await submissionJson(gs, args, ["past_submissions"]);
  const target = (d.past_submissions || []).find((s) => String(s.id) === String(args.submission_id));
  if (!target)
    throw new Error(`Submission ${args.submission_id} is not in this assignment's history.`);
  if (target.active)
    return { already_active: true, submission_id: String(target.id) };
  if (!target.can_activate || !target.activate_path)
    throw new Error("Gradescope does not allow activating this submission.");
  const summary = { submission_id: String(target.id), submitted_at: target.created_at, score: num(target.score) };
  if (args.dry_run)
    return { dry_run: true, would_post_to: target.activate_path, ...summary };
  const $ = await getPage(gs, `/courses/${args.course_id}/assignments/${args.assignment_id}/submissions/${target.id}`);
  const res = await gsFetch(gs, target.activate_path, {
    method: "POST",
    body: new URLSearchParams({ authenticity_token: csrfFrom($) }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE}/courses/${args.course_id}/assignments/${args.assignment_id}` }
  });
  await res.body?.cancel();
  if (res.status >= 400)
    throw new Error(`Gradescope rejected the activation (HTTP ${res.status}).`);
  gs.config?.cache?.storage?.delete?.(`gradescope_assignments_${args.course_id}`);
  const after = await submissionJson(gs, args, ["past_submissions"]);
  const nowActive = (after.data.past_submissions || []).find((s) => s.active);
  return { activated: String(nowActive?.id) === String(target.id), active_submission_id: nowActive ? String(nowActive.id) : null, ...summary };
}
async function downloadBinary(gs, pathOrUrl) {
  let res = /^https?:/.test(pathOrUrl) && !pathOrUrl.startsWith(BASE) ? await fetch(pathOrUrl, { redirect: "follow" }) : await gsFetch(gs, pathOrUrl);
  for (let hop = 0; hop < 5 && res.status >= 300 && res.status < 400 && res.headers.get("location"); hop++) {
    const loc = new URL(res.headers.get("location"), BASE);
    await res.body?.cancel();
    res = loc.origin === BASE ? await gsFetch(gs, loc.pathname + loc.search) : await fetch(loc, { redirect: "follow" });
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Download failed: HTTP ${res.status}`);
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), mimeType: (res.headers.get("content-type") || "").split(";")[0] };
}
async function submissionFiles(gs, args) {
  const includeContent = args.include_content ?? true;
  const maxChars = args.max_chars_per_file ?? 5e4;
  let budget = args.max_total_chars ?? 2e5;
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "assignment_submission", "pdf_attachment", "paths", "text_files", "file_comments"]);
  const result = { assignment: d.assignment?.title, submission_id: submissionId, submission_format: d.assignment?.submission_format };
  const blobs = [];
  const images = [];
  const textFiles = d.text_files || [];
  const comments = d.file_comments || [];
  const commentFor = (c, f) => c.text_file_id === f.id || c.file_id === f.id || c.path && c.path === f.path;
  if (textFiles.length) {
    const unmatched = comments.filter((c) => !textFiles.some((f) => commentFor(c, f)));
    if (unmatched.length)
      result.other_file_comments = unmatched;
    result.files = textFiles.map((f) => {
      const render = f.content?.render;
      const kind = f.content?.type ?? "text_file";
      let text2 = typeof render === "string" && kind === "text_file" ? render : null;
      if (text2 !== null && includeContent) {
        if (budget <= 0)
          text2 = null;
        else
          budget -= Math.min(text2.length, maxChars);
      }
      return {
        path: f.path,
        bytes: f.file_size ?? null,
        content_type: f.content_type ?? null,
        language: f.content?.language ?? null,
        ...kind !== "text_file" ? { kind, ...kind === "error" && typeof render === "string" ? { gradescope_note: render } : {} } : {},
        ...includeContent && text2 !== null ? { content: text2.length > maxChars ? text2.slice(0, maxChars) + `
\u2026 [${text2.length - maxChars} more characters]` : text2 } : {},
        // Signed S3 link that works without logging in; it expires after a short time.
        ...text2 === null || !includeContent ? { download_url: f.file?.url || f.url || null } : {},
        comments: comments.filter((c) => commentFor(c, f)).map((c) => ({ line: c.line_number ?? c.line ?? null, text: c.content ?? c.text ?? c.comment ?? null }))
      };
    });
    if (args.embed_binary_files) {
      let total = 0;
      let count = 0;
      for (const [i, f] of textFiles.entries()) {
        if ((f.content?.type ?? "text_file") === "text_file")
          continue;
        const entry = result.files[i];
        const url = f.file?.url || f.url;
        if (!url)
          continue;
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
        if (img && bytes.length <= MAX_IMAGE_BYTES)
          images.push({ data: Buffer2.from(bytes).toString("base64"), mimeType: img });
        else
          blobs.push({ uri: url.split("?")[0], mimeType: img || f.content_type || mimeType || "application/octet-stream", blob: Buffer2.from(bytes).toString("base64") });
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
      graded_pdf: d.paths?.graded_pdf_path ? 'available: pass embed_pdf="graded" to receive it (the link itself needs a Gradescope login)' : null
    };
    const which = args.embed_pdf ?? "none";
    if (which !== "none") {
      let res = which === "graded" ? await gsFetch(gs, d.paths.graded_pdf_path) : await fetch(d.paths?.original_file_path || pdf.url, { redirect: "follow" });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        res = await fetch(res.headers.get("location"), { redirect: "follow" });
      }
      if (!res.ok)
        throw new Error(`Downloading the ${which} PDF failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > MAX_EMBED_BYTES)
        throw new Error(`The ${which} PDF is ${bytes.length} bytes, over the ${MAX_EMBED_BYTES}-byte embed limit. Use original_url instead.`);
      blobs.push({ uri: `${BASE}${path}#${which}`, mimeType: "application/pdf", blob: Buffer2.from(bytes).toString("base64") });
      result.pdf.embedded = `${which} (${bytes.length} bytes, attached as a resource)`;
    }
  }
  const zipPath = d.paths?.submission_zip_path;
  result.zip = zipPath && d.assignment_submission?.export_allowed ? "available: pass embed_zip=true to attach it" : "not available for this submission";
  if (args.embed_zip) {
    if (!zipPath || !d.assignment_submission?.export_allowed)
      throw new Error("This course does not allow downloading this submission as a zip.");
    const { bytes, mimeType } = await downloadBinary(gs, zipPath);
    if (bytes.length > MAX_EMBED_BYTES)
      throw new Error(`The zip is ${bytes.length} bytes, over the ${MAX_EMBED_BYTES}-byte attachment limit.`);
    blobs.push({ uri: `${BASE}${zipPath}`, mimeType: /zip/.test(mimeType) ? mimeType : "application/zip", blob: Buffer2.from(bytes).toString("base64") });
    result.zip = `attached as a resource (${bytes.length} bytes)`;
  }
  if (!result.files && !result.pdf)
    result.note = "This submission has no downloadable files (it may be an online assignment).";
  result.url = BASE + path;
  return { result, blobs, images };
}
function sniffImageType(b) {
  if (b[0] === 255 && b[1] === 216 && b[2] === 255)
    return "image/jpeg";
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71)
    return "image/png";
  if (b[0] === 71 && b[1] === 73 && b[2] === 70)
    return "image/gif";
  if (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80)
    return "image/webp";
  return null;
}
async function submissionPages(gs, args) {
  const maxPages = Math.min(Math.max(args.max_pages ?? 4, 1), 12);
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "pdf_attachment", "image_attachments", "questions", "question_submissions"]);
  const pdfPages = (d.pdf_attachment?.pages || []).filter((p) => !p.deleted && !p.missing_placeholder);
  const imagePages = (d.image_attachments || []).filter((p) => p.url || p.file?.url);
  const all = (pdfPages.length ? pdfPages : imagePages).map((p, i) => ({ number: Number(p.number ?? i + 1), url: p.url || p.file?.url, thumb: p.thumb_url || null, width: p.width ?? null, height: p.height ?? null })).sort((a, b) => a.number - b.number);
  if (!all.length) {
    throw new Error(`Submission ${submissionId} has no page images (it may be a code or online submission). Use download_gradescope_submission_files instead.`);
  }
  const qById = new Map((d.questions || []).map((q) => [q.id, q]));
  const pagesByQuestion = {};
  for (const qs of d.question_submissions || []) {
    const q = qById.get(qs.question_id);
    if (q && Array.isArray(qs.data?.pages))
      pagesByQuestion[String(q.full_index)] = qs.data.pages.map(Number);
  }
  let wanted = [];
  if (args.questions?.length) {
    for (const key of args.questions) {
      const k = String(key).trim().replace(/^q(?:uestion)?\s*/i, "");
      if (!pagesByQuestion[k])
        throw new Error(`Question "${key}" has no matched pages. Matched questions: ${Object.keys(pagesByQuestion).join(", ") || "none"}.`);
      wanted.push(...pagesByQuestion[k]);
    }
  } else if (args.pages?.length) {
    wanted = args.pages.map(Number);
  } else {
    wanted = all.map((p) => p.number);
  }
  wanted = [...new Set(wanted)].sort((a, b) => a - b);
  const missing = wanted.filter((n) => !all.some((p) => p.number === n));
  if (missing.length)
    throw new Error(`Page(s) ${missing.join(", ")} do not exist; the submission has ${all.length} pages.`);
  const chosen = all.filter((p) => wanted.includes(p.number)).slice(0, maxPages);
  const images = [];
  const returned = [];
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
    const mimeType = sniffImageType(bytes) || (res.headers.get("content-type") || "").split(";")[0];
    if (!/^image\/(jpeg|png|gif|webp)$/.test(mimeType)) {
      returned.push({ page: p.number, skipped: `not a supported image type (${mimeType || "unknown"})` });
      continue;
    }
    images.push({ data: Buffer2.from(bytes).toString("base64"), mimeType });
    returned.push({ page: p.number, bytes: bytes.length, mimeType });
  }
  return {
    result: {
      assignment: d.assignment?.title,
      submission_id: submissionId,
      page_count: all.length,
      pages_by_question: pagesByQuestion,
      returned,
      ...wanted.length > chosen.length ? { more_pages: wanted.filter((n) => !chosen.some((c) => c.number === n)), note: `Only ${maxPages} pages per call; ask for the rest with pages.` } : {},
      note_on_marks: 'These are the pages as uploaded. Grader marks are listed per question by get_gradescope_submission; the graded PDF with marks drawn in is available via download_gradescope_submission_files with embed_pdf="graded".',
      url: BASE + path
    },
    images
  };
}
async function rerunAutograder(gs, args) {
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "assignment_submission", "paths", "autograder_results"]);
  const rerunPath = d.paths?.rerun_autograder_path;
  if (d.assignment?.submission_format !== "code" || !rerunPath)
    throw new Error("Only code submissions with an autograder can be rerun.");
  if (args.dry_run)
    return { dry_run: true, would_post_to: rerunPath, assignment: d.assignment?.title, submission_id: submissionId, current_score: num(d.autograder_results?.score) };
  const $ = await getPage(gs, path);
  const res = await gsFetch(gs, rerunPath, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfFrom($), "X-Requested-With": "XMLHttpRequest", Accept: "application/json", Referer: BASE + path }
  });
  const t = await res.text();
  if (res.status === 401 || res.status === 403)
    throw new Error("Gradescope does not let students rerun the autograder for this assignment.");
  if (!res.ok)
    throw new Error(`Rerunning the autograder failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  if (!args.wait_seconds)
    return { rerun_started: true, submission_id: submissionId, next_step: "Call get_gradescope_autograder_results with wait_seconds to see the new results." };
  return { rerun_started: true, ...await autograderResults(gs, { ...args, submission_id: submissionId, wait_seconds: args.wait_seconds }) };
}
async function autograderSsh(gs, args) {
  const { submissionId, path, data: d } = await submissionJson(gs, args, ["assignment", "paths", "ssh_settings", "current_user"]);
  const sshPath = d.paths?.ssh_session_path;
  const disabled = d.ssh_settings?.disabled_reason || null;
  if (!sshPath)
    throw new Error("This submission has no autograder SSH option.");
  const listRes = await gsFetch(gs, sshPath, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
  const sessions = listRes.ok ? await listRes.json().catch(() => []) : (await listRes.body?.cancel(), []);
  const mine = (Array.isArray(sessions) ? sessions : []).find((s) => (s.userId ?? s.user_id) === d.current_user?.id) || null;
  const status = { assignment: d.assignment?.title, submission_id: submissionId, ssh_disabled_reason: disabled, session: mine ? sanitizeSession(mine) : null };
  if ((args.action ?? "status") === "status")
    return status;
  if (disabled)
    throw new Error(`SSH debugging is not available: ${disabled}.`);
  if (args.dry_run)
    return { dry_run: true, would_post_to: sshPath, ...status };
  const $ = await getPage(gs, path);
  const res = await gsFetch(gs, sshPath, {
    method: "POST",
    headers: { "X-CSRF-Token": csrfFrom($), "X-Requested-With": "XMLHttpRequest", Accept: "application/json", Referer: BASE + path }
  });
  const t = await res.text();
  if (!res.ok)
    throw new Error(`Starting the SSH session failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  let started = null;
  try {
    started = JSON.parse(t);
  } catch {
  }
  return { ssh_started: true, session: started ? sanitizeSession(started) : null, next_step: 'Call again with action "status" until the session shows connection details.' };
}
function sanitizeSession(s) {
  const out = {};
  for (const [k, v] of Object.entries(s || {}))
    if (v === null || typeof v !== "object")
      out[k] = v;
  return out;
}
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 2);
  const trace = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || k !== d && v[max + k - 1] < v[max + k + 1] ? v[max + k + 1] : v[max + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[max + k] = x;
      if (x >= n && y >= m) {
        const out = [];
        let cx = n;
        let cy = m;
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd];
          const kk = cx - cy;
          const prevK = kk === -dd || kk !== dd && pv[max + kk - 1] < pv[max + kk + 1] ? kk + 1 : kk - 1;
          const px = pv[max + prevK];
          const py = px - prevK;
          while (cx > px && cy > py)
            out.push([" ", a[--cx]]), cy--;
          if (cx === px)
            out.push(["+", b[--cy]]);
          else
            out.push(["-", a[--cx]]);
        }
        while (cx > 0 && cy > 0)
          out.push([" ", a[--cx]]), cy--;
        return out.reverse();
      }
    }
  }
  return [];
}
function unifiedDiff(path, before, after, context = 3) {
  const a = before.split("\n");
  const b = after.split("\n");
  const ops = diffLines(a, b);
  const lines = [`--- a/${path}`, `+++ b/${path}`];
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
    const start = Math.max(0, i - context);
    let end = i;
    let lastChange = i;
    while (end < ops.length && (ops[end][0] !== " " || end - lastChange <= context * 2)) {
      if (ops[end][0] !== " ")
        lastChange = end;
      end++;
    }
    end = Math.min(ops.length, lastChange + context + 1);
    const back = i - start;
    let as = aLine - back;
    let bs = bLine - back;
    let ac = 0;
    let bc = 0;
    const body = [];
    for (let j = start; j < end; j++) {
      const [op, text2] = ops[j];
      body.push(op + text2);
      if (op !== "+")
        ac++;
      if (op !== "-")
        bc++;
      if (op === "+")
        added++;
      if (op === "-")
        removed++;
    }
    lines.push(`@@ -${as},${ac} +${bs},${bc} @@`, ...body);
    for (let j = i; j < end; j++) {
      if (ops[j][0] !== "+")
        aLine++;
      if (ops[j][0] !== "-")
        bLine++;
    }
    i = end;
  }
  return { diff: lines.join("\n"), added, removed };
}
async function compareSubmissions(gs, args) {
  const maxChars = args.max_chars ?? 6e4;
  const hist = await submissionHistory(gs, { course_id: args.course_id, assignment_id: args.assignment_id });
  const subs = hist.submissions;
  if (subs.length < 2 && !(args.base_submission_id && args.head_submission_id))
    throw new Error("This assignment has only one submission; there is nothing to compare.");
  const head = args.head_submission_id ? subs.find((s) => s.submission_id === String(args.head_submission_id)) : subs.find((s) => s.active) || subs[0];
  if (!head)
    throw new Error(`Submission ${args.head_submission_id} is not in this assignment's history.`);
  const base = args.base_submission_id ? subs.find((s) => s.submission_id === String(args.base_submission_id)) : subs.find((s) => s.number === head.number - 1);
  if (!base)
    throw new Error(args.base_submission_id ? `Submission ${args.base_submission_id} is not in this assignment's history.` : "The head submission is the first one; pass base_submission_id.");
  const keys = ["assignment", "assignment_submission", "text_files", "autograder_results"];
  const [A, B] = await Promise.all([
    submissionJson(gs, { ...args, submission_id: base.submission_id }, keys),
    submissionJson(gs, { ...args, submission_id: head.submission_id }, keys)
  ]);
  const filesOf = (d) => new Map((d.text_files || []).map((f) => [f.path, typeof f.content?.render === "string" ? f.content.render : null]));
  const fa = filesOf(A.data);
  const fb = filesOf(B.data);
  const paths = [.../* @__PURE__ */ new Set([...fa.keys(), ...fb.keys()])].sort();
  const files = [];
  let budget = maxChars;
  for (const p of paths) {
    const x = fa.get(p);
    const y = fb.get(p);
    if (!fa.has(p))
      files.push({ path: p, change: "added", lines: y?.split("\n").length ?? null });
    else if (!fb.has(p))
      files.push({ path: p, change: "removed", lines: x?.split("\n").length ?? null });
    else if (x === null || y === null)
      files.push({ path: p, change: x === y ? "unchanged" : "binary file, not compared" });
    else if (x === y)
      files.push({ path: p, change: "unchanged" });
    else {
      const u = unifiedDiff(p, x, y);
      const entry = { path: p, change: "modified", lines_added: u.added, lines_removed: u.removed };
      if (budget > 0) {
        entry.diff = u.diff.length > budget ? u.diff.slice(0, budget) + "\n\u2026 [diff truncated]" : u.diff;
        budget -= u.diff.length;
      } else
        entry.diff = "[omitted: max_chars reached]";
      files.push(entry);
    }
  }
  const testsOf = (d) => new Map((d.autograder_results?.tests || []).map((t) => [String(t.number ?? "") + " " + t.name, t]));
  const ta = testsOf(A.data);
  const tb = testsOf(B.data);
  const testChanges = [];
  for (const k of /* @__PURE__ */ new Set([...ta.keys(), ...tb.keys()])) {
    const x = ta.get(k);
    const y = tb.get(k);
    if (!x || !y)
      testChanges.push({ test: k.trim(), change: x ? "test removed" : "test added", score: num(y?.score), status: y?.status ?? null });
    else if (num(x.score) !== num(y.score) || x.status !== y.status)
      testChanges.push({ test: k.trim(), before: { score: num(x.score), status: x.status ?? null }, after: { score: num(y.score), status: y.status ?? null } });
  }
  return {
    assignment: B.data.assignment?.title,
    base: { submission_id: base.submission_id, number: base.number, submitted_at: base.submitted_at, score: base.score },
    head: { submission_id: head.submission_id, number: head.number, submitted_at: head.submitted_at, score: head.score, active: head.active },
    score_change: base.score != null && head.score != null ? Math.round((head.score - base.score) * 1e3) / 1e3 : null,
    files_changed: files.filter((f) => f.change !== "unchanged").length,
    files,
    ...ta.size || tb.size ? { autograder_test_changes: testChanges } : {}
  };
}
async function feedbackSummary(gs, args) {
  await ensureSession(gs);
  const onlyLost = args.only_lost_points ?? true;
  const $ = await getPage(gs, `/courses/${args.course_id}`);
  const refs = /* @__PURE__ */ new Map();
  $('a[href*="/submissions/"]').each((_, a) => {
    const m = ($(a).attr("href") || "").match(/\/assignments\/(\d+)\/submissions\/(\d+)/);
    if (m && (!args.assignment_ids?.length || args.assignment_ids.includes(m[1])))
      refs.set(m[1], m[2]);
  });
  const entries = [...refs.entries()];
  const results = await mapLimit(entries, 4, async ([assignment_id, submission_id]) => {
    try {
      return await submissionDetails(gs, { course_id: args.course_id, assignment_id, submission_id });
    } catch (err) {
      return { error: err.message, assignment_id };
    }
  });
  const assignments = [];
  let earned = 0;
  let possible = 0;
  for (const r of results) {
    if (r.error) {
      assignments.push({ assignment_id: r.assignment_id, error: r.error });
      continue;
    }
    if (!r.grades_visible)
      continue;
    const lost = r.questions.filter((q) => q.max_points != null && q.score != null && q.score < q.max_points).map((q) => ({
      question: q.question,
      title: q.title,
      score: q.score,
      max_points: q.max_points,
      lost: Math.round((q.max_points - q.score) * 1e3) / 1e3,
      rubric_applied: q.rubric_items.filter((x) => x.applied).map((x) => `${x.description} (${x.points})`),
      ...q.grader_adjustments ? { grader_adjustments: q.grader_adjustments } : {},
      ...q.annotations ? { annotations: q.annotations } : {}
    }));
    if (r.total_score != null && r.total_points != null) {
      earned += r.total_score;
      possible += r.total_points;
    }
    if (onlyLost && !lost.length)
      continue;
    assignments.push({
      assignment: r.assignment,
      submission_id: r.submission_id,
      score: r.total_score,
      total_points: r.total_points,
      regrade_requests_open: r.regrade_requests_open,
      questions_with_lost_points: lost,
      url: r.url
    });
  }
  assignments.sort((a, b) => (b.questions_with_lost_points?.reduce((s, q) => s + q.lost, 0) ?? 0) - (a.questions_with_lost_points?.reduce((s, q) => s + q.lost, 0) ?? 0));
  return {
    course_id: args.course_id,
    graded_submissions_checked: entries.length,
    total: { earned: Math.round(earned * 1e3) / 1e3, possible: Math.round(possible * 1e3) / 1e3 },
    assignments,
    note: "Sorted by points lost. regrade_requests_open shows where request_gradescope_regrade can still be used."
  };
}
var BASE, num, isSubmitted, autograderDone, MAX_EMBED_BYTES, MAX_IMAGE_BYTES;
var init_gs_student = __esm({
  "gs-student.ts"() {
    init_gs_submit();
    BASE = "https://www.gradescope.com";
    num = (v) => v === null || v === void 0 || v === "" ? null : Number(v);
    isSubmitted = (status, grade) => grade !== null || !!status && !/no submission|not submitted/i.test(status) && /submitted|graded/i.test(status);
    autograderDone = (status) => /^processed$/i.test(status) || /fail|error/i.test(status);
    MAX_EMBED_BYTES = 10 * 1024 * 1024;
    MAX_IMAGE_BYTES = 45e5;
  }
});

// gs-submit.ts
import * as cheerio2 from "cheerio@1.2.0";
import { PDFDocument } from "pdf-lib@1.17.1";
function resetSession(gs) {
  gs.isAuthenticated = false;
  gs.csrfToken = "";
  gs.cookieManager.clear();
}
async function ensureSession(gs) {
  if (loginInFlight)
    return loginInFlight;
  if (gs.isAuthenticated && Date.now() - authenticatedAt > SESSION_MAX_AGE_MS)
    resetSession(gs);
  if (gs.isAuthenticated)
    return;
  loginInFlight = (async () => {
    try {
      if (!await gs.authenticate())
        throw new Error("Gradescope login failed. Check the email and password set on the server.");
      authenticatedAt = Date.now();
    } finally {
      loginInFlight = null;
    }
  })();
  return loginInFlight;
}
async function gsFetch(gs, path, init = {}, retried = false) {
  await ensureSession(gs);
  const sessionStamp = authenticatedAt;
  const headers = {
    "User-Agent": UA,
    Cookie: gs.cookieManager.getCookieString(),
    ...init.headers || {}
  };
  const res = await fetch(path.startsWith("http") ? path : BASE2 + path, { ...init, headers, redirect: "manual" });
  gs.cookieManager.setCookiesFromHeaders(res.headers);
  const location = res.headers.get("location") || "";
  const bouncedToLogin = res.status >= 300 && res.status < 400 && /\/login(?:[/?#]|$)/.test(location);
  const freshSession = Date.now() - sessionStamp < 2 * 60 * 1e3;
  if (!retried && (bouncedToLogin || res.status === 401 && !freshSession)) {
    await res.body?.cancel();
    if (authenticatedAt === sessionStamp && !loginInFlight)
      resetSession(gs);
    return gsFetch(gs, path, init, true);
  }
  return res;
}
async function gsFetchFollow(gs, path, init = {}) {
  let url = path;
  for (let hop = 0; hop < 6; hop++) {
    const res = await gsFetch(gs, url, init);
    if (res.status < 300 || res.status >= 400)
      return { res, url };
    const loc = res.headers.get("location") || "";
    await res.body?.cancel();
    const next = new URL(loc, BASE2);
    if (next.origin !== BASE2)
      throw new Error(`Gradescope redirected ${path} off-site to ${next.origin}.`);
    if (/^\/login(?:[/?#]|$)/.test(next.pathname))
      throw new Error("Gradescope sent the request to its login page even after logging in again. The account may be locked or the password changed.");
    url = next.pathname + next.search;
  }
  throw new Error(`Too many redirects for ${path}.`);
}
async function getPage(gs, path) {
  const { res } = await gsFetchFollow(gs, path);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Gradescope returned ${res.status} for ${path}`);
  }
  return cheerio2.load(await res.text());
}
function csrfFrom($) {
  const token = $('meta[name="csrf-token"]').attr("content");
  if (!token)
    throw new Error("Could not find Gradescope's CSRF token on the page");
  return token;
}
function flashMessages($) {
  return $(".alert, .flash, .msg.error, .alert-error, .alert-danger").map((_, e) => $(e).text().trim().replace(/\s+/g, " ")).get().filter(Boolean);
}
async function findAssignment(gs, courseId, assignmentId) {
  const $course = await getPage(gs, `/courses/${courseId}`);
  const fromButton = ($) => {
    const btn = $(`.js-submitAssignment[data-assignment-id="${assignmentId}"]`).first();
    if (btn.length === 0)
      return null;
    return {
      title: btn.attr("data-assignment-title") || "",
      format: btn.attr("data-submission-format") || "",
      postUrl: btn.attr("data-post-url") || `/courses/${courseId}/assignments/${assignmentId}/submissions`,
      readyForSubmission: btn.attr("data-ready-for-submission") !== "false",
      showLateWarning: btn.attr("data-show-late-submission-warning") === "true"
    };
  };
  let info = fromButton($course);
  let $page = $course;
  if (!info) {
    const link = $course(`a[href*="/assignments/${assignmentId}/submissions/"]`).attr("href") || $course(`a[href$="/assignments/${assignmentId}"]`).attr("href");
    if (link) {
      $page = await getPage(gs, link);
      info = fromButton($page);
    }
  }
  if (!info) {
    throw new Error(
      `Assignment ${assignmentId} is not open for submission in course ${courseId} (no submit or resubmit button found). It may be closed, not released yet, or not belong to this course.`
    );
  }
  return { info, csrf: csrfFrom($page), referer: `${BASE2}/courses/${courseId}` };
}
function driveDirectUrl(url) {
  const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}
async function loadFile(f, index, defaultName) {
  let bytes;
  let name = f.filename;
  if (f.content_base64) {
    bytes = Uint8Array.from(Buffer.from(f.content_base64, "base64"));
  } else if (typeof f.text === "string") {
    bytes = new TextEncoder().encode(f.text);
  } else if (f.url) {
    const res = await fetch(driveDirectUrl(f.url), { redirect: "follow" });
    if (!res.ok)
      throw new Error(`Downloading file ${index + 1} failed: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (!name) {
      const cd = res.headers.get("content-disposition") || "";
      name = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    }
  } else {
    throw new Error(`File ${index + 1} needs one of: url, content_base64, text`);
  }
  if (bytes.length === 0)
    throw new Error(`File ${index + 1} is empty`);
  if (bytes.length > MAX_BYTES)
    throw new Error(`File ${index + 1} is larger than Gradescope's 100 MB limit`);
  return { name: name || defaultName, bytes };
}
async function combineIntoPdf(files) {
  const out = await PDFDocument.create();
  const LETTER = { w: 612, h: 792 };
  for (const [i, f] of files.entries()) {
    if (isPdf(f.bytes)) {
      try {
        const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
        for (const page of await out.copyPages(src, src.getPageIndices()))
          out.addPage(page);
      } catch (err) {
        throw new Error(`File ${i + 1} (${f.name}) is a PDF that could not be read for merging (${err.message}). Submit it on its own, or re-export it.`);
      }
    } else if (isJpeg(f.bytes) || isPng(f.bytes)) {
      const img = isJpeg(f.bytes) ? await out.embedJpg(f.bytes) : await out.embedPng(f.bytes);
      const landscape = img.width > img.height;
      const pw = landscape ? LETTER.h : LETTER.w;
      const ph = landscape ? LETTER.w : LETTER.h;
      const scale = Math.min(pw / img.width, ph / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      out.addPage([pw, ph]).drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
    } else if (isHeic(f.bytes)) {
      throw new Error(`File ${i + 1} (${f.name}) is a HEIC photo, which cannot be converted here. Export it as JPEG first (on iPhone: Settings > Camera > Formats > Most Compatible).`);
    } else {
      throw new Error(`File ${i + 1} (${f.name}) is not a PDF, JPEG or PNG, so it cannot go into the PDF.`);
    }
  }
  if (out.getPageCount() === 0)
    throw new Error("The combined PDF has no pages.");
  return { bytes: new Uint8Array(await out.save()), pages: out.getPageCount() };
}
function submissionIdFrom(location) {
  return location.match(/\/submissions\/(\d+)/)?.[1] || null;
}
function forgetAssignmentsCache(gs, courseId) {
  gs.config?.cache?.storage?.delete?.(`gradescope_assignments_${courseId}`);
}
async function readSelectPages(gs, courseId, assignmentId, submissionId) {
  const $ = await getPage(gs, `/courses/${courseId}/assignments/${assignmentId}/submissions/${submissionId}/select_pages`);
  const raw = $('[data-react-class="SelectPages"]').attr("data-react-props");
  if (!raw)
    throw new Error("This submission has no page-matching step (it may be a fixed-template or code assignment).");
  const props = JSON.parse(raw);
  const pa = props.pdfAttachment || {};
  return {
    questions: (props.questions || []).map((q) => ({ id: q.id, full_index: String(q.full_index), title: q.title, assignable: !!q.assignable })),
    pages: pa.pages || [],
    pageCount: pa.page_count || 0,
    status: String(pa.status_string || pa.status || ""),
    urls: props.urls,
    csrf: csrfFrom($),
    cannotReselectPages: !!props.cannotReselectPages
  };
}
async function waitForPages(gs, courseId, assignmentId, submissionId, timeoutMs = 9e4) {
  const start = Date.now();
  let data = await readSelectPages(gs, courseId, assignmentId, submissionId);
  while (!(data.status === "complete" && data.pages.length > 0) && Date.now() - start < timeoutMs) {
    if (/fail|error/i.test(data.status))
      throw new Error(`Gradescope could not process the PDF (status: ${data.status}).`);
    await new Promise((r) => setTimeout(r, 3e3));
    data = await readSelectPages(gs, courseId, assignmentId, submissionId);
  }
  if (data.pages.length === 0)
    throw new Error(`Gradescope is still processing the PDF (status: ${data.status || "unknown"}). Try match_gradescope_pages again in a minute.`);
  return data;
}
function describeQuestions(data) {
  return data.questions.filter((q) => q.assignable).map((q) => ({ question: q.full_index, title: q.title }));
}
function buildMapping(data, questionPages) {
  const kept = data.pages.filter((p) => !p.deleted);
  const assignable = data.questions.filter((q) => q.assignable);
  const mapping = Object.fromEntries(assignable.map((q) => [String(q.id), []]));
  const unknown = [];
  for (const [key, pageNumbers] of Object.entries(questionPages)) {
    const k = key.trim().replace(/^q(?:uestion)?\s*/i, "");
    const q = assignable.find((x) => x.full_index === k) || assignable.find((x) => x.title.toLowerCase() === key.trim().toLowerCase());
    if (!q) {
      unknown.push(key);
      continue;
    }
    for (const n of pageNumbers) {
      const page = kept.find((p) => p.number != null && Number(p.number) === Number(n)) ?? kept[Number(n) - 1];
      if (!page)
        throw new Error(`Question ${key}: page ${n} does not exist (the PDF has ${kept.length} pages)`);
      if (!mapping[String(q.id)].includes(page.id))
        mapping[String(q.id)].push(page.id);
    }
  }
  if (unknown.length) {
    throw new Error(
      `Unknown question(s): ${unknown.join(", ")}. Valid questions: ` + describeQuestions(data).map((q) => `${q.question} (${q.title})`).join("; ")
    );
  }
  const unmatched = assignable.filter((q) => mapping[String(q.id)].length === 0).map((q) => q.full_index);
  return { mapping, unmatched };
}
async function matchPages(gs, args) {
  const { course_id, assignment_id, submission_id } = args;
  const data = await waitForPages(gs, course_id, assignment_id, submission_id);
  const { submissionJson: submissionJson2 } = await Promise.resolve().then(() => (init_gs_student(), gs_student_exports));
  const { data: sj } = await submissionJson2(gs, { course_id, assignment_id, submission_id }, ["questions", "question_submissions"]);
  const byId = new Map((sj.question_submissions || []).map((q) => [q.question_id, q]));
  const current = {};
  const unmatched = [];
  for (const q of data.questions.filter((x) => x.assignable)) {
    const pages = byId.get(q.id)?.data?.pages;
    if (Array.isArray(pages) && pages.length)
      current[q.full_index] = pages.map(Number);
    else
      unmatched.push(q.full_index);
  }
  if (!args.question_pages || Object.keys(args.question_pages).length === 0) {
    return {
      submission_id,
      pdf_status: data.status,
      page_count: data.pages.length,
      questions: describeQuestions(data),
      current_matching: current,
      unmatched_questions: unmatched,
      all_matched: unmatched.length === 0,
      note: unmatched.length ? "Pass question_pages for the unmatched questions; questions you leave out keep their current pages." : "Every question has pages. Pass question_pages to change some of them; the rest keep their current pages."
    };
  }
  if (data.cannotReselectPages)
    throw new Error("Gradescope no longer allows changing the page selection for this submission.");
  const keyOf = (key) => {
    const k = key.trim().replace(/^q(?:uestion)?\s*/i, "");
    return data.questions.find((x) => x.full_index === k || x.title.toLowerCase() === key.trim().toLowerCase())?.full_index ?? k;
  };
  const requested = Object.fromEntries(Object.entries(args.question_pages).map(([k, v]) => [keyOf(k), v]));
  const merged = args.replace_all ? requested : { ...current, ...requested };
  const { mapping, unmatched: stillUnmatched } = buildMapping(data, merged);
  const body = new URLSearchParams({ pages_for_question: JSON.stringify(mapping), pages: JSON.stringify(data.pages) });
  if (args.dry_run) {
    return { dry_run: true, would_post_to: data.urls.update_pages_path, pages_for_question: mapping, matching: merged, page_count: data.pages.length, unmatched_questions: stillUnmatched };
  }
  const res = await gsFetch(gs, data.urls.update_pages_path, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-CSRF-Token": data.csrf,
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE2}/courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}/select_pages`
    }
  });
  const textBody = await res.text();
  if (!res.ok)
    throw new Error(`Saving the page selection failed: HTTP ${res.status} ${textBody.slice(0, 200)}`);
  let path;
  try {
    path = JSON.parse(textBody).path;
  } catch {
  }
  return {
    pages_matched: true,
    submission_url: `${BASE2}${path || `/courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}`}`,
    unmatched_questions: stillUnmatched
  };
}
async function submitAssignment(gs, args) {
  const { course_id, assignment_id } = args;
  if (!Array.isArray(args.files) || args.files.length === 0)
    throw new Error("Pass files (at least one), or repository for a code assignment submitted from GitHub.");
  const { info, csrf, referer } = await findAssignment(gs, course_id, assignment_id);
  if (info.format === "online") {
    throw new Error(`"${info.title}" is an online assignment answered in the browser; it cannot be submitted as a file.`);
  }
  const isPdfAssignment = info.format === "fixed_length" || info.format === "variable_length";
  const isTypedDocument = info.format === "typed_document";
  if (!isPdfAssignment && !isTypedDocument && info.format !== "code") {
    throw new Error(`"${info.title}" uses the "${info.format}" submission format, which this tool does not support yet. Submit it on the Gradescope website.`);
  }
  if (isPdfAssignment && !info.readyForSubmission) {
    throw new Error(`"${info.title}" is not accepting submissions yet (the instructor has not finished its outline).`);
  }
  const form = new FormData();
  form.append("utf8", "\u2713");
  form.append("authenticity_token", csrf);
  const loaded = [];
  let combinedFrom = null;
  if (isPdfAssignment) {
    const files = await Promise.all(args.files.map((f, i) => loadFile(f, i, `file${i + 1}`)));
    let bytes;
    let name;
    if (files.length === 1 && isPdf(files[0].bytes)) {
      bytes = files[0].bytes;
      name = /\.pdf$/i.test(files[0].name) ? files[0].name : "submission.pdf";
    } else {
      if (files.length === 1 && !isJpeg(files[0].bytes) && !isPng(files[0].bytes) && !isHeic(files[0].bytes)) {
        throw new Error(
          "The file is not a PDF (it does not start with %PDF-) or a JPEG/PNG photo. If it came from a share link, make sure the link downloads the file itself rather than a preview page."
        );
      }
      const combined = await combineIntoPdf(files);
      bytes = combined.bytes;
      name = "submission.pdf";
      combinedFrom = files.map((f) => f.name);
      loaded.push({ name, bytes: bytes.length, pages: combined.pages, combined_from: combinedFrom });
    }
    if (bytes.length > MAX_BYTES)
      throw new Error("The PDF is larger than Gradescope's 100 MB limit.");
    form.append("pdf_attachment", new Blob([bytes], { type: "application/pdf" }), name);
    if (!combinedFrom)
      loaded.push({ name, bytes: bytes.length });
  } else if (isTypedDocument) {
    if (args.files.length !== 1)
      throw new Error(`"${info.title}" takes exactly one document file.`);
    const f = await loadFile(args.files[0], 0, "document");
    form.append("file", new Blob([f.bytes], { type: "application/octet-stream" }), f.name);
    loaded.push({ name: f.name, bytes: f.bytes.length });
  } else {
    form.append("submission[method]", "upload");
    for (const [i, file] of args.files.entries()) {
      const f = await loadFile(file, i, `file${i + 1}`);
      form.append("submission[files][]", new Blob([f.bytes], { type: "application/octet-stream" }), f.name);
      loaded.push({ name: f.name, bytes: f.bytes.length });
    }
    if (args.leaderboard_name)
      form.append("submission[leaderboard_name]", args.leaderboard_name);
  }
  const summary = {
    assignment: info.title,
    kind: isPdfAssignment ? `pdf (${info.format})` : isTypedDocument ? "document" : "code upload",
    files: loaded,
    late_submission: info.showLateWarning
  };
  if (args.dry_run)
    return { dry_run: true, would_post_to: info.postUrl, ...summary };
  const res = await gsFetch(gs, info.postUrl, {
    method: "POST",
    body: form,
    headers: isPdfAssignment || isTypedDocument ? { Referer: referer } : { Referer: referer, "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" }
  });
  forgetAssignmentsCache(gs, course_id);
  let location = res.headers.get("location") || "";
  if (!location && res.headers.get("content-type")?.includes("json")) {
    try {
      const j = await res.json();
      location = j.url || j.path || j.redirect_url || j.location || "";
    } catch {
    }
  }
  const submissionId = submissionIdFrom(location);
  if (!submissionId) {
    let reasons = [];
    try {
      const $ = location ? await getPage(gs, location) : cheerio2.load(await res.text());
      reasons = flashMessages($);
    } catch {
    }
    throw new Error(`Gradescope did not accept the submission (HTTP ${res.status}). ${reasons.join(" ") || "No reason given."}`);
  }
  const result = {
    submitted: true,
    submission_id: submissionId,
    submission_url: `${BASE2}/courses/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`,
    ...summary
  };
  if (info.format === "variable_length") {
    if (args.question_pages && Object.keys(args.question_pages).length > 0) {
      Object.assign(result, await matchPages(gs, { course_id, assignment_id, submission_id: submissionId, question_pages: args.question_pages }));
    } else {
      const data = await waitForPages(gs, course_id, assignment_id, submissionId);
      result.pages_matched = false;
      result.page_count = data.pages.length;
      result.questions = describeQuestions(data);
      result.next_step = "Pages are not matched to questions yet. Call match_gradescope_pages with question_pages.";
    }
  }
  return result;
}
function sessionInfo() {
  return { logged_in_at: authenticatedAt ? new Date(authenticatedAt).toISOString() : null, max_age_minutes: SESSION_MAX_AGE_MS / 6e4 };
}
var BASE2, UA, MAX_BYTES, SESSION_MAX_AGE_MS, authenticatedAt, loginInFlight, isPdf, isJpeg, isPng, isHeic;
var init_gs_submit = __esm({
  "gs-submit.ts"() {
    BASE2 = "https://www.gradescope.com";
    UA = "Canvas-MCP/1.1.0";
    MAX_BYTES = 100 * 1024 * 1024;
    SESSION_MAX_AGE_MS = 20 * 60 * 1e3;
    authenticatedAt = 0;
    loginInFlight = null;
    isPdf = (b) => new TextDecoder().decode(b.slice(0, 1024)).includes("%PDF-");
    isJpeg = (b) => b[0] === 255 && b[1] === 216 && b[2] === 255;
    isPng = (b) => b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71;
    isHeic = (b) => new TextDecoder().decode(b.slice(4, 12)).startsWith("ftyphei") || new TextDecoder().decode(b.slice(4, 12)).startsWith("ftypmif");
  }
});

// ../src/gradescope-api.ts
import * as cheerio from "cheerio@1.2.0";
var DEFAULT_GRADESCOPE_BASE_URL = "https://www.gradescope.com";
var CookieManager = class {
  constructor() {
    this.cookies = /* @__PURE__ */ new Map();
  }
  /**
   * Parse and store cookies from Set-Cookie header
   */
  setCookiesFromHeaders(headers) {
    const setCookieHeaders = headers.getSetCookie?.() || [];
    for (const cookie of setCookieHeaders) {
      const parts = cookie.split(";")[0].split("=");
      if (parts.length >= 2) {
        const name = parts[0].trim();
        const value = parts.slice(1).join("=").trim();
        this.cookies.set(name, value);
      }
    }
  }
  /**
   * Get cookie string for request header
   */
  getCookieString() {
    const entries = [];
    for (const [name, value] of this.cookies.entries()) {
      entries.push(`${name}=${value}`);
    }
    return entries.join("; ");
  }
  /**
   * Clear all cookies
   */
  clear() {
    this.cookies.clear();
  }
};
var GradescopeApi = class {
  constructor(config) {
    this.isAuthenticated = false;
    this.csrfToken = "";
    this.config = config;
    this.cookieManager = new CookieManager();
  }
  /**
   * Authenticate with Gradescope using real login flow
   */
  async authenticate() {
    if (this.isAuthenticated) {
      return true;
    }
    try {
      this.config.logger.debug("Starting Gradescope authentication...");
      const authToken = await this.getAuthTokenAndInitSession();
      if (!authToken) {
        this.config.logger.error("Failed to get authentication token");
        return false;
      }
      const loginSuccess = await this.loginWithCredentials(authToken);
      if (!loginSuccess) {
        this.config.logger.error("Login failed");
        return false;
      }
      this.isAuthenticated = true;
      this.config.logger.debug("Gradescope authentication successful");
      return true;
    } catch (error) {
      this.config.logger.error("Gradescope authentication failed:", error);
      return false;
    }
  }
  /**
   * Get authenticity token from homepage and initialize session
   */
  async getAuthTokenAndInitSession() {
    try {
      const response = await fetch(DEFAULT_GRADESCOPE_BASE_URL, {
        method: "GET",
        headers: {
          "User-Agent": "Canvas-MCP/1.1.0"
        }
      });
      if (!response.ok) {
        this.config.logger.error(`Failed to load homepage: ${response.status}`);
        return null;
      }
      this.cookieManager.setCookiesFromHeaders(response.headers);
      const html = await response.text();
      const $ = cheerio.load(html);
      const authTokenElement = $(
        'form[action="/login"] input[name="authenticity_token"]'
      );
      const authToken = authTokenElement.attr("value");
      if (!authToken) {
        this.config.logger.error(
          "Could not find authenticity token on homepage"
        );
        return null;
      }
      return authToken;
    } catch (error) {
      this.config.logger.error("Error getting auth token:", error);
      return null;
    }
  }
  /**
   * Login with credentials and auth token
   */
  async loginWithCredentials(authToken) {
    try {
      const loginEndpoint = `${DEFAULT_GRADESCOPE_BASE_URL}/login`;
      const cookieHeader = this.cookieManager.getCookieString();
      const loginData = new URLSearchParams({
        utf8: "\u2713",
        "session[email]": this.config.email,
        "session[password]": this.config.password,
        "session[remember_me]": "0",
        commit: "Log In",
        "session[remember_me_sso]": "0",
        authenticity_token: authToken
      });
      const response = await fetch(loginEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "Canvas-MCP/1.1.0",
          Cookie: cookieHeader,
          Referer: DEFAULT_GRADESCOPE_BASE_URL
        },
        body: loginData,
        redirect: "manual"
        // Handle redirects manually to detect success
      });
      this.cookieManager.setCookiesFromHeaders(response.headers);
      if (response.status === 302) {
        this.config.logger.debug("Login redirect detected - success");
        const redirectLocation = response.headers.get("location");
        if (redirectLocation) {
          await this.extractCSRFToken(redirectLocation);
        }
        return true;
      } else {
        this.config.logger.error(`Login failed with status: ${response.status}`);
        return false;
      }
    } catch (error) {
      this.config.logger.error("Error during login:", error);
      return false;
    }
  }
  /**
   * Extract CSRF token from account page after successful login
   */
  async extractCSRFToken(redirectUrl) {
    try {
      const fullUrl = redirectUrl.startsWith("http") ? redirectUrl : `${DEFAULT_GRADESCOPE_BASE_URL}${redirectUrl}`;
      const cookieHeader = this.cookieManager.getCookieString();
      const response = await fetch(fullUrl, {
        method: "GET",
        headers: {
          "User-Agent": "Canvas-MCP/1.1.0",
          Cookie: cookieHeader
        }
      });
      if (response.ok) {
        this.cookieManager.setCookiesFromHeaders(response.headers);
        const html = await response.text();
        const $ = cheerio.load(html);
        const csrfTokenElement = $('meta[name="csrf-token"]');
        const csrfToken = csrfTokenElement.attr("content");
        if (csrfToken) {
          this.csrfToken = csrfToken;
          this.config.logger.debug("CSRF token extracted successfully");
        }
      }
    } catch (error) {
      this.config.logger.error("Error extracting CSRF token:", error);
    }
  }
  /**
   * Make authenticated request to Gradescope
   */
  async makeAuthenticatedRequest(url, options = {}) {
    if (!await this.authenticate()) {
      return null;
    }
    try {
      const cookieHeader = this.cookieManager.getCookieString();
      const headers = {
        "User-Agent": "Canvas-MCP/1.1.0",
        Cookie: cookieHeader,
        ...options.headers
      };
      if (this.csrfToken) {
        headers["X-CSRF-Token"] = this.csrfToken;
      }
      const response = await fetch(url, {
        ...options,
        headers
      });
      this.cookieManager.setCookiesFromHeaders(response.headers);
      if (response.status === 401) {
        this.config.logger.error(
          "Unauthorized - authentication may have expired"
        );
        this.isAuthenticated = false;
        return null;
      }
      if (!response.ok) {
        this.config.logger.error(
          `Request failed: ${response.status} ${response.statusText}`
        );
        return null;
      }
      return response;
    } catch (error) {
      this.config.logger.error("Error making authenticated request:", error);
      return null;
    }
  }
  /**
   * Get all courses from Gradescope
   */
  async getGradescopeCourses() {
    const cached = this.config.cache.get("gradescope_courses");
    if (cached) {
      this.config.logger.debug("Using cached Gradescope courses data");
      return cached;
    }
    try {
      const accountUrl = `${DEFAULT_GRADESCOPE_BASE_URL}/account`;
      const response = await this.makeAuthenticatedRequest(accountUrl);
      if (!response) {
        return null;
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      const courses = { instructor: {}, student: {} };
      const instructorCourses = await this.parseCoursesFromHTML(
        $,
        "Instructor Courses"
      );
      if (instructorCourses) {
        courses.instructor = instructorCourses.courses;
      }
      const studentCourses = await this.parseCoursesFromHTML(
        $,
        "Student Courses"
      );
      if (studentCourses) {
        courses.student = studentCourses.courses;
      }
      if (Object.keys(courses.instructor).length === 0 && Object.keys(courses.student).length === 0) {
        const yourCourses = await this.parseCoursesFromHTML($, "Your Courses");
        if (yourCourses) {
          if (yourCourses.isInstructor) {
            courses.instructor = yourCourses.courses;
          } else {
            courses.student = yourCourses.courses;
          }
        }
      }
      const serializedCourses = {
        student: Object.fromEntries(
          Object.entries(courses.student).map(([id, course]) => [
            `Course ID: ${id}`,
            course
          ])
        ),
        instructor: Object.fromEntries(
          Object.entries(courses.instructor).map(([id, course]) => [
            `Course ID: ${id}`,
            course
          ])
        )
      };
      this.config.cache.set("gradescope_courses", serializedCourses);
      this.config.logger.debug(
        `Retrieved ${Object.keys(courses.student).length} student courses and ${Object.keys(courses.instructor).length} instructor courses`
      );
      return serializedCourses;
    } catch (error) {
      this.config.logger.error("Error in getGradescopeCourses:", error);
      return null;
    }
  }
  /**
   * Parse courses from HTML
   */
  async parseCoursesFromHTML($, userType) {
    const courses = {};
    const coursesHeading = $(`h1.pageHeading:contains("${userType}")`).first();
    if (coursesHeading.length === 0) {
      return null;
    }
    const button = coursesHeading.next("button");
    const isInstructor = button.text().trim().includes("Create a new course");
    const courseList = coursesHeading.nextAll(".courseList").first();
    if (courseList.length === 0) {
      return { courses, isInstructor };
    }
    courseList.find(".courseList--term").each((_, termElement) => {
      const termEl = $(termElement);
      const termText = termEl.contents().first().text().trim();
      const [semester, year] = termText.split(" ");
      termEl.find("a").each((_2, courseElement) => {
        const courseEl = $(courseElement);
        const href = courseEl.attr("href");
        if (!href)
          return;
        const courseId = href.split("/").pop();
        if (!courseId)
          return;
        const shortName = courseEl.find("h3.courseBox--shortname").text().trim();
        const fullName = courseEl.find(".courseBox--name").text().trim();
        let numGradesPublished = null;
        let numAssignments = "";
        if (userType === "Instructor Courses" || isInstructor) {
          const gradesEl = courseEl.find(".courseBox--noGradesPublised");
          if (gradesEl.length > 0) {
            numGradesPublished = gradesEl.text().trim();
          }
          const assignmentsEl = courseEl.find(
            ".courseBox--assignments.courseBox--assignments-unpublished"
          );
          if (assignmentsEl.length > 0) {
            numAssignments = assignmentsEl.text().trim();
          }
        } else {
          const assignmentsEl = courseEl.find(".courseBox--assignments");
          if (assignmentsEl.length > 0) {
            numAssignments = assignmentsEl.text().trim();
          }
        }
        courses[courseId] = {
          id: courseId,
          name: shortName,
          full_name: fullName,
          semester: semester || "",
          year: year || "",
          num_grades_published: numGradesPublished,
          num_assignments: numAssignments
        };
      });
    });
    return { courses, isInstructor };
  }
  /**
   * Get a course from Gradescope by name
   */
  async getGradescopeCourseByName(courseName) {
    const courses = await this.getGradescopeCourses();
    if (!courses) {
      return null;
    }
    for (const course of Object.values(courses.student)) {
      if (course.name.toLowerCase().includes(courseName.toLowerCase()) || course.full_name.toLowerCase().includes(courseName.toLowerCase())) {
        return course;
      }
    }
    for (const course of Object.values(courses.instructor)) {
      if (course.name.toLowerCase().includes(courseName.toLowerCase()) || course.full_name.toLowerCase().includes(courseName.toLowerCase())) {
        return course;
      }
    }
    return null;
  }
  /**
   * Get all assignments for a course
   */
  async getGradescopeAssignments(courseId) {
    const cached = this.config.cache.get(
      "gradescope_assignments",
      courseId
    );
    if (cached) {
      this.config.logger.debug(
        `Using cached Gradescope assignments for course ${courseId}`
      );
      return cached;
    }
    try {
      const courseUrl = `${DEFAULT_GRADESCOPE_BASE_URL}/courses/${courseId}`;
      const response = await this.makeAuthenticatedRequest(courseUrl);
      if (!response) {
        return null;
      }
      const html = await response.text();
      const $ = cheerio.load(html);
      let assignments = this.parseAssignmentsInstructorView($);
      if (!assignments || assignments.length === 0) {
        assignments = this.parseAssignmentsStudentView($);
      }
      if (assignments) {
        this.config.cache.set("gradescope_assignments", assignments, courseId);
        this.config.logger.debug(
          `Retrieved ${assignments.length} assignments for course ${courseId}`
        );
      }
      return assignments;
    } catch (error) {
      this.config.logger.error("Error in getGradescopeAssignments:", error);
      return null;
    }
  }
  /**
   * Parse assignments from instructor view
   */
  parseAssignmentsInstructorView($) {
    const assignmentsList = [];
    const elementWithProps = $('div[data-react-class="AssignmentsTable"]');
    if (elementWithProps.length === 0) {
      return null;
    }
    const propsStr = elementWithProps.attr("data-react-props");
    if (!propsStr) {
      return null;
    }
    try {
      const assignmentJson = JSON.parse(propsStr);
      for (const assignment of assignmentJson.table_data || []) {
        if (assignment.type !== "assignment") {
          continue;
        }
        const assignmentObj = {
          assignment_id: assignment.url?.split("/").pop() || "",
          name: assignment.title || "",
          release_date: assignment.submission_window?.release_date ? new Date(assignment.submission_window.release_date) : null,
          due_date: assignment.submission_window?.due_date ? new Date(assignment.submission_window.due_date) : null,
          late_due_date: assignment.submission_window?.hard_due_date ? new Date(assignment.submission_window.hard_due_date) : null,
          submissions_status: null,
          grade: null,
          max_grade: assignment.total_points ? parseFloat(assignment.total_points) : null
        };
        assignmentsList.push(assignmentObj);
      }
      return assignmentsList;
    } catch (error) {
      this.config.logger.error(
        "Error parsing instructor view assignments:",
        error
      );
      return null;
    }
  }
  /**
   * Parse assignments from student view
   */
  parseAssignmentsStudentView($) {
    const assignmentsList = [];
    const assignmentRows = $('tr[role="row"]').slice(1, -1);
    assignmentRows.each((_, row) => {
      const rowEl = $(row);
      const cells = rowEl.find("th, td");
      if (cells.length < 3)
        return;
      const nameCell = $(cells[0]);
      const name = nameCell.text().trim();
      let assignmentId = null;
      const assignmentLink = nameCell.find("a[href]");
      const assignmentButton = nameCell.find("button.js-submitAssignment");
      if (assignmentLink.length > 0) {
        const href = assignmentLink.attr("href");
        if (href) {
          assignmentId = href.split("/")[4];
        }
      } else if (assignmentButton.length > 0) {
        assignmentId = assignmentButton.attr("data-assignment-id") || null;
      }
      let grade = null;
      let maxGrade = null;
      let submissionStatus = "Not Submitted";
      const pointsText = $(cells[1]).text().trim();
      if (pointsText.includes(" / ")) {
        const points = pointsText.split(" / ");
        try {
          grade = parseFloat(points[0]);
          maxGrade = parseFloat(points[1]);
          submissionStatus = "Submitted";
        } catch {
        }
      } else {
        submissionStatus = pointsText;
      }
      let releaseDate = null;
      let dueDate = null;
      let lateDueDate = null;
      const dateCell = $(cells[2]);
      const releaseDateEl = dateCell.find(".submissionTimeChart--releaseDate");
      const dueDateEls = dateCell.find(".submissionTimeChart--dueDate");
      if (releaseDateEl.length > 0) {
        const datetime = releaseDateEl.attr("datetime");
        if (datetime) {
          releaseDate = new Date(datetime);
        }
      }
      if (dueDateEls.length > 0) {
        const firstDueDatetime = $(dueDateEls[0]).attr("datetime");
        if (firstDueDatetime) {
          dueDate = new Date(firstDueDatetime);
        }
        if (dueDateEls.length > 1) {
          const lateDueDatetime = $(dueDateEls[1]).attr("datetime");
          if (lateDueDatetime) {
            lateDueDate = new Date(lateDueDatetime);
          }
        }
      }
      const assignmentObj = {
        assignment_id: assignmentId || "",
        name,
        release_date: releaseDate,
        due_date: dueDate,
        late_due_date: lateDueDate,
        submissions_status: submissionStatus,
        grade,
        max_grade: maxGrade
      };
      assignmentsList.push(assignmentObj);
    });
    return assignmentsList;
  }
  /**
   * Get an assignment by name within a course
   */
  async getGradescopeAssignmentByName(courseId, assignmentName) {
    const assignments = await this.getGradescopeAssignments(courseId);
    if (!assignments) {
      return null;
    }
    for (const assignment of assignments) {
      if (assignment.name.toLowerCase().includes(assignmentName.toLowerCase())) {
        return assignment;
      }
    }
    return null;
  }
};

// ../src/cache.ts
var CACHE_TTL = {
  courses: 3600,
  // 1 hour
  modules: 1800,
  // 30 minutes
  module_items: 1800,
  // 30 minutes
  file_urls: 3600,
  // 1 hour
  assignments: 1800,
  // 30 minutes
  gradescope_courses: 3600,
  // 1 hour
  gradescope_assignments: 1800,
  // 30 minutes
  gradescope_submissions: 1800
  // 30 minutes
};
var WorkerCache = class {
  constructor() {
    this.storage = /* @__PURE__ */ new Map();
  }
  /**
   * Get an item from cache if it exists and is not expired
   */
  get(cacheType, key) {
    const cacheKey = key ? `${cacheType}_${key}` : cacheType;
    const entry = this.storage.get(cacheKey);
    if (!entry) {
      return null;
    }
    const currentTime = Date.now() / 1e3;
    if (currentTime - entry.timestamp > entry.ttl) {
      this.storage.delete(cacheKey);
      return null;
    }
    return entry.value;
  }
  /**
   * Store an item in cache with current timestamp
   */
  set(cacheType, value, key) {
    const cacheKey = key ? `${cacheType}_${key}` : cacheType;
    const ttl = CACHE_TTL[cacheType];
    const timestamp = Date.now() / 1e3;
    this.storage.set(cacheKey, {
      value,
      timestamp,
      ttl
    });
  }
  /**
   * Clear all cache entries
   */
  clear() {
    this.storage.clear();
  }
  /**
   * Clear specific cache type
   */
  clearType(cacheType) {
    const keysToDelete = [];
    for (const key of this.storage.keys()) {
      if (key.startsWith(cacheType)) {
        keysToDelete.push(key);
      }
    }
    keysToDelete.forEach((key) => this.storage.delete(key));
  }
  /**
   * Get cache statistics for debugging
   */
  getStats() {
    const cacheTypes = {};
    for (const key of this.storage.keys()) {
      const type = key.split("_")[0];
      cacheTypes[type] = (cacheTypes[type] || 0) + 1;
    }
    return {
      totalEntries: this.storage.size,
      cacheTypes
    };
  }
};

// ../src/config.ts
var Logger = class {
  constructor(debug = false) {
    this.debugMode = debug;
  }
  log(...args) {
    console.log("[Canvas-MCP]", ...args);
  }
  error(...args) {
    console.error("[Canvas-MCP ERROR]", ...args);
  }
  debug(...args) {
    if (this.debugMode) {
      console.log("[Canvas-MCP DEBUG]", ...args);
    }
  }
  warn(...args) {
    console.warn("[Canvas-MCP WARN]", ...args);
  }
};

// gs-server.ts
init_gs_submit();
init_gs_student();

// gs-extra.ts
init_gs_submit();
init_gs_student();
import * as cheerio3 from "cheerio@1.2.0";
import { Buffer as Buffer3 } from "node:buffer";
var BASE3 = "https://www.gradescope.com";
var HOST = new URL(BASE3).host;
var XHR = (csrf, referer) => ({
  "X-CSRF-Token": csrf,
  "X-Requested-With": "XMLHttpRequest",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  Referer: referer
});
function sanitize(v, depth = 0) {
  if (depth > 40)
    return "[\u2026]";
  if (Array.isArray(v))
    return v.map((x) => sanitize(x, depth + 1));
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === "course_members")
        out.course_members_count = Array.isArray(x) ? x.length : null;
      else if (/token|password|secret|session_key/i.test(k))
        out[k] = "[removed]";
      else
        out[k] = sanitize(x, depth + 1);
    }
    return out;
  }
  return v;
}
var BLOCKED_PATH = /^\/(logout|login|signup|auth\b|auth\/|identities|github_authentication|bitbucket_authentication|gitlab|saml|sso|password|reset_password|users\/password)/i;
function checkPath(raw) {
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    throw new Error('path must be a Gradescope path starting with a single "/", e.g. /courses/123 (no scheme or host).');
  }
  const url = new URL(raw, BASE3);
  if (url.host !== HOST)
    throw new Error("Only www.gradescope.com pages can be read.");
  if (BLOCKED_PATH.test(url.pathname) || /logout/i.test(url.pathname)) {
    throw new Error(`Refusing to open ${url.pathname}: that page changes the session or account (log out, sign-in, linked accounts).`);
  }
  return url.pathname + url.search;
}
function pageText($, root) {
  const el = root.clone();
  el.find("script, style, noscript, svg, template, [aria-hidden='true'], .js-dropzonePreviewTemplate").remove();
  el.find("br").replaceWith("\n");
  el.find("p, div, li, tr, h1, h2, h3, h4, h5, h6, section, header, footer, table, dt, dd, label").each((_, e) => {
    $(e).append("\n");
  });
  el.find("td, th").each((_, e) => {
    $(e).append(" | ");
  });
  return el.text().split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).filter(Boolean).join("\n");
}
async function readPage(gs, args) {
  await ensureSession(gs);
  const maxChars = Math.min(Math.max(args.max_chars ?? 6e4, 2e3), 2e5);
  let path = checkPath(args.path);
  let res = null;
  const redirects = [];
  for (let hop = 0; hop < 5; hop++) {
    res = await gsFetch(gs, path, { headers: { Accept: path.includes(".json") ? "application/json" : "text/html,application/json" } });
    if (res.status < 300 || res.status >= 400)
      break;
    const loc = res.headers.get("location") || "";
    await res.body?.cancel();
    const next = new URL(loc, BASE3);
    if (next.host !== HOST)
      return { path, status: res.status, redirected_off_site_to: next.origin, note: "The page redirects outside Gradescope; not followed." };
    path = checkPath(next.pathname + next.search);
    redirects.push(path);
  }
  const ct = res.headers.get("content-type") || "";
  const base = { path, status: res.status, ...redirects.length ? { redirected_to: path } : {} };
  if (/json/.test(ct)) {
    const data = sanitize(await res.json().catch(() => null));
    let s = JSON.stringify(data);
    const truncated = s.length > maxChars;
    if (truncated)
      s = s.slice(0, maxChars);
    return { ...base, content_type: "json", ...truncated ? { truncated: true, json_text: s } : { json: data } };
  }
  if (!/html/.test(ct)) {
    const bytes = (await res.arrayBuffer()).byteLength;
    return { ...base, content_type: ct, bytes, note: "Not a web page; use download_gradescope_submission_files for submission files." };
  }
  const $ = cheerio3.load(await res.text());
  $('meta[name="csrf-token"], meta[name="csrf-param"]').remove();
  const components = $("[data-react-class]").map((_, e) => {
    const name = $(e).attr("data-react-class") || "";
    if (name === "SessionTimeoutManager")
      return null;
    if (args.component && name !== args.component)
      return null;
    let props = null;
    try {
      props = sanitize(JSON.parse($(e).attr("data-react-props") || "null"));
    } catch {
    }
    return { component: name, props };
  }).get().filter(Boolean);
  const forms = $("form").map((_, f) => ({
    method: ($(f).find('input[name="_method"]').attr("value") || $(f).attr("method") || "get").toUpperCase(),
    action: $(f).attr("action") || null,
    fields: [...new Set($(f).find("input, select, textarea").map((_2, i) => $(i).attr("name")).get().filter((n) => n && n !== "authenticity_token" && n !== "utf8"))]
  })).get();
  const links = [];
  const seen = /* @__PURE__ */ new Set();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!/^\/(?!\/)/.test(href) && !href.startsWith(BASE3))
      return;
    if (seen.has(href) || /logout/i.test(href))
      return;
    seen.add(href);
    links.push({ text: $(a).text().trim().replace(/\s+/g, " ").slice(0, 80), href });
  });
  const root = $("main").length ? $("main").first() : $("body");
  let text2 = pageText($, root);
  const out = {
    ...base,
    title: $("title").text().trim(),
    text: text2,
    links: links.slice(0, 150),
    forms,
    ...args.include_props === false ? { components: components.map((c) => c.component) } : { components }
  };
  let size = JSON.stringify(out).length;
  if (size > maxChars) {
    if (args.include_props !== false && components.length) {
      out.components = components.map((c) => {
        const s = JSON.stringify(c.props);
        return s.length > maxChars / 2 ? { component: c.component, props_truncated: s.slice(0, Math.floor(maxChars / 2)) } : c;
      });
      size = JSON.stringify(out).length;
    }
    if (size > maxChars) {
      out.text = text2.slice(0, Math.max(1e3, text2.length - (size - maxChars)));
      out.truncated = true;
    }
  }
  return out;
}
async function assignmentInfo(gs, args) {
  await ensureSession(gs);
  const { course_id, assignment_id } = args;
  const $ = await getPage(gs, `/courses/${course_id}`);
  const btn = $(`.js-submitAssignment[data-assignment-id="${assignment_id}"]`).first();
  const fromButton = btn.length ? {
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
    template_url: btn.attr("data-template-url") || null
  } : null;
  const all = await gs.getGradescopeAssignments(course_id);
  const row = (all || []).find((a) => String(a.assignment_id) === String(assignment_id)) || null;
  let submissionId = null;
  try {
    submissionId = await resolveSubmissionId(gs, { course_id, assignment_id });
  } catch {
  }
  let fromSubmission = null;
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
      course_timezone: a.timezone?.identifier || null
    };
  }
  if (!fromButton && !fromSubmission && !row) {
    throw new Error(`Assignment ${assignment_id} was not found in course ${course_id}.`);
  }
  return {
    course_id,
    assignment_id,
    ...row ? { name: row.name, release_date: row.release_date, due_date: row.due_date, late_due_date: row.late_due_date, status: row.submissions_status, grade: row.grade, max_grade: row.max_grade } : {},
    open_for_submission: !!fromButton,
    has_submission: !!submissionId,
    submission_id: submissionId,
    ...fromButton || {},
    ...fromSubmission || {},
    url: `${BASE3}/courses/${course_id}/assignments/${assignment_id}`
  };
}
async function listRegradeRequests(gs, args) {
  await ensureSession(gs);
  const $ = await getPage(gs, `/courses/${args.course_id}/regrade_requests`);
  const table = $("table").first();
  const headers = table.find("thead th").map((_, th) => $(th).text().trim().toLowerCase().replace(/\s+/g, "_")).get();
  const requests = table.find("tbody tr").map((_, tr) => {
    const cells = $(tr).find("td, th");
    if (cells.length < 2)
      return null;
    const row = {};
    cells.each((i, td) => {
      row[headers[i] || `col${i}`] = $(td).text().trim().replace(/\s+/g, " ");
    });
    const link = $(tr).find("a[href]").first().attr("href");
    if (link)
      row.url = link.startsWith("http") ? link : BASE3 + link;
    return row;
  }).get().filter(Boolean);
  return { course_id: args.course_id, count: requests.length, requests };
}
var questionKey = (s) => String(s).trim().replace(/^q(?:uestion)?\s*/i, "");
async function requestRegrade(gs, args) {
  if (!args.comment || !args.comment.trim())
    throw new Error("comment is required: explain to the grader why the question should be regraded.");
  const { submissionId, path, data: d } = await submissionJson(gs, args);
  const a = d.assignment || {};
  if (!a.regrade_requests_open)
    throw new Error(`Regrade requests are not open for "${a.title}".`);
  const now = Date.now();
  if (a.regrade_request_start && new Date(a.regrade_request_start).getTime() > now)
    throw new Error(`Regrade requests open at ${a.regrade_request_start}.`);
  if (a.regrade_request_end && new Date(a.regrade_request_end).getTime() < now)
    throw new Error(`Regrade requests closed at ${a.regrade_request_end}.`);
  const questions = d.questions || [];
  const key = questionKey(args.question);
  const q = questions.find((x) => String(x.full_index) === key) || questions.find((x) => (x.title || "").toLowerCase() === String(args.question).trim().toLowerCase());
  const qsub = q && (d.question_submissions || []).find((s) => s.question_id === q.id);
  if (!q || !qsub) {
    const valid = (d.question_submissions || []).map((s) => questions.find((x) => x.id === s.question_id)).filter(Boolean).map((x) => `${x.full_index} (${x.title})`);
    throw new Error(`Question "${args.question}" not found in this submission. Valid questions: ${valid.join("; ")}`);
  }
  const existing = (d.regrade_requests || []).filter((r) => r.question_submission_id === qsub.id).sort((x, y) => new Date(y.created_at || 0).getTime() - new Date(x.created_at || 0).getTime())[0];
  const flat = (r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v === null || typeof v !== "object"));
  if (existing && !args.update_existing) {
    return { already_requested: true, question: q.full_index, existing_request: flat(existing), note: "Pass update_existing: true to replace the comment on this request." };
  }
  const url = existing ? `${d.paths.regrade_requests_path}/${existing.id}` : d.paths.regrade_requests_path;
  const method = existing ? "PATCH" : "POST";
  const summary = { assignment: a.title, question: q.full_index, question_title: q.title, current_score: qsub.score != null ? Number(qsub.score) : null, action: existing ? "update existing request" : "create request" };
  if (args.dry_run)
    return { dry_run: true, would_send: `${method} ${url}`, ...summary, comment: args.comment };
  const $ = await getPage(gs, path);
  const body = new URLSearchParams({ "regrade_request[student_comment]": args.comment, "regrade_request[question_submission_id]": String(qsub.id) });
  const res = await gsFetch(gs, url, { method, body, headers: XHR(csrfFrom($), BASE3 + path) });
  const textBody = await res.text();
  if (res.status === 403)
    throw new Error("Gradescope refused the regrade request (403): requests may be closed for this question.");
  if (!res.ok)
    throw new Error(`Regrade request failed: HTTP ${res.status} ${textBody.slice(0, 200)}`);
  const after = await submissionJson(gs, { ...args, submission_id: submissionId }, ["regrade_requests"]);
  const saved = (after.data.regrade_requests || []).find((r) => r.question_submission_id === qsub.id);
  return { submitted: !!saved, ...summary, request: saved ? flat(saved) : null, url: BASE3 + path };
}
async function groupState(gs, ref) {
  const r = await submissionJson(gs, ref, ["assignment", "ownerships", "course_members", "current_user", "paths"]);
  const d = r.data;
  const roster = new Map((d.course_members || []).map((m) => [m.id, m]));
  const members = (d.ownerships || []).map((o) => {
    const m = roster.get(o.user_id) || {};
    return { name: m.name || null, email: m.email || null, user_id: o.user_id, ownership_id: o.id, active: !!o.active, uploader: !!o.uploader, is_you: o.user_id === d.current_user?.id };
  });
  return { ...r, members, roster, currentUserId: d.current_user?.id };
}
async function groupMembers(gs, args) {
  const { submissionId, data: d, members } = await groupState(gs, args);
  const a = d.assignment || {};
  return {
    assignment: a.title,
    submission_id: submissionId,
    group_size_limit: a.group_size ?? null,
    members_updatable: !!a.group_members_updatable,
    members
  };
}
async function updateGroupMembers(gs, args) {
  const add = (args.add_emails || []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const remove = (args.remove_emails || []).map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!add.length && !remove.length)
    throw new Error("Pass add_emails and/or remove_emails.");
  const { submissionId, path, data: d, members, roster, currentUserId } = await groupState(gs, args);
  const a = d.assignment || {};
  if (!a.group_members_updatable)
    throw new Error(`Group members cannot be changed for "${a.title}".`);
  const byEmail = /* @__PURE__ */ new Map();
  for (const m of roster.values())
    if (m.email)
      byEmail.set(String(m.email).toLowerCase(), m);
  const toAdd = [];
  const skipped = [];
  const notFound = [];
  for (const e of add) {
    const m = byEmail.get(e);
    if (!m)
      notFound.push(e);
    else if (members.some((x) => x.user_id === m.id))
      skipped.push(`${e} (already in the group)`);
    else
      toAdd.push(m);
  }
  if (notFound.length)
    throw new Error(`No student in this course has the email: ${notFound.join(", ")}. Emails must match exactly.`);
  const toRemove = [];
  for (const e of remove) {
    const m = members.find((x) => (x.email || "").toLowerCase() === e);
    if (!m)
      skipped.push(`${e} (not in the group)`);
    else if (m.is_you)
      throw new Error("Refusing to remove yourself: you would lose access to this submission. Do it on the Gradescope website if you mean it.");
    else if (m.uploader)
      throw new Error(`Refusing to remove ${e}: they uploaded the submission.`);
    else
      toRemove.push(m);
  }
  const finalCount = members.length + toAdd.length - toRemove.length;
  if (a.group_size && finalCount > Number(a.group_size))
    throw new Error(`The group would have ${finalCount} members; the limit is ${a.group_size}.`);
  const plan = {
    assignment: a.title,
    add: toAdd.map((m) => ({ name: m.name, email: m.email })),
    remove: toRemove.map((m) => ({ name: m.name, email: m.email })),
    ...skipped.length ? { skipped } : {},
    resulting_group_size: finalCount
  };
  if (args.dry_run || !toAdd.length && !toRemove.length)
    return { dry_run: !!args.dry_run, ...plan };
  const $ = await getPage(gs, path);
  const headers = XHR(csrfFrom($), BASE3 + path);
  if (toAdd.length) {
    const body = new URLSearchParams();
    for (const m of toAdd)
      body.append("user_ids[]", String(m.id));
    const res = await gsFetch(gs, d.paths.many_ownerships_path, { method: "POST", body, headers });
    const t = await res.text();
    if (!res.ok)
      throw new Error(`Adding group members failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  for (const m of toRemove) {
    const res = await gsFetch(gs, `${d.paths.ownerships_path}/${m.ownership_id}`, { method: "DELETE", headers });
    const t = await res.text();
    if (!res.ok)
      throw new Error(`Removing ${m.email} failed: HTTP ${res.status} ${t.slice(0, 200)}`);
  }
  const after = await groupState(gs, { ...args, submission_id: submissionId });
  return { updated: true, ...plan, members: after.members };
}
async function accountInfo(gs) {
  await ensureSession(gs);
  const $ = await getPage(gs, "/account/edit");
  const form = $('form[action="/account"]').first();
  const linked = $(".linkedAccount--name").map((_, e) => $(e).text().trim().replace(/\s+/g, " ")).get();
  const emailGroup = form.find(".form--label").filter((_, e) => /email/i.test($(e).text())).first().closest(".form--group");
  const emails = emailGroup.find("tr").map((_, tr) => ({ email: $(tr).find("td").first().text().trim(), primary: $(tr).find(".statusIndicator--primaryEmail").length > 0 })).get().filter((e) => e.email.includes("@"));
  return {
    name: form.find('input[name="user[name]"]').attr("value") || null,
    emails,
    student_id: form.find('input[name="user[sid]"]').attr("value") || null,
    locale: form.find('select[name="user[locale]"] option[selected]').attr("value") || null,
    linked_accounts: linked,
    url: `${BASE3}/account/edit`
  };
}
async function getJson(gs, path) {
  const res = await gsFetch(gs, path, { headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" } });
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel();
    throw new Error("Gradescope could not reach the linked GitHub/Bitbucket account. Link it under Account Settings > Linked Accounts on the Gradescope website first.");
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Gradescope returned ${res.status} for ${path.split("?")[0]}`);
  }
  return res.json();
}
var REPO_URL = { github: "/github_repositories", bitbucket: "/bitbucket_projects" };
var SERVICE_NAME = { github: "GitHub", bitbucket: "Bitbucket" };
async function linkedRepositories(gs, service = "github") {
  await ensureSession(gs);
  const repos = [];
  if (service === "bitbucket") {
    const r = await getJson(gs, REPO_URL.bitbucket);
    for (const [uid, list] of Object.entries(r || {}))
      for (const x of list || [])
        repos.push({ ...x, uid: String(uid), id: x.full_name, pushed_at: x.updated_on });
    return repos;
  }
  const first = await getJson(gs, `${REPO_URL.github}?page=1&per_page=100`);
  const uids = first.uids?.length ? first.uids.map(String) : [String(first.uid)];
  for (const uid of uids) {
    for (let page = 1; page <= 20; page++) {
      const r = page === 1 && String(first.uid) === uid ? first : await getJson(gs, `${REPO_URL.github}?uid=${encodeURIComponent(uid)}&page=${page}&per_page=100`);
      const batch = r.repositories || [];
      for (const x of batch)
        repos.push({ ...x, uid: String(r.uid ?? uid) });
      if (batch.length < 100)
        break;
    }
  }
  return repos;
}
async function repositoryBranches(gs, repo, service = "github") {
  const branches = [];
  if (service === "bitbucket") {
    const b = await getJson(gs, `${REPO_URL.bitbucket}/${repo.id}/branches?uid=${encodeURIComponent(repo.uid)}`);
    return (Array.isArray(b) ? b : []).map((x) => x.name);
  }
  for (let page = 1; page <= 20; page++) {
    const b = await getJson(gs, `${REPO_URL.github}/${repo.id}/branches?uid=${encodeURIComponent(repo.uid)}&page=${page}&per_page=100`);
    if (!Array.isArray(b) || b.length === 0)
      break;
    branches.push(...b);
    if (b.length < 100)
      break;
  }
  return branches.map((x) => x.name);
}
async function findRepository(gs, fullName, service = "github") {
  const want = fullName.trim().replace(/^https?:\/\/(github\.com|bitbucket\.org)\//i, "").replace(/\.git$/i, "").toLowerCase();
  const repos = await linkedRepositories(gs, service);
  const repo = repos.find((r) => String(r.full_name).toLowerCase() === want);
  if (!repo) {
    throw new Error(`${SERVICE_NAME[service]} repository "${fullName}" is not visible to Gradescope. Use list_gradescope_repositories to see the ones it can access.`);
  }
  return repo;
}
async function listRepositories(gs, args) {
  const service = args.service || "github";
  if (args.repository) {
    const repo = await findRepository(gs, args.repository, service);
    return { service, repository: repo.full_name, private: !!(repo.private ?? repo.is_private), default_branch: repo.default_branch || repo.mainbranch?.name || null, branches: await repositoryBranches(gs, repo, service) };
  }
  const q = (args.query || "").toLowerCase();
  const repos = (await linkedRepositories(gs, service)).filter((r) => !q || String(r.full_name).toLowerCase().includes(q)).sort((a, b) => new Date(b.pushed_at || 0).getTime() - new Date(a.pushed_at || 0).getTime()).map((r) => ({ repository: r.full_name, private: !!(r.private ?? r.is_private), default_branch: r.default_branch || r.mainbranch?.name || null, last_pushed: r.pushed_at || null }));
  return { service, count: repos.length, repositories: repos.slice(0, 200) };
}
async function submitFromRepository(gs, args) {
  const { course_id, assignment_id } = args;
  const service = args.repository.service || "github";
  const { info, csrf, referer } = await findAssignment(gs, course_id, assignment_id);
  if (info.format !== "code")
    throw new Error(`"${info.title}" is not a code assignment; repository submission only works for code assignments.`);
  const repo = await findRepository(gs, args.repository.name, service);
  const branches = await repositoryBranches(gs, repo, service);
  const branch = args.repository.branch || repo.default_branch || repo.mainbranch?.name;
  if (!branch || !branches.includes(branch)) {
    throw new Error(`Branch "${branch}" not found in ${repo.full_name}. Branches: ${branches.slice(0, 30).join(", ")}`);
  }
  const summary = { assignment: info.title, kind: service, repository: repo.full_name, branch, late_submission: info.showLateWarning };
  if (args.dry_run)
    return { dry_run: true, would_post_to: info.postUrl, ...summary };
  const body = new URLSearchParams({
    utf8: "\u2713",
    authenticity_token: csrf,
    "submission[method]": service,
    // GitHub sends the numeric repository id; Bitbucket sends the full name.
    "submission[repository]": String(repo.id),
    "submission[uid]": String(repo.uid),
    "submission[revision]": branch
  });
  if (args.leaderboard_name)
    body.append("submission[leaderboard_name]", args.leaderboard_name);
  const res = await gsFetch(gs, info.postUrl, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: referer } });
  forgetAssignmentsCache(gs, course_id);
  const location = res.headers.get("location") || "";
  const submissionId = submissionIdFrom(location);
  if (!submissionId) {
    let reasons = [];
    try {
      reasons = flashMessages(location ? await getPage(gs, location) : cheerio3.load(await res.text()));
    } catch {
    }
    throw new Error(`Gradescope did not accept the ${SERVICE_NAME[service]} submission (HTTP ${res.status}). ${reasons.join(" ") || "No reason given."}`);
  }
  await res.body?.cancel();
  return {
    submitted: true,
    submission_id: submissionId,
    submission_url: `${BASE3}/courses/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`,
    ...summary,
    next_step: "The autograder runs next; call get_gradescope_autograder_results with wait_seconds to see the results."
  };
}
var snapKey = (courseId, a) => `${courseId}:${a.assignment_id || `name=${a.name}`}`;
async function gradesOverview(gs, args) {
  await ensureSession(gs);
  const all = await gs.getGradescopeCourses();
  if (!all)
    throw new Error("Could not read the Gradescope course list.");
  let courses = Object.values(all.student || {});
  if (args.course_ids?.length)
    courses = courses.filter((c) => args.course_ids.includes(String(c.id)));
  else if (!args.include_inactive_courses && courses.some((c) => c.active))
    courses = courses.filter((c) => c.active);
  const out = [];
  const snap = {};
  const failed = [];
  for (const c of courses) {
    const list = await gs.getGradescopeAssignments(String(c.id));
    if (!list) {
      failed.push(c.name);
      continue;
    }
    let earned = 0;
    let possible = 0;
    const rows = list.map((a) => {
      if (a.grade != null && a.max_grade != null) {
        earned += Number(a.grade);
        possible += Number(a.max_grade);
      }
      snap[snapKey(c.id, a)] = [a.grade ?? null, a.submissions_status ?? null];
      return { assignment: a.name, assignment_id: a.assignment_id, score: a.grade, max: a.max_grade, status: a.submissions_status, due_date: a.due_date };
    });
    out.push({ course: c.name, course_id: String(c.id), term: `${c.semester} ${c.year}`, graded_points: { earned: Math.round(earned * 100) / 100, possible: Math.round(possible * 100) / 100 }, assignments: rows });
  }
  let changes;
  if (args.previous_snapshot) {
    let prev = {};
    try {
      prev = JSON.parse(Buffer3.from(args.previous_snapshot, "base64").toString("utf8"));
    } catch {
      throw new Error("previous_snapshot is not a snapshot returned by this tool.");
    }
    changes = [];
    const name = /* @__PURE__ */ new Map();
    for (const c of out)
      for (const a of c.assignments)
        name.set(snapKey(c.course_id, { assignment_id: a.assignment_id, name: a.assignment }), { course: c.course, assignment: a.assignment });
    for (const [k, [grade, status]] of Object.entries(snap)) {
      const before = prev[k];
      const label = name.get(k);
      if (!before)
        changes.push({ ...label, change: "new assignment", score: grade, status });
      else if (before[0] !== grade)
        changes.push({ ...label, change: before[0] == null ? "newly graded" : "score changed", before: before[0], score: grade });
      else if (before[1] !== status)
        changes.push({ ...label, change: "status changed", before: before[1], status });
    }
  }
  return {
    courses: out,
    ...failed.length ? { courses_failed: failed } : {},
    ...changes ? { changes_since_snapshot: changes } : {},
    snapshot: Buffer3.from(JSON.stringify(snap)).toString("base64"),
    snapshot_note: "Pass snapshot back later as previous_snapshot to see what changed."
  };
}
async function enrollInCourse(gs, args) {
  const code = String(args.entry_code || "").trim();
  if (!/^[A-Za-z0-9]{4,12}$/.test(code))
    throw new Error("entry_code should be the short code from the instructor, e.g. 6 letters and digits.");
  await ensureSession(gs);
  if (args.dry_run)
    return { dry_run: true, would_post_to: "/student_memberships", entry_code: code, note: "A dry run cannot check whether the code is valid; only a real enrollment can." };
  const $ = await getPage(gs, "/account");
  const token = $('form[action="/student_memberships"] input[name="authenticity_token"]').attr("value") || csrfFrom($);
  const res = await gsFetch(gs, "/student_memberships", {
    method: "POST",
    body: new URLSearchParams({ utf8: "\u2713", authenticity_token: token, "student_membership[course_entry_code]": code }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE3}/account` }
  });
  const loc = res.headers.get("location") || "";
  const html = await res.text();
  gs.config?.cache?.storage?.delete?.("gradescope_courses");
  const courseId = loc.match(/\/courses\/(\d+)/)?.[1];
  if (!courseId) {
    const reasons = flashMessages(cheerio3.load(html));
    let followed = [];
    if (loc) {
      try {
        followed = flashMessages(await getPage(gs, loc));
      } catch {
      }
    }
    throw new Error(`Enrollment did not go through (HTTP ${res.status}). ${[...reasons, ...followed].join(" ") || "Check the entry code."}`);
  }
  const courses = await gs.getGradescopeCourses();
  const course = courses && Object.values({ ...courses.student, ...courses.instructor }).find((c) => String(c.id) === courseId);
  return { enrolled: true, course_id: courseId, course: course ? { name: course.name, full_name: course.full_name, term: `${course.semester} ${course.year}` } : null, url: `${BASE3}/courses/${courseId}` };
}
async function assignmentTemplate(gs, templateUrl) {
  const { bytes, mimeType } = await downloadBinary(gs, templateUrl);
  if (bytes.length > 10 * 1024 * 1024)
    throw new Error(`The template is ${bytes.length} bytes, over the 10 MB attachment limit; use template_url instead.`);
  const looksPdf = new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-");
  return { uri: templateUrl.split("?")[0], mimeType: looksPdf ? "application/pdf" : mimeType || "application/octet-stream", blob: Buffer3.from(bytes).toString("base64"), bytes: bytes.length };
}
var PUBLIC_KEY = /^(ssh-(ed25519|rsa|dss)|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\r\n]*)?$/;
async function addSshPublicKey(gs, args) {
  const key = String(args.public_key || "").trim();
  if (/PRIVATE KEY/.test(key)) {
    throw new Error("That is a PRIVATE key. Never share it. Pass the public key instead: the one-line contents of the .pub file (starts with ssh-ed25519 or ssh-rsa).");
  }
  if (!PUBLIC_KEY.test(key))
    throw new Error("public_key should be one line like: ssh-ed25519 AAAA... comment");
  await ensureSession(gs);
  const [type, , comment] = key.split(" ");
  const summary = { key_type: type, comment: comment || null, fingerprint_hint: key.split(" ")[1].slice(-12) };
  if (args.dry_run)
    return { dry_run: true, would_post_to: "/public_keys", ...summary };
  const $ = await getPage(gs, "/public_keys/new");
  const token = $('form[action="/public_keys"] input[name="authenticity_token"]').attr("value") || csrfFrom($);
  const res = await gsFetch(gs, "/public_keys", {
    method: "POST",
    body: new URLSearchParams({ utf8: "\u2713", authenticity_token: token, "public_key[contents]": key }),
    headers: { "Content-Type": "application/x-www-form-urlencoded", Referer: `${BASE3}/public_keys/new` }
  });
  const loc = res.headers.get("location") || "";
  const html = await res.text();
  if (res.status >= 300 && res.status < 400 && !/\/public_keys\/new/.test(loc)) {
    return { added: true, ...summary, next_step: 'Use gradescope_autograder_ssh with action "start" on a code submission.' };
  }
  const reasons = flashMessages(cheerio3.load(html));
  throw new Error(`Gradescope did not accept the key (HTTP ${res.status}). ${reasons.join(" ") || "It may already be on the account, or be malformed."}`);
}
async function searchAssignments(gs, args) {
  const q = String(args.query || "").trim().toLowerCase();
  if (!q)
    throw new Error("query is required.");
  await ensureSession(gs);
  const all = await gs.getGradescopeCourses();
  if (!all)
    throw new Error("Could not read the Gradescope course list.");
  let courses = [...Object.values(all.student || {}), ...Object.values(all.instructor || {})];
  if (!args.include_inactive_courses && courses.some((c) => c.active))
    courses = courses.filter((c) => c.active);
  const hits = [];
  for (const c of courses) {
    const list = await gs.getGradescopeAssignments(String(c.id));
    for (const a of list || []) {
      if (!String(a.name || "").toLowerCase().includes(q))
        continue;
      hits.push({ course: c.name, course_id: String(c.id), assignment: a.name, assignment_id: a.assignment_id || null, due_date: a.due_date, status: a.submissions_status, score: a.grade, max: a.max_grade });
    }
  }
  return { query: args.query, courses_searched: courses.length, count: hits.length, matches: hits };
}
var icsEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, ";").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
var icsTime = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
var fold = (line) => line.match(/.{1,73}/g).join("\r\n ");
async function deadlinesCalendar(gs, args) {
  const { upcomingDeadlines: upcomingDeadlines2 } = await Promise.resolve().then(() => (init_gs_student(), gs_student_exports));
  const res = await upcomingDeadlines2(gs, { days: args.days ?? 60, include_submitted: args.include_submitted ?? true, include_inactive_courses: args.include_inactive_courses, course_ids: args.course_ids });
  const items = [...res.deadlines, ...res.past_due_late_submission_still_open || []];
  const stamp = icsTime(/* @__PURE__ */ new Date());
  const alarm = args.reminder_minutes ?? 24 * 60;
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//gradescope-mcp//deadlines//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Gradescope deadlines"];
  for (const d of items) {
    const due = new Date(d.only_late_window_open ? d.late_due_date : d.due_date);
    const start = new Date(due.getTime() - 30 * 60 * 1e3);
    const title = `${d.course}: ${d.assignment}${d.only_late_window_open ? " (late deadline)" : ""}${d.submitted ? " \u2713" : ""}`;
    lines.push(
      "BEGIN:VEVENT",
      `UID:gradescope-${d.course_id}-${d.assignment_id || icsEscape(d.assignment)}-${d.only_late_window_open ? "late" : "due"}@gradescope-mcp`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${icsTime(start)}`,
      `DTEND:${icsTime(due)}`,
      fold(`SUMMARY:${icsEscape(title)}`),
      ...d.url ? [fold(`URL:${d.url}`)] : [],
      fold(`DESCRIPTION:${icsEscape(`Due ${due.toISOString()}${d.late_due_date ? `; late deadline ${d.late_due_date}` : ""}. Status: ${d.status ?? "unknown"}.`)}`),
      ...alarm > 0 ? ["BEGIN:VALARM", "ACTION:DISPLAY", fold(`DESCRIPTION:${icsEscape(title)}`), `TRIGGER:-PT${Math.round(alarm)}M`, "END:VALARM"] : [],
      "END:VEVENT"
    );
  }
  lines.push("END:VCALENDAR");
  return { events: items.length, window_days: res.window_days, ics: lines.join("\r\n") + "\r\n", note: "Save ics as a .ics file and open it, or import it into Google Calendar / Apple Calendar." };
}

// gs-server.ts
var upstreamParse = GradescopeApi.prototype.parseCoursesFromHTML;
GradescopeApi.prototype.parseCoursesFromHTML = async function($, userType) {
  const parsed = await upstreamParse.call(this, $, userType);
  if (parsed || userType !== "Your Courses")
    return parsed;
  const list = $(".courseList").first();
  if (list.length === 0)
    return null;
  const courses = {};
  let term = "";
  list.find(".courseList--term, .courseList--coursesForTerm").each((_, el) => {
    const block = $(el);
    if (block.hasClass("courseList--term"))
      term = block.contents().first().text().trim();
    const active = block.closest(".courseList--inactiveCourses").length === 0;
    block.find("a.courseBox").each((_2, a) => {
      const box = $(a);
      const id = (box.attr("href") || "").split("/").pop();
      if (!id)
        return;
      const [semester, year] = term.split(" ");
      courses[id] = {
        id,
        name: box.find(".courseBox--shortname").text().trim(),
        full_name: box.find(".courseBox--name").text().trim(),
        semester: semester || "",
        year: year || "",
        num_grades_published: null,
        num_assignments: box.find(".courseBox--assignments").text().trim(),
        active
      };
    });
  });
  const isInstructor = /Create a new course/i.test($.html());
  return { courses, isInstructor };
};
var upstreamStudentView = GradescopeApi.prototype.parseAssignmentsStudentView;
GradescopeApi.prototype.parseAssignmentsStudentView = function($) {
  const list = upstreamStudentView.call(this, $);
  if (!list)
    return list;
  const rows = $('tr[role="row"]').slice(1, -1).filter((_, r) => $(r).find("th, td").length >= 3);
  rows.each((i, r) => {
    const item = list[i];
    if (!item || item.grade !== null)
      return;
    const cell = $($(r).find("th, td")[1]).clone();
    cell.find("*").each((_, e) => {
      $(e).append(" ");
    });
    item.submissions_status = cell.text().replace(/\s+/g, " ").trim();
  });
  return list;
};
GradescopeApi.prototype.makeAuthenticatedRequest = async function(url, options = {}) {
  try {
    const { res } = await gsFetchFollow(this, url, options);
    if (!res.ok) {
      await res.body?.cancel();
      this.lastError = `Gradescope returned ${res.status} for ${new URL(url, "https://www.gradescope.com").pathname}`;
      return null;
    }
    return res;
  } catch (err) {
    this.lastError = err.message;
    return null;
  }
};
var ACCESS_TOKEN = Bun.env.ACCESS_TOKEN || "";
var SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
var SERVER_VERSION = "2.0.0";
var gsApi = null;
function api() {
  if (!Bun.env.GRADESCOPE_EMAIL || !Bun.env.GRADESCOPE_PASSWORD) {
    throw new Error("GRADESCOPE_EMAIL / GRADESCOPE_PASSWORD are not set on the server");
  }
  if (!gsApi) {
    gsApi = new GradescopeApi({
      email: Bun.env.GRADESCOPE_EMAIL,
      password: Bun.env.GRADESCOPE_PASSWORD,
      logger: new Logger(false),
      cache: new WorkerCache()
    });
  }
  return gsApi;
}
var text = (value, fallback) => {
  const why = gsApi?.lastError;
  return { content: [{ type: "text", text: value ? JSON.stringify(value, null, 2) : why ? `${fallback}: ${why}` : fallback }] };
};
async function session() {
  const gs = api();
  gs.lastError = null;
  await ensureSession(gs);
  return gs;
}
function pickByName(items, query, names) {
  const q = query.trim().toLowerCase();
  const exact = items.filter((x) => names(x).some((n) => (n || "").toLowerCase() === q));
  const partial = items.filter((x) => names(x).some((n) => (n || "").toLowerCase().includes(q)));
  const hits = exact.length ? exact : partial;
  if (hits.length === 0)
    return null;
  if (hits.length === 1)
    return hits[0];
  return { matches: hits, note: `${hits.length} matches for "${query}"; pick one by its ID.` };
}
async function courseByName(gs, name) {
  const all = await gs.getGradescopeCourses();
  if (!all)
    return null;
  const courses = [...Object.values(all.student || {}), ...Object.values(all.instructor || {})];
  return pickByName(courses, name, (c) => [c.name, c.full_name]);
}
async function assignmentByName(gs, courseId, name) {
  const list = await gs.getGradescopeAssignments(courseId);
  if (!list)
    return null;
  return pickByName(list, name, (a) => [a.name]);
}
var READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
var WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
var ASSIGNMENT_ID = {
  type: "string",
  description: "The Gradescope assignment ID. Can be found via get_gradescope_assignments."
};
var QUESTION_PAGES = {
  type: "object",
  description: 'Which PDF pages answer which question, e.g. {"1": [1], "2": [2, 3], "3.1": [4]}. Keys are question numbers as Gradescope shows them (or exact question titles); values are 1-based page numbers of the uploaded PDF.',
  additionalProperties: { type: "array", items: { type: "integer", minimum: 1 } }
};
var COURSE_ID = {
  type: "string",
  description: "The unique identifier for the Gradescope course. Can be found via get_gradescope_courses or get_gradescope_course_by_name."
};
var SUBMISSION_ID = {
  type: "string",
  description: "Optional submission ID. Omit it to use the active (latest graded) submission for the assignment."
};
var submissionRef = (extra = {}, required = []) => ({
  type: "object",
  properties: { course_id: COURSE_ID, assignment_id: ASSIGNMENT_ID, submission_id: SUBMISSION_ID, ...extra },
  required: ["course_id", "assignment_id", ...required]
});
var tools = [
  {
    name: "get_gradescope_courses",
    description: "Retrieve all Gradescope courses for the current user.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Get Gradescope Courses", ...READ_ONLY },
    handler: async () => text(await (await session()).getGradescopeCourses(), "Failed to retrieve Gradescope courses")
  },
  {
    name: "get_gradescope_course_by_name",
    description: "Find a Gradescope course by name. An exact name match wins; otherwise all partial matches are returned as a list.",
    inputSchema: {
      type: "object",
      properties: {
        course_name: { type: "string", description: "The name of the Gradescope course to search for. Partial matches are supported." }
      },
      required: ["course_name"]
    },
    annotations: { title: "Find Gradescope Course by Name", ...READ_ONLY },
    handler: async (a) => text(await courseByName(await session(), a.course_name), "Course not found")
  },
  {
    name: "get_gradescope_assignments",
    description: "Retrieve all assignments for a Gradescope course.",
    inputSchema: { type: "object", properties: { course_id: COURSE_ID }, required: ["course_id"] },
    annotations: { title: "Get Gradescope Assignments", ...READ_ONLY },
    handler: async (a) => text(await (await session()).getGradescopeAssignments(a.course_id), "Failed to retrieve assignments")
  },
  {
    name: "get_gradescope_assignment_by_name",
    description: "Find a Gradescope assignment by name. An exact name match wins; otherwise all partial matches are returned as a list.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_name: { type: "string", description: "The name of the assignment to search for. Partial matches are supported." }
      },
      required: ["course_id", "assignment_name"]
    },
    annotations: { title: "Find Gradescope Assignment by Name", ...READ_ONLY },
    handler: async (a) => text(await assignmentByName(await session(), a.course_id, a.assignment_name), "Assignment not found")
  },
  {
    name: "get_gradescope_upcoming_deadlines",
    description: "List assignments due soon across Gradescope courses, soonest first. By default only unsubmitted assignments from active courses (the ones Gradescope has not moved to its archived list, which can include the previous term) are shown; assignments past their regular deadline whose late deadline is still open are flagged, and listed separately when that late deadline is beyond the window.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to look. Default 14." },
        include_submitted: { type: "boolean", description: "Also list assignments that already have a submission. Default false." },
        include_inactive_courses: { type: "boolean", description: "Also check archived courses from older terms. Default false." },
        course_ids: { type: "array", items: { type: "string" }, description: "Only check these course IDs." }
      },
      required: []
    },
    annotations: { title: "Get Upcoming Gradescope Deadlines", ...READ_ONLY },
    handler: async (a) => text(await upcomingDeadlines(await session(), a), "No deadlines found")
  },
  {
    name: "get_gradescope_submission",
    description: "Get the grade breakdown of a submission: total score, each question's score and max points, which rubric items were applied, grader point adjustments and comments, and an autograder summary.",
    inputSchema: submissionRef(),
    annotations: { title: "Get Gradescope Submission Grades", ...READ_ONLY },
    handler: async (a) => text(await submissionDetails(await session(), a), "Submission not found")
  },
  {
    name: "get_gradescope_autograder_results",
    description: "Get autograder test results for a code submission: overall score and output, plus each test's name, status, score and output. Right after submitting, the autograder may still be running; pass wait_seconds to wait for it.",
    inputSchema: submissionRef({
      only_failed: { type: "boolean", description: "Only return tests that failed or lost points. Default false." },
      max_output_chars: { type: "number", description: "Truncate each test's output to this many characters. Default 2000." },
      wait_seconds: { type: "number", description: "If the autograder is still running, wait up to this many seconds (max 120). Default 0." }
    }),
    annotations: { title: "Get Gradescope Autograder Results", ...READ_ONLY },
    handler: async (a) => text(await autograderResults(await session(), a), "No autograder results")
  },
  {
    name: "get_gradescope_submission_history",
    description: "List every submission made for an assignment, newest first, with time, score, submitters, and which one is active.",
    inputSchema: submissionRef(),
    annotations: { title: "Get Gradescope Submission History", ...READ_ONLY },
    handler: async (a) => text(await submissionHistory(await session(), a), "No submissions found")
  },
  {
    name: "activate_gradescope_submission",
    description: "Make an earlier submission the active one that gets graded. This changes what course staff grade, so confirm with the user first, or use dry_run. Get submission IDs from get_gradescope_submission_history.",
    inputSchema: submissionRef(
      {
        submission_id: { type: "string", description: "The submission to activate, from get_gradescope_submission_history." },
        dry_run: { type: "boolean", description: "Check that the submission can be activated without changing anything." }
      },
      ["submission_id"]
    ),
    annotations: { title: "Activate Gradescope Submission", ...WRITE },
    handler: async (a) => text(await activateSubmission(await session(), a), "Activation failed")
  },
  {
    name: "download_gradescope_submission_files",
    description: "Get the files of a submission. Code submissions return each file's path and text contents, plus any line comments from graders. PDF submissions return a temporary download link to the uploaded PDF; set embed_pdf to attach the original or the graded (annotated) PDF itself.",
    inputSchema: submissionRef({
      include_content: { type: "boolean", description: "Include code file contents. Default true." },
      max_chars_per_file: { type: "number", description: "Truncate each code file to this many characters. Default 50000." },
      max_total_chars: { type: "number", description: "Stop including file contents after this many characters in total; later files get a download link instead. Default 200000." },
      embed_pdf: {
        type: "string",
        enum: ["none", "original", "graded"],
        description: 'Attach a PDF to the result: "original" (as uploaded) or "graded" (with grader marks). Default "none". Limit 10 MB.'
      },
      embed_zip: { type: "boolean", description: "Attach the whole submission as a zip (the website's Download Submission), where the course allows it. Limit 10 MB." },
      embed_binary_files: {
        type: "boolean",
        description: "Attach the code submission's non-text files too (screenshots, large or binary files): images as images, others as files. Up to 10 files / 15 MB."
      }
    }),
    annotations: { title: "Download Gradescope Submission Files", ...READ_ONLY },
    handler: async (a) => {
      const { result, blobs, images } = await submissionFiles(await session(), a);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
          ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType })),
          ...blobs.map((b) => ({ type: "resource", resource: b }))
        ]
      };
    }
  },
  {
    name: "get_gradescope_page",
    description: "Read any Gradescope page the user can see, by path (e.g. /courses/123, /courses/123/assignments/456/submissions/789, /account). Returns the page's visible text, its links, its forms (field names only), and the data behind its interactive components. Use it for anything the specific tools do not cover, such as online assignments, leaderboards, or course pages. Read-only: pages that sign out or change the account are refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'A path on www.gradescope.com starting with "/". Paths ending in .json?content=react return raw JSON.' },
        component: { type: "string", description: "Only return this interactive component's data (e.g. AssignmentSubmissionViewer)." },
        include_props: { type: "boolean", description: "Include component data. Default true; set false for just text, links and forms." },
        max_chars: { type: "number", description: "Approximate size limit for the result. Default 60000, max 200000." }
      },
      required: ["path"]
    },
    annotations: { title: "Read a Gradescope Page", ...READ_ONLY },
    handler: async (a) => text(await readPage(await session(), a), "Page could not be read")
  },
  {
    name: "get_gradescope_assignment_info",
    description: "Everything about one assignment, submitted or not: dates, status and grade, submission format (PDF, code, online), accepted submission methods, the blank template link, time limit, group size, late-submission warning, regrade window, and the active submission ID if there is one. Set embed_template to attach the template file itself (often the problem set).",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        embed_template: { type: "boolean", description: "Attach the assignment's blank template (usually a PDF), if it has one. Limit 10 MB." }
      },
      required: ["course_id", "assignment_id"]
    },
    annotations: { title: "Get Gradescope Assignment Info", ...READ_ONLY },
    handler: async (a) => {
      const gs = await session();
      const info = await assignmentInfo(gs, a);
      if (!a.embed_template)
        return text(info, "Assignment not found");
      if (!info.template_url)
        return text({ ...info, template: "this assignment has no template" }, "Assignment not found");
      const t = await assignmentTemplate(gs, info.template_url);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...info, template: `attached as a resource (${t.bytes} bytes, ${t.mimeType})` }, null, 2) },
          { type: "resource", resource: { uri: t.uri, mimeType: t.mimeType, blob: t.blob } }
        ]
      };
    }
  },
  {
    name: "get_gradescope_feedback_summary",
    description: "Where points were lost across a whole course: for every graded submission, the questions below full marks with the rubric items applied and the grader's comments, sorted by points lost. Use it to review mistakes or find regrade candidates.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        only_lost_points: { type: "boolean", description: "Only list assignments that lost points. Default true." },
        assignment_ids: { type: "array", items: { type: "string" }, description: "Only these assignments." }
      },
      required: ["course_id"]
    },
    annotations: { title: "Get Gradescope Feedback Summary", ...READ_ONLY },
    handler: async (a) => text(await feedbackSummary(await session(), a), "No graded submissions")
  },
  {
    name: "get_gradescope_status",
    description: "Check the connection: whether the server is logged in to Gradescope, as whom, since when, and the last error a read hit. Use it when other tools fail.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Gradescope Connection Status", ...READ_ONLY },
    handler: async () => {
      const gs = api();
      const before = gs.lastError || null;
      let account = null;
      let error = null;
      try {
        await ensureSession(gs);
        account = await accountInfo(gs);
      } catch (err) {
        error = err.message;
      }
      return text(
        {
          logged_in: !!account,
          account: account ? { name: account.name, primary_email: account.emails?.find((e) => e.primary)?.email ?? null } : null,
          session: sessionInfo(),
          error,
          last_read_error: before,
          server: { name: "Gradescope MCP", version: SERVER_VERSION, tools: tools.length }
        },
        "Status unavailable"
      );
    }
  },
  {
    name: "search_gradescope_assignments",
    description: `Find assignments by name across all active courses at once (e.g. "midterm", "project 3"), with each one's course, due date, status and score.`,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in assignment names." },
        include_inactive_courses: { type: "boolean", description: "Also search archived courses. Default false." }
      },
      required: ["query"]
    },
    annotations: { title: "Search Gradescope Assignments", ...READ_ONLY },
    handler: async (a) => text(await searchAssignments(await session(), a), "No assignments found")
  },
  {
    name: "export_gradescope_deadlines_calendar",
    description: "Export upcoming Gradescope deadlines as an iCalendar (.ics) file the user can import into Google Calendar, Apple Calendar or Outlook, with a reminder before each deadline.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead. Default 60." },
        include_submitted: { type: "boolean", description: "Include assignments already submitted (marked with a check). Default true." },
        include_inactive_courses: { type: "boolean", description: "Also include archived courses. Default false." },
        course_ids: { type: "array", items: { type: "string" }, description: "Only these courses." },
        reminder_minutes: { type: "number", description: "Reminder this many minutes before each deadline; 0 for none. Default 1440 (one day)." }
      },
      required: []
    },
    annotations: { title: "Export Gradescope Deadlines Calendar", ...READ_ONLY },
    handler: async (a) => text(await deadlinesCalendar(await session(), a), "No deadlines to export")
  },
  {
    name: "compare_gradescope_submissions",
    description: "Show what changed between two submissions of an assignment: a diff of every changed text file, the score change, and which autograder tests changed. By default compares the active submission with the one before it; get IDs from get_gradescope_submission_history.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        base_submission_id: { type: "string", description: "The older submission. Default: the one just before head." },
        head_submission_id: { type: "string", description: "The newer submission. Default: the active one." },
        max_chars: { type: "number", description: "Size limit for all diffs together. Default 60000." }
      },
      required: ["course_id", "assignment_id"]
    },
    annotations: { title: "Compare Gradescope Submissions", ...READ_ONLY },
    handler: async (a) => text(await compareSubmissions(await session(), a), "Comparison failed")
  },
  {
    name: "add_gradescope_ssh_public_key",
    description: "Add an SSH public key to the Gradescope account, which autograder SSH debugging requires. This changes account settings, so confirm with the user first, or use dry_run. Pass only the public key (one line from a .pub file); a private key is refused.",
    inputSchema: {
      type: "object",
      properties: {
        public_key: { type: "string", description: "One line like: ssh-ed25519 AAAA... comment" },
        dry_run: { type: "boolean", description: "Validate the key without adding it." }
      },
      required: ["public_key"]
    },
    annotations: { title: "Add Gradescope SSH Public Key", ...WRITE },
    handler: async (a) => text(await addSshPublicKey(await session(), a), "Adding the key failed")
  },
  {
    name: "get_gradescope_regrade_requests",
    description: "List the user's regrade requests in a course, with question, assignment, date and status.",
    inputSchema: { type: "object", properties: { course_id: COURSE_ID }, required: ["course_id"] },
    annotations: { title: "Get Gradescope Regrade Requests", ...READ_ONLY },
    handler: async (a) => text(await listRegradeRequests(await session(), a), "No regrade requests")
  },
  {
    name: "request_gradescope_regrade",
    description: "Ask graders to regrade one question of a graded submission, with an explanation. Course staff see the request, so confirm the question and wording with the user first, or use dry_run. If a request already exists for that question, its status is returned instead unless update_existing is true.",
    inputSchema: submissionRef(
      {
        question: { type: "string", description: 'The question number as Gradescope shows it (e.g. "2" or "3.1"), or its exact title.' },
        comment: { type: "string", description: "The explanation sent to the grader." },
        update_existing: { type: "boolean", description: "Replace the comment on an existing request for this question. Default false." },
        dry_run: { type: "boolean", description: "Check the question, the regrade window and existing requests without sending anything." }
      },
      ["question", "comment"]
    ),
    annotations: { title: "Request Gradescope Regrade", ...WRITE },
    handler: async (a) => text(await requestRegrade(await session(), a), "Regrade request failed")
  },
  {
    name: "get_gradescope_group_members",
    description: "Show who is in the group on a submission (name, email, uploader), the group size limit, and whether members can still be changed.",
    inputSchema: submissionRef(),
    annotations: { title: "Get Gradescope Group Members", ...READ_ONLY },
    handler: async (a) => text(await groupMembers(await session(), a), "Submission not found")
  },
  {
    name: "update_gradescope_group_members",
    description: "Add or remove group members on a submission, by exact school email. Added students get credit for, and access to, the submission, so confirm the emails with the user first, or use dry_run. Removing yourself or the uploader is refused.",
    inputSchema: submissionRef({
      add_emails: { type: "array", items: { type: "string" }, description: "Emails of classmates to add. Must match their Gradescope email exactly." },
      remove_emails: { type: "array", items: { type: "string" }, description: "Emails of current members to remove." },
      dry_run: { type: "boolean", description: "Resolve the emails and check the group size limit without changing anything." }
    }),
    annotations: { title: "Update Gradescope Group Members", ...WRITE },
    handler: async (a) => text(await updateGroupMembers(await session(), a), "Updating group members failed")
  },
  {
    name: "get_gradescope_account",
    description: "Show the Gradescope account's name, email, student ID, language, and linked external accounts.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Get Gradescope Account", ...READ_ONLY },
    handler: async () => text(await accountInfo(await session()), "Account page could not be read")
  },
  {
    name: "enroll_gradescope_course",
    description: "Join a Gradescope course with the entry code the instructor shared. Confirm the code with the user first. A dry run cannot check whether the code is valid.",
    inputSchema: {
      type: "object",
      properties: {
        entry_code: { type: "string", description: "The course entry code, e.g. 6 letters and digits." },
        dry_run: { type: "boolean", description: "Show what would be sent without enrolling." }
      },
      required: ["entry_code"]
    },
    annotations: { title: "Enroll in Gradescope Course", ...WRITE },
    handler: async (a) => text(await enrollInCourse(await session(), a), "Enrollment failed")
  },
  {
    name: "submit_gradescope_assignment",
    description: "Submit files to a Gradescope assignment on the user's behalf. This creates a real submission that course staff can see and replaces any earlier submission, so confirm the course, assignment and file with the user before calling it, or use dry_run first. PDF assignments take one PDF, or several PDFs and/or JPEG/PNG photos (e.g. of handwritten work), which are merged into one PDF in the order given; document assignments take one document (doc, docx, pdf, ...); code assignments take one or more files, or a linked GitHub repository and branch instead of files. For PDF assignments where students mark pages, pass question_pages to match pages to questions in the same call; otherwise the result lists the questions so you can call match_gradescope_pages next.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        files: {
          type: "array",
          minItems: 1,
          description: "Files to submit. Give each file one source: url (a direct download link; Google Drive share links are converted automatically, and the file must be shared so anyone with the link can view), content_base64 (raw bytes), or text (plain-text file contents, for code).",
          items: {
            type: "object",
            properties: {
              filename: { type: "string", description: "File name to show on Gradescope. Optional for PDFs." },
              url: { type: "string" },
              content_base64: { type: "string" },
              text: { type: "string" }
            }
          }
        },
        repository: {
          type: "object",
          description: "Code assignments only, instead of files: submit a GitHub or Bitbucket repository linked to the user's Gradescope account.",
          properties: {
            name: { type: "string", description: 'Repository as "owner/name".' },
            branch: { type: "string", description: "Branch to submit. Defaults to the repository's default branch." },
            service: { type: "string", enum: ["github", "bitbucket"], description: 'Where the repository lives. Default "github".' }
          },
          required: ["name"]
        },
        question_pages: QUESTION_PAGES,
        leaderboard_name: { type: "string", description: "Leaderboard name, only for code assignments with a leaderboard." },
        dry_run: { type: "boolean", description: "Check everything (assignment is open, file downloads and is valid, or repository and branch exist) without submitting." }
      },
      required: ["course_id", "assignment_id"]
    },
    annotations: { title: "Submit Gradescope Assignment", ...WRITE },
    handler: async (a) => {
      const gs = await session();
      if (a.repository && a.files?.length)
        throw new Error("Pass either files or repository, not both.");
      if (a.repository)
        return text(await submitFromRepository(gs, a), "Submission failed");
      return text(await submitAssignment(gs, a), "Submission failed");
    }
  },
  {
    name: "list_gradescope_repositories",
    description: "List the GitHub or Bitbucket repositories Gradescope can access through the user's linked account, or the branches of one repository. Use it before submitting a code assignment from a repository.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["github", "bitbucket"], description: 'Default "github".' },
        query: { type: "string", description: "Only list repositories whose name contains this text." },
        repository: { type: "string", description: 'Show the branches of this repository ("owner/name") instead of listing repositories.' }
      },
      required: []
    },
    annotations: { title: "List Linked Repositories", ...READ_ONLY },
    handler: async (a) => text(await listRepositories(await session(), a), "No repositories found")
  },
  {
    name: "get_gradescope_submission_pages",
    description: "Look at the pages of a PDF or photo submission as images, so you can see exactly what was handed in. Pick pages by number or by question; up to 12 pages per call (default 4).",
    inputSchema: submissionRef({
      pages: { type: "array", items: { type: "integer", minimum: 1 }, description: "1-based page numbers to return." },
      questions: { type: "array", items: { type: "string" }, description: 'Return the pages matched to these questions, e.g. ["2", "3.1"].' },
      size: { type: "string", enum: ["full", "thumbnail"], description: 'Image size. Default "full".' },
      max_pages: { type: "number", description: "At most this many pages in one call (1 to 12). Default 4." }
    }),
    annotations: { title: "View Gradescope Submission Pages", ...READ_ONLY },
    handler: async (a) => {
      const { result, images } = await submissionPages(await session(), a);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }, ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))]
      };
    }
  },
  {
    name: "rerun_gradescope_autograder",
    description: "Run the autograder again on a code submission (the Rerun Autograder button). The score can change, for example if staff updated the tests since, so confirm with the user first, or use dry_run. Gradescope may not allow this for students in every course. Pass wait_seconds to wait for the new results.",
    inputSchema: submissionRef({
      dry_run: { type: "boolean", description: "Check that the submission can be rerun without starting it." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds (max 120) for the new results." }
    }),
    annotations: { title: "Rerun Gradescope Autograder", ...WRITE },
    handler: async (a) => text(await rerunAutograder(await session(), a), "Rerun failed")
  },
  {
    name: "gradescope_autograder_ssh",
    description: 'Debug a code submission inside the autograder over SSH, where the course allows it. action "status" (default) shows whether SSH is available and any running session; "start" starts one. The account needs an SSH public key on Gradescope.',
    inputSchema: submissionRef({
      action: { type: "string", enum: ["status", "start"], description: 'Default "status".' },
      dry_run: { type: "boolean", description: "With start: check availability without starting a session." }
    }),
    annotations: { title: "Gradescope Autograder SSH", ...WRITE, destructiveHint: false },
    handler: async (a) => text(await autograderSsh(await session(), a), "SSH request failed")
  },
  {
    name: "get_gradescope_grades",
    description: "All scores across courses in one view: every assignment's score, maximum and status, and graded points per course. Returns a snapshot; pass it back later as previous_snapshot to list new grades, changed scores and new submissions since then.",
    inputSchema: {
      type: "object",
      properties: {
        course_ids: { type: "array", items: { type: "string" }, description: "Only these courses." },
        include_inactive_courses: { type: "boolean", description: "Also include archived courses. Default false." },
        previous_snapshot: { type: "string", description: "A snapshot from an earlier call, to report changes since then." }
      },
      required: []
    },
    annotations: { title: "Get Gradescope Grades", ...READ_ONLY },
    handler: async (a) => text(await gradesOverview(await session(), a), "No grades found")
  },
  {
    name: "match_gradescope_pages",
    description: "Match the pages of an uploaded PDF submission to the assignment's questions. Call without question_pages to see the questions, the current matching and any unmatched questions; call with question_pages to change it. Questions you leave out keep their current pages unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        submission_id: { type: "string", description: "The submission ID returned by submit_gradescope_assignment." },
        question_pages: QUESTION_PAGES,
        replace_all: { type: "boolean", description: "Replace the whole matching with question_pages (questions left out get no pages). Default false." },
        dry_run: { type: "boolean", description: "Show the matching that would be saved without saving it." }
      },
      required: ["course_id", "assignment_id", "submission_id"]
    },
    annotations: { title: "Match Gradescope Pages", ...WRITE },
    handler: async (a) => text(await matchPages(await session(), a), "Page matching failed")
  }
];
var PROMPTS = [
  {
    name: "weekly_review",
    description: "What is due soon, what was graded since last time, and what to do first.",
    arguments: [{ name: "previous_snapshot", description: "Snapshot from the last get_gradescope_grades call, if you have one." }],
    build: (a) => `Give me my Gradescope weekly review. 1) Call get_gradescope_upcoming_deadlines (14 days) and list what is due, soonest first, with hours left. 2) Call get_gradescope_grades${a.previous_snapshot ? ` with previous_snapshot "${a.previous_snapshot}"` : ""} and list new or changed grades. 3) End with the three most urgent things to do. Keep it short, and give me the new snapshot at the end.`
  },
  {
    name: "before_deadline_check",
    description: "Check that a submission is complete before the deadline: submitted, every question has pages, autograder passing.",
    arguments: [
      { name: "course_id", description: "Course ID", required: true },
      { name: "assignment_id", description: "Assignment ID", required: true }
    ],
    build: (a) => `Check my Gradescope submission for course ${a.course_id}, assignment ${a.assignment_id} before the deadline. Use get_gradescope_assignment_info to see the format, due date and whether there is a submission. For a PDF assignment, call match_gradescope_pages without question_pages and report any unmatched questions. For a code assignment, call get_gradescope_autograder_results with only_failed. Tell me plainly whether it is complete and what, if anything, I still need to do. Do not submit or change anything.`
  },
  {
    name: "lost_points_review",
    description: "Where points were lost in a course, and which might deserve a regrade request.",
    arguments: [{ name: "course_id", description: "Course ID", required: true }],
    build: (a) => `Review where I lost points in Gradescope course ${a.course_id}. Call get_gradescope_feedback_summary, then group the mistakes by topic, and point out any question where the applied rubric items seem not to match the comments, as possible regrade candidates (only where regrade requests are open). Do not send any regrade request without asking me.`
  }
];
async function handleMessage(msg) {
  const { id, method, params } = msg ?? {};
  if (id === void 0 || id === null)
    return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "Gradescope MCP", version: SERVER_VERSION }
      });
    }
    case "ping":
      return ok({});
    case "prompts/list":
      return ok({ prompts: PROMPTS.map(({ build, ...p }) => p) });
    case "prompts/get": {
      const p = PROMPTS.find((x) => x.name === params?.name);
      if (!p)
        return fail(-32602, `Unknown prompt: ${params?.name}`);
      const missing = (p.arguments || []).filter((a) => a.required && !params?.arguments?.[a.name]).map((a) => a.name);
      if (missing.length)
        return fail(-32602, `Missing argument(s): ${missing.join(", ")}`);
      return ok({ description: p.description, messages: [{ role: "user", content: { type: "text", text: p.build(params?.arguments || {}) } }] });
    }
    case "tools/list":
      return ok({ tools: tools.map(({ handler, ...t }) => t) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool)
        return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        return ok(await tool.handler(params?.arguments ?? {}));
      } catch (err) {
        return ok({ content: [{ type: "text", text: `Error: ${err.message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*"
};
async function handleRequest(request) {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (!ACCESS_TOKEN || path !== `/${ACCESS_TOKEN}` && path !== `/${ACCESS_TOKEN}/mcp`) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers: CORS });
  if (request.method === "DELETE")
    return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST")
    return new Response("Method Not Allowed", { status: 405, headers: CORS });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
  }
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map(handleMessage))).filter(Boolean);
  if (replies.length === 0)
    return new Response(null, { status: 202, headers: CORS });
  return Response.json(Array.isArray(body) ? replies : replies[0], { headers: CORS });
}
if (!Bun.env.SKIP_SERVE) {
  Bun.serve({ port: Number(Bun.env.PORT) || 3e3, idleTimeout: 255, fetch: handleRequest });
  console.log("gradescope-mcp listening");
}
(globalThis as any).__handleRequest = handleRequest;
