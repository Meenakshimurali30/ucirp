# UCIRP backend – REST API reference

Node.js 16 or newer, no packages to install. Start with `node server.js` (port 8080; `PORT` changes it).

## Modules

| File | Module | Responsibility |
|---|---|---|
| `lib/auth-service.js` | AuthService | Password hashing (scrypt), JWT sign/verify (HS256), login throttling |
| `lib/city-store.js` | CityStore | Reference data (departments, agencies, wards, categories), synthetic demo data, `data/db.json` persistence |
| `public/city-algorithms.js` | CityAlgorithms | Duplicate score, priority score and band, SLA state, simulated diagnosis, agency routing. Loaded by the server and by the browser, so both use the same rules |
| `controllers/auth.js` | Auth controller | Sign in, register, sign out |
| `controllers/shared.js` | Shared controller | Read endpoints for all roles |
| `controllers/citizen.js` | Citizen controller | Report, duplicate check, support, reply, confirm, dispute |
| `controllers/authority.js` | Authority controller | Officer, field engineer, supervisor and administrator actions |
| `lib/local-https.js` | – | Self-signed HTTPS so phones can use GPS |
| `server.js` | – | Wires the modules together: workflow helpers, per-role data views, HTTP, live updates |

## Conventions

- Request and response bodies are JSON (`Content-Type: application/json`). Other content types get `415`.
- Errors: `{ "error": "message" }` with status `400` invalid input, `401` not signed in, `403` role or ward/department not allowed, `404` not found, `409` wrong state, `413` too large, `429` too many failed logins.
- Every successful change is written to `data/db.json` before the reply is sent.
- Request size limit: 18 MB. Photos: JPEG, PNG or WebP as data URLs, 4 MB each.

## Authentication (JWT)

`POST /api/auth/login` returns `{ me, role, token }`. The token is a JSON Web Token (HS256) with the claims `sub` (user id), `role`, `jti`, `iat`, `exp` (14 days).
Send it on later requests either way:

- browser: it is set as an `HttpOnly; SameSite=Lax` cookie named `token`;
- API client: header `Authorization: Bearer <token>`.

Each endpoint lists the roles it accepts; the role inside the verified token decides. Ward and department are checked as well (an officer of ward 45 cannot act on ward 63).
Signing out puts the token's `jti` on a revocation list until it would have expired.

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/auth/login` | `{login, password}` | 10 failures in 5 minutes block the address |
| POST | `/api/auth/register` | `{name, phone, password}` | Citizens only. 10-digit mobile number. No OTP (simulated) |
| POST | `/api/auth/logout` | – | Revokes the token |

Roles: `citizen`, `officer` (ward verification officer), `crew` (field engineer), `admin`, plus `supervisor` (department supervisor, an addition to the four PRD roles).

## Read endpoints

| Method | Path | Roles | Returns |
|---|---|---|---|
| GET | `/api/state` | anyone | Everything the caller may see. Without a token: a sanitised public view |
| GET | `/api/issues` | all signed in | Issues with `priority {parts, weights, computed, total, override}` and `band` |
| GET | `/api/issues/:id` | all signed in | One issue with `priority`, `band`, `stage`, `workOrders[]` (each with `sla`) |
| GET | `/api/work-orders` | officer, supervisor, crew, admin | Work orders in the caller's scope, each with `sla` = `On Track`, `At Risk` or `Breached` |
| GET | `/api/notifications` | all signed in | The caller's in-app notifications |
| POST | `/api/notifications/read` | all signed in | Marks them read |
| GET | `/api/audit` | officer, supervisor, admin | Audit log: every state change, override and merge |
| GET | `/api/analytics` | admin | `recurrence[]`, `byAgency`, `sla` counts, `dup` counts |
| GET | `/api/live` | all signed in | Live field-engineer positions the caller may see |
| GET | `/api/events` | anyone | Server-sent events: `change` (reload state), `loc` (live position) |
| POST | `/api/issues/:id/briefing` | all signed in | Simulated AI briefing (rule engine) |

## Citizen

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/issues/check` | report without photos | `{ai, radius, duplicates[]}`: open issues of the same category inside the category's duplicate radius, each with `s, geo, text, image, band` |
| POST | `/api/issues` | `{cat, desc, ward, street, landmark, lat, lng, acc?, addr?, sos?, photos[1..3], hashes[]?, distinct?}` | See duplicate rules below. Returns `{id, dept, agency, match}` or `{linked: true, id, match}` |
| POST | `/api/issues/:id/support` | – | Adds the caller as a supporter |
| POST | `/api/issues/:id/reply` | `{text}` | Answer to an officer's information request |
| POST | `/api/issues/:id/confirm` | – | `Resolved` → `Closed`, awards Civic Karma once |
| POST | `/api/issues/:id/dispute` | `{reason}` | `Resolved` → `Reopened`, history kept, work orders go back for rework |

