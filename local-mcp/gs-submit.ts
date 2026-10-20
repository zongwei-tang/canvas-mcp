// Gradescope submission flow, reverse-engineered from Gradescope's own frontend (2026-10):
//   1. POST /courses/:c/assignments/:a/submissions
//        PDF assignments  (submission format fixed_length / variable_length): field `pdf_attachment`
//        code assignments: `submission[method]=upload` + `submission[files][]`
//      Success redirects to /courses/:c/assignments/:a/submissions/:s[/select_pages].
//   2. Variable-length PDFs are processed asynchronously; the select_pages page embeds a
//      `SelectPages` React component whose props list the questions and the processed pages.
//   3. POST .../submissions/:s/update_pages (XHR) with
//        pages_for_question = JSON {questionId: [pageId, ...]}, pages = JSON (the pages array as received).
import * as cheerio from "cheerio";

const BASE = "https://www.gradescope.com";
const UA = "Canvas-MCP/1.1.0";
const MAX_BYTES = 100 * 1024 * 1024;
const SESSION_MAX_AGE_MS = 20 * 60 * 1000;

export interface SubmitFile {
  filename?: string;
  url?: string;
  content_base64?: string;
  text?: string;
}

let authenticatedAt = 0;

function resetSession(gs: any) {
  gs.isAuthenticated = false;
  gs.csrfToken = "";
  gs.cookieManager.clear();
}

// Gradescope sessions expire; a long-running server must log in again instead of
// silently reading the login page.
export async function ensureSession(gs: any) {
  if (gs.isAuthenticated && Date.now() - authenticatedAt > SESSION_MAX_AGE_MS) resetSession(gs);
  if (!gs.isAuthenticated) {
    if (!(await gs.authenticate())) throw new Error("Gradescope login failed. Check the email and password set on the server.");
    authenticatedAt = Date.now();
  }
}

async function gsFetch(gs: any, path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  await ensureSession(gs);
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Cookie: gs.cookieManager.getCookieString(),
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(path.startsWith("http") ? path : BASE + path, { ...init, headers, redirect: "manual" });
  gs.cookieManager.setCookiesFromHeaders(res.headers);
  const location = res.headers.get("location") || "";
  const bouncedToLogin = res.status >= 300 && res.status < 400 && /\/login(?:[/?#]|$)/.test(location);
  if (!retried && (res.status === 401 || bouncedToLogin)) {
    resetSession(gs);
    return gsFetch(gs, path, init, true);
  }
  return res;
}

async function getPage(gs: any, path: string) {
  const res = await gsFetch(gs, path);
  if (res.status >= 300 && res.status < 400) {
    return getPage(gs, res.headers.get("location")!);
  }
  if (!res.ok) throw new Error(`Gradescope returned ${res.status} for ${path}`);
  return cheerio.load(await res.text());
}

function csrfFrom($: cheerio.CheerioAPI) {
  const token = $('meta[name="csrf-token"]').attr("content");
  if (!token) throw new Error("Could not find Gradescope's CSRF token on the page");
  return token;
}

function flashMessages($: cheerio.CheerioAPI) {
  return $(".alert, .flash, .msg.error, .alert-error, .alert-danger")
    .map((_, e) => $(e).text().trim().replace(/\s+/g, " "))
    .get()
    .filter(Boolean);
}

interface AssignmentInfo {
  title: string;
  format: string;
  postUrl: string;
  readyForSubmission: boolean;
  showLateWarning: boolean;
}

// The submit button carries everything the browser needs. For an assignment that already has a
// submission, the course page links to it instead, and the button lives on that page (Resubmit).
async function findAssignment(gs: any, courseId: string, assignmentId: string) {
  const $course = await getPage(gs, `/courses/${courseId}`);
  const fromButton = ($: cheerio.CheerioAPI): AssignmentInfo | null => {
    const btn = $(`.js-submitAssignment[data-assignment-id="${assignmentId}"]`).first();
    if (btn.length === 0) return null;
    return {
      title: btn.attr("data-assignment-title") || "",
      format: btn.attr("data-submission-format") || "",
      postUrl: btn.attr("data-post-url") || `/courses/${courseId}/assignments/${assignmentId}/submissions`,
      readyForSubmission: btn.attr("data-ready-for-submission") !== "false",
      showLateWarning: btn.attr("data-show-late-submission-warning") === "true",
    };
  };
  let info = fromButton($course);
  let $page = $course;
  if (!info) {
    const link = $course(`a[href*="/assignments/${assignmentId}/submissions/"]`).attr("href")
      || $course(`a[href$="/assignments/${assignmentId}"]`).attr("href");
    if (link) {
      $page = await getPage(gs, link);
      info = fromButton($page);
    }
  }
  if (!info) {
    throw new Error(
      `Assignment ${assignmentId} is not open for submission in course ${courseId} (no submit or resubmit button found). ` +
        "It may be closed, not released yet, or not belong to this course.",
    );
  }
  return { info, csrf: csrfFrom($page), referer: `${BASE}/courses/${courseId}` };
}

function driveDirectUrl(url: string) {
  const m = url.match(/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:.*&)?id=)([\w-]+)/);
  return m ? `https://drive.google.com/uc?export=download&id=${m[1]}` : url;
}

