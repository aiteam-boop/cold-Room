# CRMCTS — Cold Room Management & Construction Tracking System

A full-stack web platform that turns BOQ documents and architectural drawings into a **live, measurable picture of cold-room construction progress** — completion %, projected finish dates, delay-risk flags, an interactive 2D/3D floor plan, and one-click reports. Built to the spec in `CRMCTS_PRD_v1.0.pdf`.

---

## ✨ What's implemented

| PRD Module | Status |
|---|---|
| **Auth & RBAC** — JWT, bcrypt, 5 roles (Admin/Engineer/Supervisor/Client/Management), read-only enforcement, audit trail | ✅ |
| **Projects** — create, members/invites, status (Draft/Active/On-Hold/Completed), isolated workspaces | ✅ |
| **BOQ module** — upload `.xlsx`/`.csv`/`.pdf`, auto-parse (SheetJS + optional Claude AI), review table, lock baseline, collapsible hierarchy | ✅ |
| **Progress tracking** — daily entry with photo, over-install validation, supervisor approval queue, bulk entry, admin void | ✅ |
| **Calculations engine** — cumulative installed, remaining, item/category/overall %, rolling 7-day work rate, estimated completion date, delay-risk flag | ✅ |
| **Drawing & Visualization** — drawing upload/versioning, interactive **2D floor plan** + **3D extruded view**, color-coded zones (Green/Yellow/Red), click-for-detail | ✅ |
| **Dashboard & Analytics** — completion gauge, category bar chart, material consumption, delay-risk table, 7-day activity feed | ✅ |
| **Reports** — Excel workbook + branded PDF (client & full) | ✅ |
| **Client read-only dashboard** — high-level progress, floor plan, downloadable report | ✅ |

---

## 🚀 Quick start

> Requires **Node 18+** (tested on Node 22). No database to install — uses SQLite.

```bash
# from the project root  (d:\Cool Room)
npm run setup     # installs server+client deps, creates the DB, seeds demo data
npm run dev       # starts API (http://localhost:4100) + web app (http://localhost:5173)
```

Then open the web app and sign in with a demo account (password **`Password123`**):

| Role | Email |
|---|---|
| Admin | `admin@crmcts.dev` |
| Site Engineer | `engineer@crmcts.dev` |
| Supervisor | `supervisor@crmcts.dev` |
| Client | `client@crmcts.dev` |
| Management | `management@crmcts.dev` |

The seed loads the **FKI Cold Room Project** with the full BOQ from the PRD (56 line items across 10 categories), 7 floor-plan zones, and sample progress so every screen has data on first load.

> If a port is busy the client auto-bumps (e.g. 5174); the API port is set in `server/.env` (`PORT=4100`).

### Running the two halves separately

```bash
npm run dev:server   # API only
npm run dev:client   # web app only
```

---

## 🤖 Optional: Claude AI parsing

BOQ/drawing parsing works **without any API key** (structured SheetJS parser + manual review). To enable AI extraction from **PDF** BOQs:

1. Get a key at <https://console.anthropic.com>
2. Put it in `server/.env`:
   ```env
   ANTHROPIC_API_KEY=sk-ant-...
   ANTHROPIC_MODEL=claude-opus-4-8
   ```
3. Restart the server. The console prints `AI parsing → ENABLED (Claude)`.

**This is the only external key the app needs.** Everything else runs locally.

---

## 🏗 Architecture

```
Cool Room/
├─ server/                  Express + TypeScript REST API
│  ├─ prisma/schema.prisma  Data models (SQLite, portable to Postgres)
│  ├─ prisma/seed.ts        FKI BOQ baseline + demo users
│  └─ src/
│     ├─ services/calc.ts            Pure calculation engine (testable)
│     ├─ services/projectProgress.ts DB → calc engine bridge
│     ├─ services/boqParser.ts       SheetJS + Claude BOQ extraction
│     ├─ routes/                     auth, projects, boq, progress, drawings, dashboard, reports
│     └─ middleware/                 JWT auth, RBAC, uploads
└─ client/                  React + Vite + TypeScript + Tailwind
   └─ src/
      ├─ pages/             Login, ProjectsList, ProjectWorkspace
      └─ components/        AppShell, FloorPlan2D/3D, charts, tab views
```

**Stack:** Express · Prisma · SQLite · JWT · Zod · SheetJS · ExcelJS · PDFKit · React · React Query · React Router · Recharts · Tailwind.

---

## 🗺 Phased rollout (PRD §13)

- **Phase 1 — MVP Core Tracking** ✅ projects, BOQ upload+review, daily progress, approval, dashboard
- **Phase 2 — Visualization & AI Parsing** ✅ 2D floor plan + zones, drawing upload, AI BOQ parsing, client dashboard
- **Phase 3 — Predictive Analytics & 3D** ✅ estimated completion, delay prediction, 3D view, PDF/Excel export
- **Phase 4 — Integrations & Mobile** — _next:_ offline mobile, WhatsApp/SMS alerts, ERP hooks (the UI is already mobile-responsive)

---

## 🔌 API at a glance

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/auth/login` · `/register` · `GET /me` | Authentication |
| `GET/POST` | `/api/projects` | List / create projects |
| `POST` | `/api/projects/:id/boq/parse` · `/import` · `/lock` | BOQ upload, import, lock |
| `POST` | `/api/projects/:id/progress` · `/:eid/approve` · `/reject` | Progress + approval |
| `GET` | `/api/projects/:id/dashboard` | Analytics + delay risk |
| `GET` | `/api/projects/:id/drawings/zones` | Floor-plan zones (color-coded) |
| `GET` | `/api/projects/:id/reports/pdf` · `/excel` | Report export |

---

## 🧪 Useful commands

```bash
npm run seed                       # reset demo data
npm --prefix server run prisma:push   # apply schema changes
npm run build                      # production build (server + client)
```

---

_Confidential — built from CRMCTS PRD v1.0._
