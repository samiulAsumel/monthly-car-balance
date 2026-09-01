# Daily Car Balance Tracker

**Mongla Port Authority • Traffic Department**

A zero-dependency, offline-first vehicle tracking system for managing daily car movements across multiple port locations. Runs from the `file://` protocol or static hosting, with cloud sync via a Cloudflare Worker that commits to a private GitHub repository (every save is a commit, so nothing is ever lost).

---

## Quick Start

1. Open `index.html` in any modern browser
2. Add daily delivery/receipt data via the **Daily Entry** tab
3. Enter rotation numbers in the **Rot No** column (click any cell to edit)
4. View analytics on the **Charts** tab
5. Generate reports on the **Reports** tab
6. Track inter-location movements on the **Car Transfer** tab
7. Export data as Excel via the top bar (current month or all months)

**No server required.** The app runs entirely from local files and syncs to the cloud (Cloudflare Worker → private GitHub repo) when online. All dates are shown as `dd-mm-yyyy`. Press **Ctrl+K** anywhere to jump to a tab, month, location, or report section without the mouse — the palette traps focus and exposes full listbox ARIA semantics for screen-reader and keyboard-only use; below 700px width the daily table becomes one expandable card per date, navigation moves to a fixed bottom tab bar, and a floating button opens the same Ctrl+K palette by tap (with a swipe left/right on the card list as a shortcut for next/previous month).

---

## Features

### Daily Entry
- 8-location vehicle tracking (Warehouse-A/B, Yard No-1/7, Shed No-5/6/7/8)
- Opening/closing balance auto-calculation
- Holiday/weekend day marking (red rows)
- **Bangladesh Government Holiday Calendar** — one-click load of the official
  general + optional/executive holidays for a chosen year (2025, 2026, and any
  future year you add). Friday & Saturday are red by default; gazette holidays
  are merged on top. Moon-dependent Eid/Islamic dates can be fine-tuned per day.
- Real-time summary cards and group totals
- **Rot No column** — inline-editable rotation number per row (up to 30 chars), included in Excel export

#### How red (off) days are decided
Each date is evaluated in this order:
1. If it is in the **"Remove Red from Date"** list → always a normal working day (this wins over everything).
2. Else if it is **Friday/Saturday** (or Sunday) and that weekly-holiday toggle is on → red.
3. Else if it is in the **holiday list** (manual or loaded from the BD calendar) → red.

**Future years are partly automatic.** The dropdown always lists upcoming years, and **fixed-date national holidays** (Feb 21, Mar 26, Apr 14, May 1, Aug 5, Dec 16, Dec 25) are generated automatically for any year via the `BD_FIXED` table in `src/app.js` — no edit needed. Only **moon-dependent dates** (Eid, Ashura, Milad-un-Nabi, Puja, Buddha Purnima, etc.) must be bundled, since they have no fixed date and are set yearly by the government gazette. To bundle them for a new year, copy a year block in the `BD_HOLIDAYS` table in `src/app.js` and change the key and dates — or just add them per-day with "Add Custom Red Date".

### Analytics Dashboard (Charts)
- 7 focused charts: daily receive vs delivery, closing balance, month comparison, location performance, balance trend, net flow
- KPI cards with range-based metrics
- Location summary table
- Period filtering (6m, 12m, all-time)

### Reports
- 13 collapsible report sections (expandable/collapsible on demand)
- Preset filters: This Month, Last Month, 3M, 6M, YTD, 12M, All
- Custom date range selector with previous-period / previous-year comparison
- Executive summary with auction delivery KPIs
- Monthly trends, location rankings, peak days, day-of-week patterns
- Group performance (Warehouse / Yard / Shed)
- Location efficiency ranking
- Daily operations log
- Year-over-year comparison
- Car transfer history
- Auction delivery analytics
- Print-optimized layout

### Car Transfer
- Track inter-location car movements
- Full transfer history with date, source, destination, and quantity
- Transfers cascade opening balances forward across subsequent months

