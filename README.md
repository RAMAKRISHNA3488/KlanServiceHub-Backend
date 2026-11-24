# KlanServiceHub Enterprise

Enterprise-grade project and issue management platform built on Cloudflare Workers, Cloudflare D1 (Serverless Distributed SQLite), Next.js, and Tailwind CSS.

---

## 🚀 Key Modules & Architecture

- **Backend**: Hono-based serverless API deployed to Cloudflare Workers with Cloudflare D1.
- **Frontend**: Next.js & Vite Single Page Application styled with Tailwind CSS, Lucide Icons, and glassmorphic UI patterns.
- **Edge Routing**: High-performance Cloudflare Service Bindings for zero-latency, same-origin in-memory `/api/*` proxies.
- **Data Persistence**: Cloudflare D1 distributed database with atomic transactions and cascade foreign keys.

---

## 🔗 Ticket-to-Ticket Linking & Dependency Management

KlanServiceHub provides Jira-standard ticket linking and dependency tracking to connect issues, prevent deadlocks, and track blockers across project workflows.

### 1. Supported Relationship Types & Inverses

Every relationship type has an automatic bidirectional inverse mapping based on which ticket is being viewed:

| Relationship Type | Inverse Relationship | Description | Category |
| :--- | :--- | :--- | :--- |
| **Blocks** | *Is Blocked By* | Current ticket prevents the related ticket from progressing | Blocks |
| **Is Blocked By** | *Blocks* | Current ticket depends upon the related ticket | Is Blocked By |
| **Relates To** | *Relates To* | Bidirectional association with no direct execution dependency | Relates To |
| **Duplicates** | *Is Duplicated By* | Current ticket is a duplicate of the related ticket | Duplicates |
| **Is Duplicated By** | *Duplicates* | Related ticket is a duplicate of the current ticket | Duplicates |
| **Clones** | *Is Cloned By* | Current ticket was cloned from the related ticket | Clones |
| **Is Cloned By** | *Clones* | Related ticket was cloned from the current ticket | Clones |

### 2. Business Rules & Integrity Guarantees

- **Project Boundary Validation**: Tickets can only be linked to other tickets within the same project (`source.project_id === target.project_id`).
- **Self-Linking Prevention**: A ticket cannot be linked to itself (`sourceTaskId !== targetTaskId`).
- **Duplicate Relationship Prevention**: Creating identical relationships between the same pair of tickets is prevented.
- **Directed Graph Cycle Detection**: Transitive circular dependency creation is blocked for blocking relationships using Breadth-First/Depth-First Search (e.g. `A blocks B`, `B blocks C`, attempting `C blocks A` is rejected with HTTP 400).
- **Unresolved Blocker Detection**: If a ticket has incoming `is blocked by` links where the blocking ticket is not `DONE`, a prominent blocker warning banner is displayed.
- **Linear Dependency Visualizer**: Displays dependency paths (`Ticket A → Ticket B → Ticket C`) with status pills and directional flow indicators.
- **Audit & Activity History**: All link creations, relationship edits, and unlink deletions are logged in the organization activity stream.

### 3. REST API Reference

#### `POST /api/ticket-links`
Create a new relationship between two tickets.
```json
{
  "sourceTicketId": "uuid-ticket-1",
  "targetTicketId": "uuid-ticket-2",
  "relationshipType": "blocks",
  "description": "Optional comment or note"
}
```

#### `GET /api/tickets/:ticketId/links`
Retrieve all links connected to `:ticketId`, grouped by relationship category with ticket metadata, status pills, and blocker indicators.

#### `GET /api/tickets/:ticketId/dependencies`
Retrieve dependency graph and linear visual chains (`Ticket A → Ticket B → Ticket C`) for `:ticketId`.

#### `PUT /api/ticket-links/:linkId`
Update relationship type or description on an existing link (re-runs cycle detection if relationship becomes `blocks`).

#### `DELETE /api/ticket-links/:linkId`
Remove relationship link and record deletion in activity history.

---

## 📊 Cumulative Flow Diagram (CFD) – Advanced Project Analytics

KlanServiceHub provides a Kanban-grade, real-time Cumulative Flow Diagram (CFD) under **Reports & Organization Analytics** to visualize how work moves through workflow stages over time, uncover delivery bottlenecks, and track team velocity.

### 1. Database Schema & Transition History Ledger

Historical snapshots are reconstructed using a dedicated transition ledger table in Cloudflare D1:

```sql
CREATE TABLE IF NOT EXISTS ticket_status_history (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT NOT NULL,
  changed_by TEXT,
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (ticket_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tsh_ticket ON ticket_status_history(ticket_id);
CREATE INDEX IF NOT EXISTS idx_tsh_project ON ticket_status_history(project_id);
CREATE INDEX IF NOT EXISTS idx_tsh_changed_at ON ticket_status_history(changed_at);
```

### 2. Analytics Metrics & Calculation Logic

| Metric | Calculation Method | Description |
| :--- | :--- | :--- |
| **Total Tickets** | $\sum \text{tickets in scope}$ | Total work items included in selected project, team, and date range |
| **Work in Progress (WIP)** | $\text{count}(\text{status} \in \{\text{IN\_PROGRESS}, \text{CODE\_REVIEW}, \text{TESTING}\})$ | Total tickets currently undergoing active development or review |
| **Completed Tickets** | $\text{count}(\text{status} = \text{DONE})$ | Total tickets that reached completion |
| **Throughput** | $\frac{\text{Completed Tickets}}{\text{Days in Window}}$ (daily), $\times 7$ (weekly) | Delivery rate of completed tickets per day and week |
| **Avg Cycle Time** | $\text{avg}(\text{completed\_at} - \text{first\_active\_status\_time})$ | Time from starting active work to final completion |
| **Avg Lead Time** | $\text{avg}(\text{completed\_at} - \text{created\_at})$ | Total elapsed time from creation to completion |
| **Bottleneck Indicator** | $\max(\text{count} \times \text{avg\_dwell\_days})$ for active stages | Identifies stages where tickets accumulate with high dwell duration |

### 3. REST API Reference

#### `GET /api/reports/:workspaceId/cumulative-flow`
Returns timeline buckets (`date`, `label`, `statuses`, `cumulative`, `total`) and sorted workflow statuses.
- **Query Parameters**: `projectId`, `teamId`, `sprintId`, `dateRange` (`7d`, `14d`, `30d`, `90d`, `custom`), `startDate`, `endDate`, `interval` (`daily`, `weekly`, `monthly`).

#### `GET /api/reports/:workspaceId/cumulative-flow/summary`
Returns the 7 high-level KPI cards (Total, WIP, Completed, Throughput, Cycle Time, Lead Time, Bottleneck).

#### `GET /api/reports/:workspaceId/cumulative-flow/bottlenecks`
Returns automated stage diagnostics across `TESTING`, `CODE_REVIEW`, `IN_PROGRESS`, dwell times, affected tickets, severity (`CRITICAL`, `WARNING`, `NORMAL`), and Agile recommendations.

#### `GET /api/reports/:workspaceId/cumulative-flow/tickets`
Historical drill-down returning tickets that were in `:status` on `:date` based on transition logs.

---

## ⚡ Application-Wide Skeleton Loading Architecture (Zero-CLS)

KlanServiceHub incorporates a comprehensive skeleton loading system across every route, dashboard, modal, and asynchronous data surface. This architecture completely eliminates blank white screens, abrupt layout jumps (Cumulative Layout Shift, CLS = 0), and uninformative isolated spinners.

### 1. Architectural Principles
- **Geometric Mirroring**: Each skeleton component mirrors the exact flexbox/grid dimensions, paddings, borders, and column layouts of its loaded counterpart.
- **Predictive Wireframing**: Displays contextual placeholders for priority badges, story points, avatars, status pills, and key metrics rather than generic grey rectangles.
- **Micro-Interactions**: Smooth `animate-pulse` shimmer with Tailwind color palette (`bg-neutral-200/80` dark-mode aware) provides visual feedback during cold starts, route shifts, and network latency.
- **Zero Layout Shift (CLS = 0)**: Ensures parent containers maintain static heights (`min-h-[350px]`, `w-[280px]` columns) so arriving data slots directly into position without content popping.

