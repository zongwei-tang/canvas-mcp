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

// gs-submit.ts
import * as cheerio2 from "cheerio@1.2.0";
var BASE = "https://www.gradescope.com";
var UA = "Canvas-MCP/1.1.0";
var MAX_BYTES = 100 * 1024 * 1024;
var SESSION_MAX_AGE_MS = 20 * 60 * 1e3;
var authenticatedAt = 0;
function resetSession(gs) {
  gs.isAuthenticated = false;
  gs.csrfToken = "";
  gs.cookieManager.clear();
}
async function ensureSession(gs) {
  if (gs.isAuthenticated && Date.now() - authenticatedAt > SESSION_MAX_AGE_MS)
    resetSession(gs);
  if (!gs.isAuthenticated) {
    if (!await gs.authenticate())
      throw new Error("Gradescope login failed. Check the email and password set on the server.");
    authenticatedAt = Date.now();
  }
}
async function gsFetch(gs, path, init = {}, retried = false) {
  await ensureSession(gs);
  const headers = {
    "User-Agent": UA,
    Cookie: gs.cookieManager.getCookieString(),
    ...init.headers || {}
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
async function getPage(gs, path) {
  const res = await gsFetch(gs, path);
  if (res.status >= 300 && res.status < 400) {
    return getPage(gs, res.headers.get("location"));
  }
  if (!res.ok)
    throw new Error(`Gradescope returned ${res.status} for ${path}`);
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
  return { info, csrf: csrfFrom($page), referer: `${BASE}/courses/${courseId}` };
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
var isPdf = (b) => new TextDecoder().decode(b.slice(0, 1024)).includes("%PDF-");
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
      const page = kept[Number(n) - 1];
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
  if (!args.question_pages || Object.keys(args.question_pages).length === 0) {
    return { submission_id, pdf_status: data.status, page_count: data.pages.length, questions: describeQuestions(data), note: "Pass question_pages to assign pages." };
  }
  if (data.cannotReselectPages)
    throw new Error("Gradescope no longer allows changing the page selection for this submission.");
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
      Referer: `${BASE}/courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}/select_pages`
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
    submission_url: `${BASE}${path || `/courses/${course_id}/assignments/${assignment_id}/submissions/${submission_id}`}`,
    unmatched_questions: unmatched
  };
}
async function submitAssignment(gs, args) {
  const { course_id, assignment_id } = args;
  if (!Array.isArray(args.files) || args.files.length === 0)
    throw new Error("files must contain at least one file");
  const { info, csrf, referer } = await findAssignment(gs, course_id, assignment_id);
  if (info.format === "online") {
    throw new Error(`"${info.title}" is an online assignment answered in the browser; it cannot be submitted as a file.`);
  }
  const isPdfAssignment = info.format === "fixed_length" || info.format === "variable_length";
  if (isPdfAssignment && !info.readyForSubmission) {
    throw new Error(`"${info.title}" is not accepting submissions yet (the instructor has not finished its outline).`);
  }
  const form = new FormData();
  form.append("utf8", "\u2713");
  form.append("authenticity_token", csrf);
  const loaded = [];
  if (isPdfAssignment) {
    if (args.files.length !== 1)
      throw new Error(`"${info.title}" is a PDF assignment: submit exactly one PDF file.`);
    const f = await loadFile(args.files[0], 0, "submission.pdf");
    if (!isPdf(f.bytes)) {
      throw new Error(
        "The file is not a PDF (it does not start with %PDF-). If it came from a share link, make sure the link downloads the file itself rather than a preview page."
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
    if (args.leaderboard_name)
      form.append("submission[leaderboard_name]", args.leaderboard_name);
  }
  const summary = {
    assignment: info.title,
    kind: isPdfAssignment ? `pdf (${info.format})` : "code upload",
    files: loaded,
    late_submission: info.showLateWarning
  };
  if (args.dry_run)
    return { dry_run: true, would_post_to: info.postUrl, ...summary };
  const res = await gsFetch(gs, info.postUrl, {
    method: "POST",
    body: form,
    headers: isPdfAssignment ? { Referer: referer } : { Referer: referer, "X-CSRF-Token": csrf, "X-Requested-With": "XMLHttpRequest", Accept: "application/json, text/javascript, */*; q=0.01" }
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
    submission_url: `${BASE}/courses/${course_id}/assignments/${assignment_id}/submissions/${submissionId}`,
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
        num_assignments: box.find(".courseBox--assignments").text().trim()
      };
    });
  });
  const isInstructor = /Create a new course/i.test($.html());
  return { courses, isInstructor };
};
var ACCESS_TOKEN = Bun.env.ACCESS_TOKEN || "";
var SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
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
var text = (value, fallback) => ({
  content: [{ type: "text", text: value ? JSON.stringify(value, null, 2) : fallback }]
});
async function session() {
  const gs = api();
  await ensureSession(gs);
  return gs;
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
    description: "Find a Gradescope course by name.",
    inputSchema: {
      type: "object",
      properties: {
        course_name: { type: "string", description: "The name of the Gradescope course to search for. Partial matches are supported." }
      },
      required: ["course_name"]
    },
    annotations: { title: "Find Gradescope Course by Name", ...READ_ONLY },
    handler: async (a) => text(await (await session()).getGradescopeCourseByName(a.course_name), "Course not found")
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
    description: "Find a Gradescope assignment by name.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_name: { type: "string", description: "The name of the assignment to search for. Partial matches are supported." }
      },
      required: ["course_id", "assignment_name"]
    },
    annotations: { title: "Find Gradescope Assignment by Name", ...READ_ONLY },
    handler: async (a) => text(await (await session()).getGradescopeAssignmentByName(a.course_id, a.assignment_name), "Assignment not found")
  },
  {
    name: "submit_gradescope_assignment",
    description: "Submit files to a Gradescope assignment on the user's behalf. This creates a real submission that course staff can see and replaces any earlier submission, so confirm the course, assignment and file with the user before calling it, or use dry_run first. PDF assignments take exactly one PDF; code assignments take one or more files. For PDF assignments where students mark pages, pass question_pages to match pages to questions in the same call; otherwise the result lists the questions so you can call match_gradescope_pages next.",
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
        question_pages: QUESTION_PAGES,
        leaderboard_name: { type: "string", description: "Leaderboard name, only for code assignments with a leaderboard." },
        dry_run: { type: "boolean", description: "Check everything (assignment is open, file downloads and is valid) without submitting." }
      },
      required: ["course_id", "assignment_id", "files"]
    },
    annotations: { title: "Submit Gradescope Assignment", ...WRITE },
    handler: async (a) => text(await submitAssignment(await session(), a), "Submission failed")
  },
  {
    name: "match_gradescope_pages",
    description: "Match the pages of an uploaded PDF submission to the assignment's questions. Call without question_pages to list the questions and the page count; call with question_pages to save the matching.",
    inputSchema: {
      type: "object",
      properties: {
        course_id: COURSE_ID,
        assignment_id: ASSIGNMENT_ID,
        submission_id: { type: "string", description: "The submission ID returned by submit_gradescope_assignment." },
        question_pages: QUESTION_PAGES,
        dry_run: { type: "boolean", description: "Show the matching that would be saved without saving it." }
      },
      required: ["course_id", "assignment_id", "submission_id"]
    },
    annotations: { title: "Match Gradescope Pages", ...WRITE },
    handler: async (a) => text(await matchPages(await session(), a), "Page matching failed")
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
        capabilities: { tools: {} },
        serverInfo: { name: "Gradescope MCP", version: "1.0.0" }
      });
    }
    case "ping":
      return ok({});
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
