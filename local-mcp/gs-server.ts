// Gradescope-only MCP server for Railway (Bun). Endpoint: /<ACCESS_TOKEN>/mcp
import { GradescopeApi } from "../src/gradescope-api.js";
import { WorkerCache } from "../src/cache.js";
import { Logger } from "../src/config.js";
import { ensureSession, gsFetchFollow, matchPages, sessionInfo, submitAssignment } from "./gs-submit.js";
import {
  activateSubmission,
  autograderResults,
  autograderSsh,
  compareSubmissions,
  feedbackSummary,
  rerunAutograder,
  submissionPages,
  submissionDetails,
  submissionFiles,
  submissionHistory,
  upcomingDeadlines,
} from "./gs-student.js";
import {
  accountInfo,
  addSshPublicKey,
  assignmentInfo,
  assignmentTemplate,
  deadlinesCalendar,
  searchAssignments,
  enrollInCourse,
  groupMembers,
  gradesOverview,
  listRepositories,
  listRegradeRequests,
  submitFromRepository,
  readPage,
  requestRegrade,
  updateGroupMembers,
} from "./gs-extra.js";

// Gradescope's dashboard (as of 2026-10) titles the page "Course Dashboard" and lists each term
// as a .courseList--term header followed by a .courseList--coursesForTerm block. The upstream
// parser looks for a "Your Courses" heading and finds nothing, so fall back to reading the list directly.
const upstreamParse = (GradescopeApi.prototype as any).parseCoursesFromHTML;
(GradescopeApi.prototype as any).parseCoursesFromHTML = async function ($: any, userType: string) {
  const parsed = await upstreamParse.call(this, $, userType);
  if (parsed || userType !== "Your Courses") return parsed;

  const list = $(".courseList").first();
  if (list.length === 0) return null;
  const courses: Record<string, any> = {};
  let term = "";
  // Older terms sit inside a collapsed .courseList--inactiveCourses block, so walk descendants in order.
  list.find(".courseList--term, .courseList--coursesForTerm").each((_: number, el: any) => {
    const block = $(el);
    if (block.hasClass("courseList--term")) term = block.contents().first().text().trim();
    const active = block.closest(".courseList--inactiveCourses").length === 0;
    block.find("a.courseBox").each((_2: number, a: any) => {
      const box = $(a);
      const id = (box.attr("href") || "").split("/").pop();
      if (!id) return;
      const [semester, year] = term.split(" ");
      courses[id] = {
        id,
        name: box.find(".courseBox--shortname").text().trim(),
        full_name: box.find(".courseBox--name").text().trim(),
        semester: semester || "",
        year: year || "",
        num_grades_published: null,
        num_assignments: box.find(".courseBox--assignments").text().trim(),
        active,
      };
    });
  });
  const isInstructor = /Create a new course/i.test($.html());
  return { courses, isInstructor };
};

// The upstream student-view parser reads the status cell with .text(), which glues the cell's parts together
// ("Submitted" + "1 Day, 23 Hours Late" -> "Submitted1 Day, 23 Hours Late"). Re-read it with a space between
// elements. Rows come back in table order, so they line up with the parsed list.
const upstreamStudentView = (GradescopeApi.prototype as any).parseAssignmentsStudentView;
(GradescopeApi.prototype as any).parseAssignmentsStudentView = function ($: any) {
  const list = upstreamStudentView.call(this, $);
  if (!list) return list;
  const rows = $('tr[role="row"]').slice(1, -1).filter((_: number, r: any) => $(r).find("th, td").length >= 3);
  rows.each((i: number, r: any) => {
    const item = list[i];
    if (!item || item.grade !== null) return;
    const cell = $($(r).find("th, td")[1]).clone();
    cell.find("*").each((_: number, e: any) => {
      $(e).append(" ");
    });
    item.submissions_status = cell.text().replace(/\s+/g, " ").trim();
  });
  return list;
};

// The upstream client's requests follow redirects blindly: with an expired session they land on the
// login page, parse it as "no courses / no assignments", and cache that for up to an hour. Route them
// through gsFetchFollow instead, which re-logs in, refuses the login page, and records why a read failed.
(GradescopeApi.prototype as any).makeAuthenticatedRequest = async function (url: string, options: RequestInit = {}) {
  try {
    const { res } = await gsFetchFollow(this, url, options);
    if (!res.ok) {
      await res.body?.cancel();
      this.lastError = `Gradescope returned ${res.status} for ${new URL(url, "https://www.gradescope.com").pathname}`;
      return null;
    }
    return res;
  } catch (err) {
    this.lastError = (err as Error).message;
    return null;
  }
};

