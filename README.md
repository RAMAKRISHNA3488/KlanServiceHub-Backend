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

For the complete catalog of all 39 platform enhancements and sub-tasks, refer to [TODAYS_UPDATES_TICKETS.md](./TODAYS_UPDATES_TICKETS.md).