### Data Management
- **LocalStorage** primary storage (works offline)
- **Cloud sync** via a Cloudflare Worker that commits a single `data.json` to a private GitHub repo (`carview-data`). The GitHub token never reaches the browser — it lives only in the Worker. See `docs/SETUP-GITHUB-SYNC.md`.
- **Version History & restore** — every save is a GitHub commit, so any previous version can be restored from the in-app history (Settings → Cloud Sync)
- **Overwrite protection** — concurrent edits from another device are detected (SHA conflict) and warned instead of silently clobbered
- **Honest save status** — the "Saved"/"Unsaved" badge always reflects the real outcome, including a failed autosave (it stays "Unsaved" and shows a one-time warning rather than silently claiming success); a manual save and an autosave can never fire concurrently against the same cloud version
- **Corrupted data self-heals instead of crashing** — a row synced from another device with a missing or malformed field is repaired in place (padded/trimmed to the expected shape) rather than taking the app down on load
- **Save feedback** — distinguishes "✓ Saved to cloud!" from "⚠ Saved to device only!" (the latter signals the cloud write failed, e.g. expired token)
- Excel export (current month or all months)
- All dates display as **dd-mm-yyyy**; manual date-entry fields use **dd/mm/yyyy** with auto-formatting (stored internally as `YYYY-MM-DD`)
- Salted PBKDF2 password hashing for admin and named-user accounts
- Role-based user authentication (admin + up to 3 users, managed from
  Settings → User Management)
- Auto-save with dirty-state tracking

### Security
- HTML escaping on all user-supplied data before rendering (XSS protection)
- Strict Content-Security-Policy (allowlisted CDN sources only)
- Subresource Integrity (SRI) hashes on all CDN scripts
- Salted PBKDF2 password hashing via the Web Crypto API (no plaintext);
  two older stored formats are still accepted and lazily upgraded on login
- Minimum 8-character password requirement
- Warning banner when the default admin password is still in use
- Cloudflare Worker write endpoint fails closed if misconfigured, and
  validates/size-caps the request body before committing to GitHub —
  the size cap checks the actual body, not just the client-supplied
  `Content-Length` header, which a request could omit to bypass a
  header-only check

---

## File Structure

```
.
├── index.html              # entry / app shell (must stay at root)
├── manifest.json           # PWA manifest (root; referenced as /manifest.json)
├── service-worker.js       # PWA cache (MUST be root for SW scope; bump CACHE_NAME on every code change)
├── README.md
├── CLAUDE.md               # guidance for Claude Code
├── src/
│   ├── app.js              # rendering, auth, cloud sync, charts/reports UI (~4,650 lines)
│   ├── formula.js          # constants, date/format/esc utils, password hashing,
│   │                       #   the pure balance-calculation core (tested by tests/)
│   ├── hist-data.js        # seed data for a fresh install
│   ├── icons.js            # self-hosted inline SVG icon set
│   ├── toast.js            # unified toast notifications
│   ├── command-palette.js  # Ctrl+K command palette
│   └── styles.css          # responsive + print CSS (~4,000 lines)
├── tests/
│   └── formula.test.js     # node --test (see Testing, below)
├── assets/
│   └── car.png             # app logo
├── worker/
│   └── worker.js           # Cloudflare Worker (deployed separately, not loaded by the app)
└── docs/
    └── SETUP-GITHUB-SYNC.md  # one-time cloud sync setup guide
```

> `index.html`, `manifest.json`, and `service-worker.js` must stay at the repo root: the service worker can only control pages at or below its own path, and the entry/manifest are referenced from root. All six `src/*.js` files are classic scripts loaded in dependency order by `index.html` (`icons.js`/`toast.js`/`command-palette.js`/`hist-data.js`/`formula.js` before `app.js`, which is the only one that depends on the others) — every file `index.html` loads and the SW cache list use matching paths.

## Testing

No test framework or `package.json` — just Node's built-in test runner against `src/formula.js`, the DOM-free layer (constants, date/format utilities, password hashing, and the balance-calculation core):

```bash
node --test
```

(`node --test tests/` resolves the directory as a module path and fails on some Node versions — the bare form above auto-discovers `tests/formula.test.js` by convention.) This covers balance math, leap-year date edge cases, date-format round-tripping, the red-day precedence rules, and the PBKDF2 password hashing — not the DOM-heavy rendering/auth/sync layer in `app.js`, which has no automated coverage and is verified by hand in a browser.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Browser                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────┐  │
│  │ index    │  │ styles   │  │ app.js    │  │
│  │ .html    │  │ .css     │  │ (logic)   │  │
│  └──────────┘  └──────────┘  └───────────┘  │
│         │                        │           │
│         ▼                        ▼           │
│  ┌──────────────┐  ┌──────────────────┐     │
│  │ Service      │  │ LocalStorage     │     │
│  │ Worker (SW)  │  │ (primary store)  │     │
│  └──────────────┘  └──────────────────┘     │
│                              │               │
└──────────────────────────────┼──────────────┘
                                ▼ (when online)
                   ┌─────────────────────────┐
                   │  Cloudflare Worker       │   GET data.json
                   │  (carview-proxy)         │   GET ?history / ?at=<sha>
                   │  holds GitHub token      │   PUT  (commit, auth + 409 guard)
                   └─────────────────────────┘
                                │
                                ▼
                   ┌─────────────────────────┐
                   │  GitHub repo carview-data│
                   │  (private) → data.json   │   1 commit per save
                   └─────────────────────────┘