const ACCESS_TOKEN = Bun.env.ACCESS_TOKEN || "";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_VERSION = "2.0.0";

let gsApi: GradescopeApi | null = null;
function api(): GradescopeApi {
  if (!Bun.env.GRADESCOPE_EMAIL || !Bun.env.GRADESCOPE_PASSWORD) {
    throw new Error("GRADESCOPE_EMAIL / GRADESCOPE_PASSWORD are not set on the server");
  }
  if (!gsApi) {
    gsApi = new GradescopeApi({
      email: Bun.env.GRADESCOPE_EMAIL,
      password: Bun.env.GRADESCOPE_PASSWORD,
      logger: new Logger(false),
      cache: new WorkerCache(),
    });
  }
  return gsApi;
}

const text = (value: any, fallback: string) => {
  const why = (gsApi as any)?.lastError;
  return { content: [{ type: "text", text: value ? JSON.stringify(value, null, 2) : why ? `${fallback}: ${why}` : fallback }] };
};

// Reads go through the upstream client; refresh an expired session first.
async function session(): Promise<GradescopeApi> {
  const gs = api();
  (gs as any).lastError = null;
  await ensureSession(gs);
  return gs;
}

// Name lookups: an exact (case-insensitive) match wins; otherwise every partial match is returned,
// because course names like "Math 53" can belong to several courses.
function pickByName<T>(items: T[], query: string, names: (x: T) => string[]) {
  const q = query.trim().toLowerCase();
  const exact = items.filter((x) => names(x).some((n) => (n || "").toLowerCase() === q));
  const partial = items.filter((x) => names(x).some((n) => (n || "").toLowerCase().includes(q)));
  const hits = exact.length ? exact : partial;
  if (hits.length === 0) return null;
  if (hits.length === 1) return hits[0];
  return { matches: hits, note: `${hits.length} matches for "${query}"; pick one by its ID.` };
}

async function courseByName(gs: any, name: string) {
  const all = await gs.getGradescopeCourses();
  if (!all) return null;
  const courses = [...Object.values<any>(all.student || {}), ...Object.values<any>(all.instructor || {})];
  return pickByName(courses, name, (c) => [c.name, c.full_name]);
}

