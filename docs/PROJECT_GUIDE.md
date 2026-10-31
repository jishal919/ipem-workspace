# IPEM: Complete Project Guide

**IPEM** is a browser-based, AI-assisted coding workspace. It brings chat, generated project files, a lightweight in-browser editor, program execution, interactive execution sessions, user memory, and administration into one application.

The name is expanded in the existing project overview as “Intelligent Program Environment Maintainer” (the older document contains a spelling variant). The deployed frontend URL currently recorded by the project is [ipem-web.vercel.app](https://ipem-web.vercel.app).

This guide describes the code in this repository. It distinguishes working implementation from external services and deployment assumptions; it is not a claim that every configured integration is available in every environment.

## 1. What the product does

IPEM supports a loop from an idea to an executable program:

1. A signed-in user asks a question or describes a program in the chat UI.
2. The backend passes the request to an n8n workflow, which coordinates AI response and coding/execution-related handling.
3. Generated code or multi-file projects are saved in that user's filesystem workspace, and metadata is synchronized to SQLite.
4. The user browses files, opens and edits them in the browser, and saves changes.
5. The user runs a program, sees output, and can send input to a running interactive process or stop it.
6. Chat history, conversation/project links, memory, and activity help retain context.

The UI includes chat and conversation search, a program explorer, file editor, execution controls, session status, model selection, profile and authentication pages, and an administration control center.

## 2. Current capabilities

### User workspace

- Email/password registration, email OTP verification and resend, login, Google sign-in when configured, logout, profile rename, and self-service account deletion (subject to owner protection).
- User-specific generated program directories and program lists.
- Saving a single source file or a multi-file project with project metadata.
- Reading, editing, deleting, and previewing owned project files.
- Running supported source files, starting interactive sessions, sending stdin, polling status/output, stopping sessions, and previewing detected web servers.
- Chat requests, asynchronous chat job status polling, server history, local browser conversation list, persistent user facts/memory, and program/conversation associations.
- An optional hidden-file display toggle in the explorer.

### Administration

An admin interface exists at `frontend/admin.html`, backed by `/admin` and `/api/admin` routes. It includes user and program management, conversations and moderation actions, audit and request analytics, activity, system health/metrics/alerts, AI usage/provider views, security flags/incidents/IP and device controls, search, notes, and service restart controls. Which operations are available depends on the caller's role. The frontend does not confer permissions; the backend enforces them.

Roles are `owner`, `admin`, `moderator`, and `user`. Statuses are `active`, `suspended`, `banned`, and `disabled`. The backend includes protections against removing the last owner, an owner removing their own role, and administrators restricting themselves. Banned/disabled users have sessions revoked; suspended users can authenticate but product routes require active status.

## 3. System architecture

```text
Browser (static HTML/CSS/JS)
      │ HTTPS/API requests, bearer token and cookie
      ▼
Vercel static frontend + /api proxy (deployment path)
      │
      ▼
Express backend (backend/server.js, port 9000 by default)
  ├── Authentication, RBAC, admin APIs and audit/security middleware
  ├── SQLite database (memory/ipem.sqlite by default)
  ├── User-isolated filesystem workspaces (users/<storage-id>/...)
  ├── Execution processes (host by default; optional Docker mode)
  ├── Redis execution-session metadata (when Redis is available/configured)
  └── External workflow/AI and monitoring services
      ├── n8n webhook workflow
      ├── LiteLLM and configured model providers
      └── Ollama (optional local model service)
```

The browser app is plain static HTML, CSS, and JavaScript rather than a bundled React application. The UI entry points are HTML pages with scripts. The API dependencies and start command are defined in `backend/package.json`; the frontend is static.

### Main request path

- `frontend/js/config.js` chooses an API base. On localhost it defaults to `http://localhost:9000` and allows a browser-local override. On a deployed frontend it defaults to `/api`.
- `frontend/api/proxy.js` forwards Vercel `/api/*` requests to `IPEM_UPSTREAM_URL`, `VITE_API_BASE_URL`, or the configured default upstream. It forwards auth/cookie/content/range headers and supports long-running requests (default 15-minute timeout).
- `backend/server.js` installs CORS, request logging, JSON/form parsing, cookies, security-ban and audit-context middleware, then mounts auth/admin/product APIs.
- `backend/src/aiService.js` records LLM usage; chat is handled by the server and connected workflow configuration. A sanitized workflow export is included in `workflows/IPEM_workflow.json`; reconnect credentials and update its backend URLs when importing it.

## 4. Repository map

| Path | Purpose |
|---|---|
| `frontend/` | Static user pages, admin page, styles, browser logic, service worker, and Vercel proxy/config. |
| `backend/server.js` | Express application, route wiring, startup migration and service initialization. |
| `backend/src/` | Authentication, authorization, database, workspace storage, execution, chat, audit, security, and monitoring modules. |
| `workflows/IPEM_workflow.json` | Sanitized n8n workflow export; runtime credentials and backend URLs must be configured in the receiving n8n instance. |
| `backend/.env.example` | Safe configuration template; copy it to `.env` and fill in deployment-specific values. |
| `docs/PROJECT_GUIDE.md` | Full product and technical guide. |

Generated user data, databases, logs, dependencies, tunnel credentials, and machine-specific service-manager files are intentionally excluded from this clean distribution.

## 5. Backend and API domains

The Express service listens on port **9000** by default. The route inventory below groups the actual route families; methods and individual endpoints may vary by resource.

| Domain | Representative routes | Purpose |
|---|---|---|
| Auth | `/auth/signup`, `/auth/verify-otp`, `/auth/resend-otp`, `/auth/login`, `/auth/google`, `/auth/me`, `/auth/profile`, `/auth/logout`, `/auth/account` | Registration, verification, identity, profile and session lifecycle. Also mounted under `/api/auth`. |
| Service status | `/health`, `/webhook-status`, `/n8n-health` | Basic backend liveness and workflow probes. |
| Languages/programs | `/languages`, `/save`, `/save-multi`, `/patch`, `/programs`, `/program-files/:programName`, `/project-meta/:programName`, `/read/:program_name/*filename` | Save, discover, inspect and read files/projects. |
| Program file changes | `/api/program/:programName`, `/api/program/:programName/file/*fileName` | Delete projects/files and update files. |
| Execution | `/execute`, `/execute/start`, `/execute/input`, `/execute/status/:session_id`, `/execute/stop/:session_id`, `/execute/sessions` | Run and control programs and interactive sessions. |
| Preview | `/execute/preview/:session_id`, `/preview/port/:port/*subpath`, `/preview/html/:program_name...` | Display generated web projects and local server output through the backend. |
| Chat/AI | `/chat`, `/api/chat`, `/chat/job/:jobId`, `/api/chat/job/:jobId`, `/api/ai/log` | Submit AI requests, poll longer jobs, and record client-side AI telemetry. |
| History/memory | `/history`, `/memory` | Read/write/delete history and manage user facts. |
| Conversation links | `/conversation-project`, `/conversation-projects` | Read and update conversation/program relationships. |
| Admin | `/admin/...`, also `/api/admin/...` | Roles, users, programs, conversations, audits, analytics, security, metrics, AI, notes and operational controls. |

Product routes generally use `requireAuth`, `requireActiveStatus`, and user scoping. Admin routes first require authentication and then apply role-specific checks. `/health`, `/webhook-status`, and `/n8n-health` are separate service probes; do not assume every probe is private based on the admin route policy.

### Role outline

- **Owner:** owner-level actions, including role changes; protected from self-demotion and last-owner removal.
- **Admin:** administrative controls including status management, audit/analytics, security and operational actions; cannot manage peers/higher roles where hierarchy forbids it.
- **Moderator:** selected read/moderation surfaces such as user, program and conversation inspection.
- **User:** own profile, workspace, programs, chat, memory and execution.

The precise permission boundary is in route middleware in `backend/src/adminRoutes.js`, not merely in this summary.

## 6. Data and storage

### SQLite

The configured database path is `memory/ipem.sqlite` relative to the project root (or `PROJECTS_PATH`). Schema is initialized in `backend/src/database.js` with `CREATE TABLE IF NOT EXISTS`, additive `ALTER TABLE` operations, indexes and a migration ledger. This is an imperative bootstrap with a limited migration ledger, not a separate migration framework.

Principal tables created/used include:

- Identity and continuity: `users`, `user_sessions`, `rate_limits`, `facts`, `chat_history`, `user_storage`.
- Product metadata: `programs`, `conversations`, `conversation_projects`, `user_programs`.
- Admin/operations: `audit_logs`, `api_requests`, `user_activity`, `system_metrics`, `system_alerts`, `admin_notes`, `admin_message_receipts`.
- AI and asynchronous work: `llm_requests`, `llm_jobs`.
- Security: `security_flags`, `ip_reputation`, `banned_ips`, `blocked_devices`, `security_incidents`.

Program code remains in the filesystem; the `programs` table is synchronized metadata and statistics. Conversation metadata/status is synchronized server-side, while the browser also retains conversation titles/order/messages in localStorage. `chat_history` stores server-side messages, so cross-device continuity is partial and depends on the server history and client state being in sync.

### Filesystem

`userStorage.js` resolves each account to a storage identifier and creates isolated per-user directories. Generated program folders live under that user's generated/programs area; runtime logs and compatibility metadata are also stored under user data. Legacy global folders/state can be migrated during server startup. Keep `users/`, `memory/`, and database files backed up and access-controlled; do not commit production user data.

### Execution sessions

Interactive process metadata is kept in memory and mirrored to Redis using the session manager. The implementation also clears stale Redis session metadata at startup. The UI polls HTTP status/output; the codebase does not use a WebSocket server for execution streaming.

## 7. Execution model and supported languages

Language detection/availability is defined in `backend/src/languages.js`. The executor supports common runtimes including Python, JavaScript, TypeScript, Java, Go, Rust, C/C++, Ruby and PHP when the required runtime is present; exact availability depends on the installed host runtimes and `LANGUAGES` configuration.

- One-shot execution uses child-process execution and records JSON logs.
- Interactive execution spawns a process with stdin/stdout/stderr pipes, retains a session, and returns output/status via polling endpoints.
- If `USE_DOCKER=true` and a configured image exists for the language, supported one-shot executions can use Docker with a no-network container, 512 MiB memory and one CPU limit. Docker is **off by default** in `backend/src/config.js`.
- If Docker is off, generated code runs as a local child process with the backend user's OS permissions. Timeouts exist, but host execution is not equivalent to a strong sandbox.
- The save API can install requested Python or JavaScript packages into a per-project environment. Package installation invokes system commands and requires appropriate host tooling/network access.
- Web preview support detects a web server port from output and proxies requests for the user's session. Reserved infrastructure ports are excluded from preview proxying.

Treat running generated or user-supplied code as a privileged operation. Enable and validate isolation for any untrusted or multi-user deployment, and review the current executor and package installation code before exposing it publicly.

## 8. Local development setup

### Requirements

- A supported Node.js release compatible with the installed dependencies.
- npm.
- Python and/or the other runtime(s) for languages you intend to execute.
- Optional: Docker Desktop/daemon if using Docker execution; Redis for persisted interactive session metadata; n8n and an AI gateway/provider for workflow-based responses; SMTP and Google OAuth settings for those login flows.

### Install and run

Copy `backend/.env.example` to `backend/.env` and set a unique `JWT_SECRET` plus any integrations you plan to use. Install and start the API from the backend directory:

```sh
cd backend
npm install
npm start
```

The API listens on port 9000 by default. In another terminal, serve the static frontend from the repository root:

```sh
npx http-server frontend -p 3000
```

Open `http://localhost:3000`. The clean copy starts with empty runtime storage; the backend creates its SQLite database and per-user storage as needed. For Vercel, deploy `frontend/` as the project root and set `IPEM_UPSTREAM_URL` to the public HTTPS URL of the separately hosted backend.

### Environment configuration

A safe template is provided at `backend/.env.example`. Define production secrets only in an untracked `.env` or deployment secret store; never paste secret values into documentation. Variables include:

| Variable | Use |
|---|---|
| `PROJECTS_PATH` | Root for DB, memory and generated user storage paths. |
| `PORT` | Not currently used to select the port: backend config hardcodes 9000. |
| `FRONTEND_URL`, `CORS_ALLOWED_ORIGINS` | Additional allowed frontend origins. |
| `IPEM_BOOTSTRAP_OWNER_EMAIL` | Select an existing account for initial owner promotion, if no owner exists. Otherwise bootstrap promotes the lowest-ID verified account. |
| `JWT_SECRET` | JWT signing secret; set a strong production secret. |
| `N8N_WEBHOOK_URL`, `N8N_HEALTH_URL` | n8n chat webhook and health-check URLs. |
| `GOOGLE_CLIENT_ID` | Enables Google ID token verification when configured. |
| `SMTP_USER`, `SMTP_PASS` | Gmail account and app password used for OTP email; when absent, the backend logs the OTP for development instead of sending email. |
| `USE_DOCKER` | Set to `true` to enable Docker execution where an image is configured. Defaults to false. |
| `REDIS_HOST`, `REDIS_PORT` | Redis session metadata connection; defaults to localhost:6379. |
| `LITELLM_BASE_URL`, `LITELLM_PORT`, `OLLAMA_BASE_URL` | AI gateway/local model service endpoints. |
| `IPEM_UPSTREAM_URL`, `VITE_API_BASE_URL`, `IPEM_PROXY_TIMEOUT_MS` | Vercel proxy target/timeout configuration. |
| `PUBLIC_BACKEND_URL` | Public API base used when generating preview links. |

Other model/provider credentials may be read by LiteLLM configuration or n8n rather than the Node app. Inspect deployment settings and the workflow privately before production setup. Do not assume a checked-in configuration is secret-free.

## 9. Deployment shape

The frontend deployment path supports Vercel: `frontend/vercel.json` rewrites `/api/*` to `frontend/api/proxy.js`, and static pages are served directly. Set `IPEM_UPSTREAM_URL` in Vercel to the HTTPS URL of the separately hosted backend.

The Express backend is a separate long-lived service. A real deployment needs a stable backend URL, correct CORS origins, TLS, persistent storage for SQLite and user files, backups, and configured external services.

Service worker caching is defined in `frontend/sw.js`; deployment changes should consider its caching behavior alongside the no-cache headers for HTML configured in Vercel.

## 10. Security, privacy and operational notes

- Passwords are hashed, session tokens are tracked in the database, and JWT authentication is checked against a session record. Tokens are also returned to browser code and stored in localStorage by the current frontend, which increases exposure to script injection; the backend also sets an HTTP-only cookie.
- Use a strong `JWT_SECRET`. The backend source has an insecure development fallback that must be replaced or prevented in production.
- The current role/status middleware and admin APIs are substantial, but authorization and self/last-owner protections should be verified before changing policy.
- Audit and request/activity/security records are created by the corresponding middleware/services. Retention, access, and backup policies still need to be defined operationally.
- Generated code can execute with host privileges when Docker is disabled. Docker execution currently covers configured one-shot languages, while interactive sessions use spawned host processes; enabling Docker does not automatically prove every execution path is containerized.
- Public service probes expose integration availability. Review the exact response content and network exposure appropriate to the deployment.
- The frontend keeps some conversation data in localStorage. Treat browser profile data as user data and account for same-device sharing and XSS risks.
- No password-reset HTTP route is currently exposed in `authRoutes.js`, even though the mail helper contains reset-email wording.
- `n8n` workflow JSON, LiteLLM config, tunnel configs, debug logs, database files, and user workspaces may contain sensitive information. They should not be shared or committed without review and redaction.
- SQLite and user files are local persistent state. Back up both together and test restore procedures; a database-only backup will not restore program source files.

This is a code-based architecture summary, not a penetration test or deployment certification.

## 11. Known limitations and status boundaries

- AI response quality and availability depend on external n8n, LiteLLM/provider and/or Ollama configuration.
- LocalStorage holds parts of conversation presentation state; it is not fully server-owned multi-device conversation storage.
- Program files use the filesystem as source of truth; database rows are synchronized metadata.
- Redis-backed interactive-session metadata is useful for coordination/recovery but the process itself is tied to the running backend host.
- Docker defaults off; host execution and package installation need additional isolation for untrusted workloads.
- Schema setup is mostly imperative and additive; review migrations carefully against the target database.
- The root `README.md` provides a quick setup path; this guide is the detailed project reference.
- The original workspace includes bespoke diagnostic scripts, but they are excluded from this clean code distribution until they can be reorganized and made portable.

## 12. Project documentation

This complete guide is the detailed technical reference. See the root `README.md` for the quick local setup instructions.

## 13. Suggested first places to read in the code

1. `backend/package.json` for start scripts and backend dependencies.
2. `frontend/index.html`, `frontend/js/main.js`, `frontend/js/config.js` for the user interface and API wiring.
3. `backend/server.js` for application middleware, route surface and startup.
4. `backend/src/authMiddleware.js`, `rbac.js`, `auth.js` for identity and authorization.
5. `backend/src/database.js` for schema and bootstrap behavior.
6. `backend/src/projectManager.js`, `userStorage.js`, `programService.js` for project persistence.
7. `backend/src/executor.js`, `languages.js`, `sessionManager.js` for code execution.
8. `backend/src/adminRoutes.js` and `frontend/admin.html` for control-center behavior.
9. `workflows/IPEM_workflow.json` and `backend/src/aiService.js` for the AI request path.