```

App code (`carview` repo) is served from Cloudflare Pages; the data (`carview-data` repo) and the Worker are separate. The browser only ever talks to the Worker — `GITHUB_CONFIG.workerUrl` in `src/app.js` must match the `connect-src` Worker URL in the `index.html` CSP.

### External Dependencies (CDN)
- **Chart.js 4.4.0** — Data visualization
- **SheetJS (XLSX) 0.18.5** — Excel export

All dependencies load from CDNs with Subresource Integrity (SRI) hashes. Cloud sync needs no SDK in the browser (plain `fetch` to the Worker); password hashing uses the browser's built-in Web Crypto API. The app degrades gracefully if CDN access is unavailable.

---

## Configuration

### Cloud Sync Setup

Cloud sync uses a Cloudflare Worker (`worker/worker.js`) plus a private GitHub repo (`carview-data`). Full one-time setup steps are in **`docs/SETUP-GITHUB-SYNC.md`**. In short:

1. Create a fine-grained GitHub PAT with **Contents: Read & Write** on `carview-data`.
2. Deploy `worker/worker.js` to a Cloudflare Worker and add two secrets: `GITHUB_TOKEN` and `WRITE_PASSWORD` (the admin login password).
3. Point `GITHUB_CONFIG.workerUrl` in `src/app.js` and the CSP `connect-src` in `index.html` at the Worker URL.

Without the Worker configured, all data stays in `localStorage`.

> **Note:** the fine-grained PAT has an expiry — when it expires, saves fail and fall back to device-only. Renew it in the Worker's `GITHUB_TOKEN` secret. If you change the admin password, update `WRITE_PASSWORD` too.

### Location Configuration

Edit the `LOCS` array and `LOC_CFG` object in `src/formula.js` to customize location names and colors. The number of locations (currently 8) drives the per-row `del`/`imp`/`bal`/`ob` array lengths.

---

## Production Checklist

- [x] Database validation on load, with self-healing of malformed rows
      instead of crashing (a row missing/short on a data array is
      repaired in place; only an unsalvageable row is dropped)
- [x] Memory leak prevention (chart destruction)
- [x] `prefers-reduced-motion` accessibility support
- [x] User-facing error overlay with recovery
- [x] Strict CSP with SRI hashes on all CDN scripts
- [x] HTML escaping of user data (XSS protection)
- [x] Default-password warning at startup (format-independent — keeps firing
      across a password-hash migration, not just a literal string match)
- [x] Minimum 8-character passwords
- [x] Print-optimized CSS
- [x] Responsive design (mobile-first breakpoints), incl. a mobile
      stacked-card view for the daily table below 700px, a fixed bottom
      navigation bar, swipe-left/right between months, a floating
      command-palette button, safe-area-inset support for notched
      devices, and 44px-minimum touch targets throughout
- [x] Working "Install app" prompt (Chromium browsers) with a
      dismissible banner, plus a corrected home-screen/splash-screen icon
- [x] Service worker for offline caching
- [x] Salted PBKDF2 password hashing (150k iterations, no plaintext) —
      lazily upgrades two older stored formats on login
- [x] Cloudflare Worker write endpoint fails closed on misconfiguration and
      validates/size-caps the request body before committing
- [x] Session persistence for authenticated users (admin and named users
      alike; 1-hour window)
- [x] Auto-save with dirty-state tracking that always reflects the real
      save outcome (never reports "Saved" after a failed cloud write),
      and cannot fire concurrently with a manual save against the same
      cloud version
- [x] Command palette (Ctrl+K) has a keyboard focus trap, listbox/option
      ARIA semantics, and returns focus to its trigger on close
- [x] Input sanitization on all data entry
- [x] Automated test suite for the balance-calculation core (`node --test`)

Two checklist items from earlier versions of this file — "error boundaries
on all render functions" and "null guards on DOM element lookups" — were
removed rather than kept as unverifiable blanket claims: a systematic
dead-code audit found and fixed a real instance where a missing null guard
crashed `renderSettings()` on every visit to the Settings tab, which is
exactly the class of bug those two claims asserted didn't exist. Individual
render functions do have guards where it matters (see the error-overlay
and database-validation items above); "on all" was never true.

---

## Browser Support

| Browser | Support |
|---|---|
| Chrome 90+ | ✅ Full |
| Firefox 90+ | ✅ Full |
| Safari 14+ | ✅ Full |
| Edge 90+ | ✅ Full |
| Mobile Chrome | ✅ Full |
| Mobile Safari | ✅ Full |

---

## Deployment

### Option 1: Direct File Access
Simply open `index.html` in a browser. No server needed. (Service worker / PWA install are unavailable on `file://`; cloud sync still works.)