async function assignmentByName(gs: any, courseId: string, name: string) {
  const list = await gs.getGradescopeAssignments(courseId);
  if (!list) return null;
  return pickByName(list as any[], name, (a) => [a.name]);
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
const ASSIGNMENT_ID = {
  type: "string",
  description: "The Gradescope assignment ID. Can be found via get_gradescope_assignments.",
};
const QUESTION_PAGES = {
  type: "object",
  description:
    'Which PDF pages answer which question, e.g. {"1": [1], "2": [2, 3], "3.1": [4]}. Keys are question numbers as Gradescope shows them (or exact question titles); values are 1-based page numbers of the uploaded PDF.',
  additionalProperties: { type: "array", items: { type: "integer", minimum: 1 } },
};
const COURSE_ID = {
  type: "string",
  description: "The unique identifier for the Gradescope course. Can be found via get_gradescope_courses or get_gradescope_course_by_name.",
};

const SUBMISSION_ID = {
  type: "string",
  description: "Optional submission ID. Omit it to use the active (latest graded) submission for the assignment.",
};
const submissionRef = (extra: Record<string, any> = {}, required: string[] = []) => ({
  type: "object",
  properties: { course_id: COURSE_ID, assignment_id: ASSIGNMENT_ID, submission_id: SUBMISSION_ID, ...extra },
  required: ["course_id", "assignment_id", ...required],
});

const tools = [
  {
    name: "get_gradescope_courses",
    description: "Retrieve all Gradescope courses for the current user.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Get Gradescope Courses", ...READ_ONLY },
    handler: async () => text(await (await session()).getGradescopeCourses(), "Failed to retrieve Gradescope courses"),
  },
  {
    name: "get_gradescope_course_by_name",
    description: "Find a Gradescope course by name. An exact name match wins; otherwise all partial matches are returned as a list.",
    inputSchema: {
      type: "object",
      properties: {
        course_name: { type: "string", description: "The name of the Gradescope course to search for. Partial matches are supported." },
      },
      required: ["course_name"],
    },
    annotations: { title: "Find Gradescope Course by Name", ...READ_ONLY },
    handler: async (a: any) => text(await courseByName(await session(), a.course_name), "Course not found"),
  },
  {
    name: "get_gradescope_assignments",
    description: "Retrieve all assignments for a Gradescope course.",
    inputSchema: { type: "object", properties: { course_id: COURSE_ID }, required: ["course_id"] },
    annotations: { title: "Get Gradescope Assignments", ...READ_ONLY },
    handler: async (a: any) => text(await (await session()).getGradescopeAssignments(a.course_id), "Failed to retrieve assignments"),
  },
  {
    name: "get_gradescope_assignment_by_name",
    description: "Find a Gradescope assignment by name. An exact name match wins; otherwise all partial matches are returned as a list.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_name: { type: "string", description: "The name of the assignment to search for. Partial matches are supported." },
      },
      required: ["course_id", "assignment_name"],
    },
    annotations: { title: "Find Gradescope Assignment by Name", ...READ_ONLY },
    handler: async (a: any) =>
      text(await assignmentByName(await session(), a.course_id, a.assignment_name), "Assignment not found"),
  },
  {
    name: "get_gradescope_upcoming_deadlines",
    description:
      "List assignments due soon across Gradescope courses, soonest first. By default only unsubmitted assignments from active courses (the ones Gradescope has not moved to its archived list, which can include the previous term) are shown; " +
      "assignments past their regular deadline whose late deadline is still open are flagged, and listed separately when that late deadline is beyond the window.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead to look. Default 14." },
        include_submitted: { type: "boolean", description: "Also list assignments that already have a submission. Default false." },
        include_inactive_courses: { type: "boolean", description: "Also check archived courses from older terms. Default false." },
        course_ids: { type: "array", items: { type: "string" }, description: "Only check these course IDs." },
      },
      required: [],
    },
    annotations: { title: "Get Upcoming Gradescope Deadlines", ...READ_ONLY },
    handler: async (a: any) => text(await upcomingDeadlines(await session(), a), "No deadlines found"),
  },
  {
    name: "get_gradescope_submission",
    description:
      "Get the grade breakdown of a submission: total score, each question's score and max points, which rubric items were applied, grader point adjustments and comments, and an autograder summary.",
    inputSchema: submissionRef(),
    annotations: { title: "Get Gradescope Submission Grades", ...READ_ONLY },
    handler: async (a: any) => text(await submissionDetails(await session(), a), "Submission not found"),
  },
  {
    name: "get_gradescope_autograder_results",
    description:
      "Get autograder test results for a code submission: overall score and output, plus each test's name, status, score and output. " +
      "Right after submitting, the autograder may still be running; pass wait_seconds to wait for it.",
    inputSchema: submissionRef({
      only_failed: { type: "boolean", description: "Only return tests that failed or lost points. Default false." },
      max_output_chars: { type: "number", description: "Truncate each test's output to this many characters. Default 2000." },
      wait_seconds: { type: "number", description: "If the autograder is still running, wait up to this many seconds (max 120). Default 0." },
    }),
    annotations: { title: "Get Gradescope Autograder Results", ...READ_ONLY },
    handler: async (a: any) => text(await autograderResults(await session(), a), "No autograder results"),
  },
  {
    name: "get_gradescope_submission_history",
    description: "List every submission made for an assignment, newest first, with time, score, submitters, and which one is active.",
    inputSchema: submissionRef(),
    annotations: { title: "Get Gradescope Submission History", ...READ_ONLY },
    handler: async (a: any) => text(await submissionHistory(await session(), a), "No submissions found"),
  },
  {
    name: "activate_gradescope_submission",
    description:
      "Make an earlier submission the active one that gets graded. This changes what course staff grade, so confirm with the user first, or use dry_run. " +
      "Get submission IDs from get_gradescope_submission_history.",
    inputSchema: submissionRef(
      {
        submission_id: { type: "string", description: "The submission to activate, from get_gradescope_submission_history." },
        dry_run: { type: "boolean", description: "Check that the submission can be activated without changing anything." },
      },
      ["submission_id"],
    ),
    annotations: { title: "Activate Gradescope Submission", ...WRITE },
    handler: async (a: any) => text(await activateSubmission(await session(), a), "Activation failed"),
  },
  {
    name: "download_gradescope_submission_files",
    description:
      "Get the files of a submission. Code submissions return each file's path and text contents, plus any line comments from graders. " +
      "PDF submissions return a temporary download link to the uploaded PDF; set embed_pdf to attach the original or the graded (annotated) PDF itself.",
    inputSchema: submissionRef({
      include_content: { type: "boolean", description: "Include code file contents. Default true." },
      max_chars_per_file: { type: "number", description: "Truncate each code file to this many characters. Default 50000." },
      max_total_chars: { type: "number", description: "Stop including file contents after this many characters in total; later files get a download link instead. Default 200000." },
      embed_pdf: {
        type: "string",
        enum: ["none", "original", "graded"],
        description: 'Attach a PDF to the result: "original" (as uploaded) or "graded" (with grader marks). Default "none". Limit 10 MB.',
      },
      embed_zip: { type: "boolean", description: "Attach the whole submission as a zip (the website's Download Submission), where the course allows it. Limit 10 MB." },
      embed_binary_files: {
        type: "boolean",
        description: "Attach the code submission's non-text files too (screenshots, large or binary files): images as images, others as files. Up to 10 files / 15 MB.",
      },
    }),
    annotations: { title: "Download Gradescope Submission Files", ...READ_ONLY },
    handler: async (a: any) => {
      const { result, blobs, images } = await submissionFiles(await session(), a);
      return {
        content: [
          { type: "text", text: JSON.stringify(result, null, 2) },
          ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType })),
          ...blobs.map((b) => ({ type: "resource", resource: b })),
        ],
      };
    },
  },
  {
    name: "get_gradescope_page",
    description:
      "Read any Gradescope page the user can see, by path (e.g. /courses/123, /courses/123/assignments/456/submissions/789, /account). " +
      "Returns the page's visible text, its links, its forms (field names only), and the data behind its interactive components. " +
      "Use it for anything the specific tools do not cover, such as online assignments, leaderboards, or course pages. Read-only: pages that sign out or change the account are refused.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: 'A path on www.gradescope.com starting with "/". Paths ending in .json?content=react return raw JSON.' },
        component: { type: "string", description: "Only return this interactive component's data (e.g. AssignmentSubmissionViewer)." },
        include_props: { type: "boolean", description: "Include component data. Default true; set false for just text, links and forms." },
        max_chars: { type: "number", description: "Approximate size limit for the result. Default 60000, max 200000." },
      },
      required: ["path"],
    },
    annotations: { title: "Read a Gradescope Page", ...READ_ONLY },
    handler: async (a: any) => text(await readPage(await session(), a), "Page could not be read"),
  },
  {
    name: "get_gradescope_assignment_info",
    description:
      "Everything about one assignment, submitted or not: dates, status and grade, submission format (PDF, code, online), accepted submission methods, " +
      "the blank template link, time limit, group size, late-submission warning, regrade window, and the active submission ID if there is one. " +
      "Set embed_template to attach the template file itself (often the problem set).",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        embed_template: { type: "boolean", description: "Attach the assignment's blank template (usually a PDF), if it has one. Limit 10 MB." },
      },
      required: ["course_id", "assignment_id"],
    },
    annotations: { title: "Get Gradescope Assignment Info", ...READ_ONLY },
    handler: async (a: any) => {
      const gs = await session();
      const info: any = await assignmentInfo(gs, a);
      if (!a.embed_template) return text(info, "Assignment not found");
      if (!info.template_url) return text({ ...info, template: "this assignment has no template" }, "Assignment not found");
      const t = await assignmentTemplate(gs, info.template_url);
      return {
        content: [
          { type: "text", text: JSON.stringify({ ...info, template: `attached as a resource (${t.bytes} bytes, ${t.mimeType})` }, null, 2) },
          { type: "resource", resource: { uri: t.uri, mimeType: t.mimeType, blob: t.blob } },
        ],
      };
    },
  },
  {
    name: "get_gradescope_feedback_summary",
    description:
      "Where points were lost across a whole course: for every graded submission, the questions below full marks with the rubric items applied and the grader's comments, sorted by points lost. " +
      "Use it to review mistakes or find regrade candidates.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        only_lost_points: { type: "boolean", description: "Only list assignments that lost points. Default true." },
        assignment_ids: { type: "array", items: { type: "string" }, description: "Only these assignments." },
      },
      required: ["course_id"],
    },
    annotations: { title: "Get Gradescope Feedback Summary", ...READ_ONLY },
    handler: async (a: any) => text(await feedbackSummary(await session(), a), "No graded submissions"),
  },
  {
    name: "get_gradescope_status",
    description: "Check the connection: whether the server is logged in to Gradescope, as whom, since when, and the last error a read hit. Use it when other tools fail.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Gradescope Connection Status", ...READ_ONLY },
    handler: async () => {
      const gs: any = api();
      const before = gs.lastError || null;
      let account: any = null;
      let error: string | null = null;
      try {
        await ensureSession(gs);
        account = await accountInfo(gs);
      } catch (err) {
        error = (err as Error).message;
      }
      return text(
        {
          logged_in: !!account,
          account: account ? { name: account.name, primary_email: account.emails?.find((e: any) => e.primary)?.email ?? null } : null,
          session: sessionInfo(),
          error,
          last_read_error: before,
          server: { name: "Gradescope MCP", version: SERVER_VERSION, tools: tools.length },
        },
        "Status unavailable",
      );
    },
  },
  {
    name: "search_gradescope_assignments",
    description: "Find assignments by name across all active courses at once (e.g. \"midterm\", \"project 3\"), with each one's course, due date, status and score.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to look for in assignment names." },
        include_inactive_courses: { type: "boolean", description: "Also search archived courses. Default false." },
      },
      required: ["query"],
    },
    annotations: { title: "Search Gradescope Assignments", ...READ_ONLY },
    handler: async (a: any) => text(await searchAssignments(await session(), a), "No assignments found"),
  },
  {
    name: "export_gradescope_deadlines_calendar",
    description:
      "Export upcoming Gradescope deadlines as an iCalendar (.ics) file the user can import into Google Calendar, Apple Calendar or Outlook, with a reminder before each deadline.",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number", description: "How many days ahead. Default 60." },
        include_submitted: { type: "boolean", description: "Include assignments already submitted (marked with a check). Default true." },
        include_inactive_courses: { type: "boolean", description: "Also include archived courses. Default false." },
        course_ids: { type: "array", items: { type: "string" }, description: "Only these courses." },
        reminder_minutes: { type: "number", description: "Reminder this many minutes before each deadline; 0 for none. Default 1440 (one day)." },
      },
      required: [],
    },
    annotations: { title: "Export Gradescope Deadlines Calendar", ...READ_ONLY },
    handler: async (a: any) => text(await deadlinesCalendar(await session(), a), "No deadlines to export"),
  },
  {
    name: "compare_gradescope_submissions",
    description:
      "Show what changed between two submissions of an assignment: a diff of every changed text file, the score change, and which autograder tests changed. " +
      "By default compares the active submission with the one before it; get IDs from get_gradescope_submission_history.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        base_submission_id: { type: "string", description: "The older submission. Default: the one just before head." },
        head_submission_id: { type: "string", description: "The newer submission. Default: the active one." },
        max_chars: { type: "number", description: "Size limit for all diffs together. Default 60000." },
      },
      required: ["course_id", "assignment_id"],
    },
    annotations: { title: "Compare Gradescope Submissions", ...READ_ONLY },
    handler: async (a: any) => text(await compareSubmissions(await session(), a), "Comparison failed"),
  },
  {
    name: "add_gradescope_ssh_public_key",
    description:
      "Add an SSH public key to the Gradescope account, which autograder SSH debugging requires. This changes account settings, so confirm with the user first, or use dry_run. " +
      "Pass only the public key (one line from a .pub file); a private key is refused.",
    inputSchema: {
      type: "object",
      properties: {
        public_key: { type: "string", description: "One line like: ssh-ed25519 AAAA... comment" },
        dry_run: { type: "boolean", description: "Validate the key without adding it." },
      },
      required: ["public_key"],
    },
    annotations: { title: "Add Gradescope SSH Public Key", ...WRITE },
    handler: async (a: any) => text(await addSshPublicKey(await session(), a), "Adding the key failed"),
  },
  {
    name: "get_gradescope_regrade_requests",
    description: "List the user's regrade requests in a course, with question, assignment, date and status.",
    inputSchema: { type: "object", properties: { course_id: COURSE_ID }, required: ["course_id"] },
    annotations: { title: "Get Gradescope Regrade Requests", ...READ_ONLY },
    handler: async (a: any) => text(await listRegradeRequests(await session(), a), "No regrade requests"),
  },
  {
    name: "request_gradescope_regrade",
    description:
      "Ask graders to regrade one question of a graded submission, with an explanation. Course staff see the request, so confirm the question and wording with the user first, or use dry_run. " +
      "If a request already exists for that question, its status is returned instead unless update_existing is true.",
    inputSchema: submissionRef(
      {
        question: { type: "string", description: 'The question number as Gradescope shows it (e.g. "2" or "3.1"), or its exact title.' },
        comment: { type: "string", description: "The explanation sent to the grader." },
        update_existing: { type: "boolean", description: "Replace the comment on an existing request for this question. Default false." },
        dry_run: { type: "boolean", description: "Check the question, the regrade window and existing requests without sending anything." },
      },
      ["question", "comment"],
    ),
    annotations: { title: "Request Gradescope Regrade", ...WRITE },
    handler: async (a: any) => text(await requestRegrade(await session(), a), "Regrade request failed"),
  },
  {
    name: "get_gradescope_group_members",
    description: "Show who is in the group on a submission (name, email, uploader), the group size limit, and whether members can still be changed.",
    inputSchema: submissionRef(),
    annotations: { title: "Get Gradescope Group Members", ...READ_ONLY },
    handler: async (a: any) => text(await groupMembers(await session(), a), "Submission not found"),
  },
  {
    name: "update_gradescope_group_members",
    description:
      "Add or remove group members on a submission, by exact school email. Added students get credit for, and access to, the submission, so confirm the emails with the user first, or use dry_run. " +
      "Removing yourself or the uploader is refused.",
    inputSchema: submissionRef({
      add_emails: { type: "array", items: { type: "string" }, description: "Emails of classmates to add. Must match their Gradescope email exactly." },
      remove_emails: { type: "array", items: { type: "string" }, description: "Emails of current members to remove." },
      dry_run: { type: "boolean", description: "Resolve the emails and check the group size limit without changing anything." },
    }),
    annotations: { title: "Update Gradescope Group Members", ...WRITE },
    handler: async (a: any) => text(await updateGroupMembers(await session(), a), "Updating group members failed"),
  },
  {
    name: "get_gradescope_account",
    description: "Show the Gradescope account's name, email, student ID, language, and linked external accounts.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { title: "Get Gradescope Account", ...READ_ONLY },
    handler: async () => text(await accountInfo(await session()), "Account page could not be read"),
  },
  {
    name: "enroll_gradescope_course",
    description:
      "Join a Gradescope course with the entry code the instructor shared. Confirm the code with the user first. A dry run cannot check whether the code is valid.",
    inputSchema: {
      type: "object",
      properties: {
        entry_code: { type: "string", description: "The course entry code, e.g. 6 letters and digits." },
        dry_run: { type: "boolean", description: "Show what would be sent without enrolling." },
      },
      required: ["entry_code"],
    },
    annotations: { title: "Enroll in Gradescope Course", ...WRITE },
    handler: async (a: any) => text(await enrollInCourse(await session(), a), "Enrollment failed"),
  },
  {
    name: "submit_gradescope_assignment",
    description:
      "Submit files to a Gradescope assignment on the user's behalf. This creates a real submission that course staff can see and replaces any earlier submission, so confirm the course, assignment and file with the user before calling it, or use dry_run first. " +
      "PDF assignments take one PDF, or several PDFs and/or JPEG/PNG photos (e.g. of handwritten work), which are merged into one PDF in the order given; document assignments take one document (doc, docx, pdf, ...); code assignments take one or more files, or a linked GitHub repository and branch instead of files. For PDF assignments where students mark pages, pass question_pages to match pages to questions in the same call; otherwise the result lists the questions so you can call match_gradescope_pages next.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        files: {
          type: "array",
          minItems: 1,
          description:
            "Files to submit. Give each file one source: url (a direct download link; Google Drive share links are converted automatically, and the file must be shared so anyone with the link can view), content_base64 (raw bytes), or text (plain-text file contents, for code).",
          items: {
            type: "object",
            properties: {
              filename: { type: "string", description: "File name to show on Gradescope. Optional for PDFs." },
              url: { type: "string" },
              content_base64: { type: "string" },
              text: { type: "string" },
            },
          },
        },
        repository: {
          type: "object",
          description: "Code assignments only, instead of files: submit a GitHub or Bitbucket repository linked to the user's Gradescope account.",
          properties: {
            name: { type: "string", description: 'Repository as "owner/name".' },
            branch: { type: "string", description: "Branch to submit. Defaults to the repository's default branch." },
            service: { type: "string", enum: ["github", "bitbucket"], description: 'Where the repository lives. Default "github".' },
          },
          required: ["name"],
        },
        question_pages: QUESTION_PAGES,
        leaderboard_name: { type: "string", description: "Leaderboard name, only for code assignments with a leaderboard." },
        dry_run: { type: "boolean", description: "Check everything (assignment is open, file downloads and is valid, or repository and branch exist) without submitting." },
      },
      required: ["course_id", "assignment_id"],
    },
    annotations: { title: "Submit Gradescope Assignment", ...WRITE },
    handler: async (a: any) => {
      const gs = await session();
      if (a.repository && a.files?.length) throw new Error("Pass either files or repository, not both.");
      if (a.repository) return text(await submitFromRepository(gs, a), "Submission failed");
      return text(await submitAssignment(gs, a), "Submission failed");
    },
  },
  {
    name: "list_gradescope_repositories",
    description:
      "List the GitHub or Bitbucket repositories Gradescope can access through the user's linked account, or the branches of one repository. Use it before submitting a code assignment from a repository.",
    inputSchema: {
      type: "object",
      properties: {
        service: { type: "string", enum: ["github", "bitbucket"], description: 'Default "github".' },
        query: { type: "string", description: "Only list repositories whose name contains this text." },
        repository: { type: "string", description: 'Show the branches of this repository ("owner/name") instead of listing repositories.' },
      },
      required: [],
    },
    annotations: { title: "List Linked Repositories", ...READ_ONLY },
    handler: async (a: any) => text(await listRepositories(await session(), a), "No repositories found"),
  },
  {
    name: "get_gradescope_submission_pages",
    description:
      "Look at the pages of a PDF or photo submission as images, so you can see exactly what was handed in. Pick pages by number or by question; up to 12 pages per call (default 4).",
    inputSchema: submissionRef({
      pages: { type: "array", items: { type: "integer", minimum: 1 }, description: "1-based page numbers to return." },
      questions: { type: "array", items: { type: "string" }, description: 'Return the pages matched to these questions, e.g. ["2", "3.1"].' },
      size: { type: "string", enum: ["full", "thumbnail"], description: 'Image size. Default "full".' },
      max_pages: { type: "number", description: "At most this many pages in one call (1 to 12). Default 4." },
    }),
    annotations: { title: "View Gradescope Submission Pages", ...READ_ONLY },
    handler: async (a: any) => {
      const { result, images } = await submissionPages(await session(), a);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }, ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))],
      };
    },
  },
  {
    name: "rerun_gradescope_autograder",
    description:
      "Run the autograder again on a code submission (the Rerun Autograder button). The score can change, for example if staff updated the tests since, so confirm with the user first, or use dry_run. Gradescope may not allow this for students in every course. Pass wait_seconds to wait for the new results.",
    inputSchema: submissionRef({
      dry_run: { type: "boolean", description: "Check that the submission can be rerun without starting it." },
      wait_seconds: { type: "number", description: "Wait up to this many seconds (max 120) for the new results." },
    }),
    annotations: { title: "Rerun Gradescope Autograder", ...WRITE },
    handler: async (a: any) => text(await rerunAutograder(await session(), a), "Rerun failed"),
  },
  {
    name: "gradescope_autograder_ssh",
    description:
      'Debug a code submission inside the autograder over SSH, where the course allows it. action "status" (default) shows whether SSH is available and any running session; "start" starts one. The account needs an SSH public key on Gradescope.',
    inputSchema: submissionRef({
      action: { type: "string", enum: ["status", "start"], description: 'Default "status".' },
      dry_run: { type: "boolean", description: "With start: check availability without starting a session." },
    }),
    annotations: { title: "Gradescope Autograder SSH", ...WRITE, destructiveHint: false },
    handler: async (a: any) => text(await autograderSsh(await session(), a), "SSH request failed"),
  },
  {
    name: "get_gradescope_grades",
    description:
      "All scores across courses in one view: every assignment's score, maximum and status, and graded points per course. Returns a snapshot; pass it back later as previous_snapshot to list new grades, changed scores and new submissions since then.",
    inputSchema: {
      type: "object",
      properties: {
        course_ids: { type: "array", items: { type: "string" }, description: "Only these courses." },
        include_inactive_courses: { type: "boolean", description: "Also include archived courses. Default false." },
        previous_snapshot: { type: "string", description: "A snapshot from an earlier call, to report changes since then." },
      },
      required: [],
    },
    annotations: { title: "Get Gradescope Grades", ...READ_ONLY },
    handler: async (a: any) => text(await gradesOverview(await session(), a), "No grades found"),
  },
  {
    name: "match_gradescope_pages",
    description:
      "Match the pages of an uploaded PDF submission to the assignment's questions. Call without question_pages to see the questions, the current matching and any unmatched questions; " +
      "call with question_pages to change it. Questions you leave out keep their current pages unless replace_all is true.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        submission_id: { type: "string", description: "The submission ID returned by submit_gradescope_assignment." },
        question_pages: QUESTION_PAGES,
        replace_all: { type: "boolean", description: "Replace the whole matching with question_pages (questions left out get no pages). Default false." },
        dry_run: { type: "boolean", description: "Show the matching that would be saved without saving it." },
      },
      required: ["course_id", "assignment_id", "submission_id"],
    },
    annotations: { title: "Match Gradescope Pages", ...WRITE },
    handler: async (a: any) => text(await matchPages(await session(), a), "Page matching failed"),
  },
];

