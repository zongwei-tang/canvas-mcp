# Gradescope MCP server (student side)

A Gradescope-only MCP server, run with Bun on Railway. It logs in as one Gradescope account and lets
an MCP client see and do what that student can on the Gradescope website. It works by reading the
same pages and JSON the website's own frontend uses; Gradescope has no public API, so a site change
can break individual tools.

## Tools

**Courses and assignments**

| Tool | What it does |
|---|---|
| `get_gradescope_courses` | All courses, with term and whether the course is active or archived |
| `get_gradescope_course_by_name` | Find a course; an exact name wins, otherwise every partial match is listed |
| `get_gradescope_assignments` | A course's assignments with dates, status and score |
| `get_gradescope_assignment_by_name` | Find an assignment; same matching rules as for courses |
| `get_gradescope_assignment_info` | Everything about one assignment: format, submission methods, template, limits, regrade window; can attach the template file |
| `get_gradescope_upcoming_deadlines` | Unsubmitted work due soon across active courses, soonest first |
| `search_gradescope_assignments` | Find assignments by name across all courses |
| `export_gradescope_deadlines_calendar` | Deadlines as an iCalendar (.ics) file with reminders |
| `get_gradescope_grades` | Every score across courses, plus a snapshot to diff against later |

**Submissions and feedback**

| Tool | What it does |
|---|---|
| `get_gradescope_submission` | Per-question scores, applied rubric items, grader adjustments and comments |
| `get_gradescope_submission_pages` | The pages of a PDF or photo submission, as images |
| `get_gradescope_autograder_results` | Per-test status, score and output; can wait for a running autograder |
| `get_gradescope_submission_history` | Every submission for an assignment, with score and which one is active |
| `compare_gradescope_submissions` | Diff of the text files, score change and autograder test changes between two submissions |
| `download_gradescope_submission_files` | Code file contents and line comments; can attach the original or graded PDF, the submission zip, and non-text files (images as images) |
| `get_gradescope_group_members` | Who is in the group on a submission |
| `get_gradescope_regrade_requests` | The user's regrade requests in a course |
| `gradescope_autograder_ssh` | Whether autograder SSH debugging is available, and start a session |

**Actions** (each has `dry_run`)

| Tool | What it does |
|---|---|
| `submit_gradescope_assignment` | Submit a PDF, photos or several PDFs (merged into one PDF), a document, code files, or a linked GitHub/Bitbucket repository |
| `match_gradescope_pages` | Show the current page matching and unmatched questions, or change it (other questions keep their pages) |
| `add_gradescope_ssh_public_key` | Add an SSH public key to the account, for autograder SSH debugging |
| `activate_gradescope_submission` | Make an earlier submission the active one |
| `rerun_gradescope_autograder` | Rerun the autograder on a code submission, where students may |
| `request_gradescope_regrade` | Ask for a regrade on one question; an existing request is not overwritten unless asked |
| `update_gradescope_group_members` | Add or remove group members by exact email; never removes you or the uploader |
| `enroll_gradescope_course` | Join a course with an entry code |
| `list_gradescope_repositories` | Repositories and branches Gradescope can reach through the linked GitHub/Bitbucket account |

**Anything else**

| Tool | What it does |
|---|---|
| `get_gradescope_feedback_summary` | Where points were lost across a course: questions, rubric items applied, grader comments |
| `get_gradescope_status` | Whether the server is logged in, as whom, and the last error |
| `get_gradescope_account` | Name, emails, student ID, linked accounts |
| `get_gradescope_page` | Read any Gradescope page by path: text, links, form fields and component data |

`get_gradescope_page` is GET only. It refuses paths that sign out or change the account (`/logout`,
sign-in and linked-account pages), never follows redirects off Gradescope, replaces the class roster
that group-assignment pages carry with a count, and removes tokens.

## Prompts

For clients that show MCP prompts: `weekly_review` (due soon and new grades), `before_deadline_check`
(is a submission complete: pages matched, autograder passing) and `lost_points_review` (mistakes by topic,
possible regrade candidates).

## Not covered

- Answering and submitting **online assignments**, starting **timed assignments**, and **leaderboards**:
  no sample was available to build against. Their pages can still be read with `get_gradescope_page`.
- Changing the account (name, student ID, password, emails, merging accounts) and linking GitHub or
  Bitbucket (an OAuth step in the browser).
- Leaving a course: Gradescope does not allow it once you have submitted anything.

## Run and deploy

The server runs on Railway, built from `local-mcp/Dockerfile`. Deploys go through GitHub Actions
(`.github/workflows/deploy-railway.yml`), which runs `railway up` on every push to
`feat/gradescope-submit` that touches `local-mcp/` or `src/`, or on a manual run. Railway's own GitHub
integration is deliberately not used: on a public repo it posts a commit status that exposes the
Railway project URL and service hostname. The workflow needs two repository secrets, `RAILWAY_TOKEN`
(a Railway project token) and `RAILWAY_SERVICE_ID`.

The service needs these variables:

- `GRADESCOPE_EMAIL`, `GRADESCOPE_PASSWORD`: the account to act as
- `ACCESS_TOKEN`: a long random string; the endpoint is `https://<host>/<ACCESS_TOKEN>/mcp`

`build.sh` also produces `gs-railway.ts`, a single-file bundle for running as a Railway Function.

## Test

Put the account's credentials in `local-mcp/credentials.env` (gitignored):

```
GRADESCOPE_EMAIL=...
GRADESCOPE_PASSWORD=...
```

Then run the read-only regression check. It calls every read tool and the actions only with `dry_run`,
using IDs it finds in the account, and prints pass/fail without printing grades or file contents:

```bash
bun local-mcp/test-readonly.ts
```