async function loadFile(f: SubmitFile, index: number, defaultName: string) {
  let bytes: Uint8Array;
  let name = f.filename;
  if (f.content_base64) {
    bytes = Uint8Array.from(Buffer.from(f.content_base64, "base64"));
  } else if (typeof f.text === "string") {
    bytes = new TextEncoder().encode(f.text);
  } else if (f.url) {
    const res = await fetch(driveDirectUrl(f.url), { redirect: "follow" });
    if (!res.ok) throw new Error(`Downloading file ${index + 1} failed: HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (!name) {
      const cd = res.headers.get("content-disposition") || "";
      name = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i)?.[1];
    }
  } else {
    throw new Error(`File ${index + 1} needs one of: url, content_base64, text`);
  }
  if (bytes.length === 0) throw new Error(`File ${index + 1} is empty`);
  if (bytes.length > MAX_BYTES) throw new Error(`File ${index + 1} is larger than Gradescope's 100 MB limit`);
  return { name: name || defaultName, bytes };
}

const isPdf = (b: Uint8Array) => new TextDecoder().decode(b.slice(0, 1024)).includes("%PDF-");

function submissionIdFrom(location: string) {
  return location.match(/\/submissions\/(\d+)/)?.[1] || null;
}

function forgetAssignmentsCache(gs: any, courseId: string) {
  gs.config?.cache?.storage?.delete?.(`gradescope_assignments_${courseId}`);
}

// ---- page matching ----

interface SelectPagesData {
  questions: { id: number; full_index: string; title: string; assignable: boolean }[];
  pages: any[];
  pageCount: number;
  status: string;
  urls: { update_pages_path: string };
  csrf: string;
  cannotReselectPages: boolean;
}

async function readSelectPages(gs: any, courseId: string, assignmentId: string, submissionId: string): Promise<SelectPagesData> {
  const $ = await getPage(gs, `/courses/${courseId}/assignments/${assignmentId}/submissions/${submissionId}/select_pages`);
  const raw = $('[data-react-class="SelectPages"]').attr("data-react-props");
  if (!raw) throw new Error("This submission has no page-matching step (it may be a fixed-template or code assignment).");
  const props = JSON.parse(raw);
  const pa = props.pdfAttachment || {};
  return {
    questions: (props.questions || []).map((q: any) => ({ id: q.id, full_index: String(q.full_index), title: q.title, assignable: !!q.assignable })),
    pages: pa.pages || [],
    pageCount: pa.page_count || 0,
    status: String(pa.status_string || pa.status || ""),
    urls: props.urls,
    csrf: csrfFrom($),
    cannotReselectPages: !!props.cannotReselectPages,
  };
}

// page_count can exceed pages.length (deleted pages), so wait on the processing status instead.
async function waitForPages(gs: any, courseId: string, assignmentId: string, submissionId: string, timeoutMs = 90_000) {
  const start = Date.now();
  let data = await readSelectPages(gs, courseId, assignmentId, submissionId);
  while (!(data.status === "complete" && data.pages.length > 0) && Date.now() - start < timeoutMs) {
    if (/fail|error/i.test(data.status)) throw new Error(`Gradescope could not process the PDF (status: ${data.status}).`);
    await new Promise((r) => setTimeout(r, 3000));
    data = await readSelectPages(gs, courseId, assignmentId, submissionId);
  }
  if (data.pages.length === 0) throw new Error(`Gradescope is still processing the PDF (status: ${data.status || "unknown"}). Try match_gradescope_pages again in a minute.`);
  return data;
}

function describeQuestions(data: SelectPagesData) {
  return data.questions.filter((q) => q.assignable).map((q) => ({ question: q.full_index, title: q.title }));
}

// question_pages: {"1": [1], "2.1": [2, 3]} — keys are question numbers (or titles), values are 1-based PDF page numbers.
function buildMapping(data: SelectPagesData, questionPages: Record<string, number[]>) {
  const kept = data.pages.filter((p) => !p.deleted);
  const assignable = data.questions.filter((q) => q.assignable);
  const mapping: Record<string, number[]> = Object.fromEntries(assignable.map((q) => [String(q.id), []]));
  const unknown: string[] = [];
  for (const [key, pageNumbers] of Object.entries(questionPages)) {
    const k = key.trim().replace(/^q(?:uestion)?\s*/i, "");
    const q =
      assignable.find((x) => x.full_index === k) ||
      assignable.find((x) => x.title.toLowerCase() === key.trim().toLowerCase());
    if (!q) {
      unknown.push(key);
      continue;
    }
    for (const n of pageNumbers) {
      const page = kept[Number(n) - 1];
      if (!page) throw new Error(`Question ${key}: page ${n} does not exist (the PDF has ${kept.length} pages)`);
      if (!mapping[String(q.id)].includes(page.id)) mapping[String(q.id)].push(page.id);
    }
  }
  if (unknown.length) {
    throw new Error(
      `Unknown question(s): ${unknown.join(", ")}. Valid questions: ` +
        describeQuestions(data).map((q) => `${q.question} (${q.title})`).join("; "),
    );
  }
  const unmatched = assignable.filter((q) => mapping[String(q.id)].length === 0).map((q) => q.full_index);
  return { mapping, unmatched };
}

export async function matchPages(
  gs: any,
  args: { course_id: string; assignment_id: string; submission_id: string; question_pages?: Record<string, number[]>; dry_run?: boolean },
) {
  const { course_id, assignment_id, submission_id } = args;
  const data = await waitForPages(gs, course_id, assignment_id, submission_id);
  if (!args.question_pages || Object.keys(args.question_pages).length === 0) {
    return { submission_id, pdf_status: data.status, page_count: data.pages.length, questions: describeQuestions(data), note: "Pass question_pages to assign pages." };
  }
  if (data.cannotReselectPages) throw new Error("Gradescope no longer allows changing the page selection for this submission.");
  const { mapping, unmatched } = buildMapping(data, args.question_pages);
  const body = new URLSearchParams({ pages_for_question: JSON.stringify(mapping), pages: JSON.stringify(data.pages) });
  if (args.dry_run) {
    return { dry_run: true, would_post_to: data.urls.update_pages_path, pages_for_question: mapping, page_count: data.pages.length, unmatched_questions: unmatched };
  }
  const res = await gsFetch(gs, data.urls.update_pages_path, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      Accept: "application/json, text/javascript, */*; q=0.01",
      "X-CSRF-Token": data.csrf,
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${BASE}/courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}/select_pages`,
    },
  });
  const textBody = await res.text();
  if (!res.ok) throw new Error(`Saving the page selection failed: HTTP ${res.status} ${textBody.slice(0, 200)}`);
  let path: string | undefined;
  try {
    path = JSON.parse(textBody).path;
  } catch {}
  return {
    pages_matched: true,
    submission_url: `${BASE}${path || `/courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}`}`,
    unmatched_questions: unmatched,
  };
}

// ---- submit ----

export async function submitAssignment(
  gs: any,
  args: {
    course_id: string;
    assignment_id: string;
    files: SubmitFile[];
    question_pages?: Record<string, number[]>;
    leaderboard_name?: string;
    dry_run?: boolean;
  },
) {
  const { course_id, assignment_id } = args;
  if (!Array.isArray(args.files) || args.files.length === 0) throw new Error("files must contain at least one file");

  const { info, csrf, referer } = await findAssignment(gs, course_id, assignment_id);
  if (info.format === "online") {
    throw new Error(`"${info.title}" is an online assignment answered in the browser; it cannot be submitted as a file.`);
  }
  const isPdfAssignment = info.format === "fixed_length" || info.format === "variable_length";
  if (isPdfAssignment && !info.readyForSubmission) {
    throw new Error(`"${info.title}" is not accepting submissions yet (the instructor has not finished its outline).`);
  }

  const form = new FormData();
  form.append("utf8", "✓");
  form.append("authenticity_token", csrf);
  const loaded = [];
  if (isPdfAssignment) {
    if (args.files.length !== 1) throw new Error(`"${info.title}" is a PDF assignment: submit exactly one PDF file.`);
    const f = await loadFile(args.files[0], 0, "submission.pdf");
    if (!isPdf(f.bytes)) {
      throw new Error(
        "The file is not a PDF (it does not start with %PDF-). If it came from a share link, make sure the link downloads the file itself rather than a preview page.",
      );
    }
    const name = /\.pdf$/i.test(f.name) ? f.name : "submission.pdf";
    form.append("pdf_attachment", new Blob([f.bytes], { type: "application/pdf" }), name);
    loaded.push({ name, bytes: f.bytes.length });
  } else {
    form.append("submission[method]", "upload");
    for (const [i, file] of args.files.entries()) {
      const f = await loadFile(file, i, `file${i + 1}`);
      form.append("submission[files][]", new Blob([f.bytes], { type: "application/octet-stream" }), f.name);
      loaded.push({ name: f.name, bytes: f.bytes.length });
    }
    if (args.leaderboard_name) form.append("submission[leaderboard_name]", args.leaderboard_name);
  }

  const summary = {
    assignment: info.title,
    kind: isPdfAssignment ? `pdf (${info.format})` : "code upload",
    files: loaded,
    late_submission: info.showLateWarning,
  };
  if (args.dry_run) return { dry_run: true, would_post_to: info.postUrl, ...summary };

  const res = await gsFetch(gs, info.postUrl, {
    method: "POST",
    body: form,
    headers: isPdfAssignment
      ? { Referer: referer }
      : { Referer: referer, "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" },
  });
  forgetAssignmentsCache(gs, course_id);

  let location = res.headers.get("location") || "";
  if (!location && res.headers.get("content-type")?.includes("json")) {
    try {
      const j: any = await res.json();
      location = j.url || j.path || j.redirect_url || j.location || "";
    } catch {}
  }
  const submissionId = submissionIdFrom(location);
  if (!submissionId) {
    let reasons: string[] = [];
    try {
      const $ = location ? await getPage(gs, location) : cheerio.load(await res.text());
      reasons = flashMessages($);
    } catch {}
    throw new Error(`Gradescope did not accept the submission (HTTP ${res.status}). ${reasons.join(" ") || "No reason given."}`);
  }

  const result: any = {
    submitted: true,
    submission_id: submissionId,
    submission_url: `${BASE}/courses/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`,
    ...summary,
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
