# AI Collaborative Document Editor — Project Context

> Drop this file in the repo root and point your AI tool at it (or rename it
> `AGENTS.md`, which most tools read automatically) so you never have to
> re-explain the project again.

## What this is

A Google-Docs-style collaborative document editor ("Doc Editor"). Users write
rich-text documents (Word-like: pages, tables, comments, formatting), collaborate
in real time, share with people or public links, organise work into
workspaces/folders, and use AI features (writing assistant, document Q&A, OCR,
voice dictation). There is a built-in/template library and Google Drive/Docs
integration.

The team works from a product spec called the **Master Plan**
(`AI_Collaborative_Document_Editor_Master_Plan.docx`, git-ignored). Code comments
reference it as *"master plan section N"*. Keep that phrasing in new comments.

## Tech stack

| Layer     | Stack |
|-----------|-------|
| Frontend  | Next.js 16 (App Router), React 19, TipTap 3 editor, Tailwind CSS 4, shadcn/ui + Radix, lucide-react, sonner, Yjs + y-websocket |
| Backend   | Node.js (ESM), Express 5, Mongoose 9 / MongoDB, `ws` (raw WebSockets), JWT + bcryptjs, multer, docx, pdfkit |
| Realtime  | Yjs CRDT over `ws` for document collab; separate `ws` channel for notifications |
| AI        | OpenAI-compatible provider (env-configurable) with an offline mock fallback; Google Speech/Vision optional |

- Both packages are **ESM** (`"type": "module"` in backend, `import`/`export` everywhere).
- No TypeScript. Frontend uses `.js` / `.jsx`; backend uses `.js` / `.mjs`.
- Frontend path alias: `@/*` → `frontend/src/*`.

## Repo layout

```
editor/
├─ plain.md                  ← this file
├─ backend/                  Express API + WebSockets
│  ├─ index.js               entry: HTTP server + WebSocket upgrade + DB connect + template seed
│  ├─ app.js                 Express app: CORS, JSON limits, health, mounts /api/v1
│  ├─ routes/v1/             route definitions (thin, validation + wiring only)
│  ├─ controllers/           request/response handling
│  ├─ services/              business logic (the bulk of the code)
│  ├─ models/                Mongoose schemas
│  ├─ middleware/            auth, error handling + rate limit, validation, upload
│  ├─ config/                db, ai, plans, storage, google, voice, templates, voice
│  ├─ websocket/             collab.server.js (Yjs), notify.server.js (per-user), index.js
│  ├─ utils/                 ApiError, ApiResponse, text helpers
│  ├─ tests/                 *.test.mjs suites + run.mjs runner
│  └─ .uploads/              local attachment storage (git-ignored, user data)
└─ frontend/                 Next.js app
   └─ src/
      ├─ app/                App Router pages (page.js, editor/[id], login, register, shared/[token], auth/google/callback)
      ├─ components/         feature components (Toolbar, MenuBar, AiPanel, ShareDialog, ...) + ui/ (shadcn primitives)
      └─ lib/                api.js (all API calls), auth.js, editor-sync.js, ws-base.js, tiptap.js, ...
```

## Backend architecture

**Layering:** `route → controller → service → model`. Keep it that way.
- Routes only declare paths + validation + middleware.
- Controllers translate HTTP ↔ service calls, no business logic.
- Services hold logic and are reusable/testable.
- Models define schema, indexes, helpers.

**Validation:** never inline. Use `validateSchema({...}, "body"|"query"|"params")` from
`middleware/validate.middleware.js` with composable checks (`required`, `isString`,
`isId`, `isIn`, `maxLen`, `isArrayOfStrings`, ...).

**Errors:** throw `new ApiError(status, message)` (from `utils/ApiError.js`).
The global `errorHandler` in `middleware/error.middleware.js` formats them.
Responses use `ApiResponse` / `{ error }` shapes. Don't send raw stack traces.

**Rate limiting:** `rateLimit({ windowMs, max, keyFor })` from the error middleware,
applied per router. Env overrides exist for tests (`RATE_LIMIT_*`).

**DB:** `config/db.js` caches a single Mongoose connection, tolerates cold starts,
and every `/api/v1` request awaits `connectDB()` before proceeding. If Mongo is
down the API returns `503` with a reason, not a cascade of 404s.

**Route mount order matters** (`routes/v1/index.js`): e.g. `/shared` mounts the
public router *before* the authenticated one so anonymous link access isn't 401'd.

### API surface (all under `/api/v1`)

Mounts: `auth`, `auth/google`, `documents`, `notifications`, `shared`,
`documents/:id/ai`, `documents/:id/voice`, `ai`, `voice`,
`integrations/google`, `workspaces`, `folders`, `templates`,
`attachments`, `uploads`. See `routes/v1/index.js` for the authoritative list.

Larger JSON body limit (25mb) is applied only to voice-transcribe and OCR routes;
everything else caps at 5mb.

### Auth

- HttpOnly **session cookies** (access + refresh) are the primary mechanism.
  `requireAuth` also accepts a `Bearer` token for API clients/tests.
- Access-token refresh: frontend `lib/api.js` does a single shared
  `POST /auth/refresh` on 401 and replays the request once (single-flight to
  avoid refresh-rotation replay lockouts).
- Sessions are revocable per device (`/auth/sessions`, `/auth/logout-all`).
- Google sign-in is a separate router (`/auth/google`) — no session yet at sign-in.

### WebSockets