// Ready-made workflows for clients that show MCP prompts.
const PROMPTS: { name: string; description: string; arguments?: { name: string; description: string; required?: boolean }[]; build: (a: any) => string }[] = [
  {
    name: "weekly_review",
    description: "What is due soon, what was graded since last time, and what to do first.",
    arguments: [{ name: "previous_snapshot", description: "Snapshot from the last get_gradescope_grades call, if you have one." }],
    build: (a) =>
      "Give me my Gradescope weekly review. 1) Call get_gradescope_upcoming_deadlines (14 days) and list what is due, soonest first, with hours left. " +
      `2) Call get_gradescope_grades${a.previous_snapshot ? ` with previous_snapshot "${a.previous_snapshot}"` : ""} and list new or changed grades. ` +
      "3) End with the three most urgent things to do. Keep it short, and give me the new snapshot at the end.",
  },
  {
    name: "before_deadline_check",
    description: "Check that a submission is complete before the deadline: submitted, every question has pages, autograder passing.",
    arguments: [
      { name: "course_id", description: "Course ID", required: true },
      { name: "assignment_id", description: "Assignment ID", required: true },
    ],
    build: (a) =>
      `Check my Gradescope submission for course ${a.course_id}, assignment ${a.assignment_id} before the deadline. ` +
      "Use get_gradescope_assignment_info to see the format, due date and whether there is a submission. " +
      "For a PDF assignment, call match_gradescope_pages without question_pages and report any unmatched questions. " +
      "For a code assignment, call get_gradescope_autograder_results with only_failed. " +
      "Tell me plainly whether it is complete and what, if anything, I still need to do. Do not submit or change anything.",
  },
  {
    name: "lost_points_review",
    description: "Where points were lost in a course, and which might deserve a regrade request.",
    arguments: [{ name: "course_id", description: "Course ID", required: true }],
    build: (a) =>
      `Review where I lost points in Gradescope course ${a.course_id}. Call get_gradescope_feedback_summary, then group the mistakes by topic, ` +
      "and point out any question where the applied rubric items seem not to match the comments, as possible regrade candidates (only where regrade requests are open). " +
      "Do not send any regrade request without asking me.",
  },
];

