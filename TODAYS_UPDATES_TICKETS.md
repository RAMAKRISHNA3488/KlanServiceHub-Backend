# KlanServiceHub V1 — Epic & Sub-Tasks Specification

This document is structured so you can first create the **Main Parent Ticket (Epic / Story)** in KlanServiceHub, and then create each of the **31 Sub-tasks** linked directly under it.

---

# 👑 MAIN PARENT TICKET

- **Issue Type**: `Epic` *(or `Story` if your workflow doesn't use Epics)*
- **Summary**: `Enhancing the Klanservichub V1`
- **Priority**: `P1 - High (⬆️)`
- **Total Story Points**: `138`
- **Module / Component**: `Core Platform / Multi-Module`
- **Labels**: `v1-enhancements`, `epic`, `platform-stability`, `ui-ux`, `analytics`, `tasks-boards`, `workflows`

### Description
Comprehensive platform stabilization and feature enhancements for **KlanServiceHub V1**. This work item addresses critical functional gaps across reports and analytics data integrity on Cloudflare D1, refines Jira-standard task and comment management, implements high-end glassmorphic privacy controls, enables fast board double-click interactions, resolves landing page viewport scroll locks, institutes a 50-event rolling FIFO expiration policy for organization activity streams, implements comment image attachments with automated 6-day ticket completion expiration, enables universal Share, Like, and Save / Favorite capabilities across all issue types (Tasks, Sub-tasks, Stories, Epics, Bugs), and introduces customizable Workflow Stage Overload telemetry with WIP capacity limits and dynamic real-time color indicator lines on Kanban boards.

### Key Objectives
1. **Reporting & Analytics Resilience**: Ensure real-time Cloudflare D1 persistence and metrics generation for Teams, Workloads, and Employee reports.
2. **Interactive Issue Management**: Enable inline comment editing, role-based deletions, and responsive Story Points estimation.
3. **Board Productivity**: Instant ticket details access via double-click on visual Kanban boards.
4. **Data Hygiene & Privacy**: Modernize GDPR/DPDP consent UI and enforce a strict 50-event rolling sliding window for organization activities.
5. **Public Page Access**: Fix root layout scroll constraints on the public landing page.
6. **Comment Image Lifecycle**: Support clipboard paste, drag-and-drop, and attach buttons for comment images with automatic 6-day post-completion expiration pruning.
7. **Social & Collaboration Telemetry**: Support universal one-click permalink sharing, reaction kudos/likes, and personal favorites bookmarking for all issue types.
8. **Workflow WIP Limits & Stage Overload Telemetry**: Support per-stage capacity thresholds and custom alert colors in Workflows admin, with dynamic top indicator lines (green for healthy, custom pulse for overload, and strict DONE stage exemption) rendered across Kanban boards.

---

# 📋 31 SUB-TASKS UNDER THIS TICKET

---

### 🔹 Sub-task 1: Fix Landing Page Vertical Scrolling

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 1: Restore vertical page scrolling on public landing page`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `2`
- **Component**: `Frontend / Landing Page`
- **Labels**: `landing-page`, `css`, `scrolling`, `ui-bug`

#### Description
Fix root viewport-level `overflow: hidden` constraint that prevented prospective users from scrolling down vertically past the hero section to view secondary features, solutions, integration showcases, and the footer.

#### Scope of Work
- Remove global `overflow: hidden` from body/html containers on landing page routes.
- Retain fixed top navigation bar with proper z-index and backdrop blur.
- Verify smooth vertical scrolling across desktop, tablet, and mobile browsers.

#### Acceptance Criteria
- [x] Landing page is fully scrollable from top hero section down to the footer.
- [x] Header navbar remains fixed and responsive without obscuring page sections.
- [x] No horizontal overflow or scrollbar jitter occurs.

---

### 🔹 Sub-task 2: Consent for Data Processing 100% Full-Width Glassmorphic Look

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 2: Modernize Consent for Data Processing with 100% full-width glassmorphism`
- **Priority**: `P2 - Medium (🟰)`
- **Story Points**: `3`
- **Component**: `Frontend / Privacy & Consent`
- **Labels**: `privacy`, `consent`, `glassmorphism`, `ui-design`

#### Description
Upgrade the "Consent for Data Processing" UI into a state-of-the-art white frosted glassmorphism floating bar spanning 100% full width with responsive floating margins and refined typography.

#### Scope of Work
- Style floating consent bar with `bg-white/85 backdrop-blur-md border border-neutral-200/80 shadow-xl`.
- Provide granular categories (Essential, Analytics, Performance, Personalization) in the preferences modal.
- Support quick "Accept All", "Customize Preferences", and "Decline Optional" triggers with local storage persistence.
- Fix associated `searchQuery` reference error in `BoardsView`.

#### Acceptance Criteria
- [x] Consent banner appears across the bottom with 100% full-width glassmorphic styling.
- [x] User choices persist across browser sessions.
- [x] Users can revisit settings anytime to update their preferences.

---

### 🔹 Sub-task 3: Migrate Reports & Organization Analytics to Cloudflare D1

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 3: Migrate Teams, Workload, and Employee reports to Cloudflare D1`
- **Priority**: `P0 - Critical (🔥)`
- **Story Points**: `8`
- **Component**: `Backend / Reports & Analytics`
- **Labels**: `reports`, `analytics`, `cloudflare-d1`, `teams`, `workload`

#### Description
Resolve empty data and 500 errors in Reports & Organization Analytics by migrating backend reporting endpoints from Node.js synchronous SQLite stubs to asynchronous Cloudflare D1 bindings (`env.DB`).

#### Scope of Work
- Rewrite `GET /api/reports/:workspaceId/teams` using `d1All` for team metrics, member counts, and velocity.
- Rewrite `GET /api/reports/:workspaceId/members` for workload distribution and completion percentages.
- Rewrite `GET /api/reports/:workspaceId/drilldown` for granular employee task breakdowns.
- Rewrite `GET /api/reports/:workspaceId/export` to generate live CSV data from D1 tables.
- Update `checkAccess` authorization helper to evaluate member permissions against D1.

#### Acceptance Criteria
- [x] Teams card accurately loads all workspace teams and open task metrics.
- [x] Employee Workload and Employee-Wise Report charts display real team members without errors.
- [x] CSV export generates complete live reports from Cloudflare D1.

---

### 🔹 Sub-task 4: Comment Editing and Deletion with Role-Based Permissions

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 4: Add comment inline editing and deletion for authors and admins`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Tasks & Comments / Full-Stack`
- **Labels**: `tasks`, `comments`, `permissions`, `admin`

#### Description
Enable authors and workspace administrators to edit comment content and delete obsolete comments. Fix initial task query so comments and sub-tasks populate immediately on first page load instead of displaying zeros.

#### Scope of Work
- Add `PATCH /api/tasks/:taskId/comments/:commentId` endpoint in Cloudflare Workers backend.
- Add `DELETE /api/tasks/:taskId/comments/:commentId` endpoint with author/admin authorization checks.
- Fix `GET /api/tasks/:taskId` to query comments and subtasks via `d1.prepare`.
- Add `tasksApi.updateComment` and `tasksApi.deleteComment` methods in frontend `api-client.js`.
- Render inline pencil (edit) and trash (delete) buttons on comment cards in Issue Details page and modal.

#### Acceptance Criteria
- [x] Comment author or workspace admin can edit comments inline and save changes.
- [x] Comment author or workspace admin can delete comments.
- [x] Comments and sub-tasks count load immediately upon opening the issue.

---

### 🔹 Sub-task 5: Professional Themed Confirmation Dialog for Comment Deletion

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 5: Replace native window.confirm with professional confirmation modal`
- **Priority**: `P2 - Medium (🟰)`
- **Story Points**: `2`
- **Component**: `Frontend / UI Design System`
- **Labels**: `ui`, `dialog`, `confirmation-modal`, `ux-polish`

#### Description
Replace native browser `window.confirm` popup with KlanServiceHub's themed confirmation modal dialog for deleting comments.

#### Scope of Work
- Connect `useConfirm` / `useGlobalConfirm` in `client.jsx` and `klanservicehub-issue-detail-modal.jsx`.
- Render modal with backdrop blur (`backdrop-blur-xs`), red `<AlertTriangle />` container, subtitle *"Permanent deletion"*, message *"Are you sure you want to delete this comment? This action cannot be undone."*, and destructive "Delete Comment" button.

#### Acceptance Criteria
- [x] No browser-native alert or confirm dialogs appear when clicking delete on a comment.
- [x] Clean glassmorphic modal appears with Cancel and Delete action buttons.
- [x] Deletion proceeds only when confirmed by the user.

---

### 🔹 Sub-task 6: Fix Story Points Estimate Input & Synchronization

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 6: Resolve Story Points Estimate field locking and synchronization`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `3`
- **Component**: `Tasks / Story Points`
- **Labels**: `tasks`, `story-points`, `concurrency`, `backend-format`

#### Description
Fix Story Points Estimate field locking and reverting to `1` in the Issue Details modal and page caused by missing `formatDoc` property mapping and keystroke-triggered network flooding.

#### Scope of Work
- **Backend**: Map `row.story_points` to `doc.storyPoints` and `row.issue_type` to `doc.issueType` in `formatDoc` (`backend/src/db.js`). Sanitize `story_points` in `PATCH /:taskId`.
- **Frontend**: Introduce local `storyPointsInput` state in `klanservicehub-issue-detail-modal.jsx` and `client.jsx`. Commit updates only on `blur` or `Enter` keydown. Preserve optimistic updates for both `storyPoints` and `story_points`.

#### Acceptance Criteria
- [x] User can freely clear, backspace, and type any story points value (0, 1, 2, 3, 5, 8, etc.).
- [x] Values save cleanly on blur/Enter without reverting back to 1.
- [x] Re-opening the ticket reflects the newly saved story points estimate accurately.

---

### 🔹 Sub-task 7: Open Issue Details Modal on Board Ticket Double-Click

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 7: Enable double-click on board tickets to open Issue Details modal`
- **Priority**: `P2 - Medium (🟰)`
- **Story Points**: `3`
- **Component**: `Boards & Kanban View`
- **Labels**: `boards`, `kanban`, `interaction`, `issue-modal`

#### Description
Enable users to double-click any ticket card on the visual Boards view (`/workspaces/:workspaceId/boards`) and Tasks Kanban view to instantly open the comprehensive Issue Details modal without navigating away.

#### Scope of Work
- In `boards-view.jsx`, add `onDoubleClick={() => setSelectedDetailTaskId(taskId)}` to every ticket card across all columns.
- Add `e.stopPropagation()` on child action buttons (delete, workflow advancement arrows).
- In `kanban-card.jsx` and `data-kanban.jsx`, add `onDoubleClick` prop and wire to `KlanserviceHubIssueDetailModal`.
- Synchronize updated task properties back into board state via `onUpdated`.

#### Acceptance Criteria
- [x] Double-clicking any ticket card on the board immediately opens the Issue Details Modal.
- [x] Clicking child action controls (arrows, delete) does not trigger modal opening.
- [x] Modifications made in the modal synchronize with the board card in real time.

---

### 🔹 Sub-task 8: Organization Activity 50-Event Rolling FIFO Expiration Policy

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 8: Enforce 50-event maximum rolling window for Organization Activity`
- **Priority**: `P2 - Medium (🟰)`
- **Story Points**: `3`
- **Component**: `Analytics & Activity Feed`
- **Labels**: `activity-feed`, `expiration`, `fifo`, `database-optimization`

#### Description
Implement a strict rolling window policy for Organization Activity so that the database never stores more than 50 events per workspace. When the 51st event is recorded, the oldest event automatically expires and is deleted one by one (FIFO).

#### Scope of Work
- Update `logActivity` in `backend/src/db.js` to automatically execute a pruning deletion query in Cloudflare D1 and SQLite after inserting any event:
  ```sql
  DELETE FROM activities WHERE workspace_id = ? AND id IN (
    SELECT id FROM activities WHERE workspace_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 50
  )
  ```
- Export `pruneActivities(workspaceId)` and call it upon fetching to clean up legacy records.
- Cap query limits to 50 in `reports/server/route.js` and `activity/server/route.js`.
- Update `activity-feed-card.jsx` with `Live Feed (X of max 50)` badge and expanded scroll container.

#### Acceptance Criteria
- [x] Total stored events in `activities` table never exceeds 50 per workspace.
- [x] Recording a new event when 50 exist purges the oldest event automatically.
- [x] Activity feed card displays rolling events up to 50 with clear capacity indication.

---

### 🔹 Sub-task 9: Comprehensive Board Filter Toolbar with Date Presets & 7-Tier Selectors

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 9: Implement 7-tier Board Filter Toolbar with date presets and real-time reactive filtering`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Boards & Kanban View`
- **Labels**: `boards`, `filters`, `toolbar`, `date-range`, `multi-filter`

#### Description
Build and integrate an enterprise Board Filter toolbar in the Engineering Kanban Board and Project/Tasks Kanban view featuring quick date range pills (Today, Last 7 Days, Last 30 Days, Last 90 Days, This Year, Custom) and 7 dropdown selectors (Project, Team, Assignee, Work Type, Status, Priority, Sprint) with resilient safe array normalization.

#### Scope of Work
- Create `BoardFilters` component in `frontend/src/features/company/components/board-filters.jsx`.
- Implement date range pills with active visual pill styling (`bg-white text-blue-600 shadow-xs font-bold`) and custom date inputs.
- Add 7 dropdown selectors: Project, Team, Assignee, Work Type, Status, Priority, Sprint.
- Integrate into `BoardsView` and `TaskViewSwitcher` (Kanban tab) with reactive 9-factor filtering on board cards.
- Add defensive array normalization to prevent `TypeError: c.map is not a function`.

#### Acceptance Criteria
- [x] Date range pills filter board issues reactively.
- [x] All 7 dropdown filters filter cards in real time.
- [x] Integrated into both the main Engineering Kanban Board and the Project Kanban tab.
- [x] Resilient against non-array payloads (e.g. nested sprint objects).

---

### 🔹 Sub-task 10: Drag-and-Drop Column Transitions & Double-Click Stage Advancement

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 10: Enable drag-and-drop column transitions and double-click to advance stage on Engineering Kanban Board`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `3`
- **Component**: `Boards & Kanban View`
- **Labels**: `boards`, `drag-and-drop`, `stage-transition`, `interactions`

#### Description
Enable native HTML5 drag-and-drop on the Engineering Kanban Board so users can drag ticket cards to any workflow column. Enable double-click on any ticket card to immediately advance it to the next workflow stage with RBAC validation.

#### Scope of Work
- Add `draggable={true}`, `onDragStart`, and `onDragEnd` to ticket cards with grabbing cursor and dragging opacity.
- Add `onDragOver`, `onDragLeave`, and `onDrop` drop zones to each column with highlighted border and drop feedback.
- Wire `onDoubleClick` on cards to immediately advance to `columns[colIndex + 1]` with `handleMoveStatus`.
- Wire single-click on ticket key and summary to open `KlanserviceHubIssueDetailModal`.

#### Acceptance Criteria
- [x] Users can drag ticket cards from any column and drop them onto any target column.
- [x] Target column highlights when hovering a dragged ticket.
- [x] Double-clicking any ticket card immediately advances it to the next stage with success toast.
- [x] Clicking the ticket key or title opens the Issue Details modal.

### 🔹 Sub-task 11: Mobile View Typography & Responsive Kanban Layout Refinement

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 11: Refine mobile view typography, card density, and snap layout on Engineering Kanban Board`
- **Priority**: `P2 - Medium (🔹)`
- **Story Points**: `3`
- **Component**: `Mobile UX & Kanban View`
- **Labels**: `mobile-ux`, `typography`, `responsive`, `kanban-board`

#### Description
Scale down oversized typography, padding, and action bars on mobile viewports (< 640px) across the Engineering Kanban Board and Board Filters. Enable horizontal snap scrolling for columns, compact card paddings, and condensed filter dropdowns for a sleek native-app feel on handheld devices.

#### Scope of Work
- Reduce date preset pills and search bar text size to `text-[10px]` / `text-[11px]` with tighter padding on mobile.
- Condense the 7-filter grid with responsive micro-labels (`text-[9px]`) and compact selectors (`text-[10.5px]`).
- Enable horizontal snap scrolling (`snap-x snap-mandatory`) with `min-w-[82vw]` column cards on mobile screens.
- Refine ticket card padding, key badges, priority badges (`P0`, `P1`, `P2`), and assignee footer density.

#### Acceptance Criteria
- [x] Board filters and date pills fit comfortably on mobile viewports without awkward text wrapping.
- [x] Kanban columns scroll smoothly with horizontal snap centering on mobile devices.
- [x] Ticket card fonts, badges, and avatars scale cleanly to compact proportions.
- [x] Action toolbars adapt gracefully with responsive labels and icon-first styling.

---

### 🔹 Sub-task 12: Project Governance & Approval Engine Architecture

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 12: Implement enterprise Project Governance & Approval Engine with continuous health telemetry, risk matrix, and ADRs`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Governance & Enterprise Engine`
- **Labels**: `governance`, `change-approvals`, `risk-matrix`, `adr`, `project-health`

#### Description
Deliver a full-fledged enterprise Project Governance & Approval Engine enabling change approval workflows (release sign-offs, schema migrations, architecture shifts), continuous project health telemetry (P0 blockers, open risks, completion rate), a visual 3×3 probability/impact risk matrix, Architecture Decision Records (ADRs), and delivery milestone gatekeeping.

#### Scope of Work
- Build comprehensive [`governance-view.jsx`](frontend/src/features/governance/components/governance-view.jsx) with Executive Health Bar (Health status score, completion gauge, blocker count, pending approvals).
- Implement interactive Change Approvals engine with status filtering, verification justification, and Admin Approve / Reject verdict actions with audit notes.
- Build visual 3×3 Probability vs Impact Risk Matrix and interactive risk mitigation register.
- Create Architecture Decision Records (ADRs) register with context, drivers, and consequence tracking.
- Build Delivery Milestones timeline with target dates, countdowns, and phase gate exit criteria.
- Enhance backend D1 governance endpoints with `LEFT JOIN` user resolutions, risk status updates, milestone management, and audit log tracking.

#### Acceptance Criteria
- [x] Executive health telemetry dynamically computes Green/Amber/Red health, completion rates, and P0 blockers.
- [x] Users can submit change approval requests across categories (Release, Schema, Scope, Architecture, Security).
- [x] Workspace Admins can review, approve, or reject approval requests with review notes.
- [x] Visual 3×3 Risk Matrix maps vulnerabilities with mitigation plans and status transitions.
- [x] Architecture Decision Records (ADRs) and Delivery Milestones can be created, tracked, and managed per project.

---

---

### 🔹 Sub-task 13: Restore Workspace & Project Summary Analytics on Cloudflare D1

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 13: Restore real-time Workspace and Project Analytics metrics on Cloudflare D1 with resilient task counting`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `3`
- **Component**: `Analytics & Reporting / Core Backend`
- **Labels**: `analytics`, `kpi-cards`, `d1-database`, `task-counting`, `workspace-summary`

#### Description
Fix the Workspace Planning Summary and Project Summary KPI cards (Total tasks, Assigned tasks, Completed tasks, Overdue tasks, Incomplete tasks) which were displaying 0 or inaccurate values due to synchronous mock db execution and restrictive monthly date filtering.

#### Scope of Work
- Rewrite `GET /api/workspaces/:workspaceId/analytics` and `GET /api/projects/:projectId/analytics` to query Cloudflare D1 asynchronously using `d1First`.
- Correct task counting logic to accurately track total active tasks, assigned tasks (checking both primary assignee and multi-assignee junction table), completed tasks (`status = 'DONE'`), incomplete tasks, and overdue tasks (`due_date < datetime('now')`).
- Implement accurate month-over-month trend comparisons using SQLite standard `strftime('%Y-%m', created_at)`.
- Make frontend `safeAnalytics` resilient by merging backend D1 metrics with in-memory task documents so cards never display stuck zeroes.

#### Acceptance Criteria
- [x] Total tasks KPI displays accurate total task count in the workspace and project.
- [x] Assigned tasks KPI accurately counts tasks assigned to members.
- [x] Completed tasks and Incomplete tasks accurately reflect current workflow statuses.
- [x] Overdue tasks accurately identifies overdue non-completed tasks regardless of creation date.
- [x] Frontend fallbacks ensure seamless live counting even during network transitions.

---

---

### 🔹 Sub-task 14: Modernize KlanServiceHub Service Management (KSM) Architecture

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 14: Enterprise KlanServiceHub Service Management (KSM) suite with Cloudflare D1 auto-migrations, interactive ticket details drawer, and SLA telemetry`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Service Desk (KSM) / Backend & Frontend`
- **Labels**: `ksm`, `service-desk`, `itsm`, `sla-management`, `customer-orgs`

#### Description
Deliver a robust, enterprise-grade IT Service Management (ITSM) and customer service ticketing engine in KlanServiceHub with automatic Cloudflare D1 table and column migrations, resilient ticket creation with auto-project provisioning, live SLA countdown clocks with visual breach escalation, an interactive Ticket Details Drawer, member assignment, and customer organization directory.

#### Scope of Work
- Add `ensureKsmTables` in backend to auto-migrate `service_requests` and `customer_organizations` on Cloudflare D1.
- Fix SQL joins (`LEFT JOIN users u`) to avoid dropping requests lacking matching internal user IDs.
- Auto-provision default `IT Service Operations` (`KSM`) project if raising tickets in newly initialized workspaces.
- Synchronize task assignment with `members.id` and `task_assignees` table.
- Build interactive `TicketDetailsDrawer` for inline status transitions, agent assignment from workspace members, and resolution note tracking.
- Enhance `CreateRequestModal` and `ManageCustomerOrgsModal`.

#### Acceptance Criteria
- [x] Service requests table auto-initializes in Cloudflare D1 with all required schema columns.
- [x] Raising requests works seamlessly without requiring manual project setup.
- [x] Clicking any ticket row opens the interactive Service Desk Ticket Details Drawer.
- [x] Support agents can transition statuses, assign workspace members, and log resolution notes.
- [x] SLA countdown reflects live target time with color-coded breach warnings.

---

### 🔹 Sub-task 15: Enterprise CMDB Assets & Infrastructure Topology Suite

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 15: Real-time Enterprise CMDB Assets inventory with interactive SVG Infrastructure Topology graph, blast radius analyzer, and D1 auto-migration`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `CMDB & Infrastructure / Backend & Frontend`
- **Labels**: `cmdb`, `assets`, `topology-graph`, `infrastructure`, `blast-radius`, `realtime`

#### Description
Deliver a comprehensive, real-time Configuration Management Database (CMDB) and Infrastructure Topology Suite for KlanServiceHub. The solution features continuous health telemetry, 5-tier architectural swimlanes (Ingress, Gateways, Microservices, Caches, Databases), interactive node selection, dynamic blast radius impact calculations (upstream services at risk vs. downstream dependencies), quick telemetry state transitions, dependency relationship management, and idempotent Cloudflare D1 table auto-migrations with one-click enterprise topology provisioning.

#### Scope of Work
- Implement idempotent `ensureAssetsTables` auto-migration on Cloudflare D1 for `assets` and `service_dependencies`.
- Build comprehensive backend CRUD and topology metrics endpoint `GET /api/assets/:workspaceId/topology`.
- Provide one-click enterprise architecture blueprint seeder `POST /api/assets/:workspaceId/seed-sample` (10 configuration items across all 5 tiers).
- Build modern `CmdbView` frontend component with live KPI telemetry banner (Total CIs, Health %, Degraded, Outages, Topology Edges).
- Implement interactive Multi-Tier Architecture Layout with status badges, pulsating outage indicators, and dependency routes.
- Implement slide-over CI Telemetry Inspector with real-time status switcher and automated Blast Radius Risk analysis.
- Provide Asset Inventory & Telemetry table with multi-criteria search and filters (Type, Environment, Status).
- Implement `CreateAssetModal` and `CreateDependencyModal`.

#### Acceptance Criteria
- [x] CMDB tables auto-migrate on Cloudflare D1 with zero SQL schema errors.
- [x] Multi-tier topology displays Edge, Gateway, Microservice, Cache, and Database tiers clearly.
- [x] Clicking any node opens the CI Telemetry Inspector with live metrics and blast radius calculations.
- [x] Users can switch CI status (Active, Maintenance, Degraded, Offline) and observe instant UI updates.
- [x] Users can register new CIs, link dependencies, and inspect asset inventory with search and filters.

---

### 🔹 Sub-task 16: Enterprise Deployments & DORA Engineering Metrics Suite

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 16: Real-time DORA 4-Key engineering metrics, continuous deployment stream, automated rollback tracking, and Cloudflare D1 auto-migration`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Deployments & DORA / Backend & Frontend`
- **Labels**: `deployments`, `dora-metrics`, `devops`, `mttr`, `change-failure-rate`, `realtime`

#### Description
Deliver a comprehensive, real-time Deployments & DORA Engineering Metrics Suite for KlanServiceHub. The solution features continuous delivery streams across Production, Staging, QA, and Development, real-time Google Cloud DORA 4-Key Metrics benchmarking (Deployment Frequency, Lead Time for Changes, Change Failure Rate, and Mean Time to Restore), one-click rollback triggers, multi-filter search capabilities, and idempotent Cloudflare D1 schema migrations with realistic 14-day telemetry seeding.

#### Scope of Work
- Implement idempotent `ensureDeploymentsTables` auto-migration on Cloudflare D1 for `deployments`.
- Build comprehensive backend DORA calculation engine `GET /api/deployments/dora/:workspaceId` with performance tier classification (Elite / High / Medium / Low).
- Build workspace deployment feed `GET /api/deployments/workspace/:workspaceId` and manual release recorder `POST /api/deployments/workspace/:workspaceId`.
- Implement graceful rollback action `POST /api/deployments/workspace/:workspaceId/:deploymentId/rollback`.
- Provide one-click 14-day multi-service deployment history blueprint seeder `POST /api/deployments/workspace/:workspaceId/seed-sample`.
- Build high-density `DeploymentsView` frontend suite with DORA 4-Key gauge cards, environment velocity metrics, and continuous deployment feed table.
- Implement `CreateDeploymentModal`, `RollbackConfirmationModal`, and `DeploymentDetailsDrawer`.

#### Acceptance Criteria
- [x] Deployments table auto-migrates in Cloudflare D1 with commit hash, service name, branch, duration, and rollback tracking.
- [x] DORA 4-Key metrics calculate dynamically from active workspace deployment records with official tier badges.
- [x] Users can trigger/log new deployments across Production, Staging, QA, and Dev.
- [x] Users can trigger one-click rollbacks for production releases.
- [x] Search and multi-criteria filters (Environment, Status, Service) operate smoothly on deployment history.

---

### 🔹 Sub-task 17: Enterprise Strategic Portfolio, OKRs & Initiatives Suite

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 17: Executive Strategic Portfolios & OKRs delivery suite with budget tracking, initiative progress meters, and D1 auto-migration`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Portfolios & Initiatives / Backend & Frontend`
- **Labels**: `portfolio`, `initiatives`, `okrs`, `strategic-goals`, `budgeting`, `realtime`

#### Description
Deliver an executive-grade Strategic Portfolio & Initiatives Suite for KlanServiceHub. The solution features multi-project program alignment, real-time Cloudflare D1 persistence, financial budget tracking ($ spent / $ allocated), interactive initiative progress meters (% delivery), corporate OKR attainment tracking, health state scoring (On Track, At Risk, Off Track, Completed), and one-click strategic blueprint seeding.

#### Scope of Work
- Implement idempotent `ensurePortfolioTables` auto-migration on Cloudflare D1 for `portfolios`, `initiatives`, and `strategic_goals`.
- Build comprehensive backend executive overview endpoint `GET /api/portfolio/:workspaceId/overview`.
- Support full CRUD for portfolios, initiatives, and corporate goals with real-time status transitions.
- Provide one-click executive blueprint seeder `POST /api/portfolio/:workspaceId/seed-sample` (3 portfolios, 7 initiatives, and 3 OKRs).
- Build high-density `PortfoliosView` frontend suite with Executive KPI Banner, Portfolios Grid, Strategic Initiatives Table, and OKR tracker.
- Implement `CreatePortfolioModal`, `CreateInitiativeModal`, and `InitiativeDetailsDrawer`.

#### Acceptance Criteria
- [x] Portfolio, initiatives, and strategic goals tables auto-migrate on Cloudflare D1 with budget and health fields.
- [x] Executive telemetry cards reflect real-time program counts, average progress %, and budget utilization.
- [x] Users can create and manage portfolios, initiatives, and company OKRs.
- [x] Users can inspect initiatives in the slide-over drawer to adjust progress % and toggle health states.
- [x] Search and multi-criteria filters (Portfolio, Health, Priority) function smoothly.

---

### 🔹 Sub-task 18: Enterprise Role Management & Granular Cross-Role RBAC Matrix

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 18: Real-time enterprise Role Management & Granular Cross-Role RBAC Matrix grid with instant optimistic toggles, D1 auto-seeding, and member directory`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Access Control & Security / Backend & Frontend`
- **Labels**: `rbac`, `iam`, `permissions`, `security-matrix`, `realtime`, `enterprise`

#### Description
Implement a production-grade Role Management and Granular RBAC Matrix suite adhering to modern corporate security standards (mirroring AWS IAM, GitHub Organizations, Jira Enterprise, and Datadog RBAC). The system provides multi-domain granular permissions (covering core, CMDB, deployments, ITSM, and governance), a high-density Cross-Role Matrix Grid with instant optimistic toggling, auto-seeding 8 enterprise system roles on Cloudflare D1, Company Owner superuser immutability protections, and a dedicated workspace member role assignment directory.

#### Scope of Work
- Implement resilient `ensureRolesTables` auto-migration on Cloudflare D1 for `roles`, `role_permissions`, and `user_roles`.
- Seed 8 enterprise system roles (*Company Owner*, *Company Admin*, *Project Lead*, *Senior Developer*, *QA*, *DevOps & SRE*, *ITSM Support Agent*, *Read-Only Viewer*).
- Build high-performance matrix endpoint `GET /api/roles/:workspaceId/matrix` returning categorized permission domains and role assignments.
- Build instant toggle endpoint `POST /api/roles/:workspaceId/toggle-permission` with protected owner role validation.
- Implement member role assignment endpoints `GET /api/roles/:workspaceId/members` and `POST /api/roles/:workspaceId/assign-user`.
- Redesign `RolesAdminView` with side-by-side Cross-Role Permission Matrix Grid, Category Domain filters, and search.
- Add Executive Security Posture Banner (configured roles, total perms, least-privilege score %, superusers, member counts).
- Implement `CreateCustomRoleModal` with Quick Preset Templates (*DevOps & SRE*, *QA & Test*, *Security Auditor*, *ITSM Lead*).
- Implement `AssignMemberRoleModal` for fast role switching and user governance.

#### Acceptance Criteria
- [x] Roles, role permissions, and user roles tables auto-migrate on Cloudflare D1 with zero binding errors.
- [x] Cross-Role Matrix Grid displays all roles side-by-side with grouped domain categories.
- [x] Permission toggles update instantaneously with optimistic UI feedback and persistent D1 synchronization.
- [x] Company Owner role retains immutable permissions to prevent organization lockout.
- [x] Administrators can create custom roles with tailored description, priority level, and preset baseline permissions.
- [x] Administrators can view and reassign member roles in the Active Member Directory.

---

### 🔹 Sub-task 19: Full Platform Dynamic Data Conversion & Static Mock Elimination

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 19: Eliminate all hardcoded static mock fallbacks and transition DORA metrics, Portfolios, CMDB, and RBAC to 100% dynamic Cloudflare D1 real-time calculations`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Cross-Module Reliability / Backend & Frontend`
- **Labels**: `dynamic-data`, `zero-mock`, `d1-realtime`, `dora-metrics`, `rbac`, `cmdb`, `portfolios`

#### Description
Audit and eliminate all static mock data, hardcoded fallback strings, and artificial benchmark numbers across recently developed enterprise suites. Upgrade the backend computation engines on Cloudflare D1 to calculate real-time metrics strictly from active workspace records: dynamically compute DORA Lead Time from timestamp intervals, calculate MTTR from real outage-to-recovery events, compute dynamic OKR target horizons, calculate live Least-Privilege RBAC compliance scores, and clean CMDB defaults to reflect actual user-registered infrastructure.

#### Scope of Work
- **Deployments & DORA Engine**: Replace hardcoded `3.8 hours` lead time and `24 minutes` MTTR with dynamic SQL timestamp interval calculations. Remove mock `3.2 deploys / day` frontend fallback.
- **Portfolios & OKRs Engine**: Set database schema alter column defaults to `0` instead of artificial sample numbers. Calculate `targetHorizon` dynamically from active initiative and goal target dates.
- **CMDB & Topology Engine**: Remove static `'AWS us-east-1'`, `'10.0.1.10'`, and `'99.98'` defaults; dynamically assign uptime based on asset operational status.
- **Role Management & RBAC**: Replace static `96` security posture score with live least-privilege compliance mathematical formula evaluated against granted non-owner capabilities.
- **Service Management (ITSM)**: Streamline table initialization to remove legacy sample title cleanup queries.

#### Acceptance Criteria
- [x] DORA Lead Time for Changes and MTTR calculate dynamically from actual deployment timestamps.
- [x] DORA frontend defaults to clean zero-state indicators without hardcoded benchmark numbers.
- [x] Portfolio budgets, progress %, and planning horizons calculate strictly from active D1 records.
- [x] CMDB Configuration Items register with clean user-supplied attributes and dynamic uptime scoring.
- [x] RBAC Security Posture Score calculates dynamically from the active permission distribution.
- [x] Zero static mock data remains in production views.

---

### 🔹 Sub-task 20: Instant Reactive Data Display & Cross-Module Cache Invalidation

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 20: Standardize TanStack Query v5 object invalidation syntax across all modals and views to guarantee instant automatic display of newly added data without manual refresh`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Frontend Data Synchronization & State Management`
- **Labels**: `react-query-v5`, `cache-invalidation`, `realtime-ui`, `reactive-display`, `tasks`, `cmdb`, `deployments`, `governance`

#### Description
Resolve stale view state anomalies across KlanServiceHub where adding or modifying data required a manual browser reload to display. Migrate all mutation completion hooks from legacy TanStack Query v4 array syntax (`invalidateQueries(['key'])`) to modern TanStack Query v5 object filter syntax (`invalidateQueries({ queryKey: ['key'] })`). Wire global query invalidations directly into the Jira issue creation modal, issue detail property updates, change approvals, risk registers, and architecture decisions to guarantee instant automatic UI synchronization.

#### Scope of Work
- **React Query v5 Syntax Standardization**: Fix all invalidation calls across `cmdb-view.jsx`, `deployments-view.jsx`, `portfolio-view.jsx`, and `roles-admin-view.jsx` to use `{ queryKey: [...] }`.
- **Issue Creation Reactivity**: Wire `queryClient.invalidateQueries({ queryKey: ['tasks'] })`, `['sprints']`, `['project-analytics']`, and `['dashboards']` into `KlanserviceHubCreateIssueModal` so new tickets instantly display on Kanban boards.
- **Issue Details Real-Time Sync**: Add reactive invalidations to `KlanserviceHubIssueDetailModal` for inline property edits (assignees, story points, status transitions, comments, and worklog hours).
- **Governance Real-Time Engine**: Add `useQueryClient` and reactive invalidation hooks across `governance-view.jsx` for change approvals, risk log entries, architecture decisions, and milestones.
- **CMDB & Deployments Instant Roster**: Ensure registering a CI or triggering a deployment instantly re-fetches and displays the active record stream.

#### Acceptance Criteria
- [x] Creating any ticket in the issue modal instantly appears on active Kanban boards without a page refresh.
- [x] Updating story points, status, or assignee in the details modal immediately reflects on boards and analytics.
- [x] Triggering a deployment immediately renders the new release row in the deployment stream and recalculates DORA metrics.
- [x] Registering a CI or dependency immediately updates the interactive CMDB topology graph.
- [x] Creating a portfolio, initiative, or goal immediately updates the executive portfolio overview.
- [x] Logging an approval, risk, or milestone immediately updates the governance health status.
- [x] All `invalidateQueries` calls conform strictly to TanStack Query v5 standards.

---

### 🔹 Sub-task 21: App-Wide Instant Data Reactivity & Global Entity Cache Invalidation

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 21: App-Wide Instant Data Reactivity & Global Entity Cache Invalidation across Projects, Tasks, Teams, Users, Groups, Workflows, Sprints, and Dashboards`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Frontend / Reactivity & Query Cache`
- **Labels**: `reactivity`, `cache-invalidation`, `tanstack-query`, `real-time-ui`, `sprints`, `teams`, `workflows`

#### Description
Complete the full application reactivity matrix across all entities so that adding, editing, or deleting data anywhere (Projects, Tasks, Members, Teams, Users, Access Groups, Workflows, Sprints, Fix Versions, and Dashboards) immediately and automatically updates the display without requiring any manual browser refresh or reload. Eliminates restrictive `exact: true` invalidation matching that previously broke when Cloudflare D1 returned snake_case IDs, and bridges component-local state updates with the global TanStack Query cache.

#### Scope of Work
- **Projects Mutation Hooks**: Update `useCreateProject`, `useUpdateProject`, and `useDeleteProject` to invalidate prefix keys `['projects']`, `['project']`, `['tasks']`, `['workspace-analytics']`, `['project-analytics']`, `['dashboards']`, and `['dashboard-data']`.
- **Tasks & Bulk Operations**: Broaden `useCreateTask`, `useUpdateTask`, `useDeleteTask`, and `useBulkUpdateTasks` to invalidate `['tasks']`, `['task']`, `['workspace-analytics']`, `['project-analytics']`, `['sprints']`, `['dashboards']`, `['dashboard-data']`, `['team-workload']`, `['dependencies-graph']`, and `['reports']`.
- **Issue Modals Real-Time Sync**: Add `['dashboard-data']` and `['team-workload']` invalidation to `KlanserviceHubCreateIssueModal` and `KlanserviceHubIssueDetailModal`.
- **Members & User Directory**: Standardize `useDeleteMember` and `useUpdateMember` without restrictive `exact: true`; integrate `useQueryClient` in `UsersAdminView` to invalidate `['members']`, `['users']`, `['team-workload']`, `['roles']`, and `['workspace-analytics']` on invites, status changes, and deletions.
- **Squads & Teams Admin**: Add `useQueryClient` in `TeamsAdminView` to invalidate `['teams']`, `['members']`, `['team-workload']`, and `['workspace-analytics']` on team creation, squad updates, and team deletion.
- **Access Groups & Directory**: Add `useQueryClient` in `GroupsAdminView` to invalidate `['groups']`, `['roles']`, `['members']`, and `['users']` when access groups or domain rules change.
- **Workflows & Custom Issue Types**: Add `useQueryClient` in `WorkflowsAdminView` to invalidate `['workflows']`, `['issue-types']`, `['tasks']`, and `['project-analytics']` on workflow or status additions, renamings, and transitions.
- **Sprints & Fix Versions**: Broaden `fetchData` in `SprintsView` and `ReleasesView` to invalidate `['sprints']`, `['releases']`, `['tasks']`, `['project-analytics']`, `['dashboards']`, and `['dashboard-data']`.

#### Acceptance Criteria
- [x] Creating, updating, or deleting a project immediately updates project lists, selectors, analytics, and sidebar without reload.
- [x] Creating, updating, or deleting a task/issue immediately updates Kanban boards, Sprints, Capacity workload, and Dashboards.
- [x] Inviting, updating, or deleting users or team members immediately updates member dropdowns, squads, and workload metrics.
- [x] Modifying workflows or statuses immediately refreshes Kanban columns and issue transition options.
- [x] Creating, starting, or completing sprints immediately updates the active sprint board and project delivery progress.
- [x] Zero compilation errors on Vite production build.
- [x] Successfully deployed to Cloudflare Workers and pushed to remote master.

---

### 🔹 Sub-task 22: Resolve Planning Summary Mathematical Discrepancies & Real-Time Metric Alignment

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 22: Fix mathematical discrepancies in Workspace & Project Planning Summaries, terminal status filtering, overdue date parsing, and task list count display`
- **Priority**: `P0 - Critical (🔥)`
- **Story Points**: `5`
- **Component**: `Frontend & Backend / Analytics & Planning Summary`
- **Labels**: `planning-summary`, `analytics`, `bug-fix`, `data-integrity`, `math-consistency`, `tasks`

#### Description
Eliminate mathematical contradictions in the Workspace and Project Planning Summaries where synthetic `Math.max` between server analytics and local tasks caused impossible totals (e.g. `Completed (4) + Incomplete (4) = 8` when `Total Tasks` was only 5). Compute ground-truth analytics directly from active task collections to guarantee that `completedTaskCount + incompleteTaskCount === taskCount` at all times. Update backend D1 analytics to match terminal statuses case-insensitively (`UPPER(status) IN ('DONE', 'COMPLETED', 'RESOLVED')`), fix SQLite date parsing for overdue tasks, and correct the TaskList header so it no longer shows `5 of 2` when fewer than 5 tasks exist.

#### Scope of Work
- **Mathematical Consistency in Workspace Client**: In `workspaces/[workspaceId]/client.jsx`, replace `Math.max` fallback logic with direct ground-truth computations from active task documents.
- **Mathematical Consistency in Project Client**: In `projects/[projectId]/client.jsx`, apply the same ground-truth computation guaranteeing `completed + incomplete === total`.
- **Case-Insensitive Terminal Statuses**: Update SQL queries in `backend/src/features/workspaces/server/route.js` and `backend/src/features/projects/server/route.js` to recognize `DONE`, `Done`, `COMPLETED`, and `RESOLVED`.
- **Accurate Overdue Date Normalization**: Handle both SQLite `'YYYY-MM-DD HH:MM:SS'` and standard ISO date formats cleanly to eliminate `NaN` comparisons.
- **TaskList Header Ratio Fix**: Render `(${totalCount})` when `totalCount <= 5`, preventing erroneous ratios like `(5 of 2)`.

#### Acceptance Criteria
- [x] `completedTaskCount + incompleteTaskCount === taskCount` is strictly maintained across all 5 KPI cards.
- [x] Deleting a task or updating its status immediately reflects the exact correct number on all summary metrics.
- [x] All terminal statuses (`DONE`, `Done`, `COMPLETED`, `RESOLVED`) are correctly grouped as completed.
- [x] Overdue task detection reliably computes overdue status across ISO and SQLite date strings.
- [x] Task list header displays `(2)` or `(3)` instead of `(5 of 2)` when total count is less than or equal to 5.
- [x] Zero compilation errors on Vite production build.
- [x] Backend and Frontend deployed live to Cloudflare Workers and pushed to remote master.

---

### 🔹 Sub-task 23: Task Detail Page Cache Invalidation & Backlog Overdue Metric Exclusion

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 23: Resolve Task Detail page stale cache on status update and exclude BACKLOG tasks from overdue calculations`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Tasks, Planning Summary & Analytics`
- **Labels**: `planning-summary`, `tasks`, `cache-invalidation`, `backlog`, `analytics`, `tanstack-query`

#### Description
When updating task statuses (e.g. moving a task to `BACKLOG` via the Task Details page `/workspaces/:workspaceId/tasks/:taskId`), the Workspace Planning Summary previously retained stale data upon navigation because the detail page did not trigger TanStack Query invalidation. Furthermore, backlog items with past target dates were erroneously counted as active overdue items. This sub-task wires comprehensive query invalidation into the Task Detail client, excludes `BACKLOG` status from overdue calculations across both frontend and backend SQL queries, and adds normalized badge styling for all statuses (`BACKLOG`, `TODO`, `IN_PROGRESS`, `IN_REVIEW`, `TESTING`, `DONE`).

#### Scope of Work
- **Task Detail Query Invalidation**: In `workspaces/[workspaceId]/tasks/[taskId]/client.jsx`, inject `useQueryClient` and invalidate `['tasks']`, `['task', taskId]`, `['workspace-analytics']`, `['project-analytics']`, `['sprints']`, and `['dashboards']` on `handleUpdate`, `handleAddSubtask`, and `handleLogWork`.
- **Exclude BACKLOG from Overdue Filter**:
  - In `workspaces/[workspaceId]/client.jsx`: Add `isBacklog(t)` helper and return `false` in `isOverdue` if `isCompleted(t) || isBacklog(t)`.
  - In `backend/src/features/workspaces/server/route.js`: Update `overdueTaskCount` query to `UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED', 'BACKLOG')`.
  - In `backend/src/features/projects/server/route.js`: Update `overdueTaskCount` query to `UPPER(status) NOT IN ('DONE', 'COMPLETED', 'RESOLVED', 'BACKLOG')`.
- **Status Badge Normalization**: Add case-insensitive matching for `BACKLOG` (slate badge) and `TESTING` (cyan badge) in workspace client task tables.

#### Acceptance Criteria
- [x] Changing task status to `BACKLOG` on the task detail page instantly updates the Workspace Planning Summary without requiring a manual browser reload.
- [x] Tasks in `BACKLOG` are not counted as overdue in the Workspace Planning Summary or backend analytics.
- [x] All 6 standard statuses (`BACKLOG`, `TO DO`, `IN PROGRESS`, `IN REVIEW`, `TESTING`, `DONE`) display with appropriate color-coded badges.
- [x] Clean production build on Vite and live deployment to Cloudflare Workers.

---

### 🔹 Sub-task 24: Board-to-Workspace Real-Time Synchronization & Global Invalidation

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 24: Real-time board data synchronization with Workspace Planning Summary across drag-and-drop, quick creation, deletions, and modals`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Boards, Planning Summary & Task Modals`
- **Labels**: `boards`, `kanban`, `planning-summary`, `data-sync`, `tanstack-query`, `cache-invalidation`

#### Description
Ensure that any and all data modifications performed on the interactive Boards page (`/workspaces/:workspaceId/boards`), Kanban view, or task detail modals immediately propagate and display in the Workspace Planning Summary (`/workspaces/:workspaceId`) without requiring manual page reloads. This guarantees that dragging and dropping cards, advancing workflow stages via double-click, deleting tickets, quick-creating issues directly within board columns, and updating ticket properties in modals trigger full query cache invalidation across both board and workspace analytics.

#### Scope of Work
- **Board Status Updates (`handleMoveStatus`)**: Wire comprehensive TanStack Query cache invalidations on drag-and-drop and double-click column advances across `['tasks']`, `['task']`, `['workspace-analytics']`, `['project-analytics']`, `['boards-view-data', workspaceId]`, `['sprints']`, `['dashboards']`, `['dashboard-data']`, `['team-workload']`, and `['reports']`.
- **Board Ticket Deletion (`handleDeleteTask`)**: Invalidate workspace analytics and task queries upon ticket deletion so that total task counts and recent items decrement in real time.
- **Board Quick Issue Creation (`handleQuickCreateTask`)**: Invalidate `['tasks']`, `['workspace-analytics']`, `['project-analytics']`, and `['boards-view-data']` immediately on issue creation.
- **Detail Modal & Roadmap Synchronization**: Add `['workspace-analytics']` and `['boards-view-data']` invalidations to `KlanserviceHubIssueDetailModal`, `KlanserviceHubCreateIssueModal`, and `RoadmapTaskModal` across all field edits, subtask additions, worklogs, and status changes.
- **Modal `onUpdated` Handler**: Synchronize query cache invalidations from the board's embedded issue detail modal directly into the workspace dashboard.

#### Acceptance Criteria
- [x] Dragging and dropping a card to a different column on the Boards page immediately updates the Workspace Planning Summary status distribution and completed/incomplete metrics.
- [x] Advancing a card via double-click on the board updates the Workspace Planning Summary immediately.
- [x] Creating a task via "+ Create issue" inside any board column instantly appears in the Workspace Planning Summary recent tasks and increments task totals.
- [x] Deleting a task from the board immediately decrements task counts in the Workspace Planning Summary.
- [x] Editing task properties inside `KlanserviceHubIssueDetailModal` from the board propagates all updates to the workspace dashboard.
- [x] Zero compilation errors on Vite production build and successful deployment to Cloudflare Workers.

---

### 🔹 Sub-task 25: Align Planning Summary Recent Tasks with Board Statuses, Badges & Activity Sorting

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 25: Align Recent Issues & Tasks in Planning Summary with Board statuses, dynamic workflow badges, ticket keys, and activity sorting`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Planning Summary & Tasks`
- **Labels**: `planning-summary`, `status-badge`, `code-review`, `sorting`, `task-key`, `boards-sync`

#### Description
Resolve discrepancies in the Workspace Planning Summary where tasks sitting in the `CODE REVIEW` board column were erroneously rendered with amber `TO DO` badges due to missing status badge mappings in `getStatusBadge`. In addition, ensure that recent issues are strictly sorted by the latest interaction timestamp (`Math.max(updated_at, created_at)`) so that issues modified on the board surface immediately at the top of the Recent Issues & Tasks list, and display Jira-standard ticket keys (`task.key`) beside each issue title.

#### Scope of Work
- **Workflow Status Badges Normalization (`getStatusBadge`)**:
  - Add explicit case handling for `CODE_REVIEW` / `CODE REVIEW` (purple badge `CODE REVIEW`).
  - Add `IN_REVIEW` / `IN REVIEW` / `REVIEW` (purple badge `IN REVIEW`).
  - Add `CLOSED` to completed terminal statuses (`DONE`).
  - Replace the arbitrary `TO DO` fallback with dynamic formatting (`clean.replace(/_/g, ' ')`) for custom workflow statuses.
- **Timestamp-Accurate Recent Task Sorting (`sortedTasks`)**:
  - Sort tasks descending by `Math.max(updated_at, created_at)` across both ISO8601 and SQLite date string formats, guaranteeing that board card drags and modal updates instantly place the modified ticket at the top of the list.
- **Jira-Standard Ticket Key Display**:
  - Render the blue monospace `task.key` tag (e.g. `KP-8`) next to the issue name in `TaskList`.
- **Project Client Parity**:
  - Ensure `isBacklog` and `isCompleted` in `projects/[projectId]/client.jsx` match workspace client behavior.

#### Acceptance Criteria
- [x] Tasks in `CODE_REVIEW` on the Boards page render with purple `CODE REVIEW` badges in the Workspace Planning Summary instead of defaulting to `TO DO`.
- [x] Tasks modified or moved on the Boards page immediately rise to the top of "Recent Issues & Tasks" based on the latest `updated_at` timestamp.
- [x] Ticket keys (e.g., `KP-8`, `KP-7`) are displayed clearly in blue monospace tags alongside each issue name.
- [x] Zero compilation errors on Vite production build and live deployment to Cloudflare Workers.

---

### 🔹 Sub-task 26: Complete Elimination of Static Data in Workspace Planning Summary for 100% Dynamic Workflows & RBAC

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 26: Complete elimination of static status and role data in favor of 100% dynamic workflow status badges, categorization, and RBAC roles`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Planning Summary, Workflows & RBAC`
- **Labels**: `planning-summary`, `dynamic-data`, `workflows`, `roles`, `rbac`, `no-static`

#### Description
Completely eradicate static switch cases, fixed badge colors, and hardcoded role lists from the Workspace Planning Summary. Replace them with live dynamic models fetched directly from Cloudflare D1 via `workflowsAdminApi.getWorkflows(workspaceId)` and `rolesAdminApi.getRoles(workspaceId)`. Status badges now dynamically inherit the exact hex colors, labels, and categories configured in the workspace's workflows, completion calculations strictly check dynamic workflow categories (`category === 'DONE'`), backlog status checks dynamic workflow categories (`category === 'BACKLOG'`), and member invitation forms render the live workspace RBAC role matrix dynamically.

#### Scope of Work
- **Dynamic Workflow Status Badges (`DynamicStatusBadge`)**:
  - Replace static `getStatusBadge` with dynamic `DynamicStatusBadge` component that matches task statuses against live workflow status objects.
  - Apply custom hex colors dynamically using opacity tints (`style={{ backgroundColor: `${color}18`, color: color, borderColor: `${color}40` }}`).
  - Support any custom workflow status (e.g. `DEPLOYED`, `BLOCKED`, `STAGING`, `SECURITY_AUDIT`) seamlessly without code modifications.
- **Dynamic Ground-Truth Completion & Backlog Evaluation**:
  - In `safeAnalytics`, dynamically evaluate `isCompleted(t)` via `matched?.category === 'DONE'`.
  - Dynamically evaluate `isBacklog(t)` via `matched?.category === 'BACKLOG'`.
- **Dynamic Workspace RBAC Roles**:
  - In the employee/member invite modal, replace hardcoded `<option>` elements with live dynamic roles fetched from `rolesAdminApi.getRoles(workspaceId)`.
- **Project Planning Summary Parity**:
  - Apply dynamic workflow status category evaluations to `projects/[projectId]/client.jsx`.

#### Acceptance Criteria
- [x] Zero hardcoded status badge colors or static switch statements in the Planning Summary; badges dynamically adapt to workspace workflow definitions.
- [x] Any custom workflow status created in the workspace immediately renders with its dynamic color and label.
- [x] KPI metrics (completed, incomplete, backlog, overdue) calculate strictly according to dynamic workflow categories.
- [x] Assigned roles in the invite modal are populated dynamically from the workspace's active RBAC role list.
- [x] Clean compilation on Vite build and live deployment to Cloudflare Workers.

---

### 🔹 Sub-task 27: Comprehensive Date & Time Telemetry for Tickets and Comments

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 27: Implement Comprehensive Ticket & Comment Date-Time Telemetry across Cloudflare D1, Issue Details, and Boards`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Tasks & Comments / Date-Time Telemetry`
- **Labels**: `tasks`, `comments`, `timestamps`, `date-fns`, `cloudflare-d1`, `sqlite-normalization`, `ui-ux`

#### Description
Resolve missing comment dates and ticket timestamp visibility across the platform. Implement resilient date parsing for SQLite space-separated datetime strings (`YYYY-MM-DD HH:MM:SS`), normalize timestamps to standard ISO 8601 strings in backend data formatters, upgrade comment SQL queries to `LEFT JOIN users` to prevent data loss on unlinked user profiles, and display comprehensive date and time indicators on ticket headers, property sidebars, board cards, and comment streams.

#### Scope of Work
- **Backend Timestamp Normalization**:
  - In `backend/src/features/tasks/server/route.js`, update `POST /:taskId/comments` and `PATCH /:taskId/comments/:commentId` to explicitly record and return ISO 8601 timestamps (`created_at` and `updated_at`).
  - Switch comment queries in `GET /:taskId` and `GET /:taskId/comments` from inner `JOIN users u` to `LEFT JOIN users u` so comment data is never dropped.
  - In `backend/src/db.js` `formatDoc()`, automatically normalize SQLite space-separated timestamps (`"YYYY-MM-DD HH:MM:SS"`) to standard ISO strings (`"YYYY-MM-DDTHH:MM:SSZ"`).
- **Universal Comment Date & Time Display**:
  - In `klanservicehub-issue-detail-modal.jsx`, `client.jsx`, and `roadmap-task-modal.jsx`, introduce `parseDateSafe` and `formatCommentDate` to format comments as `Oct 26, 2026 at 6:30 PM` (month, day, year, and time are always visible).
  - Display full exact timestamps in hover tooltips.
  - Render `(edited)` indicators with the last-modified timestamp.
- **Ticket Created, Updated & Due Date Telemetry**:
  - In `klanservicehub-issue-detail-modal.jsx` and `tasks/[taskId]/client.jsx`, display created and updated timestamps in header metadata beneath the issue title.
  - Add a dedicated **Dates & Timestamps** card in the right properties sidebar showing Created, Updated, and Due dates.
  - In `boards-view.jsx` and `kanban-card.jsx`, render date tags on ticket cards with hover tooltips.
- **Database Migration Script & Live Deployment**:
  - Update `backend/UPDATED_DATABASE_TABLES.sql` and root `UPDATED_DATABASE_TABLES.sql` with `task_comments` schema, timestamp columns, and performance index `idx_task_comments_task`.
  - Deploy backend and frontend workers live to Cloudflare.

#### Acceptance Criteria
- [x] All ticket comments clearly render full calendar dates and times (e.g. `Oct 26, 2026 at 6:30 PM`).
- [x] SQLite space-separated datetime strings parse without returning `Invalid Date` across all browsers.
- [x] Comments query uses `LEFT JOIN users` so comments are never lost if user profile links differ.
- [x] Ticket details modal and dedicated page display created and updated date/time badges in header and sidebar.
- [x] Board cards display compact date badges with clock icons and full hover tooltips.
- [x] Production build and Cloudflare Workers live deployments verified.

---

### 🔹 Sub-task 28: Direct In-Modal & Page Navigation for Sub-tasks with Parent Hierarchy Telemetry

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 28: Enable direct in-modal drill-down and full-page navigation for sub-tasks with parent breadcrumb telemetry`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Frontend / Tasks & Issue Detail Modal & Backend`
- **Labels**: `tasks`, `subtasks`, `modal-navigation`, `breadcrumbs`, `hierarchy`, `ui-ux`

#### Description
Transform static sub-task rows in the main ticket Issue Detail Modal and full Task Details page into interactive cards, enabling users to seamlessly open sub-tasks directly within the current modal session or navigate to them with full parent breadcrumb history and back navigation.

#### Scope of Work
- **Backend Hierarchy Resolution**:
  - Update `GET /:taskId` in `backend/src/features/tasks/server/route.js` to detect `parent_task_id` and query parent task metadata (`id`, `key`, `name`, `status`, `issue_type`), returning `task.parentTask`.
- **In-Modal Sub-task Navigation**:
  - In `klanservicehub-issue-detail-modal.jsx`, maintain an active task ID and breadcrumb history stack.
  - Turn each sub-task row into an interactive item displaying checkbox, title, ticket key tag, status badge, and hover transition.
  - On click, smoothly switch the modal to display the sub-task’s full details without leaving the modal.
  - Provide a prominent `← Back to parent` button and clickable breadcrumb trail in the top header.
  - Render a dedicated **Parent Ticket** card in the right details sidebar with an instant return button.
- **Full Task Page Navigation**:
  - In `client.jsx`, make sub-task rows clickable to navigate directly to `/workspaces/[workspaceId]/tasks/[subtaskId]`.
  - Display parent ticket breadcrumb navigation and parent ticket card in the right details sidebar.
- **Build & Cloudflare Deployment**:
  - Build frontend and deploy backend and frontend workers live to Cloudflare.

#### Acceptance Criteria
- [x] Sub-task rows in the Issue Detail Modal are interactive, hover-styled, and open the sub-task directly on click.
- [x] Modal top header features a `Back` button and clickable breadcrumbs linking to the parent ticket.
- [x] Right details sidebar renders a dedicated **Parent Ticket** card when viewing any sub-task.
- [x] Full task page navigates to sub-tasks and displays parent breadcrumbs and sidebar parent card.
- [x] Backend resolves parent task details cleanly across Cloudflare D1 and SQLite.
- [x] Both backend and frontend production builds pass and are deployed live.

---

### 🔹 Sub-task 29: Ticket Comment Image Attachments with Drag & Drop, Clipboard Paste, and 6-Day Post-Completion Expiration Engine

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 29: Implement Ticket Comment Image Attachments with Drag & Drop, Clipboard Paste, and 6-Day Post-Completion Expiration Engine`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Tasks & Comments / Image Lifecycle & Storage`
- **Labels**: `tasks`, `comments`, `image-attachments`, `expiration-engine`, `cloudflare-d1`, `sqlite`, `ui-ux`

#### Description
Enable team members to attach images to individual ticket comments across all platform surfaces (Issue Details modal, full Task Details page, and Roadmap modal). Images can be added via file picker (`[Attach Image]` button), direct clipboard paste (`Ctrl + V`), or drag-and-drop. Enforce an automated data hygiene policy where comment images expire and are pruned from the database exactly 6 days after the parent ticket is marked `DONE`, while remaining permanently active and non-expiring while tickets are open.

#### Scope of Work
- **Ticket Completion Tracking**:
  - In `backend/src/features/tasks/server/route.js`, update `PATCH /:taskId`, `POST /:taskId/transitions`, and `POST /batch-positions` to automatically record `completed_at = CURRENT_TIMESTAMP` when ticket transitions to `DONE`, or reset `completed_at = NULL` if reopened.
- **Backend 6-Day Expiration Engine**:
  - Implement `processCommentsWithExpiration()` helper function in `route.js`.
  - In `POST /:taskId/comments`, accept an `images` array, serialize into `task_comments.images`, and return real-time expiration telemetry.
  - In `GET /:taskId/comments` and `GET /:taskId`, check if the parent ticket is `DONE` and `completed_at` was > 6 days ago.
  - If expired (> 6 days post-completion): prune image payloads from SQLite/D1 database (`UPDATE task_comments SET images = '[]'`) and flag `imagesExpired = true`.
  - If within the 6-day window: calculate remaining days and display dynamic countdown telemetry (`imagesDaysRemaining`, `imagesStatus`).
  - If ticket is active/open: mark images as active without expiration.
- **Frontend Multi-Modal Comment Composer**:
  - In `klanservicehub-issue-detail-modal.jsx`, `client.jsx`, and `roadmap-task-modal.jsx`, upgrade comment inputs into a modern rich composer with an explicit `[📷 Attach Image]` button.
  - Implement clipboard screenshot pasting (`onPaste` listener for `Ctrl + V`).
  - Implement drag-and-drop file upload (`onDrop` and `onDragOver`).
  - Display pre-upload thumbnail chips with instant removal `(X)` buttons.
  - Render comment image galleries with hover zoom, lightbox full-screen modal preview, and dynamic expiration countdown badges.
- **Schema & Database Migrations**:
  - Update `backend/schema.sql`, `backend/UPDATED_DATABASE_TABLES.sql`, and root `UPDATED_DATABASE_TABLES.sql` to include `images TEXT DEFAULT '[]'` and performance index `idx_tasks_completed_at`.
- **Live Deployment & Verification**:
  - Build Vite frontend and deploy both backend and frontend workers live to Cloudflare.

#### Acceptance Criteria
- [x] Users can attach images to comments using the `[Attach Image]` button, clipboard paste (`Ctrl + V`), or drag-and-drop.
- [x] Pre-upload image thumbnails render with remove buttons and upload size limits.
- [x] Comment streams render image galleries with hover zoom and click-to-preview lightbox modal.
- [x] Images on open tickets remain active with `Active (expires 6 days after ticket is completed)` telemetry.
- [x] Marking ticket `DONE` triggers the 6-day expiration countdown.
- [x] Reopening a completed ticket resets `completed_at` and removes expiration constraints.
- [x] After 6 days past ticket completion, image data is purged from the database and displayed as expired.
- [x] Production build passes on Vite and Cloudflare Workers live deployments verified.

---

### 🔹 Sub-task 30: Implement Universal Share, Like, and Save / Favorite for Tasks, Sub-tasks, Stories, and Epics

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 30: Enable universal Share, Like, and Save / Favorite across all issue types`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Core Platform / Multi-Module`
- **Labels**: `tasks`, `subtasks`, `stories`, `epics`, `social-telemetry`, `sharing`, `favorites`, `reactions`

#### Description
Empower teams with universal collaboration actions directly on any issue (Task, Sub-task, Story, Epic, Bug). Implements a glassmorphic Share modal with one-click direct permalinks and Web Share API support, a dynamic Like reaction engine with real-time counters and micro-animations, and a personal Save/Favorite bookmarking feature backed by Cloudflare D1.

#### Scope of Work
- **Database & Persistence**:
  - Provision `task_likes` table with `id`, `task_id`, `user_id`, and `created_at` along with unique constraints and performance indexes.
  - Connect personal task bookmarks to Cloudflare D1 `user_favorites` with `entity_type = 'TASK'`.
- **Backend API Endpoints**:
  - Add `POST /api/tasks/:taskId/toggle-like` returning `{ liked: boolean, likesCount: number }`.
  - Add `POST /api/tasks/:taskId/toggle-favorite` returning `{ isFavorite: boolean }`.
  - Augment `GET /api/tasks/:taskId` and batch `GET /api/tasks` with `likesCount`, `hasLiked`, `likers`, and `isFavorite` flags.
- **Frontend UI & Interactive Modals**:
  - Develop `TaskShareModal` with permalink copy, format variations (Key & Title, Markdown), and native system sharing.
  - Implement unified header action pill bar on `KlanserviceHubIssueDetailModal`, `TaskIdClient` full page, and `RoadmapTaskModal`.
  - Add gold star favorite badges and heart like counters to Kanban cards and table actions dropdown.

#### Acceptance Criteria
- [x] Users can like/unlike any issue type with instant visual state changes, live counters, and D1 persistence.
- [x] Users can save/unsave issues to favorites with star indicators and toast notifications.
- [x] Clicking Share opens the glassmorphic modal with instant permalink copy and native mobile/desktop Web Share support.
- [x] Kanban cards and task action menus display favorite states and share links.
- [x] Optimistic updates guarantee zero-latency responsiveness with TanStack Query cache synchronization.

---

### 🔹 Sub-task 31: Workflow Stage Overload Telemetry, WIP Limits, and Dynamic Board Indicator Lines

- **Parent Ticket**: `Enhancing the Klanservichub V1`
- **Issue Type**: `Sub-task`
- **Summary**: `Subtask 31: Implement Workflow Stage Overload Telemetry, WIP Limits, and Dynamic Board Indicator Lines`
- **Priority**: `P1 - High (⬆️)`
- **Story Points**: `5`
- **Component**: `Frontend & Backend / Workflows & Boards`
- **Labels**: `workflows`, `kanban`, `wip-limits`, `overload-telemetry`, `boards`

#### Description
Enable configurable Work-In-Progress (WIP) capacity limits and stage overload alert colors in **Workflows & Issue Types** (`/workspaces/:workspaceId/workflows-admin`). Reflect real-time telemetry across both main Tasks Kanban (`DataKanban`) and Engineering Boards (`BoardsView`) through dynamic top stage indicator lines (crisp emerald green when within capacity, user-customized alert color with pulse effect when overloaded) and interactive stage capacity badges, while strictly exempting the `DONE` stage from capacity constraints.

#### Scope of Work
- **Cloudflare D1 & Schema Persistence**:
  - Add `max_tasks INTEGER DEFAULT 5` and `overload_color TEXT DEFAULT '#EF4444'` to `workflow_statuses` table.
  - Update `schema.sql`, `db.js` mock table schemas, and `formatDoc` camelCase serialization (`maxTasks`, `overloadColor`).
  - Update Workflows API endpoints (`POST`, `PATCH`, `seedDefaultWorkflow`) to store and return `max_tasks` and `overload_color`.
- **Workflow Administration UI**:
  - Extend **Workflows & Issue Types** (`workflows-admin-view.jsx`) with capacity number inputs (1–100, default 5) and overload alert color pickers (6 preset swatches + native hex picker).
  - Implement live Kanban Board preview bar in the Add and Edit Status modals.
  - Automatically enforce `DONE` stage exemption (locks capacity to 0 / unlimited with informative banner).
  - Display stage capacity (`Max: X tickets`) and overload color dots in the workflow pipeline overview cards.
- **Kanban Column Telemetry & Top Indicator Line**:
  - Add responsive top indicator bar (`h-1.5 w-full rounded-t-xl`) across `DataKanban` and `BoardsView`:
    - `<= maxTasks`: Crisp emerald green (`#10B981` / `bg-emerald-500`).
    - `> maxTasks`: Stage overloaded — renders user-configured custom color (e.g., `#EF4444`, amber, purple, rose) with subtle warning pulse.
    - `DONE` category: Neutral subtle tone, exempt from capacity bottleneck alerts.
  - Update `KanbanColumnHeader` count pills to display `⚠️ {taskCount}/{limit}` with custom overload styling or healthy emerald dot indicators.

#### Acceptance Criteria
- [x] Cloudflare D1 `workflow_statuses` stores `max_tasks` and `overload_color` per workflow stage.
- [x] Workspace Admins can customize stage capacity limits and overload colors in Workflows admin view.
- [x] Stages with active ticket counts <= limit display a clean, solid green line at the top.
- [x] Stages exceeding limit display the custom overload color top line and warning counter pill.
- [x] `DONE` stage is strictly exempt from capacity limits and overload notifications.
- [x] Changes are reflected immediately across both `DataKanban` and `BoardsView`.

---

## Quick Reference Table for Ticket Creation

| Subtask # | Summary | Type | Priority | Points |
|:---------:|---------|:----:|:--------:|:------:|
| **Parent** | **Enhancing the Klanservichub V1** | `Epic` | `P1 - High` | **138** |
| 1 | Restore vertical page scrolling on public landing page | `Sub-task` | `P1 - High` | 2 |
| 2 | Modernize Consent for Data Processing with 100% full-width glassmorphism | `Sub-task` | `P2 - Medium` | 3 |
| 3 | Migrate Teams, Workload, and Employee reports to Cloudflare D1 | `Sub-task` | `P0 - Critical` | 8 |
| 4 | Add comment inline editing and deletion for authors and admins | `Sub-task` | `P1 - High` | 5 |
| 5 | Replace native window.confirm with professional confirmation modal | `Sub-task` | `P2 - Medium` | 2 |
| 6 | Resolve Story Points Estimate field locking and synchronization | `Sub-task` | `P1 - High` | 3 |
| 7 | Enable double-click on board tickets to open Issue Details modal | `Sub-task` | `P2 - Medium` | 3 |
| 8 | Enforce 50-event maximum rolling window for Organization Activity | `Sub-task` | `P2 - Medium` | 3 |
| 9 | Implement 7-tier Board Filter Toolbar with date presets and reactive filtering | `Sub-task` | `P1 - High` | 5 |
| 10 | Enable drag-and-drop column transitions and double-click to advance stage | `Sub-task` | `P1 - High` | 3 |
| 11 | Refine mobile view typography, card density, and snap layout on Engineering Kanban Board | `Sub-task` | `P2 - Medium` | 3 |
| 12 | Implement enterprise Project Governance & Approval Engine with continuous health telemetry, risk matrix, and ADRs | `Sub-task` | `P1 - High` | 5 |
| 13 | Restore real-time Workspace and Project Analytics metrics on Cloudflare D1 with resilient task counting | `Sub-task` | `P1 - High` | 3 |
| 14 | Enterprise KlanServiceHub Service Management (KSM) suite with Cloudflare D1 auto-migrations, interactive ticket details drawer, and SLA telemetry | `Sub-task` | `P1 - High` | 5 |
| 15 | Real-time Enterprise CMDB Assets inventory with interactive SVG Infrastructure Topology graph, blast radius analyzer, and D1 auto-migration | `Sub-task` | `P1 - High` | 5 |
| 16 | Real-time DORA 4-Key engineering metrics, continuous deployment stream, automated rollback tracking, and Cloudflare D1 auto-migration | `Sub-task` | `P1 - High` | 5 |
| 17 | Executive Strategic Portfolios & OKRs delivery suite with budget tracking, initiative progress meters, and D1 auto-migration | `Sub-task` | `P1 - High` | 5 |
| 18 | Real-time enterprise Role Management & Granular Cross-Role RBAC Matrix grid with instant optimistic toggles, D1 auto-seeding, and member directory | `Sub-task` | `P1 - High` | 5 |
| 19 | Eliminate all hardcoded static mock fallbacks and transition DORA metrics, Portfolios, CMDB, and RBAC to 100% dynamic Cloudflare D1 real-time calculations | `Sub-task` | `P1 - High` | 5 |
| 20 | Standardize TanStack Query v5 object invalidation syntax across all modals and views to guarantee instant automatic display of newly added data without manual refresh | `Sub-task` | `P1 - High` | 5 |
| 21 | App-Wide Instant Data Reactivity & Global Entity Cache Invalidation across Projects, Tasks, Teams, Users, Groups, Workflows, Sprints, and Dashboards | `Sub-task` | `P1 - High` | 5 |
| 22 | Fix mathematical discrepancies in Workspace & Project Planning Summaries, terminal status filtering, overdue date parsing, and task list count display | `Sub-task` | `P0 - Critical` | 5 |
| 23 | Resolve Task Detail page stale cache on status update and exclude BACKLOG tasks from overdue calculations | `Sub-task` | `P1 - High` | 5 |
| 24 | Real-time board data synchronization with Workspace Planning Summary across drag-and-drop, quick creation, deletions, and modals | `Sub-task` | `P1 - High` | 5 |
| 25 | Align Recent Issues & Tasks in Planning Summary with Board statuses, dynamic workflow badges, ticket keys, and activity sorting | `Sub-task` | `P1 - High` | 5 |
| 26 | Complete elimination of static status and role data in favor of 100% dynamic workflow status badges, categorization, and RBAC roles | `Sub-task` | `P1 - High` | 5 |
| 27 | Implement Comprehensive Ticket & Comment Date-Time Telemetry across Cloudflare D1, Issue Details, and Boards | `Sub-task` | `P1 - High` | 5 |
| 28 | Enable direct in-modal drill-down and full-page navigation for sub-tasks with parent breadcrumb telemetry | `Sub-task` | `P1 - High` | 5 |
| 29 | Implement Ticket Comment Image Attachments with Drag & Drop, Clipboard Paste, and 6-Day Post-Completion Expiration Engine | `Sub-task` | `P1 - High` | 5 |
| 30 | Enable universal Share, Like, and Save / Favorite across all issue types | `Sub-task` | `P1 - High` | 5 |
| 31 | Implement Workflow Stage Overload Telemetry, WIP Limits, and Dynamic Board Indicator Lines | `Sub-task` | `P1 - High` | 5 |