### Option 2: Static Hosting
Deploy to any static host — the production setup uses **Cloudflare Pages** (`carview.pages.dev`). Also works on GitHub Pages, Netlify, Vercel, Nginx/Apache.

The Cloudflare Worker (`worker/worker.js`) is deployed separately from the app — see `docs/SETUP-GITHUB-SYNC.md`.

---

## Known Limitations

- PWA install prompt requires HTTPS (not available on `file://`)
- Service worker requires a server context (not available on `file://`)
- Cloud sync requires an internet connection and a configured Worker
- Native date pickers display in the browser's locale; manual date fields use custom `dd/mm/yyyy` text inputs to stay consistent
- Export requires the SheetJS CDN to load

---

## Version

**1.6.0** — Mobile UX pass: fixed a real overlap bug where the sticky
nav/month-bar assumed a hardcoded topbar height (now measured live via
CSS custom properties); fixed a login-dialog viewport overflow and
added scroll-safety to the Export/Add-User dialogs; extended touch
targets and tap-highlight/focus-visible handling; made tap feedback
(scale + ripple, with a corrected origin calculation) reach dynamically
rendered content instead of only what existed at page load; day cards
now preserve their open/expanded state and input focus across edits,
with proper `aria-expanded`. Added, with user approval of the approach:
a fixed bottom navigation bar replacing the horizontal-scroll top tabs
below 700px, a floating button opening the command palette as a
full-height mobile search sheet, swipe-left/right between months, a
working "Install app" banner (the previous handler suppressed the
browser's native prompt and replaced it with nothing), and a fixed
manifest icon that previously rendered as a tiny dot instead of filling
the frame (September 2026)

**1.5.1** — Post-hardening audit pass: `validateDB()` now self-heals
malformed synced rows instead of crashing on them, the save badge
always reflects the true save outcome (a failed autosave no longer
claims "Saved") with overlapping manual/auto saves prevented, the
command palette got a keyboard focus trap and listbox ARIA semantics,
and the Cloudflare Worker's request size cap now checks the actual
body instead of trusting the client-supplied `Content-Length` header
(September 2026)

**1.5.0** — UI polish pass (self-hosted SVG icons replacing emoji, design
tokens, sticky/keyboard-navigable daily table with a location filter and
mobile card view, Ctrl+K command palette, unified toasts), plus a
production-readiness pass: fixed a Settings-tab crash and ~25 other
dead-code bugs found via full audit, salted PBKDF2 password hashing with
migration from two older formats, a fail-closed/validated Cloudflare
Worker write endpoint, split `app.js` into `formula.js`/`hist-data.js`,
and a `node --test` suite for the balance-calculation core (September 2026)

**1.4.0** — `dd-mm-yyyy` dates everywhere (manual fields use `dd/mm/yyyy` inputs); Bangladesh Government Holiday Calendar loader with auto-generated fixed national holidays (June 2026)

**1.3.0** — Migrated cloud sync from Firebase to a Cloudflare Worker + private GitHub repo, with version history, restore, and overwrite protection (June 2026)

**1.2.0** — Security hardening: XSS escaping on user data, strict CSP, SRI hashes on CDN scripts, 8-character password minimum, default-password warning (June 2026)

**1.1.0** — Added Rot No column, expanded report sections (June 2026)

---

**© 2026 samiulAsumel. All rights reserved.**
Built for Mongla Port Authority • Traffic Department
