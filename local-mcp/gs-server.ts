// Gradescope-only MCP server for Railway (Bun). Endpoint: /<ACCESS_TOKEN>/mcp
import { GradescopeApi } from "../src/gradescope-api.js";
import { WorkerCache } from "../src/cache.js";
import { Logger } from "../src/config.js";
import { ensureSession, matchPages, submitAssignment } from "./gs-submit.js";

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
      };
    });
  });
  const isInstructor = /Create a new course/i.test($.html());
  return { courses, isInstructor };
};

const ACCESS_TOKEN = Bun.env.ACCESS_TOKEN || "";
const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

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

const text = (value: any, fallback: string) => ({
  content: [{ type: "text", text: value ? JSON.stringify(value, null, 2) : fallback }],
});

// Reads go through the upstream client; refresh an expired session first.
async function session(): Promise<GradescopeApi> {
  const gs = api();
  await ensureSession(gs);
  return gs;
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
    description: "Find a Gradescope course by name.",
    inputSchema: {
      type: "object",
      properties: {
        course_name: { type: "string", description: "The name of the Gradescope course to search for. Partial matches are supported." },
      },
      required: ["course_name"],
    },
    annotations: { title: "Find Gradescope Course by Name", ...READ_ONLY },
    handler: async (a: any) => text(await (await session()).getGradescopeCourseByName(a.course_name), "Course not found"),
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
    description: "Find a Gradescope assignment by name.",
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
      text(await (await session()).getGradescopeAssignmentByName(a.course_id, a.assignment_name), "Assignment not found"),
  },
  {
    name: "submit_gradescope_assignment",
    description:
      "Submit files to a Gradescope assignment on the user's behalf. This creates a real submission that course staff can see and replaces any earlier submission, so confirm the course, assignment and file with the user before calling it, or use dry_run first. " +
      "PDF assignments take exactly one PDF; code assignments take one or more files. For PDF assignments where students mark pages, pass question_pages to match pages to questions in the same call; otherwise the result lists the questions so you can call match_gradescope_pages next.",
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
        question_pages: QUESTION_PAGES,
        leaderboard_name: { type: "string", description: "Leaderboard name, only for code assignments with a leaderboard." },
        dry_run: { type: "boolean", description: "Check everything (assignment is open, file downloads and is valid) without submitting." },
      },
      required: ["course_id", "assignment_id", "files"],
    },
    annotations: { title: "Submit Gradescope Assignment", ...WRITE },
    handler: async (a: any) => text(await submitAssignment(await session(), a), "Submission failed"),
  },
  {
    name: "match_gradescope_pages",
    description:
      "Match the pages of an uploaded PDF submission to the assignment's questions. Call without question_pages to list the questions and the page count; call with question_pages to save the matching.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        submission_id: { type: "string", description: "The submission ID returned by submit_gradescope_assignment." },
        question_pages: QUESTION_PAGES,
        dry_run: { type: "boolean", description: "Show the matching that would be saved without saving it." },
      },
      required: ["course_id", "assignment_id", "submission_id"],
    },
    annotations: { title: "Match Gradescope Pages", ...WRITE },
    handler: async (a: any) => text(await matchPages(await session(), a), "Page matching failed"),
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
        capabilities: { tools: {} },
        serverInfo: { name: "Gradescope MCP", version: "1.0.0" },
      });
    }
    case "ping":
      return ok({});
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