### 2. Component Catalog
| Skeleton Component | File Path | Targeted Views & Modals |
| :--- | :--- | :--- |
| `Skeleton` | `frontend/src/components/ui/skeleton.jsx` | Atomic pulse primitive with customizable radii and styles |
| `PageLoader` | `frontend/src/components/page-loader.jsx` | Global route-level suspense and application shell fallback |
| `WorkspaceDashboardSkeleton` | `frontend/src/features/workspaces/components/skeletons/workspace-dashboard-skeleton.jsx` | Workspace planning dashboard, project grids, metrics, activity |
| `ProjectViewSkeleton` | `frontend/src/features/projects/components/skeletons/project-view-skeleton.jsx` | Project header, metadata banner, analytics strip, task view switcher |
| `KanbanBoardSkeleton` | `frontend/src/features/tasks/components/skeletons/kanban-board-skeleton.jsx` | 5-column Kanban board with header dots, overload bars, and detailed task cards |
| `TaskTableSkeleton` | `frontend/src/features/tasks/components/skeletons/task-table-skeleton.jsx` | Enterprise task data table with 6 header columns and 7 row skeletons |
| `TaskDetailSkeleton` | `frontend/src/features/tasks/components/skeletons/task-detail-skeleton.jsx` | Two-pane issue details modal (`KlanserviceHubIssueDetailModal`) & standalone issue page |
| `ReportsAnalyticsSkeleton` | `frontend/src/features/reports/components/skeletons/reports-analytics-skeleton.jsx` | Organization analytics dashboard with KPI overview & 4 card grids |
| `CfdSkeleton` | `frontend/src/features/reports/components/cumulative-flow/cfd-skeleton.jsx` | Cumulative Flow Diagram: 7 metric cards, filter pills, chart canvas, and bottleneck diagnostics |
| `AdminTableSkeleton` | `frontend/src/features/company/components/skeletons/admin-table-skeleton.jsx` | Enterprise administration tables: Users, Teams, Workflows management |

---

## 🔤 Application-Wide Ultra-Compact Enterprise Typography Scale

KlanServiceHub standardizes on an ultra-compact, high-density Jira/Linear typography scale across all screens, modals, tables, and controls to maximize information density and maintain crisp visual hierarchy:

### 1. Typography & Component Dimension Specifications
| UI Element | Tailwind Utility | Computed Size | Example Usage |
| :--- | :--- | :--- | :--- |
| **Section Titles & Subheaders** | `text-[11px] font-semibold text-neutral-700` | **11px** (line-height: 15px) | `Linked Tickets & Dependencies`, Column headers, Card subtitles |
| **Body & Descriptions** | `text-[11px] text-neutral-600` / `text-neutral-500` | **11px** (line-height: 15px) | Task descriptions, empty state messages, audit details |
| **Action Buttons & Form Controls** | `px-2 py-0.5 text-[10px] font-medium rounded shadow-2xs` | **10px** (line-height: 14px) | `+ Link ticket`, `Export CSV`, Filter pills, Select dropdowns |
| **Status & Counter Badges** | `px-1.5 py-0.2 text-[9px] font-medium rounded-full border` | **9px** (line-height: 12px) | Ticket counters (`0`), Priority badges, Role pills, WIP limits |
| **Accompanying Icons** | `size-2.5` (10px) / `size-3` (12px) / `size-3.5` (14px) | **10px – 14px** | Button action icons, Link chains, Chevron selectors |

### 2. Multi-Layered Architecture
1. **Global Tailwind Scale (`frontend/tailwind.config.ts`)**: Custom `fontSize` scale re-maps standard Tailwind tokens (`xs` = 10px, `sm` = 11px, `base` = 11px, `md` = 12px, `lg` = 13px, `xl` = 14px).
2. **CSS Root Base Font (`frontend/src/app/globals.css`)**: `html, body { font-size: 11px; -webkit-font-smoothing: antialiased; }` ensures 100% cascade consistency.
3. **UI Component Primitives (`frontend/src/components/ui/`)**: Harmonized atomic components (`Button`, `Badge`, `Input`, `Select`, `Tabs`, `Table`, `Card`, `Dialog`).
4. **Zero-Missed-Screen Audit**: Comprehensive coverage verified across Navigation, Workspace Planning, Kanban & Table, Task Details Modal & standalone page, Reports & CFD, and Admin views.

---

## 🛠️ Local Development & Deployment

### Backend
```bash
cd backend
npm install
npm run dev        # Local development
npm run deploy     # Deploy to Cloudflare Workers
```

### Frontend
```bash
cd frontend
npm install
npm run dev        # Local development
npm run build      # Production build
npm run deploy     # Deploy assets to Cloudflare Workers
```

---

## 📋 Tracking & Sub-Tasks

For the complete catalog of all 44 platform enhancements and sub-tasks, refer to [TODAYS_UPDATES_TICKETS.md](./TODAYS_UPDATES_TICKETS.md).
