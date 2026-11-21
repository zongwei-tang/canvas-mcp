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
import { PDFDocument } from "pdf-lib";

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

// One login at a time: concurrent tool calls that find the session expired share a single re-login
// instead of each clearing the cookie jar while another is logging in.
let loginInFlight: Promise<void> | null = null;

// Gradescope sessions expire; a long-running server must log in again instead of
// silently reading the login page.
export async function ensureSession(gs: any) {
  if (loginInFlight) return loginInFlight;
  if (gs.isAuthenticated && Date.now() - authenticatedAt > SESSION_MAX_AGE_MS) resetSession(gs);
  if (gs.isAuthenticated) return;
  loginInFlight = (async () => {
    try {
      if (!(await gs.authenticate())) throw new Error("Gradescope login failed. Check the email and password set on the server.");
      authenticatedAt = Date.now();
    } finally {
      loginInFlight = null;
    }
  })();
  return loginInFlight;
}

export async function gsFetch(gs: any, path: string, init: RequestInit = {}, retried = false): Promise<Response> {
  await ensureSession(gs);
  const sessionStamp = authenticatedAt;
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Cookie: gs.cookieManager.getCookieString(),
    ...((init.headers as Record<string, string>) || {}),
  };
  const res = await fetch(path.startsWith("http") ? path : BASE + path, { ...init, headers, redirect: "manual" });
  gs.cookieManager.setCookiesFromHeaders(res.headers);
  const location = res.headers.get("location") || "";
  const bouncedToLogin = res.status >= 300 && res.status < 400 && /\/login(?:[/?#]|$)/.test(location);
  // Gradescope also answers 401 for pages the student may not see. Right after a login a 401 means exactly
  // that, so return it instead of logging in again on every such request.
  const freshSession = Date.now() - sessionStamp < 2 * 60 * 1000;
  if (!retried && (bouncedToLogin || (res.status === 401 && !freshSession))) {
    await res.body?.cancel();
    // Only drop the session if nobody refreshed it while this request was in flight.
    if (authenticatedAt === sessionStamp && !loginInFlight) resetSession(gs);
    return gsFetch(gs, path, init, true);
  }
  return res;
}

// GET a Gradescope path, following redirects that stay on Gradescope. A redirect to the login page
// after a fresh login means the session could not be restored, which is reported instead of parsed.
export async function gsFetchFollow(gs: any, path: string, init: RequestInit = {}): Promise<{ res: Response; url: string }> {
  let url = path;
  for (let hop = 0; hop < 6; hop++) {
    const res = await gsFetch(gs, url, init);
    if (res.status < 300 || res.status >= 400) return { res, url };
    const loc = res.headers.get("location") || "";
    await res.body?.cancel();
    const next = new URL(loc, BASE);
    if (next.origin !== BASE) throw new Error(`Gradescope redirected ${path} off-site to ${next.origin}.`);
    if (/^\/login(?:[/?#]|$)/.test(next.pathname)) throw new Error("Gradescope sent the request to its login page even after logging in again. The account may be locked or the password changed.");
    url = next.pathname + next.search;
  }
  throw new Error(`Too many redirects for ${path}.`);
}

export async function getPage(gs: any, path: string) {
  const { res } = await gsFetchFollow(gs, path);
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Gradescope returned ${res.status} for ${path}`);
  }
  return cheerio.load(await res.text());
}

export function csrfFrom($: cheerio.CheerioAPI) {
  const token = $('meta[name="csrf-token"]').attr("content");
  if (!token) throw new Error("Could not find Gradescope's CSRF token on the page");
  return token;
}

export function flashMessages($: cheerio.CheerioAPI) {
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
export async function findAssignment(gs: any, courseId: string, assignmentId: string) {
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
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isHeic = (b: Uint8Array) => new TextDecoder().decode(b.slice(4, 12)).startsWith("ftyphei") || new TextDecoder().decode(b.slice(4, 12)).startsWith("ftypmif");

// Build one PDF from PDFs and photos (JPEG/PNG), in the order given: phone photos of handwritten work,
// or several PDFs that make up one answer sheet. Each photo becomes one Letter-sized page, scaled to fit.
export async function combineIntoPdf(files: { name: string; bytes: Uint8Array }[]) {
  const out = await PDFDocument.create();
  const LETTER = { w: 612, h: 792 };
  for (const [i, f] of files.entries()) {
    if (isPdf(f.bytes)) {
      try {
        const src = await PDFDocument.load(f.bytes, { ignoreEncryption: true });
        for (const page of await out.copyPages(src, src.getPageIndices())) out.addPage(page);
      } catch (err) {
        throw new Error(`File ${i + 1} (${f.name}) is a PDF that could not be read for merging (${(err as Error).message}). Submit it on its own, or re-export it.`);
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
  if (out.getPageCount() === 0) throw new Error("The combined PDF has no pages.");
  return { bytes: new Uint8Array(await out.save()), pages: out.getPageCount() };
}

export function submissionIdFrom(location: string) {
  return location.match(/\/submissions\/(\d+)/)?.[1] || null;
}

export function forgetAssignmentsCache(gs: any, courseId: string) {
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
      const page = kept.find((p) => p.number != null && Number(p.number) === Number(n)) ?? kept[Number(n) - 1];
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
  args: { course_id: string; assignment_id: string; submission_id: string; question_pages?: Record<string, number[]>; replace_all?: boolean; dry_run?: boolean },
) {
  const { course_id, assignment_id, submission_id } = args;
  const data = await waitForPages(gs, course_id, assignment_id, submission_id);
  // The current matching, as {question number: [page numbers]}, read from the submission itself.
  const { submissionJson } = await import("./gs-student.js");
  const { data: sj } = await submissionJson(gs, { course_id, assignment_id, submission_id }, ["questions", "question_submissions"]);
  const byId = new Map<number, any>((sj.question_submissions || []).map((q: any) => [q.question_id, q]));
  const current: Record<string, number[]> = {};
  const unmatched: string[] = [];
  for (const q of data.questions.filter((x) => x.assignable)) {
    const pages = byId.get(q.id)?.data?.pages;
    if (Array.isArray(pages) && pages.length) current[q.full_index] = pages.map(Number);
    else unmatched.push(q.full_index);
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
      note: unmatched.length ? "Pass question_pages for the unmatched questions; questions you leave out keep their current pages." : "Every question has pages. Pass question_pages to change some of them; the rest keep their current pages.",
    };
  }
  if (data.cannotReselectPages) throw new Error("Gradescope no longer allows changing the page selection for this submission.");
  // By default only the questions passed change; the others keep their current pages.
  const keyOf = (key: string) => {
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
    unmatched_questions: stillUnmatched,
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
  if (!Array.isArray(args.files) || args.files.length === 0) throw new Error("Pass files (at least one), or repository for a code assignment submitted from GitHub.");

  const { info, csrf, referer } = await findAssignment(gs, course_id, assignment_id);
  if (info.format === "online") {
    throw new Error(`"${info.title}" is an online assignment answered in the browser; it cannot be submitted as a file.`);
  }
  const isPdfAssignment = info.format === "fixed_length" || info.format === "variable_length";
  const isTypedDocument = info.format === "typed_document";
  // Other formats use upload fields this tool has not seen.
  if (!isPdfAssignment && !isTypedDocument && info.format !== "code") {
    throw new Error(`"${info.title}" uses the "${info.format}" submission format, which this tool does not support yet. Submit it on the Gradescope website.`);
  }
  if (isPdfAssignment && !info.readyForSubmission) {
    throw new Error(`"${info.title}" is not accepting submissions yet (the instructor has not finished its outline).`);
  }

  const form = new FormData();
  form.append("utf8", "✓");
  form.append("authenticity_token", csrf);
  const loaded: any[] = [];
  let combinedFrom: string[] | null = null;
  if (isPdfAssignment) {
    const files = await Promise.all(args.files.map((f, i) => loadFile(f, i, `file${i + 1}`)));
    let bytes: Uint8Array;
    let name: string;
    if (files.length === 1 && isPdf(files[0].bytes)) {
      bytes = files[0].bytes;
      name = /\.pdf$/i.test(files[0].name) ? files[0].name : "submission.pdf";
    } else {
      // Photos and/or several PDFs: merge them into one PDF, in the order given.
      if (files.length === 1 && !isJpeg(files[0].bytes) && !isPng(files[0].bytes) && !isHeic(files[0].bytes)) {
        throw new Error(
          "The file is not a PDF (it does not start with %PDF-) or a JPEG/PNG photo. If it came from a share link, make sure the link downloads the file itself rather than a preview page.",
        );
      }
      const combined = await combineIntoPdf(files);
      bytes = combined.bytes;
      name = "submission.pdf";
      combinedFrom = files.map((f) => f.name);
      loaded.push({ name, bytes: bytes.length, pages: combined.pages, combined_from: combinedFrom });
    }
    if (bytes.length > MAX_BYTES) throw new Error("The PDF is larger than Gradescope's 100 MB limit.");
    form.append("pdf_attachment", new Blob([bytes], { type: "application/pdf" }), name);
    // A single PDF is passed through untouched (never parsed), exactly as before merging existed.
    if (!combinedFrom) loaded.push({ name, bytes: bytes.length });
  } else if (isTypedDocument) {
    // The website's "Select Document" form (doc, docx, pdf, ppt, ...) posts one file in a `file` field.
    if (args.files.length !== 1) throw new Error(`"${info.title}" takes exactly one document file.`);
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
    if (args.leaderboard_name) form.append("submission[leaderboard_name]", args.leaderboard_name);
  }

  const summary = {
    assignment: info.title,
    kind: isPdfAssignment ? `pdf (${info.format})` : isTypedDocument ? "document" : "code upload",
    files: loaded,
    late_submission: info.showLateWarning,
  };
  if (args.dry_run) return { dry_run: true, would_post_to: info.postUrl, ...summary };

  const res = await gsFetch(gs, info.postUrl, {
    method: "POST",
    body: form,
    headers: isPdfAssignment || isTypedDocument
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

// For the status tool: when the current session logged in.
export function sessionInfo() {
  return { logged_in_at: authenticatedAt ? new Date(authenticatedAt).toISOString() : null, max_age_minutes: SESSION_MAX_AGE_MS / 60000 };
}