Started in `backend/index.js` via `websocket/index.js`:
- `/ws/notifications` → per-user notifications (`notify.server.js`), authed via a
  short-lived socket token from `/auth/socket-token` (cookie can't cross origin).
- `/ws/...` → document collaboration (`collab.server.js`, Yjs `setupWSConnection`).
- Serverless hosts serve the function under `/api`, so an `/api/ws` prefix is
  stripped before routing. Both `/ws` and `/api/ws` must keep working.

### Key features / supporting services

- **Documents:** versions, trash/restore, star, tags, folders, export
  (markdown/html/txt/pdf/docx; `docx` + `pdfkit`).
- **Collaboration:** comments (threaded, anchored to ranges), per-person shares,
  "anyone with link" capped at *commenter* (token stripped from normal
  serialization — see `models/doc.model.js` transform).
- **Workspaces:** membership + roles (owner/admin/editor/member), plans, activity
  audit log.
- **AI:** actions in `config/ai.js` (`improve`, `summarize`, `translate`, ...),
  mock provider when no key so local dev works. Quotas per plan.
- **OCR** (`services/ocr.*`), **Voice dictation** (`services/voice.*`),
  **Google** (OAuth, Drive, Docs, Speech, Vision under `services/google.*`).
- **Attachments:** metadata in Mongo, bytes in object storage behind
  `config/storage.js` + `services/storage.service.js` (default local disk,
  swappable). Allow-list + magic-byte checks; SVG never rendered inline.
- **Templates:** built-in (seeded at boot via `ensureBuiltIns`), workspace, and
  AI-generated.
- **Plans/quotas:** all limits in `config/plans.js` (free/pro), env-overridable.

## Frontend architecture

- Next.js App Router. Routes: `/` (dashboard), `/editor/[id]`, `/login`,
  `/register`, `/shared/[token]`, `/auth/google/callback`.
- **All API calls live in `src/lib/api.js`** — add new endpoints there, don't
  scatter `fetch` calls in components.
- API requests go through the **Next.js rewrite proxy** (`next.config.mjs`):
  `/api/*` → `BACKEND_API_URL` (default `http://localhost:5000`). This keeps the
  session cookie first-party and avoids CORS entirely. Production builds ignore a
  configured `localhost` API URL on purpose.
- Editor is **TipTap 3** + **Yjs**. Collab wiring is in `lib/editor-sync.js`,
  `lib/ws-base.js`, `lib/tiptap.js`.
- UI primitives are shadcn/ui in `src/components/ui/`; feature components sit in
  `src/components/`.
- App is **light-mode only** (no theme provider — see `components/providers.jsx`).

## Environment

Backend `.env` (git-ignored) — see `backend/.env` for the full list. Names matter:
`PORT`, `MONGO_URI`, `JWT_SECRET`, `FRONTEND_URL` (CORS allow-list, comma-separated),
`OPENAI_API_KEY` / `AI_PROVIDER` / `AI_CHAT_MODEL` / `AI_VISION_MODEL` /
`AI_ALLOW_MOCK`, `AI_DAILY_QUOTA` / `AI_MONTHLY_QUOTA`, `OCR_MAX_IMAGE_BYTES`,
`STORAGE_PROVIDER` / `STORAGE_ROOT` / `UPLOAD_MAX_BYTES`, Google OAuth vars,
`PLAN_FREE_*` / `PLAN_PRO_*` overrides.

Frontend `.env`: `NEXT_PUBLIC_API_URL` (usually leave empty to use the proxy),
`BACKEND_API_URL` (server-side proxy target), `NEXT_PUBLIC_NOTIFY_WS_URL`.

> **Never commit secrets.** `.env` and `.uploads/` are git-ignored. Do not print
> env values into code, logs, or docs.

## Running locally

```powershell
# backend  (http://localhost:5000)
cd backend; npm install; npm run dev      # nodemon index.js

# frontend (http://localhost:3000)
cd frontend; npm install; npm run dev     # next dev
```

Requires a MongoDB URI (`MONGO_URI`). No AI key needed — it falls back to mock.

## Testing

Backend has a custom runner over `backend/tests/*.test.mjs`:

```powershell
cd backend
npm test                                  # boots a throwaway server on :5051, runs all suites
$env:TEST_FILTER="google"; npm test       # subset by filename
$env:PORT="6001"; npm test                # custom port (avoid WHATWG-blocked ports)
```

Suites exercise real HTTP + WebSocket flows against a live server. Cleanup helper:
`tests/cleanup-test-data.mjs`. There is no frontend test suite yet — lint only.

## Commands

| Task | Backend | Frontend |
|------|---------|----------|
| Dev | `npm run dev` | `npm run dev` |
| Start | `npm start` | `npm start` |
| Build | — | `npm run build` |
| Test | `npm test` | — |
| Lint | — | `npm run lint` (`eslint`) |

## Conventions & gotchas

- **Comments explain "why", not "what".** This codebase is heavily commented with
  rationale and master-plan references — match that density and tone; don't add
  noise.
- Prefer editing existing files and following nearby patterns (service + route +
  validate + controller + model) over inventing new structure.
- Keep `api.js` as the single frontend source of API truth.
- Respect route mount ordering and cookie/CORS assumptions when adding endpoints.
- Attachments: bytes never in Mongo; only metadata. Keep the magic-byte + allow-list
  checks intact.
- Link-share tokens must never leak through normal document serialization.
- Backend is deployment-aware (Vercel `vercel.json`, `/api`-prefixed sockets,
  serverless-safe storage) — don't assume a long-lived process.
- There is currently **no root README, AGENTS.md, or other docs** besides this file.

## Git

Meaningful, sentence-style commit messages (e.g. "Baseline the notification poll
by time", "Support same-origin API proxy and serverless-safe storage"). Only commit
when explicitly asked.
