# IPEM

IPEM is an AI-assisted coding workspace. Users chat with an AI workflow, save and edit generated projects, run supported programs, and manage conversations and account memory. It includes a static browser frontend, an Express API, SQLite persistence, filesystem-based user workspaces, and an optional n8n workflow.

## Repository layout

- `frontend/` — static user, authentication, profile, and admin pages; browser scripts; Vercel API proxy.
- `backend/` — Express API and backend modules.
- `workflows/` — sanitized n8n workflow export. Reconnect credentials and update backend URLs after import.
- `docs/PROJECT_GUIDE.md` — detailed product, architecture, operations, and security guide.

Runtime data such as SQLite databases, generated programs, logs, dependencies, and secrets are intentionally excluded from Git.

## Local development

Requirements: Node.js/npm, Python or other runtimes you plan to execute, and optional Redis, Docker, n8n, LiteLLM, and model-provider configuration.

1. Copy `backend/.env.example` to `backend/.env` and set a strong `JWT_SECRET` plus any integrations you use.
2. Install and start the API:

   ```sh
   cd backend
   npm install
   npm start
   ```

   The API listens on port 9000 by default. It creates runtime storage under the repository root (`memory/`, `users/`, `generated/`, and `logs/`).

3. In a second terminal, serve the frontend:

   ```sh
   npx http-server frontend -p 3000
   ```

   Open `http://localhost:3000`. The frontend defaults to `http://localhost:9000` for local API calls.

## Deployment notes

- Deploy `frontend/` as the static site root. For Vercel, set the project root to `frontend/`.
- Set the Vercel environment variable `IPEM_UPSTREAM_URL` to the public HTTPS URL of the separately hosted backend. Do not use the local default for production.
- Configure backend CORS using `FRONTEND_URL` or `CORS_ALLOWED_ORIGINS`.
- For Google sign-in, set the same OAuth client ID in `backend/.env` and in `frontend/js/config.js` as `__IPEM_GOOGLE_CLIENT_ID__`.
- Import the workflow from `workflows/IPEM_workflow.json` into your own n8n instance, reconnect its model credentials, and replace `host.docker.internal:9000` URLs with the backend URL reachable from n8n. Set `N8N_WEBHOOK_URL` and `N8N_HEALTH_URL` in the backend.
- Store all credentials in environment variables or the hosting provider's secret manager. Never commit `.env` files, credentials, live database files, or user-generated program folders.

See `docs/PROJECT_GUIDE.md` for the full feature set, route groups, roles, storage model, execution modes, and known limitations.