### Duplicate rules (FR06)

`S = 0.5 × geo + 0.3 × text + 0.2 × image`, compared with open issues of the same category inside the category radius (100 to 300 m).

- `geo`: 1 within 25 m (GPS noise), falling in a straight line to 0 at the radius.
- `text`: share of the shorter description's key words found in the other description.
- `image`: closeness of 64-bit average hashes of the photos, computed in the browser and sent as `hashes` (16 hex characters each). Without hashes this part is 0.
- `S >= 0.80`: the report is linked to the existing issue (no new issue; supporter count goes up).
- `0.55 <= S < 0.80`: a new issue is created with `dup = {id, s, geo, text, image, d}` for the officer.
- `S < 0.55`: a new issue.
- `sos: true` or `distinct: true` never auto-links; a score of 0.55 or more is still shown to the officer.

## Ward officer

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/issues/:id/verify` | – | |
| POST | `/api/issues/:id/info` | `{reason}` | Reason is logged |
| POST | `/api/issues/:id/reject` | `{reason}` | Reason is logged |
| POST | `/api/issues/:id/duplicate` | `{accept: true}` or `{accept: false, reason}` | Accept merges into the suggested issue; reject records the reason |
| POST | `/api/issues/:id/merge` | `{into, reason}` | Manual merge inside the same ward |
| POST | `/api/issues/:id/priority` | `{score: 1..100, reason}` or `{clear: true}` | Priority override; the computed score stays visible |
| POST | `/api/issues/:id/route` | `{dept, agency?}` | Routing override, only before work orders exist |
| POST | `/api/issues/:id/work-orders` | `{crew, hours, instr, dep?, joint?}` | Assignment: starts the SLA timer. `joint` = second agency key for joint dispatch. SOS issues are capped at 4 hours |

## Field engineer

| Method | Path | Body | Notes |
|---|---|---|---|
| POST | `/api/work-orders/:id/accept` | – | |
| POST | `/api/work-orders/:id/start` | – | Refused while a prerequisite work order is unverified (unless overridden) |
| POST | `/api/work-orders/:id/progress` | `{note}` | Appears in the issue's tracking timeline |
| POST | `/api/work-orders/:id/block` | `{reason}` | |
| POST | `/api/work-orders/:id/submit` | `{remarks, photo, loc?}` | After-repair photo and resolution note are mandatory |
| POST | `/api/location` | `{lat, lng, acc?, spd?, hdg?}` | Live position while a work order is accepted or in progress |
| POST | `/api/location/stop` | – | |

## Officer or supervisor

| Method | Path | Body |
|---|---|---|
| POST | `/api/work-orders/:id/review` | `{approve: true}` or `{approve: false, reason}` |
| POST | `/api/work-orders/:id/override` | `{reason}` (dependency override) |
| POST | `/api/work-orders/:id/reassign` | `{crew}` |

When every work order of an issue is verified the issue becomes `Resolved` and waits for the citizen.

## Administrator

| Method | Path | Body |
|---|---|---|
| PUT | `/api/config/weights` | `{sev, safety, sens, support, recur}` each 0 to 50 |
| PUT | `/api/config/departments` | `{roads, health, light, water}` default SLA hours, 1 to 720 |
| POST | `/api/admin/reset` | `{"confirm": "RESET"}` restores the demo data |

## Background rules (every 30 seconds)

- A work order becomes **At Risk** when 75% of its SLA time is used (logged, officer and engineer notified).
- A work order past its deadline is **Breached**: the issue is escalated (logged, officer, supervisor and engineer notified).
- A `Resolved` issue with no citizen answer for 7 days is closed with `autoClosed: true` (logged as closed without confirmation).

## Status values

Issue: `Under Verification`, `Needs Info`, `Assigned`, `In Progress`, `Escalated`, `Resolved`, `Reopened`, `Closed`, `Rejected`, `Merged`.
Citizen-visible stage (`stage`): `Submitted`, `AE Review`, `Assigned`, `In Progress`, `Resolved`, `Closed`.
Work order: `Assigned`, `Accepted`, `In Progress`, `Blocked`, `Submitted for Verification`, `Rework Required`, `Verified`.

## Tests

`npm test` (Node 18 or newer) starts a private server with a temporary data folder and runs 21 end-to-end tests of the endpoints above.
