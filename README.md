# UCIRP – working app

UCIRP (Urban Complaint Intelligence & Resolution Platform) is a civic complaint app, set in Coimbatore:
citizens report problems with photos and a map pin, repeated reports of the same problem join one issue,
ward officers verify and assign, field engineers repair with photo evidence, and the citizen confirms the fix.
Everything is saved on your own computer.

## Start it (Windows)

1. Install **Node.js** (the "LTS" version) from https://nodejs.org – only needed once.
2. Unzip this folder anywhere.
3. Double-click **start.bat**. A black window opens and your browser opens http://localhost:8080
4. Keep the black window open while you use the app. Close it (or press Ctrl+C) to stop.

On macOS/Linux: `sh start.sh`, then open http://localhost:8080

## Sign in

Every demo login uses the password **demo123**.

| Login ID | Who | What they do |
|---|---|---|
| c1, c2 | Citizens | Report problems, support existing issues, confirm or dispute repairs, earn Civic Karma |
| o1 | Ward 45 verification officer (Roads, Water, Lights) | Ranked queue, verify, merge duplicates, assign, review evidence |
| o4 | Ward 45 officer (Sanitation) | Same, for sanitation |
| o2, o3 | Ward 63 / Ward 30 officers | Same, for their wards |
| w1, w2, w3, w4 | Field engineers (Roads, Water, Sanitation, Electrical) | Work orders with SLA timers, progress updates, after-repair photo and note |
| a1 | City administrator | Dashboard, hotspots, audit log, priority weights, department settings |
| s1, s2 | Department supervisors | Workload and deadlines across wards (an extra role, not one of the four in the PRD) |

Citizens can also create their own account with a mobile number on the Citizen sign-in page.

## Try the whole flow (10 minutes)

Open three browser windows (a normal window, an Incognito window and a second browser, so each has its own login).

1. **c1** → New complaint → describe it (or tap a quick-draft preset), add 1 to 3 photos, press "Use my exact location" or drag the pin → submit. You get a reference ID and the six-step timeline (Submitted → AE Review → Assigned → In Progress → Resolved → Closed).
2. **c2** → report the same problem at the same spot. The app shows the similar issue with its match score; submitting adds the report to the existing issue instead of creating a second one.
3. **o1** → the queue is ranked by priority. Open **I-1007**: it carries a ready-made duplicate suggestion (score 0.71) that you can accept (merge) or reject with a reason.
4. **o1** → open the new issue → Verify issue → Create work order (this starts the SLA timer; a second agency can be added for joint dispatch).
5. **w1** → Accept → Start work → add a progress update → resolution note and after-repair photo → Submit.
6. **o1** → Work orders → Approve evidence.
7. **c1** → open the issue → Confirm fix (earns Civic Karma) or Dispute fix (reopens it with its history).
8. **a1** → dashboard, hotspot map, audit log, priority weights and department SLA settings.

The windows update by themselves; there is no need to reload.

## The rules the app applies

- **Duplicates:** S = 0.5 × location + 0.3 × text + 0.2 × photo. 0.80 or more links the report to the existing issue, 0.55 to 0.79 goes to the ward officer as a suggestion, below 0.55 is a new issue.
- **Priority:** an explainable 1–100 score with a band (Critical, High, Medium, Low). The factors are shown on every issue. Officers can override it with a reason.
- **Routing:** by category to GCC, CMWSSB, TANGEDCO or State Highways, with optional joint dispatch to a second agency.
- **SLA:** On Track, At Risk after 75% of the time, Breached after the deadline (the issue is escalated). Emergency SOS always has a 4-hour SLA.
- **Closure:** an issue is Resolved only with an after-repair photo and a note. The citizen confirms or disputes. With no answer for 7 days it closes automatically and is flagged "closed without confirmation".
- **Audit log:** every state change, override and merge is recorded.

## Location and maps

- **Use my exact location** keeps reading the GPS until the accuracy is 15 m or better and shows the accuracy. You can still drag the pin.
- When a field engineer accepts a job, their phone shares its position; the citizen and the officer see it move on the map.
- A phone outdoors gives 3–10 m. A laptop has no GPS chip and guesses from Wi-Fi, which can be far off – drag the pin in that case.
- The street map uses Esri tiles (OpenStreetMap is the automatic backup) and needs internet. Without internet a simple built-in map of Coimbatore is shown.

### Using it on a phone

Phones only allow GPS on a secure (https) address. The black window prints one, for example
`https://192.168.1.20:8443`. Connect the phone to the same Wi-Fi, open that address, and on the
certificate warning tap **Advanced → Proceed** (the certificate is made on your own computer, so the browser cannot verify it).
If the page does not open, allow Node.js through the Windows Firewall when Windows asks.

## If the server stops

The browser keeps a copy of the last data it loaded. If the server is unreachable, a yellow bar appears, the lists stay
readable from that copy, and a citizen can still write a new complaint: it is kept in the browser and sent automatically
when the server is back. Other actions (verify, assign, confirm) need the server. This is a fallback copy for one browser,
not a way to share data between people.

## What is real and what is simulated

Real: logins (JWT) and role permissions, saved data, photo uploads, duplicate scoring and linking, priority scoring, work orders,
SLA states and escalation, auto-close, in-app notifications, GPS location and live tracking, audit log, Tamil/English.

Simulated (and labelled in the app):

- **CivicFix AI** (diagnosis, briefing, "Ask the city") is a built-in rule engine using keywords and distances. No AI model is called, and photos are not analysed for damage.
- **Photo similarity** is a simple 64-bit image fingerprint, good at spotting the same or a near-identical picture, not two different pictures of the same pothole.
- **SMS / WhatsApp** are not sent; notifications appear inside the app only. No OTP is sent on registration.
- **Government systems** (for example the TN CM Helpline) are not connected.
- Wards, staff, complaints and the list of schools and hospitals are synthetic demo data. Only three wards (30, 45, 63) are modelled.
- **Agency names** follow the PRD (GCC, CMWSSB) although the demo city is Coimbatore. The two display names are in the `AGENCIES` block of `lib/city-store.js`.

## Where things are

| Path | What |
|---|---|
| `server.js` | Starts the server and wires the modules together |
| `lib/auth-service.js` | AuthService: passwords, JWT, login throttling |
| `lib/city-store.js` | CityStore: reference data, demo data, saving to `data/db.json` |
| `public/city-algorithms.js` | CityAlgorithms: duplicate score, priority, SLA state, routing (used by server and browser) |
| `controllers/` | REST endpoints: `auth`, `shared`, `citizen`, `authority` |
| `public/` | The web app: `index.html`, `app.js`, `styles.css`, Leaflet and Chart.js |
| `BACKEND.md` | REST API reference |
| `data/` | Created on first start: `db.json` (all data) and `uploads/` (photos). Delete the folder to start fresh |
| `test/workflow.test.js` | 21 automated end-to-end tests: `npm test` (Node 18 or newer) |
| `src/tailwind.css` | Style source. `public/styles.css` is already built, so nothing needs building to run the app. To change styles: `npm run build:css` (needs internet the first time) |

## Before using this for real

This is an academic prototype with synthetic data, not a hardened public service. Before real citizens use it:
change the demo passwords, use a proper HTTPS certificate, move from the JSON file to a database (PostgreSQL/PostGIS),
add real SMS/OTP, and add face and number-plate blurring with a data retention policy.