async function handleMessage(msg: any): Promise<any> {
  const { id, method, params } = msg ?? {};
  if (id === undefined || id === null) return null; // notification
  const ok = (result: any) => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      return ok({
        protocolVersion: SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0],
        capabilities: { tools: {}, prompts: {} },
        serverInfo: { name: "Gradescope MCP", version: SERVER_VERSION },
      });
    }
    case "ping":
      return ok({});
    case "prompts/list":
      return ok({ prompts: PROMPTS.map(({ build, ...p }) => p) });
    case "prompts/get": {
      const p = PROMPTS.find((x) => x.name === params?.name);
      if (!p) return fail(-32602, `Unknown prompt: ${params?.name}`);
      const missing = (p.arguments || []).filter((a: any) => a.required && !params?.arguments?.[a.name]).map((a: any) => a.name);
      if (missing.length) return fail(-32602, `Missing argument(s): ${missing.join(", ")}`);
      return ok({ description: p.description, messages: [{ role: "user", content: { type: "text", text: p.build(params?.arguments || {}) } }] });
    }
    case "tools/list":
      return ok({ tools: tools.map(({ handler, ...t }) => t) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return fail(-32602, `Unknown tool: ${params?.name}`);
      try {
        return ok(await tool.handler(params?.arguments ?? {}));
      } catch (err) {
        return ok({ content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
      }
    }
    default:
      return fail(-32601, `Method not found: ${method}`);
  }
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export async function handleRequest(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname.replace(/\/+$/, "");
  if (!ACCESS_TOKEN || (path !== `/${ACCESS_TOKEN}` && path !== `/${ACCESS_TOKEN}/mcp`)) {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method === "DELETE") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: CORS });

  let body: any;
  try {
    body = await request.json();
  } catch {
    return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, { status: 400, headers: CORS });
  }
  const replies = (await Promise.all((Array.isArray(body) ? body : [body]).map(handleMessage))).filter(Boolean);
  if (replies.length === 0) return new Response(null, { status: 202, headers: CORS });
  return Response.json(Array.isArray(body) ? replies : replies[0], { headers: CORS });
}

if (!Bun.env.SKIP_SERVE) {
  Bun.serve({ port: Number(Bun.env.PORT) || 3000, idleTimeout: 255, fetch: handleRequest }); // PDF processing can take a while
  console.log("gradescope-mcp listening");
}
