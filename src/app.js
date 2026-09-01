// ════════════════════════════════════════════════════
//  CONSTANTS
// ════════════════════════════════════════════════════
// LOCS/DAYS/MO/LOC_CFG/GRP_SEC/getToday moved to src/formula.js.
const LS = "carbal_v7";

// Per-device daily-table location visibility filter — deliberately NOT part
// of `sett` (which syncs to the cloud): this is a view preference, not data.
const LOC_FILTER_LS = "carbal_locfilter_v1";
function loadLocFilter() {
  try {
    const saved = JSON.parse(localStorage.getItem(LOC_FILTER_LS));
    if (Array.isArray(saved) && saved.length === LOCS.length) return saved;
  } catch {}
  return LOCS.map(() => true);
}
let locFilter = loadLocFilter();
function toggleLocFilter(li) {
  locFilter[li] = !locFilter[li];
  if (!locFilter.some(Boolean)) locFilter[li] = true; // never hide every location
  localStorage.setItem(LOC_FILTER_LS, JSON.stringify(locFilter));
  renderTable();
}

// ═══════════════════════════════════════════════════════════════════════
//  FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════════
//
//  Firebase Realtime Database Security Rules (paste in Firebase Console):
//
//  {
//    "rules": {
//      "carBalance": {
//        ".read": true,
//        "adminHash": { ".write": true },
//        "users": { ".write": true },
//        "settings": { ".write": true },
//        "data": {
//          "$month": {
//            ".write": true,
//            ".indexOn": ["date"]
//          }
//        }
//      }
//    }
//  }
//
//  NOTE: Auth is app-level (password hash check), not Firebase Auth.
//  For production, migrate to Firebase Auth with email/password and
//  use request.auth.uid in rules. Rate limiting and validation should
//  also be added via Firebase App Check.
//
// Cloud storage is a private GitHub repo (samiulAsumel/carview-data),
// accessed only through a Cloudflare Worker proxy. The Worker holds the
// GitHub token server-side, so no secret is ever exposed in the browser.
//   READ  (GET workerUrl): returns data.json (works for everyone, viewers too)
//   WRITE (PUT workerUrl): commits data.json; requires the write key below
const GITHUB_CONFIG = {
  workerUrl: "https://carview-proxy.sasas.workers.dev",
};

// Kept as a truthy flag so existing cloud-sync code paths that check
// `if (firebaseDb)` keep working unchanged after the migration.
const firebaseDb = true;

// Write authorization, derived from the admin password at login time and
// kept in localStorage so any logged-in device can save. The Worker checks
// it before writing, so only password-holders can change the data.
let writeAuth = localStorage.getItem("writeAuth") || null;
async function computeWriteAuth(password) {
  return await sha256("carview-write:" + password);
}

// SHA of the data.json version this device last loaded. Sent on save so the
// Worker can reject a write that would clobber a newer version saved elsewhere.
let cloudBaseSha = null;

// ═══════════════════════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════════════════════
// DB[monthKey] = [{date, del:[8], imp:[8], bal:[8], al, av}]
// bal[i] = per-location balance (calculated)
// closing_balance = sum(bal) - total_delivery + total_import
let DB = {};
let sett = {
  fri: true,
  sat: true,
  sun: false,
  hols: [],
  excs: [],
  tz: "Asia/Dhaka",
  transfers: {}, // { "YYYY-MM-DD": [{from, to, qty, note}] }
};
let users = {}; // username -> passHash  (max 3 + admin)
let loggedIn = null; // current username or null
let cur = "";
let undoStack = [];
let dirty = false;
let CH = {};
let reportFilter = { preset: "this-month", from: "", to: "", compare: "prev-period" };
let rptMs = [];    // active filtered months for current render cycle
let rptFocus = ""; // focus month (last of rptMs) for single-month reports
let auctionFilter = { from: "", to: "", preset: "all" }; // independent day-level filter for auction report

// Now that `sett` exists, TODAY can actually resolve against sett.tz.
const TODAY = getToday();

// ════════════════════════════════════════════════════
//  UTILS
// ════════════════════════════════════════════════════
// mk/dIn/dow/fmtDMY/isoToDMY/dmyToISO/fmt/pct/esc/sha256/PBKDF2 helpers/
// isRed moved to src/formula.js. dmyMask/dmyPick stay here — they touch
// the DOM directly, unlike everything that moved.
function dmyMask(el) {
  let v = el.value.replace(/\D/g, "").slice(0, 8);
  if (v.length >= 5) v = v.slice(0, 2) + "/" + v.slice(2, 4) + "/" + v.slice(4);
  else if (v.length >= 3) v = v.slice(0, 2) + "/" + v.slice(2);
  el.value = v;
}
// Calendar-icon picker fills the paired text field with dd/mm/yyyy.
function dmyPick(nativeEl, textId) {
  const t = document.getElementById(textId);
  if (t) t.value = isoToDMY(nativeEl.value);
}

// ════════════════════════════════════════════════════
// BANGLADESH GOVERNMENT HOLIDAY CALENDAR
// General + optional/executive holidays per the official Ministry of Public
// Administration (MoPA) gazette. Friday & Saturday are the weekly holidays and
// are handled separately by the Fri/Sat toggles above — they are NOT repeated
// here.
//
// ⚠ Islamic holidays (Eid, Shab-e-Barat, Ashura, Milad-un-Nabi, etc.) depend on
//   moon sighting and the National Moon Sighting Committee can shift them ±1 day
//   from these gazetted/predicted dates. After loading a year, verify against the
//   official gazette and fine-tune with "Add Custom Red Date" / "Remove Red from
//   Date" below.
//
// To add a FUTURE year: copy a year block, change the key and the dates. Each
// entry is { d:"YYYY-MM-DD", n:"name", t:"general" | "optional" }.
const BD_HOLIDAYS = {
  "2025": [
    { d: "2025-02-15", n: "Shab-e-Barat", t: "optional" },
    { d: "2025-02-21", n: "Shaheed Dibosh & Int'l Mother Language Day", t: "general" },
    { d: "2025-03-27", n: "Laylatul Qadr", t: "optional" },
    { d: "2025-03-28", n: "Jumatul Bidah", t: "optional" },
    { d: "2025-03-29", n: "Eid-ul-Fitr holiday", t: "general" },
    { d: "2025-03-30", n: "Eid-ul-Fitr holiday", t: "general" },
    { d: "2025-03-31", n: "Eid-ul-Fitr", t: "general" },
    { d: "2025-04-01", n: "Eid-ul-Fitr holiday", t: "general" },
    { d: "2025-04-02", n: "Eid-ul-Fitr holiday (executive)", t: "optional" },
    { d: "2025-04-14", n: "Pohela Boishakh (Bengali New Year)", t: "general" },
    { d: "2025-05-01", n: "May Day", t: "general" },
    { d: "2025-05-11", n: "Buddha Purnima", t: "general" },
    { d: "2025-06-05", n: "Eid-ul-Adha holiday", t: "general" },
    { d: "2025-06-06", n: "Eid-ul-Adha holiday", t: "general" },
    { d: "2025-06-07", n: "Eid-ul-Adha", t: "general" },
    { d: "2025-06-08", n: "Eid-ul-Adha holiday", t: "general" },
    { d: "2025-06-09", n: "Eid-ul-Adha holiday (executive)", t: "optional" },
    { d: "2025-06-10", n: "Eid-ul-Adha holiday (executive)", t: "optional" },
    { d: "2025-07-06", n: "Ashura", t: "general" },
    { d: "2025-08-16", n: "Janmashtami", t: "general" },
    { d: "2025-09-05", n: "Eid-e-Milad-un-Nabi", t: "general" },
    { d: "2025-10-01", n: "Durga Puja holiday", t: "optional" },
    { d: "2025-10-02", n: "Vijaya Dashami (Durga Puja)", t: "general" },
    { d: "2025-12-16", n: "Victory Day", t: "general" },
    { d: "2025-12-25", n: "Christmas Day", t: "general" },
  ],
  "2026": [
    { d: "2026-02-04", n: "Shab-e-Barat", t: "optional" },
    { d: "2026-02-21", n: "Shaheed Dibosh & Int'l Mother Language Day", t: "general" },
    { d: "2026-03-17", n: "Shab-e-Qadr", t: "optional" },
    { d: "2026-03-20", n: "Jumatul Wida", t: "optional" },
    { d: "2026-03-21", n: "Eid-ul-Fitr", t: "general" },
    { d: "2026-03-22", n: "Eid-ul-Fitr holiday", t: "general" },
    { d: "2026-03-23", n: "Eid-ul-Fitr holiday", t: "general" },
    { d: "2026-03-26", n: "Independence Day", t: "general" },
    { d: "2026-04-14", n: "Pohela Boishakh (Bengali New Year)", t: "general" },
    { d: "2026-05-01", n: "May Day & Buddha Purnima", t: "general" },
    { d: "2026-05-25", n: "Eid-ul-Adha holiday", t: "optional" },
    { d: "2026-05-26", n: "Eid-ul-Adha holiday", t: "general" },
    { d: "2026-05-27", n: "Eid-ul-Adha", t: "general" },
    { d: "2026-05-28", n: "Eid-ul-Adha holiday", t: "general" },
    { d: "2026-05-29", n: "Eid-ul-Adha holiday (executive)", t: "optional" },
    { d: "2026-05-30", n: "Eid-ul-Adha holiday (executive)", t: "optional" },
    { d: "2026-05-31", n: "Eid-ul-Adha holiday (executive)", t: "optional" },
    { d: "2026-06-26", n: "Ashura", t: "general" },
    { d: "2026-08-05", n: "July Mass Uprising Day", t: "general" },
    { d: "2026-08-26", n: "Eid-e-Milad-un-Nabi", t: "general" },
    { d: "2026-09-04", n: "Janmashtami", t: "general" },
    { d: "2026-10-20", n: "Durga Puja holiday", t: "optional" },
    { d: "2026-10-21", n: "Vijaya Dashami (Durga Puja)", t: "general" },
    { d: "2026-12-16", n: "Victory Day", t: "general" },
    { d: "2026-12-25", n: "Christmas Day", t: "general" },
  ],
};

// Fixed-date (Gregorian) national holidays — these fall on the SAME calendar
// date every year, so they are generated automatically for ANY selected year
// (including future years not yet listed in BD_HOLIDAYS above).
const BD_FIXED = [
  { md: "02-21", n: "Shaheed Dibosh & Int'l Mother Language Day" },
  { md: "03-26", n: "Independence Day" },
  { md: "04-14", n: "Pohela Boishakh (Bengali New Year)" },
  { md: "05-01", n: "May Day" },
  { md: "08-05", n: "July Mass Uprising Day" },
  { md: "12-16", n: "Victory Day" },
  { md: "12-25", n: "Christmas Day" },
];

// Load a year's Bangladesh holidays into the custom red-date list.
// Fixed national holidays are always generated; moon-dependent (Eid/lunar)
// holidays are added only when bundled for that year in BD_HOLIDAYS.
// includeOptional=false loads only mandatory "general" holidays.
function loadBDHolidays() {
  const sel = document.getElementById("bd-hol-year");
  const yr = sel ? sel.value : "";
  if (!yr) return;
  const incOpt = document.getElementById("bd-hol-opt");
  const includeOptional = incOpt ? incOpt.checked : true;

  // Fixed national holidays (auto-generated for any year) + bundled variable ones.
  const fixed = BD_FIXED.map((h) => ({ d: `${yr}-${h.md}`, n: h.n, t: "general" }));
  const variable = BD_HOLIDAYS[yr] || [];
  const combined = [...fixed, ...variable];

  let added = 0,
    skipped = 0;
  combined.forEach((h) => {
    if (!includeOptional && h.t !== "general") return;
    sett.excs = sett.excs.filter((x) => x !== h.d);
    if (sett.hols.includes(h.d)) {
      skipped++;
    } else {
      sett.hols.push(h.d);
      added++;
    }
  });
  setDirty(true);
  renderSettings();
  renderTable();
  alert(
    `Bangladesh ${yr} holidays loaded.\n` +
      `${added} date(s) added, ${skipped} already present.\n\n` +
      (variable.length === 0
        ? `Only fixed national holidays exist for ${yr}. Moon-dependent Eid/Islamic and Puja dates aren't bundled for this year yet — add them with "Add Custom Red Date" below using the official gazette.`
        : `Note: moon-dependent Eid/Islamic dates are predictions — verify with the official gazette and adjust below if needed.`),
  );
}

function pBadge(a, b, goodUp = true) {
  const p = pct(a, b);
  if (p === null) return "";
  if (p === 0) return '<span class="pe">±0%</span>';
  if (b === 0 && a > 0) return '<span class="pu">New</span>'; // Previous was 0
  if (Math.abs(p) > 999)
    return '<span class="pd">>' + (goodUp ? "999%" : "999%") + "</span>"; // Cap at 999%
  const good = goodUp ? p > 0 : p < 0;
  return `<span class="${good ? "pu" : "pd"}">${p > 0 ? "▲" : "▼"}${Math.abs(p)}%</span>`;
}
function setDirty(v) {
  dirty = v;
  const el = document.getElementById("sv-badge");
  el.innerHTML = v
    ? icon("alert-triangle", 12) + " Unsaved"
    : icon("check-circle", 12) + " Saved";
  el.className = "sv " + (v ? "dirty" : "ok");
  const saveBtn = document.getElementById("save-button");
  if (saveBtn) {
    saveBtn.classList.toggle("dirty-pulse", v);
  }
  if (v) startAutoSave();
}

// ════════════════════════════════════════════════════
//  FORMULA ENGINE — exact Excel logic
// ════════════════════════════════════════════════════
// calcLocBals/calcClosing/getClosing/validateNumber moved to
// src/formula.js.

function buildHist() {
  // Don't clear existing data - preserve user's work

  // Sort historical data by date to ensure proper order
  const sortedData = HIST_DATA.rows
    .slice()
    .sort((a, b) => a.d.localeCompare(b.d));

  sortedData.forEach((r) => {
    if (!r.v || !Array.isArray(r.v)) return;
    const key = r.d.slice(0, 7);
    if (!DB[key]) DB[key] = [];
    // Never create a duplicate date: if this day already exists (e.g. loaded
    // from the cloud), skip the embedded historical seed for it.
    if (DB[key].some((x) => x.date === r.d)) return;
    const del = [];
    const imp = [];
    for (let i = 0; i < LOCS.length; i++) {
      del.push((r.v[i * 2]) || 0);
      imp.push((r.v[i * 2 + 1]) || 0);
    }
    if (del.length !== LOCS.length || imp.length !== LOCS.length) return;
    let locBals;
    let isDay1 = false;
    if (r.ob) {
      locBals = r.ob.slice();
      isDay1 = true;
    } else {
      const prev = DB[key].slice(-1)[0];
      locBals = calcLocBals(prev.bal, prev.del, prev.imp);
    }
    const newRow = {
      date: r.d,
      del,
      imp,
      bal: locBals,
      al: r.al || "",
      av: r.av || "",
    };
    if (isDay1) newRow.ob = locBals.slice();
    DB[key].push(newRow);
  });

  // Only fix transitions if there are inconsistencies
  checkAndFixMonthTransitions();
}

function validateDB() {
  let issues = [];
  Object.keys(DB).forEach((k) => {
    if (!/^\d{4}-\d{2}$/.test(k)) {
      issues.push("Invalid month key: " + k);
      return;
    }
    if (!Array.isArray(DB[k])) {
      issues.push("Month " + k + " is not an array");
      return;
    }
    DB[k].forEach((r, idx) => {
      if (!r.date) issues.push(k + " row " + idx + " missing date");
      if (!Array.isArray(r.del) || r.del.length !== LOCS.length) issues.push(k + " row " + idx + " invalid del[]");
      if (!Array.isArray(r.imp) || r.imp.length !== LOCS.length) issues.push(k + " row " + idx + " invalid imp[]");
      if (!Array.isArray(r.bal) || r.bal.length !== LOCS.length) issues.push(k + " row " + idx + " invalid bal[]");
      r.del = r.del.map((v) => isNaN(v) ? 0 : v);
      r.imp = r.imp.map((v) => isNaN(v) ? 0 : v);
      r.bal = r.bal.map((v) => isNaN(v) ? 0 : v);
    });
  });
  if (issues.length) {
    console.warn("DB validation issues:", issues);
    if (issues.length > 10) {
      showErrorOverlay("Data corruption detected (" + issues.length + " issues). Resetting to defaults.");
      localStorage.removeItem(LS);
      return true;
    }
  }
  return false;
}

function loadLS() {
  try {
    const raw = localStorage.getItem(LS);
    if (!raw) return;
    const s = JSON.parse(raw);
    if (s.db && typeof s.db === "object")
      Object.keys(s.db).forEach((k) => {
        if (Array.isArray(s.db[k])) DB[k] = s.db[k];
      });
    if (s.sett && typeof s.sett === "object") Object.assign(sett, s.sett);
    if (s.users && typeof s.users === "object") users = s.users;
    if (s.loggedIn) loggedIn = s.loggedIn;
  } catch (e) {
    console.error("localStorage data corrupted, clearing:", e);
    try { localStorage.removeItem(LS); } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  FIREBASE SYNC
// ═══════════════════════════════════════════════════════════════════════

function loadFromFirebase(callback) {
  // Read from the Worker (which reads the private repo). Cache-bust so we
  // always get the latest committed data.
  fetch(GITHUB_CONFIG.workerUrl + "?t=" + Date.now())
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      cloudBaseSha = r.headers.get("X-Data-Sha") || null;
      return r.json();
    })
    .then((data) => {
      if (data && (data.db || data.adminHash)) {
        if (data.db) {
          Object.keys(data.db).forEach((k) => {
            const m = data.db[k];
            // Firebase stored arrays as numeric-keyed objects; coerce back to
            // an array so the rest of the app (which expects arrays) works.
            const arr = Array.isArray(m)
              ? m
              : Object.keys(m)
                  .sort((a, b) => Number(a) - Number(b))
                  .map((i) => m[i]);
            // Self-heal: drop duplicate dates (old migrations left an empty
            // extra row on the 1st), keeping the row with real data.
            const weight = (r) =>
              ["bal", "del", "imp", "ob"].reduce(
                (s, key) =>
                  s +
                  (Array.isArray(r[key])
                    ? r[key].reduce((a, v) => a + Math.abs(Number(v) || 0), 0)
                    : 0),
                0,
              );
            const seen = {};
            arr.forEach((r) => {
              if (!seen[r.date] || weight(r) > weight(seen[r.date]))
                seen[r.date] = r;
            });
            DB[k] = Object.keys(seen)
              .sort()
              .map((d) => seen[d]);
          });
        }
        if (data.sett) Object.assign(sett, data.sett);
        if (data.users) users = data.users;
        if (data.loggedIn) loggedIn = data.loggedIn;
        if (data.adminHash) {
          ADMIN_HASH = data.adminHash;
        }
      } else {
        loadLS();
      }
      if (callback) callback();
    })
    .catch((e) => {
      console.warn("Cloud load failed, using local data:", e);
      loadLS();
      if (callback) callback();
    });
}

function saveToFirebase() {
  if (!firebaseDb || !isLoggedIn) return Promise.resolve(false);

  const dataToSave = {
    db: DB,
    sett: sett,
    users: users,
    loggedIn: loggedIn,
    adminHash: ADMIN_HASH,
  };

  // Send to the Worker, which fetches the current SHA and commits to the
  // private repo. The write key proves we know the admin password.
  return fetch(GITHUB_CONFIG.workerUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Write-Key": writeAuth || "",
    },
    body: JSON.stringify({
      message: "Update data " + new Date().toISOString(),
      data: dataToSave,
      baseSha: cloudBaseSha, // overwrite protection
    }),
  })
    .then((r) => r.json().then((j) => ({ ok: r.ok, status: r.status, j })))
    .then(({ ok, status, j }) => {
      if (status === 409) {
        // Another device saved newer data; don't clobber it.
        showError(
          "Newer data was saved from another device. Please reload the page and save again to avoid overwriting it.",
          "warning",
        );
        return false;
      }
      if (ok && j.content && j.content.sha) {
        cloudBaseSha = j.content.sha; // advance to the version we just wrote
      }
      return ok && (j.commit || j.content) ? true : false;
    })
    .catch((e) => {
      console.error("Cloud save failed:", e);
      return false;
    });
}

// ── Cloud history / restore (powered by GitHub commit history) ─────────────

function fmtCloudDate(iso) {
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      timeZone: sett.tz,
    }).formatToParts(new Date(iso));
    const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
    return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}`;
  } catch {
    return iso;
  }
}

// Update the "Last saved" label and (optionally) render the version list.
function loadCloudHistory(renderList) {
  const listEl = document.getElementById("cloud-history-list");
  const lastEl = document.getElementById("cloud-last-saved");
  if (renderList && listEl) listEl.innerHTML = "Loading…";

  return fetch(GITHUB_CONFIG.workerUrl + "?history=1&t=" + Date.now())
    .then((r) => {
      if (!r.ok) throw new Error("HTTP " + r.status);
      return r.json();
    })
    .then((commits) => {
      if (lastEl && commits.length) {
        lastEl.textContent = "Last saved: " + fmtCloudDate(commits[0].date);
      }
      if (renderList && listEl) {
        if (!commits.length) {
          listEl.innerHTML =
            '<div style="color:#666;font-size:12px">No history yet.</div>';
          return;
        }
        listEl.innerHTML = commits
          .map((c, i) => {
            const label = i === 0 ? " (current)" : "";
            const btn =
              i === 0
                ? ""
                : `<button class="btn" style="padding:4px 10px;font-size:11px" onclick="restoreVersion('${esc(
                    c.sha,
                  )}')">Restore</button>`;
            return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px;border-bottom:1px solid #eee;font-size:12px">
                <span>${esc(fmtCloudDate(c.date))}${label}</span>${btn}
              </div>`;
          })
          .join("");
      }
    })
    .catch((e) => {
      console.warn("History load failed:", e);
      if (renderList && listEl)
        listEl.innerHTML =
          '<div style="color:#dc2626;font-size:12px">History load failed.</div>';
    });
}

function showCloudHistory() {
  loadCloudHistory(true);
}

// Restore an older version: load it, then save it as a new commit on top
// (nothing is ever destroyed — the old commit stays in history).
async function restoreVersion(sha) {
  if (!isLoggedIn) {
    showError("Please login first");
    return;
  }
  if (
    !confirm(
      "Restore this earlier version? It will replace the current data (the existing version stays in history and is not lost).",
    )
  )
    return;
  try {
    const r = await fetch(
      GITHUB_CONFIG.workerUrl + "?at=" + encodeURIComponent(sha),
    );
    if (!r.ok) throw new Error("HTTP " + r.status);
    const data = await r.json();
    DB = {};
    if (data.db) Object.keys(data.db).forEach((k) => (DB[k] = data.db[k]));
    if (data.sett) Object.assign(sett, data.sett);
    if (data.users) users = data.users;
    if (data.adminHash) ADMIN_HASH = data.adminHash;
    buildHist();
    renderAll();
    const ok = await saveToFirebase();
    if (ok) {
      showSuccess("Restored to selected version!");
      saveLS();
      loadCloudHistory(true);
    } else {
      showError("Restore loaded locally but cloud save failed", "warning");
    }
  } catch (e) {
    console.error("Restore failed:", e);
    showError("Restore failed: " + e.message);
  }
}

function saveLS() {
  if (!isLoggedIn) return false;

  const db = {};
  Object.keys(DB).forEach((k) => {
    db[k] = DB[k];
  });
  localStorage.setItem(LS, JSON.stringify({ db, sett, users, loggedIn }));
  setDirty(false);
  return true;
}

function doSave() {
  if (!isLoggedIn) {
    showLoginForm();
    return;
  }
  const restoreButton = showButtonLoading("save-button");
  const lsSuccess = saveLS();
  if (!lsSuccess) {
    restoreButton();
    showError("Login required to save data");
    return;
  }

  // Save to Firebase
  if (firebaseDb) {
    // Keep badge unsaved until cloud sync succeeds
    setDirty(true);
    saveToFirebase()
      .then((fbSuccess) => {
        if (fbSuccess) {
          setDirty(false);
        }
        restoreButton();
        showSuccess(
          fbSuccess
            ? "Saved to cloud at " +
                new Date().toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
            : "Saved to device only!",
          fbSuccess ? "check-circle" : "alert-triangle",
        );
      })
      .catch((err) => {
        restoreButton();
        // Keep dirty=true on error so user sees unsaved state
        showError("Failed to save: " + err.message);
      });
  } else {
    setDirty(false);
    setTimeout(() => {
      restoreButton();
      showSuccess("Data saved successfully!");
    }, 500);
  }
}

function showSuccess(message, iconName) {
  toast(message, "success", { icon: iconName });
}

function showInfo(message, iconName) {
  toast(message, "info", { icon: iconName });
}

function addClickFeedback(element) {
  element.addEventListener("click", function () {
    this.style.transform = "scale(0.95)";
    setTimeout(() => {
      this.style.transform = "";
    }, 150);
  });
}

function addHoverFeedback(elements) {
  elements.forEach((element) => {
    element.addEventListener("mouseenter", function () {
      this.style.transition = "all 0.2s ease";
    });
  });
}

function initializeVisualFeedback() {
  // Add click feedback to buttons
  const buttons = document.querySelectorAll(".tbtn, .btn, .mtab, .ntab");
  buttons.forEach(addClickFeedback);

  // Add hover feedback to interactive elements
  const interactiveElements = document.querySelectorAll(".card, .gc, .loc-blk");
  addHoverFeedback(interactiveElements);

  // Add ripple effect to buttons
  buttons.forEach((button) => {
    button.addEventListener("click", function (e) {
      const ripple = document.createElement("span");
      ripple.className = "ripple";
      ripple.style.left = e.clientX - this.offsetLeft + "px";
      ripple.style.top = e.clientY - this.offsetTop + "px";

      // Add ripple styles if not exists
      if (!document.querySelector("#ripple-styles")) {
        const style = document.createElement("style");
        style.id = "ripple-styles";
        style.textContent = `
                      .ripple {
                        position: absolute;
                        border-radius: 50%;
                        background: rgba(255, 255, 255, 0.6);
                        transform: scale(0);
                        animation: ripple 0.6s linear;
                        pointer-events: none;
                      }
                      @keyframes ripple {
                        to {
                          transform: scale(4);
                          opacity: 0;
                        }
                      }
                      .tbtn, .btn, .mtab, .ntab {
                        position: relative;
                        overflow: hidden;
                      }
                    `;
        document.head.appendChild(style);
      }

      this.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });
}

// ════════════════════════════════════════════════════
//  AUTO-SAVE FUNCTIONALITY
// ════════════════════════════════════════════════════
let autoSaveTimer = null;
let autoSaveEnabled = true; // Auto-saves AUTO_SAVE_DELAY after the last edit; startAutoSave() is called from setDirty(true)
const AUTO_SAVE_DELAY = 3000; // 3 seconds

function startAutoSave() {
  if (!autoSaveEnabled || !isLoggedIn) return;

  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (dirty) {
      performAutoSave();
    }
  }, AUTO_SAVE_DELAY);
}

function performAutoSave() {
  if (!isLoggedIn || !dirty) return;

  // Show subtle auto-save indicator
  showAutoSaveIndicator();

  // Save data locally
  const lsSuccess = saveLS();
  if (!lsSuccess) {
    hideAutoSaveIndicator();
    return;
  }

  // Also save to Firebase
  if (firebaseDb) {
    saveToFirebase()
      .then((fbSuccess) => {
        if (fbSuccess) {
          setDirty(false); // Only mark as saved if Firebase succeeded
        } else {
          console.warn("Auto-save to Firebase failed");
          // Keep dirty=true so user knows data not synced
        }
        setTimeout(() => {
          hideAutoSaveIndicator();
        }, 2000);
      })
      .catch((err) => {
        console.error("Auto-save error:", err);
        // Keep dirty=true on error
        setTimeout(() => {
          hideAutoSaveIndicator();
        }, 2000);
      });
  } else {
    // No Firebase, mark as saved locally
    setDirty(false);
    setTimeout(() => {
      hideAutoSaveIndicator();
    }, 2000);
  }
}

function showAutoSaveIndicator() {
  const badge = document.getElementById("sv-badge");
  badge.innerHTML = '<span class="mini-spinner"></span>Saving...';
  badge.className = "sv dirty";
}

function hideAutoSaveIndicator() {
  const badge = document.getElementById("sv-badge");
  // Show the actual state based on dirty flag
  if (dirty) {
    badge.innerHTML = icon("alert-triangle", 12) + " Unsaved";
    badge.className = "sv dirty";
  } else {
    badge.innerHTML = icon("check-circle", 12) + " Saved";
    badge.className = "sv ok";
  }
}

function ensureMonth(y, m) {
  const key = mk(y, m);
  if (DB[key]) return;
  const pk = m === 1 ? mk(y - 1, 12) : mk(y, m - 1);
  const prevRows = DB[pk] || [];
  let openBals;
  if (prevRows.length) {
    // Use the actual closing balances from last day of previous month
    const lastDay = prevRows[prevRows.length - 1];
    openBals = calcLocBals(lastDay.bal, lastDay.del, lastDay.imp);
  } else {
    openBals = LOCS.map(() => 0);
  }
  DB[key] = [];
  let locBals = [...openBals];
  for (let d = 1; d <= dIn(y, m); d++) {
    const ds = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (d === 1) {
      DB[key].push({
        date: ds,
        del: LOCS.map(() => 0),
        imp: LOCS.map(() => 0),
        bal: [...openBals],
        ob: [...openBals], // store original opening balance for transfer recalc
        al: "",
        av: "",
        rn: "",
      });
    } else {
      const prev = DB[key].slice(-1)[0];
      const newBals = calcLocBals(prev.bal, prev.del, prev.imp);
      DB[key].push({
        date: ds,
        del: LOCS.map(() => 0),
        imp: LOCS.map(() => 0),
        bal: newBals,
        al: "",
        av: "",
        rn: "",
      });
    }
  }
}

function recalcFrom(key, fi) {
  const rows = DB[key];
  if (!rows) return;
  // If starting from 0, do a full month recalc (restores ob + applies transfers)
  if (fi === 0) {
    fullRecalcMonth(key);
    return;
  }
  for (let i = fi; i < rows.length; i++) {
    if (i === 0) continue; // day 1 opening bal is kept (managed by fullRecalcMonth)
    const prev = rows[i - 1];
    rows[i].bal = calcLocBals(prev.bal, prev.del, prev.imp);
    applyTransfersToRow(rows[i]); // apply any transfers for this specific day
  }
}

// ════════════════════════════════════════════════════
//  CAR TRANSFER — core logic
// ════════════════════════════════════════════════════

/**
 * Apply stored transfers for a given date to the row's bal[] array.
 * Transfers increase the destination and decrease the source, leaving
 * Total Delivery and Total Import/Receive completely unchanged.
 */
function applyTransfersToRow(row) {
  const ts = (sett.transfers || {})[row.date] || [];
  ts.forEach((t) => {
    if (t.from >= 0 && t.from < LOCS.length)
      row.bal[t.from] = (row.bal[t.from] || 0) - t.qty;
    if (t.to >= 0 && t.to < LOCS.length)
      row.bal[t.to] = (row.bal[t.to] || 0) + t.qty;
  });
}

/**
 * Fully recalculates all balances for a month from scratch.
 * Restores day-1 from its stored ob (original opening balance),
 * then cascades through every day applying transfers along the way.
 */
function fullRecalcMonth(key) {
  const rows = DB[key];
  if (!rows || !rows.length) return;
  // Restore day-1 from stored original opening balance, then apply its transfers
  if (rows[0].ob) rows[0].bal = rows[0].ob.slice();
  applyTransfersToRow(rows[0]);
  // Recalc days 2+ with transfers
  for (let i = 1; i < rows.length; i++) {
    rows[i].bal = calcLocBals(
      rows[i - 1].bal,
      rows[i - 1].del,
      rows[i - 1].imp,
    );
    applyTransfersToRow(rows[i]);
  }
}

/**
 * After adding or removing a transfer, fully recalculates the given month
 * AND propagates the change to all subsequent months.
 */
function recalcTransferCascade(startMonthKey) {
  const allMonths = Object.keys(DB).sort();
  const startIdx = allMonths.indexOf(startMonthKey);
  if (startIdx < 0) return;

  // Fully recalc the starting month
  fullRecalcMonth(startMonthKey);

  // Propagate to subsequent months
  for (let i = startIdx + 1; i < allMonths.length; i++) {
    const prevRows = DB[allMonths[i - 1]];
    const currRows = DB[allMonths[i]];
    if (!prevRows || !prevRows.length || !currRows || !currRows.length)
      continue;

    const prevLast = prevRows[prevRows.length - 1];
    const newOpen = calcLocBals(prevLast.bal, prevLast.del, prevLast.imp);

    // Update day-1 of the current month
    currRows[0].ob = newOpen.slice();
    currRows[0].bal = newOpen.slice();
    applyTransfersToRow(currRows[0]);

    // Recalc the rest of the month
    for (let j = 1; j < currRows.length; j++) {
      currRows[j].bal = calcLocBals(
        currRows[j - 1].bal,
        currRows[j - 1].del,
        currRows[j - 1].imp,
      );
      applyTransfersToRow(currRows[j]);
    }
  }
}

/**
 * Adds a car transfer record and triggers balance recalculation.
 * Only the Balance column per location is affected — del[] and imp[] are untouched.
 */
function addCarTransfer(date, fromIdx, toIdx, qty, note) {
  requireLogin(() => {
    fromIdx = parseInt(fromIdx);
    toIdx = parseInt(toIdx);
    qty = parseInt(qty);

    if (!date) {
      showError("Please select a date.");
      return;
    }
    if (isNaN(fromIdx) || isNaN(toIdx)) {
      showError("Please select both locations.");
      return;
    }
    if (fromIdx === toIdx) {
      showError("Source and destination must be different locations.");
      return;
    }
    if (!qty || qty <= 0) {
      showError("Quantity must be greater than 0.");
      return;
    }
    if (qty > 9999) {
      showError("Quantity cannot exceed 9999.");
      return;
    }

    const monthKey = date.slice(0, 7);
    if (!DB[monthKey]) {
      showError(
        "No data found for " + date + ". Please generate the month first.",
      );
      return;
    }

    if (!sett.transfers) sett.transfers = {};
    if (!sett.transfers[date]) sett.transfers[date] = [];
    sett.transfers[date].push({
      from: fromIdx,
      to: toIdx,
      qty,
      note: (note || "").trim(),
    });

    recalcTransferCascade(monthKey);
    setDirty(true);
    renderTransferPage();
    renderAll();
    showSuccess(
      `Transfer recorded: ${qty} cars — ${LOCS[fromIdx]} → ${LOCS[toIdx]}`,
    );
  });
}

/**
 * Removes a transfer record by date + index and triggers balance recalculation.
 */
function removeCarTransfer(date, idx) {
  requireLogin(() => {
    if (!sett.transfers || !sett.transfers[date]) return;
    const t = sett.transfers[date][idx];
    if (!t) return;
    sett.transfers[date].splice(idx, 1);
    if (!sett.transfers[date].length) delete sett.transfers[date];

    recalcTransferCascade(date.slice(0, 7));
    setDirty(true);
    renderTransferPage();
    renderAll();
    showSuccess(
      `Transfer removed (${t.qty} cars — ${LOCS[t.from]} → ${LOCS[t.to]})`,
    );
  });
}

/**
 * Renders the Car Transfer page: a form to add transfers + a list of existing ones.
 */
function renderTransferPage() {
  const el = document.getElementById("page-transfer");
  if (!el) return;

  // Build location options for dropdowns
  const locOptions = LOCS.map((loc, i) => {
    const cfg = LOC_CFG[loc];
    return `<option value="${i}" style="background:${cfg.lt};color:${cfg.bg}">${loc}</option>`;
  }).join("");

  // Get today's date for default value
  const todayVal = TODAY || new Date().toLocaleDateString("en-CA");

  // ── Form section ─────────────────────────────────
  const form = `
    <div class="transfer-form-card">
      <div class="transfer-form-title">
        <span style="font-size:20px">${icon("truck", 20)}</span> Add Car Transfer
        <span style="font-size:11px;font-weight:500;color:#64748b;margin-left:auto">
          Moves cars between locations — only Balance column is affected
        </span>
      </div>

      <div class="transfer-form-grid">
        <div class="transfer-field">
          <label>${icon("calendar", 12)} Transfer Date</label>
          <span class="dmy-wrap">
            <input type="text" id="tr-date" class="dmy-text" placeholder="dd/mm/yyyy"
                   inputmode="numeric" maxlength="10" autocomplete="off"
                   oninput="dmyMask(this)" value="${isoToDMY(todayVal)}" />
            <input type="date" class="dmy-native" aria-label="Pick date" tabindex="-1"
                   value="${todayVal}" onclick="try{this.showPicker()}catch(e){}"
                   onchange="dmyPick(this,'tr-date')" />
          </span>
        </div>
        <div class="transfer-field">
          <label>${icon("hash", 12)} Number of Cars</label>
          <input type="number" id="tr-qty" min="1" max="9999" placeholder="e.g. 10" />
        </div>
        <div class="transfer-field">
          <label><span style="color:#dc2626">${icon("map-pin", 12)}</span> From Location</label>
          <select id="tr-from" onchange="renderTransferPreview()">${locOptions}</select>
        </div>
        <div class="transfer-field">
          <label><span style="color:#16a34a">${icon("map-pin", 12)}</span> To Location</label>
          <select id="tr-to" onchange="renderTransferPreview()">${locOptions}</select>
        </div>
      </div>

      <div class="transfer-arrow-row" id="tr-preview">
        <div class="transfer-loc-chip" id="tr-chip-from" style="border-color:#fca5a5;color:#b91c1c;background:#fee2e2">${LOCS[0]}</div>
        <div class="transfer-arrow-badge">→</div>
        <div class="transfer-loc-chip" id="tr-chip-to" style="border-color:#86efac;color:#166534;background:#dcfce7">${LOCS[1]}</div>
      </div>

      <div class="transfer-field" style="margin-bottom:14px">
        <label>${icon("message-square", 12)} Note (optional)</label>
        <input type="text" id="tr-note" placeholder="e.g. Repositioning for auction" maxlength="80" />
      </div>

      <button class="transfer-submit-btn" onclick="submitTransferForm()">
        <span>${icon("truck", 16)}</span> Record Transfer
      </button>
    </div>`;

  // ── Existing transfers list ───────────────────────
  const transfers = sett.transfers || {};
  const sortedDates = Object.keys(transfers).sort();

  let listHtml = "";
  if (!sortedDates.length) {
    listHtml = `<div class="transfer-empty-state">
      <div class="transfer-empty-icon">${icon("truck", 44)}</div>
      <p>No transfers recorded yet.<br>Use the form above to add one.</p>
    </div>`;
  } else {
    // Show most-recent dates first
    sortedDates.reverse().forEach((date) => {
      const dayTs = transfers[date];
      if (!dayTs || !dayTs.length) return;

      // Format date for display
      const [yr, mo, dy] = date.split("-");
      const dateObj = new Date(date + "T00:00:00");
      const dayName = DAYS[dateObj.getDay()];
      const displayDate = `${dayName}, ${dy}-${mo}-${yr}`;

      const items = dayTs
        .map((t, idx) => {
          const fromCfg = LOC_CFG[LOCS[t.from]] || {};
          const toCfg = LOC_CFG[LOCS[t.to]] || {};
          const noteHtml = t.note
            ? `<span class="transfer-item-note" title="${esc(t.note)}">${icon("message-square", 11)} ${esc(t.note)}</span>`
            : `<span class="transfer-item-note"></span>`;
          return `<div class="transfer-item">
          <span class="transfer-item-qty">${icon("truck", 12)} ${t.qty}</span>
          <span class="transfer-item-from" style="background:${fromCfg.lt || "#fee2e2"};color:${fromCfg.bg || "#b91c1c"};border-color:${fromCfg.bg || "#fca5a5"}">${LOCS[t.from] || "Loc " + esc(t.from)}</span>
          <span class="transfer-item-arrow">→</span>
          <span class="transfer-item-to" style="background:${toCfg.lt || "#dcfce7"};color:${toCfg.bg || "#166534"};border-color:${toCfg.bg || "#86efac"}">${LOCS[t.to] || "Loc " + esc(t.to)}</span>
          ${noteHtml}
          <button class="transfer-item-del" data-date="${esc(date)}" onclick="removeCarTransfer(this.dataset.date, ${idx})" title="Remove this transfer">${icon("x", 12)}</button>
        </div>`;
        })
        .join("");

      listHtml += `<div class="transfer-date-group">
        <div class="transfer-date-label">${icon("calendar", 12)} ${esc(displayDate)}</div>
        ${items}
      </div>`;
    });
  }

  const list = `
    <div class="transfer-list-card">
      <div class="transfer-list-title">
        <span style="font-size:20px">${icon("clipboard-list", 20)}</span> Transfer History
        <span style="font-size:11px;font-weight:500;color:#64748b;margin-left:auto">
          ${sortedDates.length ? sortedDates.length + " date(s) with transfers" : "No transfers yet"}
        </span>
      </div>
      ${listHtml}
    </div>`;

  el.innerHTML = `<div class="transfer-page-wrap" style="padding:10px 14px">${form}${list}</div>`;

  // Set the "to" dropdown default to index 1 so from≠to by default
  const toSel = document.getElementById("tr-to");
  if (toSel && toSel.options.length > 1) toSel.selectedIndex = 1;
  renderTransferPreview();
}

/**
 * Updates the live from→to preview chips when dropdowns change.
 */
function renderTransferPreview() {
  const fromSel = document.getElementById("tr-from");
  const toSel = document.getElementById("tr-to");
  if (!fromSel || !toSel) return;
  const fi = parseInt(fromSel.value);
  const ti = parseInt(toSel.value);

  const chipFrom = document.getElementById("tr-chip-from");
  const chipTo = document.getElementById("tr-chip-to");
  if (!chipFrom || !chipTo) return;

  const fromCfg = LOC_CFG[LOCS[fi]] || {};
  const toCfg = LOC_CFG[LOCS[ti]] || {};

  chipFrom.textContent = LOCS[fi] || "—";
  chipFrom.style.background = fromCfg.lt || "#fee2e2";
  chipFrom.style.color = fromCfg.bg || "#b91c1c";
  chipFrom.style.borderColor = fromCfg.bg || "#fca5a5";

  chipTo.textContent = LOCS[ti] || "—";
  chipTo.style.background = toCfg.lt || "#dcfce7";
  chipTo.style.color = toCfg.bg || "#166534";
  chipTo.style.borderColor = toCfg.bg || "#86efac";
}

/**
 * Reads the transfer form inputs and calls addCarTransfer().
 */
function submitTransferForm() {
  const date = dmyToISO(document.getElementById("tr-date")?.value || "");
  const fromIdx = document.getElementById("tr-from")?.value;
  const toIdx = document.getElementById("tr-to")?.value;
  const qty = document.getElementById("tr-qty")?.value;
  const note = document.getElementById("tr-note")?.value || "";
  addCarTransfer(date, fromIdx, toIdx, qty, note);
}

function summ(key) {
  const rows = DB[key] || [];
  if (!rows.length)
    return {
      bal: 0,
      del: 0,
      imp: 0,
      end: LOCS.map(() => 0),
      dl: LOCS.map(() => 0),
      il: LOCS.map(() => 0),
    };
  let td = 0,
    ti = 0;
  const dl = LOCS.map(() => 0),
    il = LOCS.map(() => 0);
  rows.forEach((r) => {
    const d = Array.isArray(r.del) ? r.del : LOCS.map(() => 0);
    const i = Array.isArray(r.imp) ? r.imp : LOCS.map(() => 0);
    d.forEach((v, j) => {
      if (j < LOCS.length) {
        td += v || 0;
        dl[j] += v || 0;
      }
    });
    i.forEach((v, j) => {
      if (j < LOCS.length) {
        ti += v || 0;
        il[j] += v || 0;
      }
    });
  });
  const last = rows.slice(-1)[0];
  const lastClosing = getClosing(last);
  return {
    bal: lastClosing,
    del: td,
    imp: ti,
    end: (Array.isArray(last.bal) ? last.bal : LOCS.map(() => 0)).slice(),
    dl,
    il,
  };
}

const months = () =>
  Object.keys(DB)
    .filter((k) => /^\d{4}-\d{2}$/.test(k))
    .sort();

// ════════════════════════════════════════════════════
//  AUTHENTICATION & SECURITY
// ════════════════════════════════════════════════════
const ADMIN_USER = "admin";
// SHA-256 of the default password ("admin"). Anyone still on the default
// gets a warning at login/startup — see warnIfDefaultPassword().
const ADMIN_DEFAULT_SHA256 =
  "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918";
let ADMIN_HASH = ADMIN_DEFAULT_SHA256; // Will be updated when password changes
let isLoggedIn = false;
let currentUser = null;

// Enhanced security functions
function hash(str) {
  // Simple hash function for demo (in production, use bcrypt/scrypt)
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

function validateInput(input, type = "text") {
  if (typeof input !== "string") return false;

  // Remove potentially dangerous characters
  const clean = input
    .trim()
    .replace(/[<>]/g, "") // Remove HTML tags
    .replace(/['"]/g, "") // Remove quotes
    .replace(/[;&]/g, ""); // Remove script separators

  if (type === "username") {
    return /^[a-zA-Z0-9_]{3,20}$/.test(clean);
  }
  if (type === "password") {
    return clean.length >= 8 && clean.length <= 50;
  }

  return clean.length > 0 && clean.length <= 100;
}

function sanitizeInput(input) {
  if (typeof input !== "string") return "";
  return input
    .trim()
    .replace(/[<>]/g, "")
    .replace(/['"]/g, "")
    .replace(/[;&]/g, "");
}

function showLoginForm() {
  const modal = document.createElement("div");
  modal.style.cssText = `
          position: fixed;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          background: rgba(0,0,0,0.5);
          display: flex;
          justify-content: center;
          align-items: center;
          z-index: 10000;
        `;

  modal.innerHTML = `
          <div style="background: white; padding: 30px; border-radius: 12px; box-shadow: 0 20px 25px -5px rgba(0,0,0,0.1); min-width: 400px;">
            <h3 style="margin: 0 0 20px 0; color: #1f2937; font-size: 18px; display:flex; align-items:center; gap:8px;">${icon("lock", 18)} Login Required</h3>
            <div style="margin-bottom: 15px;">
              <label style="display: block; margin-bottom: 5px; color: #374151; font-size: 14px; font-weight: 500;">Username:</label>
              <input type="text" id="login-username" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;" placeholder="Enter username">
            </div>
            <div style="margin-bottom: 20px;">
              <label style="display: block; margin-bottom: 5px; color: #374151; font-size: 14px; font-weight: 500;">Password:</label>
              <input type="password" id="login-password" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font-size: 14px;" placeholder="Enter password">
            </div>
            <div style="display: flex; gap: 10px; justify-content: flex-end;">
              <button onclick="this.closest('.login-modal').remove()" style="padding: 8px 16px; border: 1px solid #d1d5db; border-radius: 6px; background: white; color: #374151; cursor: pointer; font-size: 14px;">Cancel</button>
              <button onclick="submitLogin(this)" style="padding: 8px 16px; border: none; border-radius: 6px; background: #3b82f6; color: white; cursor: pointer; font-size: 14px;">Login</button>
            </div>
          </div>
        `;

  modal.className = "login-modal";
  document.body.appendChild(modal);

  // Focus on username field
  setTimeout(() => {
    document.getElementById("login-username").focus();
  }, 100);

  // Handle Enter key
  modal.addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      submitLogin(modal.querySelector('button[onclick="submitLogin(this)"]'));
    }
  });
}

function submitLogin(button) {
  const modal = button.closest(".login-modal");
  const username = document.getElementById("login-username").value.trim();
  const password = document.getElementById("login-password").value;

  if (!username || !password) {
    showError("Please enter both username and password");
    return;
  }

  modal.remove();
  doLoginSimple(username, password);
}

// Rate limiting for login attempts
let loginAttempts = 0;
let lastLoginAttempt = 0;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_TIME = 60000; // 1 minute lockout

function checkRateLimit() {
  const now = Date.now();
  if (loginAttempts >= MAX_LOGIN_ATTEMPTS) {
    if (now - lastLoginAttempt < LOCKOUT_TIME) {
      return true; // Still locked out
    }
    // Reset after lockout period
    loginAttempts = 0;
  }
  return false;
}

function recordFailedLogin() {
  loginAttempts++;
  lastLoginAttempt = Date.now();
}

function resetLoginAttempts() {
  loginAttempts = 0;
}

async function doLoginSimple(userid, password) {
  if (checkRateLimit()) {
    showError("Too many failed attempts. Please wait 1 minute.");
    return;
  }

  userid = sanitizeInput(userid);
  if (!validateInput(userid, "username")) {
    showError("Invalid username format");
    return;
  }

  if (await checkCred(userid, password)) {
    resetLoginAttempts();
    isLoggedIn = true;
    currentUser = userid;

    // Derive and store the cloud write key from the password so this device
    // can save without entering anything extra.
    writeAuth = await computeWriteAuth(password);
    localStorage.setItem("writeAuth", writeAuth);

    const sessionToken = crypto.randomUUID
      ? crypto.randomUUID()
      : "sess_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    localStorage.setItem("sessionToken", sessionToken);
    localStorage.setItem("isLoggedIn", "true");
    localStorage.setItem("currentUser", userid);
    localStorage.setItem("loginTime", Date.now().toString());

    showSuccess("Login successful! Refreshing...");
    updateLoginUI();

    setTimeout(() => {
      window.location.reload();
    }, 500);
  } else {
    recordFailedLogin();
    showError("Invalid credentials");
  }
}

function logout() {
  isLoggedIn = false;
  currentUser = null;
  localStorage.removeItem("isLoggedIn");
  localStorage.removeItem("currentUser");
  localStorage.removeItem("loginTime");
  localStorage.removeItem("sessionToken");
  localStorage.removeItem("writeAuth");
  writeAuth = null;
  showSuccess("Logged out successfully");
  renderAll();
}

function updateLoginUI() {
  document.getElementById("lock-info").textContent = isLoggedIn
    ? `Logged in: ${currentUser}`
    : "Not logged in — login to edit/save";

  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");

  if (loginBtn) {
    loginBtn.style.display = isLoggedIn ? "none" : "inline-block";
  }

  if (logoutBtn) {
    logoutBtn.style.display = isLoggedIn ? "inline-block" : "none";
  }
}

async function warnIfDefaultPassword() {
  // Checked by verifying "admin" against whatever format ADMIN_HASH is
  // currently in, rather than comparing to the bare-SHA-256
  // ADMIN_DEFAULT_SHA256 constant directly — checkCred() upgrades the
  // stored hash to the PBKDF2 format on login, so a string-equality check
  // against one specific old format would stop firing after the first
  // login, even though the password itself is still "admin".
  if (
    isLoggedIn &&
    currentUser === ADMIN_USER &&
    (await verifyAgainstStoredHash("admin", ADMIN_HASH))
  ) {
    showError(
      "You are using the default admin password. Change it now in Settings → Admin Password.",
      "warning",
    );
  }
}

function checkLoginStatus() {
  const savedLogin = localStorage.getItem("isLoggedIn");
  const savedUser = localStorage.getItem("currentUser");
  const loginTime = localStorage.getItem("loginTime");
  const sessionToken = localStorage.getItem("sessionToken");


  if (savedLogin === "true" && savedUser && loginTime && sessionToken) {
    const timeDiff = Date.now() - parseInt(loginTime);
    const maxSessionTime = 60 * 60 * 1000; // 1 hour


    // Any previously-logged-in user restores here, not just admin — this
    // check was never a real security boundary (the whole session is a
    // client-side localStorage flag either way), just an oversight that
    // logged named users out on every reload while admin stayed in.
    if (timeDiff < maxSessionTime) {
      isLoggedIn = true;
      currentUser = savedUser;
      return true;
    } else {
      logout();
    }
  }
  return false;
}

async function changeAdminPassword() {
  if (!isLoggedIn) {
    showError("Please login first");
    return;
  }

  const currentPass = document.getElementById("current-password").value;
  const newPass = document.getElementById("new-password").value;
  const confirmPass = document.getElementById("confirm-password").value;

  if (!(await verifyAgainstStoredHash(currentPass, ADMIN_HASH))) {
    showError("Current password is incorrect");
    return;
  }

  if (newPass.length < 8) {
    showError("New password must be at least 8 characters");
    return;
  }

  if (newPass !== confirmPass) {
    showError("New passwords do not match");
    return;
  }

  ADMIN_HASH = await hashPassword(newPass);
  localStorage.setItem("adminHash", ADMIN_HASH);

  // Rotate the cloud write key to the new password and push the change.
  // NOTE: also update the Worker's WRITE_PASSWORD secret to the new password,
  // otherwise future saves will be rejected.
  writeAuth = await computeWriteAuth(newPass);
  localStorage.setItem("writeAuth", writeAuth);

  if (firebaseDb && isLoggedIn) {
    saveToFirebase().then((ok) => {
      if (!ok) {
        showError(
          "Password changed locally. Update the Worker WRITE_PASSWORD secret to the new password to re-enable cloud save.",
          "warning",
        );
      }
    });
  }

  document.getElementById("current-password").value = "";
  document.getElementById("new-password").value = "";
  document.getElementById("confirm-password").value = "";

  showSuccess("Password changed successfully!");
}

// ════════════════════════════════════════════════════
//  AUTH  — must login to edit/save
// ════════════════════════════════════════════════════
function isAdmin(u) {
  return u === ADMIN_USER;
}
async function checkCred(u, p) {
  const stored = u === ADMIN_USER ? ADMIN_HASH : users[u];
  if (!stored) return false;
  if (!(await verifyAgainstStoredHash(p, stored))) return false;

  // Lazily upgrade to the strongest stored format on any successful login
  // that wasn't already using it (mirrors the pre-existing legacy→SHA-256
  // upgrade this replaces, just one tier stronger).
  if (!isPBKDF2Hash(stored)) {
    const upgraded = await hashPassword(p);
    if (u === ADMIN_USER) {
      ADMIN_HASH = upgraded;
      localStorage.setItem("adminHash", ADMIN_HASH);
    } else {
      users[u] = upgraded;
      saveLS();
    }
  }
  return true;
}

function requireLogin(cb) {
  if (isLoggedIn) {
    cb();
    return;
  }
  // Login always reloads the page on success (see doLoginSimple), which
  // wipes JS state — so there is no way to resume `cb` after the fact.
  // Just prompt; the user re-does the edit once logged in.
  showLoginForm();
}

// ════════════════════════════════════════════════════
//  USER MANAGEMENT  (max 3 + admin)
// ════════════════════════════════════════════════════
async function addUser() {
  if (!loggedIn || !isAdmin(loggedIn)) {
    showError("Admin login required.");
    return;
  }
  const u = document.getElementById("s-user").value.trim();
  const p = document.getElementById("s-pass").value;
  const p2 = document.getElementById("s-pass2").value;
  const err = document.getElementById("s-err");
  if (!u || !p) {
    err.textContent = "Both fields required.";
    err.style.display = "block";
    return;
  }
  if (p.length < 8) {
    err.textContent = "Password must be at least 8 characters.";
    err.style.display = "block";
    return;
  }
  if (p !== p2) {
    err.textContent = "Passwords do not match.";
    err.style.display = "block";
    return;
  }
  if (u === ADMIN_USER) {
    err.textContent = "Cannot override admin user.";
    err.style.display = "block";
    return;
  }
  if (Object.keys(users).length >= 3) {
    err.textContent = "Max 3 users reached (excluding admin).";
    err.style.display = "block";
    return;
  }
  err.style.display = "none";
  users[u] = await hashPassword(p);
  document.getElementById("ov-setup").classList.remove("on");
  document.getElementById("s-user").value = "";
  document.getElementById("s-pass").value = "";
  document.getElementById("s-pass2").value = "";
  saveLS();
  renderSettings();
  showSuccess(`User "${u}" added successfully.`);
}

// ════════════════════════════════════════════════════
//  UNDO
// ════════════════════════════════════════════════════
function pushUndo() {
  undoStack.push({ key: cur, data: JSON.parse(JSON.stringify(DB[cur])) });
  if (undoStack.length > 50) undoStack.shift();
}
function undoLast() {
  if (!undoStack.length) {
    alert("Nothing to undo.");
    return;
  }
  requireLogin(() => {
    const { key, data } = undoStack.pop();
    DB[key] = data;
    recalcFrom(key, 1);
    setDirty(true);
    renderAll();
  });
}

// ════════════════════════════════════════════════════
//  DATA VALIDATION & ERROR HANDLING
// ════════════════════════════════════════════════════
// validateNumber moved to src/formula.js.

function showError(message, type = "error") {
  toast(message, type === "error" ? "error" : "warning");
}

function validateAndShowError(input, fieldName, min = 0, max = 99999) {
  const validation = validateNumber(input.value, fieldName, min, max);

  if (!validation.isValid) {
    showError(validation.error);
    input.value = validation.value;
    input.style.borderColor = "#dc2626";
    input.style.backgroundColor = "#fee2e2";

    setTimeout(() => {
      input.style.borderColor = "";
      input.style.backgroundColor = "";
    }, 3000);
  }

  return validation.value;
}

// ════════════════════════════════════════════════════
//  INPUT HANDLERS  — require login
// ════════════════════════════════════════════════════
function onDel(key, ri, li, val) {
  requireLogin(() => {
    const validatedValue = validateAndShowError(
      { value: val },
      "Delivery",
      0,
      9999,
    );
    pushUndo();
    DB[key][ri].del[li] = validatedValue;
    recalcFrom(key, ri);
    setDirty(true);
    renderAll();
  });
}
function onImp(key, ri, li, val) {
  requireLogin(() => {
    const validatedValue = validateAndShowError(
      { value: val },
      "Receive",
      0,
      9999,
    );
    pushUndo();
    DB[key][ri].imp[li] = validatedValue;
    recalcFrom(key, ri);
    setDirty(true);
    renderAll();
  });
}
function onAuc(key, ri, f, val) {
  requireLogin(() => {
    // Validate auction location (should be text and reasonable length)
    if (f === "al" && val.length > 20) {
      showError("Auction location cannot exceed 20 characters");
      return;
    }
    // Validate auction value (should be a reasonable number)
    if (f === "av" && val) {
      const validatedValue = validateAndShowError(
        { value: val },
        "Auction Value",
        0,
        999999,
      );
      DB[key][ri][f] = validatedValue.toString();
    } else if (f === "ad" && val) {
      // Validate auction delivery (should be a reasonable number)
      const validatedValue = validateAndShowError(
        { value: val },
        "Auction Delivery",
        0,
        999999,
      );
      DB[key][ri][f] = validatedValue.toString();
    } else {
      DB[key][ri][f] = val;
    }
    setDirty(true);
  });
}
function editRotNo(td, key, ri) {
  if (td.querySelector("input")) return;
  requireLogin(() => {
    const saved = DB[key][ri].rn || "";
    td.innerHTML = `<input class="rot-edit" type="text" maxlength="30" value="${esc(saved)}" placeholder="Enter Rot No">`;
    const inp = td.querySelector("input");
    inp.focus();
    inp.select();
    const commit = () => {
      const val = inp.value.trim().slice(0, 30);
      DB[key][ri].rn = val;
      setDirty(true);
      td.innerHTML = val ? `<span class="rn-text">${esc(val)}</span>` : '<span class="rn-dash">—</span>';
    };
    inp.addEventListener("blur", commit);
    inp.addEventListener("keydown", (e) => {
      if (e.key === "Enter") inp.blur();
      if (e.key === "Escape") {
        td.innerHTML = saved ? `<span class="rn-text">${esc(saved)}</span>` : '<span class="rn-dash">—</span>';
      }
    });
  });
}


// ════════════════════════════════════════════════════
//  SETTINGS
// ════════════════════════════════════════════════════
function saveSett() {
  sett.fri = document.getElementById("cb-fri").checked;
  sett.sat = document.getElementById("cb-sat").checked;
  sett.sun = document.getElementById("cb-sun").checked;
  setDirty(true);

  // Update current date display when timezone changes
  updateCurrentDate();

  // Update today label
  const n = new Date();
  const todayInTz = n.toLocaleDateString("en-CA", { timeZone: sett.tz });
  document.getElementById("today-lbl").textContent = "Today: " + fmtDMY(todayInTz);

  renderTable();
  renderSumCards();
}
function addHol() {
  const el = document.getElementById("hol-date");
  const d = dmyToISO(el.value);
  if (!d) {
    alert("Please enter the date in dd/mm/yyyy format (e.g. 01/05/2026).");
    return;
  }
  if (!sett.hols.includes(d)) sett.hols.push(d);
  sett.excs = sett.excs.filter((x) => x !== d);
  el.value = "";
  setDirty(true);
  renderSettings();
  renderTable();
}
function addExc() {
  const el = document.getElementById("exc-date");
  const d = dmyToISO(el.value);
  if (!d) {
    alert("Please enter the date in dd/mm/yyyy format (e.g. 01/05/2026).");
    return;
  }
  if (!sett.excs.includes(d)) sett.excs.push(d);
  sett.hols = sett.hols.filter((x) => x !== d);
  el.value = "";
  setDirty(true);
  renderSettings();
  renderTable();
}
function renderSettings() {
  document.getElementById("cb-fri").checked = sett.fri;
  document.getElementById("cb-sat").checked = sett.sat;
  document.getElementById("cb-sun").checked = sett.sun;
  // Populate the Bangladesh holiday year dropdown: bundled years plus a rolling
  // window of future years (which auto-load the fixed national holidays).
  const bdSel = document.getElementById("bd-hol-year");
  if (bdSel) {
    const cur = new Date().getFullYear();
    const yset = new Set(Object.keys(BD_HOLIDAYS).map(Number));
    for (let y = cur - 1; y <= cur + 5; y++) yset.add(y);
    const years = [...yset].sort((a, b) => a - b);
    const keep = bdSel.value || String(cur);
    bdSel.innerHTML = years
      .map((y) => `<option value="${y}"${String(y) === keep ? " selected" : ""}>${y}</option>`)
      .join("");
  }
  const hl = document.getElementById("hol-list");
  hl.innerHTML = sett.hols.length
    ? sett.hols
        .sort()
        .map(
          (d) =>
            `<span class="htag">${esc(d)} <span style="cursor:pointer;color:#b91c1c;display:inline-flex;vertical-align:middle" data-d="${esc(d)}" onclick="sett.hols=sett.hols.filter(x=>x!==this.dataset.d);setDirty(true);renderSettings();renderTable();">${icon("x", 11)}</span></span>`,
        )
        .join("")
    : '<span style="color:#aaa;font-size:10px">None</span>';
  const el = document.getElementById("exc-list");
  el.innerHTML = sett.excs.length
    ? sett.excs
        .sort()
        .map(
          (d) =>
            `<span class="htag htag-g">${esc(d)} <span style="cursor:pointer;color:#166534;display:inline-flex;vertical-align:middle" data-d="${esc(d)}" onclick="sett.excs=sett.excs.filter(x=>x!==this.dataset.d);setDirty(true);renderSettings();renderTable();">${icon("x", 11)}</span></span>`,
        )
        .join("")
    : '<span style="color:#aaa;font-size:10px">None</span>';
  // User list
  const ul = document.getElementById("user-list");
  const all = [
    { u: ADMIN_USER, role: "Admin (master)" },
    ...Object.keys(users).map((u) => ({ u, role: "User" })),
  ];
  ul.innerHTML = all
    .map(
      (
        x,
      ) => `<div style="display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px solid #f0f0f0;font-size:11px">
          <span><b>${esc(x.u)}</b> <span style="color:#888;font-size:9px">${x.role}</span></span>
          ${x.role !== "Admin (master)" ? `<span style="cursor:pointer;color:#b91c1c;font-size:10px" data-u="${esc(x.u)}" onclick="delUser(this.dataset.u)">Remove</span>` : ""}
        </div>`,
    )
    .join("");
}
function delUser(u) {
  if (!loggedIn || !isAdmin(loggedIn)) {
    alert("Admin login required.");
    return;
  }
  delete users[u];
  saveLS();
  renderSettings();
}

// ════════════════════════════════════════════════════
//  MONTH BAR
// ═══════════════════════════════════════════════════════════════════════
function jumpToToday() {
  const n = new Date();
  ensureMonth(n.getFullYear(), n.getMonth() + 1);
  cur = mk(n.getFullYear(), n.getMonth() + 1);
  renderAll();
}

function onMbarSelect(val) {
  cur = val;
  renderAll();
}

function renderMbar() {
  const ms = months();
  const el = document.getElementById("mbar");
  const idx = ms.indexOf(cur);

  // Group months by year for the <optgroup>s
  const byYear = {};
  ms.forEach((k) => {
    const y = k.slice(0, 4);
    (byYear[y] = byYear[y] || []).push(k);
  });
  const optionsHtml = Object.keys(byYear)
    .sort()
    .map((y) => {
      const opts = byYear[y]
        .map((k) => {
          const m = Number(k.slice(5, 7));
          return `<option value="${k}"${k === cur ? " selected" : ""}>${MO[m - 1]} ${y}</option>`;
        })
        .join("");
      return `<optgroup label="${y}">${opts}</optgroup>`;
    })
    .join("");

  el.innerHTML = `
    <button class="mnav-btn" id="mbar-prev" type="button" title="Previous month" aria-label="Previous month"${idx <= 0 ? " disabled" : ""}>${icon("chevron-left", 16)}</button>
    <select class="mnav-select" id="mbar-select" aria-label="Jump to month">${optionsHtml}</select>
    <button class="mnav-btn" id="mbar-next" type="button" title="Next month" aria-label="Next month"${idx < 0 || idx >= ms.length - 1 ? " disabled" : ""}>${icon("chevron-right", 16)}</button>
    <button class="mnav-btn mnav-today" id="mbar-today" type="button" title="Jump to current month" aria-label="Jump to current month">${icon("calendar-clock", 14)} Today</button>
  `;
  document.getElementById("mbar-prev").onclick = () => navigateMonth(-1);
  document.getElementById("mbar-next").onclick = () => navigateMonth(1);
  document.getElementById("mbar-today").onclick = () => jumpToToday();
  document.getElementById("mbar-select").onchange = (e) => onMbarSelect(e.target.value);

  // Update login status
  document.getElementById("lock-info").textContent = isLoggedIn
    ? `Logged in: ${currentUser}`
    : "Not logged in — login to edit/save";

  // Show/hide login and logout buttons
  const loginBtn = document.getElementById("login-btn");
  const logoutBtn = document.getElementById("logout-btn");

  if (loginBtn) {
    loginBtn.style.display = isLoggedIn ? "none" : "inline-block";
  }

  if (logoutBtn) {
    logoutBtn.style.display = isLoggedIn ? "inline-block" : "none";
  }
}

// ════════════════════════════════════════════════════
//  SUMMARY CARDS
// ════════════════════════════════════════════════════
function renderSumCards() {
  const s = summ(cur);
  const ms = months();
  const idx = ms.indexOf(cur);
  const ps = idx > 0 ? summ(ms[idx - 1]) : null;
  const rows = DB[cur] || [];
  const sortedRows = rows.slice().sort((a, b) => a.date.localeCompare(b.date));
  const wDays = sortedRows.filter((r) => !isRed(r.date)).length;
  const aucDelTotal = sortedRows.reduce(
    (sum, row) => sum + (parseInt(row.av) || 0),
    0,
  );
  const net = s.imp - s.del;
  const ratio = s.imp ? Math.round((s.del / s.imp) * 100) : 0;
  const avgDel = wDays ? Math.round(s.del / wDays) : 0;
  const avgImp = wDays ? Math.round(s.imp / wDays) : 0;

  const formatMonthLabel = (monthKey) => {
    if (!monthKey) return "—";
    const [year, month] = monthKey.split("-").map(Number);
    const date = new Date(year, month - 1, 1);
    return date.toLocaleDateString("en-GB", {
      month: "long",
      year: "numeric",
    });
  };

  const totalForRow = (row, field) => {
    if (!row || !Array.isArray(row[field])) return 0;
    return row[field].reduce((acc, val) => acc + Number(val || 0), 0);
  };

  const prevMonthClose = ps ? fmt(ps.bal) : "—";
  const todayDate = TODAY;
  const rowsBeforeToday = sortedRows.filter((r) => r.date < todayDate);
  const nonRedBeforeToday = rowsBeforeToday.filter((r) => !isRed(r.date));
  const prevWorkingRow = nonRedBeforeToday.length
    ? nonRedBeforeToday[nonRedBeforeToday.length - 1]
    : null;
  const prevWorkDel = totalForRow(prevWorkingRow, "del");
  const prevWorkDate = prevWorkingRow ? fmtDMY(prevWorkingRow.date) : "—";
  const currentRow =
    sortedRows.find((r) => r.date === todayDate) ||
    sortedRows[sortedRows.length - 1] ||
    null;
  const prevDayIndex = currentRow ? sortedRows.indexOf(currentRow) - 1 : -1;
  const prevDay = prevDayIndex >= 0 ? sortedRows[prevDayIndex] : null;
  const prevDayReceive = totalForRow(prevDay, "imp");
  const prevDayDate = prevDay ? fmtDMY(prevDay.date) : "—";

  const card = (lbl, val, color, sub, hl = false) =>
    `<div class="card${hl ? " hl" : ""}">
            <div class="c-lbl">${lbl}</div>
            <div class="c-val" style="color:${color}">${val}</div>
            <div class="c-sub">${sub}</div>
          </div>`;

  let h = "";
  // 1. Historical Context
  h += card(
    "Prev Month Closing",
    prevMonthClose,
    "#1f2937",
    ps ? `as of ${formatMonthLabel(ms[idx - 1])}` : "No prev month",
  );
  // 2. Primary Operations
  h += card(
    "Total Delivery",
    fmt(s.del),
    "#1d4ed8",
    ps ? pBadge(s.del, ps.del, false) : "—",
  );
  h += card(
    "Total Receive",
    fmt(s.imp),
    "#92400e",
    ps ? pBadge(s.imp, ps.imp, true) : "—",
  );
  // 3. Current State (Highlighted)
  h += card(
    "Closing Balance",
    fmt(s.bal),
    "#166534",
    ps ? pBadge(s.bal, ps.bal) : "First month",
    true,
  );
  // 4. Recent Activity
  h += card(
    "Prev Working Day Delivery",
    fmt(prevWorkDel),
    "#1d4ed8",
    prevWorkingRow ? `${prevWorkDate}` : "No working day",
  );
  h += card(
    "Prev Day Receive",
    fmt(prevDayReceive),
    "#92400e",
    prevDay ? prevDayDate : "No previous day",
  );
  // 5. Performance & Derived Metrics
  h += card(
    "Net Stock Change",
    (net >= 0 ? "+" : "") + fmt(net),
    net > 0 ? "#92400e" : net < 0 ? "#166534" : "#555",
    net > 0 ? "Stock up" : net < 0 ? "Stock down" : "Balanced",
  );
  h += card(
    "Del/Rec Ratio",
    ratio + "%",
    ratio >= 100 ? "#166534" : ratio >= 75 ? "#92400e" : "#b91c1c",
    `${fmt(s.del)} of ${fmt(s.imp)}`,
  );
  h += card(
    "Avg Daily Del",
    fmt(avgDel),
    "#1d4ed8",
    `Avg Receive: ${fmt(avgImp)}/day`,
  );
  h += card("Auction Delivery", aucDelTotal, "#8b5cf6", "Monthly total");

  document.getElementById("sum-cards").innerHTML = h;
}

// ════════════════════════════════════════════════════
//  GROUP CARDS
// ════════════════════════════════════════════════════
function renderGrpCards() {
  const ms = months();
  const idx = ms.indexOf(cur);
  const rows = DB[cur] || [];
  const prevRows = idx > 0 ? DB[ms[idx - 1]] || [] : [];
  const last = rows.slice(-1)[0] || {
    bal: LOCS.map(() => 0),
    del: LOCS.map(() => 0),
    imp: LOCS.map(() => 0),
  };
  const prevLast = prevRows.slice(-1)[0] || { bal: LOCS.map(() => 0) };
  let h = "";
  GRP_SEC.forEach((g) => {
    h += `<div class="gc"><div class="gc-ttl" style="color:${g.bg};border-color:${g.bg}">${g.lbl}</div>`;
    g.lis.forEach((li) => {
      const loc = LOCS[li];
      const cfg = LOC_CFG[loc];
      const del = rows.reduce((s, r) => s + r.del[li], 0);
      const imp = rows.reduce((s, r) => s + r.imp[li], 0);
      const bal = last.bal[li];
      const pd = prevRows.reduce((s, r) => s + r.del[li], 0);
      const pi = prevRows.reduce((s, r) => s + r.imp[li], 0);
      const pb = prevLast.bal[li];
      const ratio = imp ? Math.round((del / imp) * 100) : 0;
      const gap = imp - del;
      h += `<div class="loc-blk" style="background:${cfg.lt}">
              <div class="loc-name" style="color:${cfg.bg}">${loc}</div>
              <div class="loc-st">
                <div><span class="ls-lbl">Closing Bal</span><span class="ls-val" style="color:#166534">${fmt(bal)} ${pBadge(bal, pb)}</span></div>
                <div><span class="ls-lbl">Delivery</span><span class="ls-val" style="color:#1d4ed8">${fmt(del)} ${pBadge(del, pd, false)}</span></div>
                <div><span class="ls-lbl">Receive</span><span class="ls-val" style="color:#92400e">${fmt(imp)} ${pBadge(imp, pi, true)}</span></div>
              </div>
              <div style="font-size:10px;margin-top:2px;display:flex;gap:8px">
                <span style="color:${ratio >= 75 ? "#166534" : "#b91c1c"}">D/R: <b>${ratio}%</b></span>
                <span style="color:${gap > 0 ? "#92400e" : "#166534"}">Gap: ${gap >= 0 ? "+" : ""}${fmt(gap)}</span>
              </div>
            </div>`;
    });
    h += "</div>";
  });
  document.getElementById("grp-cards").innerHTML = h;
}

// ════════════════════════════════════════════════════
//  MAIN TABLE  — no horizontal scroll, tight fit
// ════════════════════════════════════════════════════
function renderLocFilterChips() {
  const el = document.getElementById("loc-filter-row");
  if (!el) return;
  let h = `<span class="loc-filter-lbl">Show:</span>`;
  LOCS.forEach((loc, li) => {
    const cfg = LOC_CFG[loc];
    const on = locFilter[li] !== false;
    h += `<span class="loc-chip${on ? "" : " off"}" style="${on ? `background:${cfg.lt};color:${cfg.bg};border-color:${cfg.bg}` : ""}" onclick="toggleLocFilter(${li})" role="checkbox" aria-checked="${on}" tabindex="0" onkeydown="if(event.key===' '||event.key==='Enter'){event.preventDefault();toggleLocFilter(${li})}"><span class="dot" style="background:${cfg.bg}"></span>${loc}</span>`;
  });
  el.innerHTML = h;
}

// Recomputes the sticky top offsets for the two-row table header from the
// actual rendered height of the chrome above it (topbar+nav+mbar are also
// sticky, and their heights vary across breakpoints, so this can't be a
// fixed CSS constant).
function updateStickyTableOffsets() {
  const dailyPage = document.getElementById("page-daily");
  if (!dailyPage || !dailyPage.offsetParent) return; // hidden pages report 0 height
  const row1 = document.querySelector("#main-tbl thead tr:first-child");
  if (!row1) return;
  const row1H = row1.getBoundingClientRect().height;
  document.documentElement.style.setProperty("--tbl-row2-top", row1H + "px");
}

function renderTable() {
  const rows = DB[cur] || [];
  renderLocFilterChips();

  // Empty state check
  if (!rows || rows.length === 0) {
    document.getElementById("tbl-scroll").innerHTML =
      '<div style="text-align:center;padding:60px 20px;color:#64748b;background:#f8fafc;border-radius:12px;margin:20px;"><div style="margin-bottom:16px;display:flex;justify-content:center;color:#94a3b8">' +
      icon("clipboard-list", 48) +
      '</div><p style="font-size:16px;font-weight:600;margin-bottom:8px;">No data for this month</p><p style="font-size:13px;">Click "Generate Next Month" button or switch to another month</p></div>';
    renderDayCards();
    return;
  }

  // Preserve keyboard focus across the thead/tbody rebuild below — every
  // edit re-renders the whole table, which otherwise drops focus.
  const active = document.activeElement;
  let focusRestore = null;
  if (active && active.matches && active.matches("#main-tbl tbody input.ci")) {
    const tr = active.closest("tr");
    const tbody = tr && tr.parentElement;
    if (tbody) {
      focusRestore = {
        rowIndex: Array.from(tbody.children).indexOf(tr),
        col: active.dataset.col,
        selStart: active.selectionStart,
        selEnd: active.selectionEnd,
      };
    }
  }

  // ── Header ──────────────────────────────────────
  // Row 1: Date | Day | [loc colspan 3] × 8 | Total Delivery | Auc Val | Closing Balance | Total Import
  // Row 2:              [Bal | Del | Imp] × 8
  // NO gap between loc header and sub-headers — same background, borderless join

  let h1 = `<tr><th class="hdate" rowspan="2" scope="col">Date</th><th class="hday col-sep" rowspan="2" scope="col">Day</th>`;
  LOCS.forEach((loc, li) => {
    const cfg = LOC_CFG[loc];
    // Left border only at group start (WH-A, Yard-1, Shed-5)
    const gsp = li === 0 || li === 2 || li === 4 ? "gsp" : "";
    const hide = locFilter[li] === false ? " loc-hidden" : "";
    h1 += `<th class="${cfg.cls} ${gsp} no-gap${hide}" colspan="3" scope="colgroup" style="border-bottom:none">${loc}</th>`;
  });
  h1 += `<th class="thd gsp" rowspan="2" scope="col">Total<br>Delivery</th>
              <th class="tha"     rowspan="2" scope="col">Auction<br>Delivery</th>
              <th class="thcb gsp" rowspan="2" scope="col">Closing<br>Balance</th>
              <th class="thi gsp" rowspan="2" scope="col">Total<br>Import</th>
              <th class="thrn gsp" rowspan="2" scope="col">Rot<br>No</th></tr>`;

  // Row 2 sub-headers — SAME color as parent, NO top border gap
  let h2 = "<tr>";
  LOCS.forEach((loc, li) => {
    const cfg = LOC_CFG[loc];
    const gsp = li === 0 || li === 2 || li === 4 ? "gsp" : "";
    const hide = locFilter[li] === false ? " loc-hidden" : "";
    // Balance col: same bg, no-gap (connects seamlessly to row 1)
    h2 += `<th class="hsub ${cfg.cls} ${gsp} no-gap${hide}" scope="col" style="border-top:1px solid transparent">Balance</th>`;
    h2 += `<th class="hsub ${cfg.cls}${hide}" scope="col" style="border-top:1px solid transparent">Delivery</th>`;
    h2 += `<th class="hsub ${cfg.cls} col-sep${hide}" scope="col" style="border-top:1px solid transparent">Import</th>`;
  });
  h2 += "</tr>";

  // ── Body ─────────────────────────────────────────
  let body = "<tbody>";
  let fd = LOCS.map(() => 0),
    fi = LOCS.map(() => 0),
    fa = 0;

  rows.forEach((row, ri) => {
    const red = isRed(row.date);
    const it = row.date === TODAY;
    const cls = (red ? "red" : "") + (it ? " tod" : "");
    const dw = DAYS[new Date(row.date + "T00:00:00").getDay()];
    const tDel = row.del.reduce((a, b) => a + b, 0);
    const tImp = row.imp.reduce((a, b) => a + b, 0);
    const closing = getClosing(row);
    const aucVal = row.av ? parseInt(row.av) : 0;
    const prev = ri > 0 ? rows[ri - 1] : null;
    fa += aucVal;
    row.del.forEach((v, i) => (fd[i] += v));
    row.imp.forEach((v, i) => (fi[i] += v));

    let tr = `<tr class="${cls}" data-date="${row.date}">
            <td class="ddate">${fmtDMY(row.date)}</td>
            <td class="dday col-sep">${dw.slice(0, 3)}</td>`;

    let col = 0;
    LOCS.forEach((loc, li) => {
      const gsp = li === 0 || li === 2 || li === 4 ? "gsp" : "";
      const hide = locFilter[li] === false ? " loc-hidden" : "";
      const delChg = prev && prev.del[li] !== row.del[li] ? " chg" : "";
      const impChg = prev && prev.imp[li] !== row.imp[li] ? " chg" : "";
      // Opening balance (day 1) or calculated balance: same as regular days
      tr += `<td class="dbal ${gsp}${hide}">${row.bal[li]}</td>`;
      // Delivery and Import: always editable (require login on change)
      tr += `<td class="${hide.trim()}${delChg}"><input class="ci del" type="number" min="0" value="${row.del[li]}" data-col="${col++}" onchange="onDel('${cur}',${ri},${li},this.value)"></td>`;
      tr += `<td class="col-sep${hide}${impChg}"><input class="ci imp" type="number" min="0" value="${row.imp[li]}" data-col="${col++}" onchange="onImp('${cur}',${ri},${li},this.value)"></td>`;
    });

    tr += `<td class="tdel gsp">${tDel || "—"}</td>`;
    tr += `<td class="col-sep"><input class="ci auc" type="number" min="0" value="${row.av || 0}" data-col="${col++}" onchange="onAuc('${cur}',${ri},'av',this.value)" style="width:100%"></td>`;
    tr += `<td class="tcb gsp">${closing}</td>`;
    tr += `<td class="timp gsp">${tImp || "—"}</td>`;
    const rnVal = row.rn || "";
    tr += `<td class="trn gsp" title="Click to edit" onclick="editRotNo(this,'${cur}',${ri})">${rnVal ? `<span class="rn-text">${esc(rnVal)}</span>` : '<span class="rn-dash">—</span>'}</td>`;
    tr += "</tr>";
    body += tr;
  });

  // Footer
  const last = rows.slice(-1)[0] || {
    bal: LOCS.map(() => 0),
    del: LOCS.map(() => 0),
    imp: LOCS.map(() => 0),
  };
  const lastClosing = getClosing(last);
  const lastLocClosing = calcLocBals(last.bal, last.del, last.imp);
  let foot = `<tr class="foot"><td style="text-align:center;font-size:9px">TOTAL</td><td class="col-sep"></td>`;
  LOCS.forEach((loc, li) => {
    const gsp = li === 0 || li === 2 || li === 4 ? "gsp" : "";
    const csep = "col-sep";
    const hide = locFilter[li] === false ? " loc-hidden" : "";
    foot += `<td class="${gsp}${hide}" style="color:#1a3a5c;font-weight:700;font-size:10px">${lastLocClosing[li]}</td>`;
    foot += `<td class="${hide.trim()}" style="color:#1d4ed8;font-size:10px">${fd[li]}</td>`;
    foot += `<td class="${csep}${hide}" style="color:#92400e;font-size:10px">${fi[li]}</td>`;
  });
  const td2 = fd.reduce((a, b) => a + b, 0),
    ti2 = fi.reduce((a, b) => a + b, 0);
  const aucTotal = fa;
  foot += `<td class="gsp" style="color:#1d4ed8;font-size:12px">${td2 > 0 ? td2.toLocaleString() : "—"}</td>
               <td style="color:#7c3aed;font-size:14px;font-weight:700">${aucTotal > 0 ? aucTotal.toLocaleString() : "—"}</td>
               <td class="gsp" style="color:#166534;font-size:14px;font-weight:700">${lastClosing}</td>
               <td class="gsp" style="color:#92400e;font-size:12px">${ti2 > 0 ? ti2.toLocaleString() : "—"}</td>
               <td class="gsp"></td></tr>`;
  body += foot + "</tbody>";

  // Keep existing colgroup, just update thead/tbody
  const tbl = document.getElementById("main-tbl");
  // Remove old thead/tbody
  while (tbl.querySelector("thead")) tbl.querySelector("thead").remove();
  while (tbl.querySelector("tbody")) tbl.querySelector("tbody").remove();
  tbl.insertAdjacentHTML("beforeend", `<thead>${h1}${h2}</thead>${body}`);

  if (focusRestore) {
    const newTbody = tbl.querySelector("tbody");
    const newTr = newTbody && newTbody.children[focusRestore.rowIndex];
    const newInput =
      newTr && newTr.querySelector(`input.ci[data-col="${focusRestore.col}"]`);
    if (newInput) {
      newInput.focus();
      try {
        newInput.setSelectionRange(focusRestore.selStart, focusRestore.selEnd);
      } catch {}
    }
  }

  updateStickyTableOffsets();
  renderDayCards();
}

// Mobile stacked-card view of the same rows renderTable() draws — shown
// instead of the 31-column table below the .day-cards-bp breakpoint (see
// CSS). Reuses onDel/onImp/onAuc directly, so there is one write path for
// both views, not two.
function renderDayCards() {
  const container = document.getElementById("day-cards");
  if (!container) return;
  const rows = DB[cur] || [];

  if (!rows.length) {
    container.innerHTML =
      '<div class="day-cards-empty">' +
      icon("clipboard-list", 40) +
      "<p>No data for this month</p></div>";
    return;
  }

  let h = "";
  rows.forEach((row, ri) => {
    const red = isRed(row.date);
    const it = row.date === TODAY;
    const dw = DAYS[new Date(row.date + "T00:00:00").getDay()];
    const closing = getClosing(row);
    const tDel = row.del.reduce((a, b) => a + b, 0);
    const tImp = row.imp.reduce((a, b) => a + b, 0);

    h += `<div class="day-card${red ? " red" : ""}${it ? " tod" : ""}">
      <button type="button" class="day-card-hdr" onclick="this.closest('.day-card').classList.toggle('open')">
        <span class="day-card-date">${fmtDMY(row.date)} <span class="day-card-dow">${dw}</span></span>
        <span class="day-card-bal">${closing}</span>
        ${icon("chevron-down", 16, "day-card-chevron")}
      </button>
      <div class="day-card-body">
        <div class="day-card-summary">
          <div><span>Total Delivery</span><b>${tDel || "—"}</b></div>
          <div><span>Total Import</span><b>${tImp || "—"}</b></div>
          <div><span>Auction</span><b>${row.av || "—"}</b></div>
        </div>
        ${LOCS.map((loc, li) => {
          if (locFilter[li] === false) return "";
          const cfg = LOC_CFG[loc];
          return `<div class="day-card-loc" style="border-left-color:${cfg.bg}">
            <div class="day-card-loc-name" style="color:${cfg.bg}">${loc}</div>
            <div class="day-card-loc-row">
              <label>Balance<span class="day-card-static">${row.bal[li]}</span></label>
              <label>Delivery<input class="ci del" type="number" min="0" value="${row.del[li]}" onchange="onDel('${cur}',${ri},${li},this.value)"></label>
              <label>Import<input class="ci imp" type="number" min="0" value="${row.imp[li]}" onchange="onImp('${cur}',${ri},${li},this.value)"></label>
            </div>
          </div>`;
        }).join("")}
        <div class="day-card-loc" style="border-left-color:#7c3aed">
          <div class="day-card-loc-name" style="color:#7c3aed">Auction Delivery</div>
          <div class="day-card-loc-row">
            <label>Value<input class="ci auc" type="number" min="0" value="${row.av || 0}" onchange="onAuc('${cur}',${ri},'av',this.value)"></label>
          </div>
        </div>
      </div>
    </div>`;
  });
  container.innerHTML = h;
}

// Arrow-key navigation between editable cells in the daily table (Enter
// commits and moves down, like a spreadsheet). Delegated on #main-tbl so
// it survives renderTable()'s full thead/tbody rebuild.
function tableKeyNav(e) {
  const input = e.target;
  if (!input.classList || !input.classList.contains("ci")) return;
  const key = e.key;
  if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter"].includes(key))
    return;

  const isVisible = (el) => !!el && !!el.offsetParent;
  const tr = input.closest("tr");
  if (!tr) return;

  if (key === "ArrowLeft" || key === "ArrowRight") {
    const all = Array.from(
      document.querySelectorAll("#main-tbl tbody input.ci"),
    ).filter(isVisible);
    const idx = all.indexOf(input);
    const next = key === "ArrowLeft" ? all[idx - 1] : all[idx + 1];
    if (next) {
      e.preventDefault();
      next.focus();
      next.select();
    }
    return;
  }

  // ArrowUp / ArrowDown / Enter — move to the same column in the row above/below
  const col = input.dataset.col;
  const dir = key === "ArrowUp" ? -1 : 1;
  let targetRow = dir === -1 ? tr.previousElementSibling : tr.nextElementSibling;
  while (targetRow && !targetRow.querySelector(`input.ci[data-col="${col}"]`)) {
    targetRow = dir === -1 ? targetRow.previousElementSibling : targetRow.nextElementSibling;
  }
  const targetInput =
    targetRow && targetRow.querySelector(`input.ci[data-col="${col}"]`);
  if (isVisible(targetInput)) {
    e.preventDefault();
    targetInput.focus();
    targetInput.select();
  }
}
document.getElementById("main-tbl").addEventListener("keydown", tableKeyNav);
window.addEventListener("resize", updateStickyTableOffsets);

// ════════════════════════════════════════════════════
//  CHARTS
// ════════════════════════════════════════════════════
function killCharts() {
  ["c-trend", "c-cm-di", "c-cm-bal", "c-cmp", "c-loc", "c-loc-di", "c-net"].forEach((id) => {
    if (CH[id]) {
      try { CH[id].destroy(); } catch (e) { console.warn("Chart destroy failed:", id); }
      delete CH[id];
    }
  });
}
function safeChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el) {
    console.warn("Canvas missing:", canvasId);
    return null;
  }
  try {
    return new Chart(el, config);
  } catch (e) {
    console.error("Chart failed for", canvasId, e);
    return null;
  }
}

// Shows a "no activity" placeholder instead of an empty axis + dangling
// legend when a chart has nothing to plot. Returns true when the caller
// should skip building the chart.
function chartEmpty(canvasId, hasData, message) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return !hasData;
  const card = canvas.closest(".ch-card");
  let placeholder = card && card.querySelector(".ch-empty");
  if (hasData) {
    canvas.style.display = "";
    if (placeholder) placeholder.style.display = "none";
    return false;
  }
  canvas.style.display = "none";
  if (!placeholder && card) {
    placeholder = document.createElement("div");
    placeholder.className = "ch-empty";
    card.appendChild(placeholder);
  }
  if (placeholder) {
    placeholder.style.display = "flex";
    placeholder.innerHTML =
      `<div class="ch-empty-icon">${icon("bar-chart-3", 32)}</div>` +
      `<div class="ch-empty-msg">${esc(message)}</div>`;
  }
  return true;
}

function renderCharts(quiet) {
  if (!quiet) showLoading("Generating charts...");

  setTimeout(() => {
    try {
      killCharts();
      const ms = months();
    const lbls = ms.map((k) => {
      const [y, m] = k.split("-").map(Number);
      return MO[m - 1] + "'" + String(y).slice(2);
    });
    const ebs = ms.map((k) => summ(k).bal);
    const dels = ms.map((k) => summ(k).del);
    const imps = ms.map((k) => summ(k).imp);
    const nets = ms.map((k) => {
      const s = summ(k);
      return s.imp - s.del;
    });
    const cs = summ(cur);
    const cr = DB[cur] || [];

    const base = {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 2,
      animation: { duration: 600, easing: "easeInOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: false,
          position: "bottom",
          labels: { font: { size: 11 }, padding: 8, usePointStyle: true, pointStyle: "circle" },
        },
        tooltip: {
          backgroundColor: "rgba(31,41,55,0.95)",
          titleColor: "#fff", bodyColor: "#fff",
          borderColor: "#374151", borderWidth: 1, cornerRadius: 8,
          displayColors: true, padding: 12,
          titleFont: { size: 12, weight: "bold" }, bodyFont: { size: 11 },
          callbacks: {
            label: function (ctx) {
              let lbl = ctx.dataset.label || "";
              if (lbl) lbl += ": ";
              if (ctx.parsed.y !== null) lbl += ctx.parsed.y.toLocaleString();
              return lbl;
            },
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 }, color: "#6b7280" },
          title: { display: true, font: { size: 11, weight: "600" }, color: "#374151" },
        },
        y: {
          grid: { color: "rgba(229,231,235,0.5)", drawBorder: false },
          ticks: { font: { size: 10 }, color: "#6b7280" },
          title: { display: true, font: { size: 11, weight: "600" }, color: "#374151" },
        },
      },
    };

    const curM = cr.map((r) => parseInt(r.date.slice(8)));
    const curD = cr.map((r) => r.del.reduce((a, b) => a + b, 0));
    const curI = cr.map((r) => r.imp.reduce((a, b) => a + b, 0));
    const curB = cr.map((r) => getClosing(r));

    // 1. Current Month: Daily Receive vs Delivery
    CH["c-cm-di"] = chartEmpty(
      "c-cm-di",
      curD.some((v) => v > 0) || curI.some((v) => v > 0),
      "No delivery/receive activity this month",
    )
      ? null
      : safeChart("c-cm-di", {
      type: "bar",
      data: {
        labels: curM.map((d) => String(d)),
        datasets: [
          { label: "Receive", data: curI, backgroundColor: "rgba(239,68,68,0.75)", borderRadius: 3 },
          { label: "Delivery", data: curD, backgroundColor: "rgba(34,197,94,0.75)", borderRadius: 3 },
        ],
      },
      options: {
        ...base,
        plugins: {
          ...base.plugins,
          legend: { display: true, position: "top", labels: { font: { size: 10 }, padding: 10, usePointStyle: true, pointStyle: "rect" } },
        },
        scales: {
          ...base.scales,
          x: { ...base.scales.x, title: { ...base.scales.x.title, text: "Day" } },
          y: { ...base.scales.y, title: { ...base.scales.y.title, text: "Vehicles" }, beginAtZero: true },
        },
      },
    });

    // 2. Current Month: Daily Closing Balance
    CH["c-cm-bal"] = chartEmpty("c-cm-bal", cr.length > 0, "No data recorded for this month yet")
      ? null
      : safeChart("c-cm-bal", {
      type: "line",
      data: {
        labels: curM.map((d) => String(d)),
        datasets: [{
          label: "Closing Balance", data: curB,
          borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,0.1)",
          fill: true, tension: 0.25, pointRadius: cr.map((r) => (isRed(r.date) ? 4 : 2)),
          pointBackgroundColor: cr.map((r) => (isRed(r.date) ? "#ef4444" : "#3b82f6")),
          pointBorderColor: "#fff", pointBorderWidth: 2,
        }],
      },
      options: {
        ...base,
        scales: {
          ...base.scales,
          x: { ...base.scales.x, title: { ...base.scales.x.title, text: "Day" } },
          y: { ...base.scales.y, title: { ...base.scales.y.title, text: "Balance" } },
        },
      },
    });

    // 3. Month Comparison: Current vs Previous vs Same Month Last Year
    const [cy, cm] = cur.split("-").map(Number);
    const prevKey = cm > 1 ? mk(cy, cm - 1) : mk(cy - 1, 12);
    const lastYearKey = mk(cy - 1, cm);
    const hasPrev = DB[prevKey] && DB[prevKey].length;
    const hasLY = DB[lastYearKey] && DB[lastYearKey].length;
    const cmpLbls = ["Current"];
    const cmpDel = [cs.del];
    const cmpImp = [cs.imp];
    const cmpBal = [cs.bal];
    if (hasPrev) {
      const ps = summ(prevKey);
      const [, pm] = prevKey.split("-").map(Number);
      cmpLbls.push(MO[pm - 1] + " Prev");
      cmpDel.push(ps.del); cmpImp.push(ps.imp); cmpBal.push(ps.bal);
    }
    if (hasLY) {
      const lys = summ(lastYearKey);
      cmpLbls.push(MO[cm - 1] + " LY");
      cmpDel.push(lys.del); cmpImp.push(lys.imp); cmpBal.push(lys.bal);
    }
    CH["c-cmp"] = safeChart("c-cmp", {
      type: "bar",
      data: {
        labels: cmpLbls,
        datasets: [
          { label: "Receive", data: cmpImp, backgroundColor: "rgba(239,68,68,0.8)", borderRadius: 4 },
          { label: "Delivery", data: cmpDel, backgroundColor: "rgba(34,197,94,0.8)", borderRadius: 4 },
          { label: "Closing Balance", data: cmpBal, type: "line", borderColor: "#3b82f6", backgroundColor: "transparent",
            pointRadius: 5, pointBackgroundColor: "#3b82f6", tension: 0.2, yAxisID: "y1" },
        ],
      },
      options: {
        ...base,
        plugins: {
          ...base.plugins,
          legend: { display: true, position: "top", labels: { font: { size: 11 }, padding: 12, usePointStyle: true, pointStyle: "rect" } },
        },
        scales: {
          ...base.scales,
          x: { ...base.scales.x, title: { display: false } },
          y: { ...base.scales.y, title: { ...base.scales.y.title, text: "Deliveries / Receive" }, beginAtZero: true },
          y1: { position: "right", grid: { display: false }, ticks: { font: { size: 10 }, color: "#6b7280", callback: (v) => v.toLocaleString() },
            title: { display: true, text: "Closing Balance", font: { size: 11, weight: "600" }, color: "#3b82f6" } },
        },
      },
    });

    // 4. Location Closing Balance (horizontal bar)
    const lcols = LOCS.map((l) => LOC_CFG[l].bg);
    const locBals = LOCS.map((_, li) => {
      const last = cr.slice(-1)[0] || { bal: LOCS.map(() => 0) };
      return last.bal[li];
    });
    CH["c-loc"] = chartEmpty("c-loc", locBals.some((v) => v !== 0), "No location balances to show")
      ? null
      : safeChart("c-loc", {
      type: "bar",
      data: {
        labels: LOCS,
        datasets: [{ label: "Balance", data: locBals, backgroundColor: lcols, borderRadius: 4, borderWidth: 1, borderColor: "rgba(0,0,0,0.1)" }],
      },
      options: {
        ...base,
        indexAxis: "y",
        scales: {
          x: { ...base.scales.x, title: { ...base.scales.x.title, text: "Balance" }, beginAtZero: true, ticks: { ...base.scales.x.ticks, callback: (v) => v.toLocaleString() } },
          y: { ...base.scales.y, title: { display: false }, ticks: { font: { size: 9 }, color: "#374151" } },
        },
      },
    });

    // 5. Location Receive vs Delivery grouped bar
    const locDels = LOCS.map((_, li) => cr.reduce((s, r) => s + r.del[li], 0));
    const locImps = LOCS.map((_, li) => cr.reduce((s, r) => s + r.imp[li], 0));
    CH["c-loc-di"] = chartEmpty(
      "c-loc-di",
      locDels.some((v) => v > 0) || locImps.some((v) => v > 0),
      "No delivery/receive activity by location this month",
    )
      ? null
      : safeChart("c-loc-di", {
      type: "bar",
      data: {
        labels: LOCS,
        datasets: [
          { label: "Receive", data: locImps, backgroundColor: "rgba(239,68,68,0.7)", borderRadius: 3 },
          { label: "Delivery", data: locDels, backgroundColor: "rgba(34,197,94,0.7)", borderRadius: 3 },
        ],
      },
      options: {
        ...base,
        plugins: {
          ...base.plugins,
          legend: { display: true, position: "top", labels: { font: { size: 10 }, padding: 10, usePointStyle: true, pointStyle: "rect" } },
        },
        scales: {
          x: { ...base.scales.x, title: { display: false }, ticks: { font: { size: 9 }, color: "#374151" } },
          y: { ...base.scales.y, title: { ...base.scales.y.title, text: "Vehicles" }, beginAtZero: true },
        },
      },
    });

    // 6. Balance Trend (all months)
    CH["c-trend"] = safeChart("c-trend", {
      type: "line",
      data: {
        labels: lbls,
        datasets: [{
          label: "Closing Balance", data: ebs,
          borderColor: "#3b82f6", backgroundColor: "rgba(59,130,246,0.1)",
          fill: true, tension: 0.3, pointRadius: 4, pointHoverRadius: 6,
          pointBackgroundColor: "#3b82f6", pointBorderColor: "#fff", pointBorderWidth: 2,
        }],
      },
      options: {
        ...base,
        scales: {
          ...base.scales,
          x: { ...base.scales.x, ticks: { ...base.scales.x.ticks, maxTicksLimit: 12 } },
          y: { ...base.scales.y, title: { ...base.scales.y.title, text: "Balance" } },
        },
      },
    });

    // 7. Net Flow per month
    CH["c-net"] = safeChart("c-net", {
      type: "bar",
      data: {
        labels: lbls,
        datasets: [{
          label: "Net Change", data: nets,
          backgroundColor: nets.map((n) => (n >= 0 ? "rgba(239,68,68,0.8)" : "rgba(34,197,94,0.8)")),
          borderRadius: 3,
        }],
      },
      options: {
        ...base,
        scales: {
          x: { ...base.scales.x, title: { display: false }, ticks: { font: { size: 9 }, color: "#374151", maxTicksLimit: 8 } },
          y: { ...base.scales.y, title: { ...base.scales.y.title, text: "Net Change" } },
        },
      },
    });

    renderChartQuickStats(ms, cs);
    renderLocSummaryTable();

    const pl = document.getElementById("chart-period-lbl");
    if (pl) {
      pl.textContent = lbls.length + " months loaded";
    }

    if (quiet) hideSkeleton("page-chart");
    else hideLoading();
    } catch (e) {
      console.error("renderCharts error:", e);
      if (quiet) hideSkeleton("page-chart");
      else hideLoading();
      showErrorOverlay("Charts failed to render: " + e.message);
    }
  }, quiet ? 0 : 300);
}

function renderChartQuickStats(ms, cs) {
  const prevMs = ms.slice(-2)[0];
  const ps = prevMs ? summ(prevMs) : null;
  const ratio = cs.imp ? Math.round((cs.del / cs.imp) * 100) : 0;

  const card = (label, value, color, change, iconName) => `
    <div class="card" style="text-align:center;padding:14px 10px;border-left:4px solid ${color};background:#fff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.06)">
      <div style="color:${color};margin-bottom:2px;display:flex;justify-content:center">${icon(iconName, 18)}</div>
      <div class="c-lbl" style="font-size:9px;text-transform:uppercase;color:#6b7280;font-weight:600">${label}</div>
      <div class="c-val" style="font-size:20px;color:${color};font-weight:700">${typeof value === "number" ? value.toLocaleString() : value}</div>
      <div class="c-sub" style="font-size:9px;color:#9ca3af">${change}</div>
    </div>`;

  let h = "";
  h += card("Balance", cs.bal, "#166534", ps ? pBadge(cs.bal, ps.bal) : "—", "wallet");
  h += card("Delivery", cs.del, "#1d4ed8", ps ? pBadge(cs.del, ps.del, false) : "—", "arrow-up");
  h += card("Receive", cs.imp, "#92400e", ps ? pBadge(cs.imp, ps.imp, true) : "—", "arrow-down");
  h += card("D/R Ratio", ratio + "%", ratio <= 75 ? "#16a34a" : "#dc2626", ratio <= 75 ? "Good" : "High", "bar-chart-3");
  h += card("Net Change", cs.imp - cs.del >= 0 ? "+" + (cs.imp - cs.del) : cs.imp - cs.del, cs.imp - cs.del >= 0 ? "#16a34a" : "#dc2626", cs.imp - cs.del >= 0 ? "↗ Positive" : "↘ Negative", cs.imp - cs.del >= 0 ? "trending-up" : "trending-down");
  h += card("Work Days", DB[cur] ? DB[cur].filter((r) => !isRed(r.date)).length : 0, "#6366f1", ms.length + " months", "calendar");

  document.getElementById("chart-quick-stats").innerHTML = h;
}

function renderLocSummaryTable() {
  const rows = DB[cur] || [];
  if (!rows.length) {
    document.getElementById("loc-summary-table").innerHTML =
      "<div style='color:#94a3b8;text-align:center;padding:30px 10px;font-size:13px'>No data for this month</div>";
    return;
  }

  let h = `<table style="width:100%;font-size:11px;border-collapse:collapse">
    <thead><tr style="background:#f8fafc;border-bottom:2px solid #e2e8f0">
      <th style="padding:6px 8px;text-align:left;color:#64748b;font-weight:600;font-size:10px">Location</th>
      <th style="padding:6px 6px;text-align:right;color:#64748b;font-weight:600;font-size:10px">Balance</th>
      <th style="padding:6px 6px;text-align:right;color:#64748b;font-weight:600;font-size:10px">Del</th>
      <th style="padding:6px 6px;text-align:right;color:#64748b;font-weight:600;font-size:10px">Rec</th>
      <th style="padding:6px 6px;text-align:right;color:#64748b;font-weight:600;font-size:10px">D/R</th>
    </tr></thead><tbody>`;

  LOCS.forEach((loc, li) => {
    const cfg = LOC_CFG[loc];
    const del = rows.reduce((s, r) => s + r.del[li], 0);
    const imp = rows.reduce((s, r) => s + r.imp[li], 0);
    const last = rows.slice(-1)[0];
    const bal = last ? last.bal[li] : 0;
    const ratio = imp ? Math.round((del / imp) * 100) : 0;
    const color = ratio <= 75 ? "#16a34a" : ratio <= 100 ? "#d97706" : "#dc2626";

    h += `<tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:5px 8px;font-weight:600;color:${cfg.bg};font-size:10px"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${cfg.bg};margin-right:5px"></span>${loc}</td>
      <td style="padding:5px 6px;text-align:right;font-weight:700;color:#1f2937;font-size:10px">${bal.toLocaleString()}</td>
      <td style="padding:5px 6px;text-align:right;font-weight:500;color:#3b82f6;font-size:10px">${del.toLocaleString()}</td>
      <td style="padding:5px 6px;text-align:right;font-weight:500;color:#d97706;font-size:10px">${imp.toLocaleString()}</td>
      <td style="padding:5px 6px;text-align:right;font-weight:700;color:${color};font-size:10px">${ratio}%</td>
    </tr>`;
  });

  h += "</tbody></table>";
  document.getElementById("loc-summary-table").innerHTML = h;
}

// ════════════════════════════════════════════════════
//  REPORT
// ════════════════════════════════════════════════════
// ════════════════════════════════════════════════════
//  REPORT FILTER HELPERS
// ════════════════════════════════════════════════════

function getFilteredMonths() {
  const all = months();
  if (!all.length) return [];
  const from = reportFilter.from || all[0];
  const to = reportFilter.to || all[all.length - 1];
  const filtered = all.filter((k) => k >= from && k <= to);
  return filtered.length ? filtered : [all[all.length - 1]];
}

function getCompareKey() {
  if (reportFilter.compare === "none" || !rptMs.length) return null;
  if (reportFilter.compare === "prev-year") {
    const [y, m] = rptFocus.split("-").map(Number);
    const k = mk(y - 1, m);
    return DB[k] && DB[k].length ? k : null;
  }
  // prev-period: the month immediately before the selected range
  const all = months();
  const fromIdx = all.indexOf(rptMs[0]);
  return fromIdx > 0 ? all[fromIdx - 1] : null;
}

function getCompareSumm() {
  const k = getCompareKey();
  return k ? summ(k) : null;
}

function buildFilterMonthOptions() {
  const all = months();
  if (!all.length) return;
  const fromSel = document.getElementById("rpt-from-sel");
  const toSel = document.getElementById("rpt-to-sel");
  if (!fromSel || !toSel) return;
  const opts = all
    .slice()
    .reverse()
    .map((k) => {
      const [y, m] = k.split("-").map(Number);
      return `<option value="${k}" ${k === (reportFilter.from || all[all.length - 1]) ? "selected" : ""}>${MO[m - 1]} ${y}</option>`;
    })
    .join("");
  const optsTo = all
    .slice()
    .reverse()
    .map((k) => {
      const [y, m] = k.split("-").map(Number);
      return `<option value="${k}" ${k === (reportFilter.to || all[all.length - 1]) ? "selected" : ""}>${MO[m - 1]} ${y}</option>`;
    })
    .join("");
  fromSel.innerHTML = opts;
  toSel.innerHTML = optsTo;
}

function updateFilterPresetButtons() {
  document.querySelectorAll(".rpt-preset").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.preset === reportFilter.preset);
  });
  const radios = document.querySelectorAll('input[name="rpt-cmp"]');
  radios.forEach((r) => { if (r.value === reportFilter.compare) r.checked = true; });
}

function updateFilterStatus() {
  const badge = document.getElementById("rpt-filter-badge");
  if (!badge || !rptMs.length) return;

  const labels = {
    "this-month": "This Month", "last-month": "Last Month", "3m": "3 Months",
    "6m": "6 Months", "ytd": "Year to Date", "12m": "12 Months",
    "all": "All Time", "custom": "Custom Range",
  };
  badge.textContent = labels[reportFilter.preset] || "Custom";
}

function applyReportPreset(preset) {
  const all = months();
  if (!all.length) return;
  const latest = all[all.length - 1];
  const [ly, lm] = latest.split("-").map(Number);
  reportFilter.preset = preset;

  switch (preset) {
    case "this-month":
      reportFilter.from = reportFilter.to = latest;
      break;
    case "last-month": {
      const d = new Date(ly, lm - 2, 1);
      const k = mk(d.getFullYear(), d.getMonth() + 1);
      reportFilter.from = reportFilter.to = all.includes(k) ? k : latest;
      break;
    }
    case "3m": {
      const d = new Date(ly, lm - 3, 1);
      reportFilter.from = mk(d.getFullYear(), d.getMonth() + 1);
      reportFilter.to = latest;
      break;
    }
    case "6m": {
      const d = new Date(ly, lm - 6, 1);
      reportFilter.from = mk(d.getFullYear(), d.getMonth() + 1);
      reportFilter.to = latest;
      break;
    }
    case "ytd":
      reportFilter.from = mk(ly, 1);
      reportFilter.to = latest;
      break;
    case "12m": {
      const d = new Date(ly, lm - 12, 1);
      reportFilter.from = mk(d.getFullYear(), d.getMonth() + 1);
      reportFilter.to = latest;
      break;
    }
    case "all":
      reportFilter.from = all[0];
      reportFilter.to = latest;
      break;
  }
  renderReport();
}

function applyReportCustomRange() {
  const from = document.getElementById("rpt-from-sel")?.value;
  const to = document.getElementById("rpt-to-sel")?.value;
  if (!from || !to) return;
  reportFilter.from = from <= to ? from : to;
  reportFilter.to = from <= to ? to : from;
  reportFilter.preset = "custom";
  renderReport();
}

function onCustomRangeChange() {
  applyReportCustomRange();
}

function renderReport(quiet) {
  if (!quiet) showLoading("Generating reports...");

  setTimeout(() => {
    try {
    const allMs = months();

    // Init filter on first render
    if (!reportFilter.from && allMs.length) {
      reportFilter.from = reportFilter.to = allMs[allMs.length - 1];
    }

    buildFilterMonthOptions();
    updateFilterPresetButtons();

    rptMs = getFilteredMonths();
    if (!rptMs.length && allMs.length) rptMs = [allMs[allMs.length - 1]];
    rptFocus = rptMs[rptMs.length - 1] || cur;

    const ms = rptMs;
    const compareKey = getCompareKey();
    const cs = summ(rptFocus);
    const ps = compareKey ? summ(compareKey) : null;

    // Header: show selected range
    const now = new Date();
    const [fy, fm] = rptMs[0].split("-").map(Number);
    const [ty, tm] = rptFocus.split("-").map(Number);
    const periodEl = document.getElementById("report-period-display");
    if (periodEl) periodEl.textContent =
      ms.length === 1
        ? `${MO[tm - 1]} ${ty}`
        : `${MO[fm - 1]} ${fy} — ${MO[tm - 1]} ${ty}`;
    const genEl = document.getElementById("report-generated");
    if (genEl) genEl.textContent = "Generated: " + fmtDMY(now.toLocaleDateString("en-CA", { timeZone: sett.tz }));

    // Column labels for comparison tables
    const currLbl = `${MO[tm - 1]} ${ty}`;
    const prevLbl = compareKey
      ? (() => { const [py, pm] = compareKey.split("-").map(Number); return `${MO[pm - 1]} ${py}`; })()
      : "Compare";

    // --- Location vs Compare Period (locH) ---
    let locH = `<div class="simple-table-container"><table class="simple-table">
              <thead><tr>
                <th style="text-align:left">${icon("map-pin", 12)} Location</th>
                <th>${currLbl}<br>Receive</th><th>${prevLbl}<br>Receive</th><th>Recv Change</th>
                <th>${currLbl}<br>Delivery</th><th>${prevLbl}<br>Delivery</th><th>Del Change</th>
              </tr></thead><tbody>`;

    LOCS.forEach((loc, i) => {
      let cI = 0, cD = 0;
      rptMs.forEach((k) => {
        (DB[k] || []).forEach((r) => {
          cI += r.imp[i] || 0;
          cD += r.del[i] || 0;
        });
      });
      const pI = compareKey ? (DB[compareKey] || []).reduce((s, r) => s + (r.imp[i] || 0), 0) : 0;
      const pD = compareKey ? (DB[compareKey] || []).reduce((s, r) => s + (r.del[i] || 0), 0) : 0;
      const iDiff = cI - pI, dDiff = cD - pD;
      const iPct = pI > 0 ? Math.round((iDiff / pI) * 100) : cI > 0 ? 100 : 0;
      const dPct = pD > 0 ? Math.round((dDiff / pD) * 100) : cD > 0 ? 100 : 0;
      locH += `<tr>
        <td class="month" style="text-align:left;font-weight:700">${loc}</td>
        <td style="color:#92400e;font-weight:700;font-size:13px">${fmt(cI)}</td>
        <td style="color:#64748b;font-size:12px">${compareKey ? fmt(pI) : "—"}</td>
        <td style="font-weight:700"><span style="color:${iDiff >= 0 ? "#16a34a" : "#dc2626"};font-size:11px">${iDiff >= 0 ? "+" : ""}${fmt(iDiff)}</span><br><span style="font-size:10px;color:${iPct >= 0 ? "#16a34a" : "#dc2626"}">(${iPct >= 0 ? "↑" : "↓"}${Math.abs(iPct)}%)</span></td>
        <td style="color:#1d4ed8;font-weight:700;font-size:13px">${fmt(cD)}</td>
        <td style="color:#64748b;font-size:12px">${compareKey ? fmt(pD) : "—"}</td>
        <td style="font-weight:700"><span style="color:${dDiff >= 0 ? "#16a34a" : "#dc2626"};font-size:11px">${dDiff >= 0 ? "+" : ""}${fmt(dDiff)}</span><br><span style="font-size:10px;color:${dPct >= 0 ? "#16a34a" : "#dc2626"}">(${dPct >= 0 ? "↑" : "↓"}${Math.abs(dPct)}%)</span></td>
      </tr>`;
    });

    let tCI = 0, tCD = 0;
    rptMs.forEach((k) => {
      (DB[k] || []).forEach((r) => {
        tCI += r.imp.reduce((a, b) => a + b, 0);
        tCD += r.del.reduce((a, b) => a + b, 0);
      });
    });
    const tPI = compareKey ? (DB[compareKey] || []).reduce((s, r) => s + r.imp.reduce((a, b) => a + b, 0), 0) : 0;
    const tPD = compareKey ? (DB[compareKey] || []).reduce((s, r) => s + r.del.reduce((a, b) => a + b, 0), 0) : 0;
    const tiD = tCI - tPI, tdD = tCD - tPD;
    const tiPct = tPI > 0 ? Math.round((tiD / tPI) * 100) : 0;
    const tdPct = tPD > 0 ? Math.round((tdD / tPD) * 100) : 0;
    locH += `<tr style="background:#f1f5f9;font-weight:700">
      <td class="month" style="text-align:left">${icon("bar-chart-3", 11)} TOTAL</td>
      <td style="color:#92400e;font-size:14px">${fmt(tCI)}</td>
      <td style="color:#64748b">${compareKey ? fmt(tPI) : "—"}</td>
      <td style="color:${tiD >= 0 ? "#16a34a" : "#dc2626"}">${tiD >= 0 ? "+" : ""}${fmt(tiD)} (${tiPct >= 0 ? "↑" : "↓"}${Math.abs(tiPct)}%)</td>
      <td style="color:#1d4ed8;font-size:14px">${fmt(tCD)}</td>
      <td style="color:#64748b">${compareKey ? fmt(tPD) : "—"}</td>
      <td style="color:${tdD >= 0 ? "#16a34a" : "#dc2626"}">${tdD >= 0 ? "+" : ""}${fmt(tdD)} (${tdPct >= 0 ? "↑" : "↓"}${Math.abs(tdPct)}%)</td>
    </tr>`;
    locH += "</tbody></table></div>";

    // --- Monthly Trend Table (filtered range) ---
    let monthlyH = `<div class="simple-table-container"><table class="simple-table">
      <thead><tr><th>Month</th><th>Receive</th><th>Delivery</th><th>Balance</th><th>Efficiency</th></tr></thead>
      <tbody>`;
    ms.slice().reverse().forEach((k) => {
      const s = summ(k);
      const [y, m] = k.split("-").map(Number);
      const eff = s.imp ? Math.round((s.del / s.imp) * 100) : 0;
      const effCls = eff >= 100 ? "excellent" : eff >= 75 ? "good" : "poor";
      monthlyH += `<tr class="${k === rptFocus ? "current" : ""}">
        <td class="month">${MO[m - 1]} ${y}</td>
        <td class="receive">${fmt(s.imp)}</td>
        <td class="delivery">${fmt(s.del)}</td>
        <td class="balance">${fmt(s.bal)}</td>
        <td><span class="efficiency ${effCls}">${eff}%</span></td>
      </tr>`;
    });
    monthlyH += "</tbody></table></div>";
    document.getElementById("rpt-monthly").innerHTML = monthlyH;

    // --- Location Performance Cards (range aggregate) ---
    let locationH = `<div class="location-grid">`;
    LOCS.forEach((loc, li) => {
      let locDel = 0, locImp = 0;
      rptMs.forEach((k) => {
        (DB[k] || []).forEach((r) => {
          locDel += r.del[li] || 0;
          locImp += r.imp[li] || 0;
        });
      });
      const locRatio = locImp ? Math.round((locDel / locImp) * 100) : 0;
      const cfg = LOC_CFG[loc];
      locationH += `<div class="location-card">
        <div class="location-header" style="background:${cfg.bg}">${loc}</div>
        <div class="location-metrics">
          <div class="metric"><span class="metric-label">Delivery</span><span class="metric-value" style="color:#1d4ed8">${fmt(locDel)}</span></div>
          <div class="metric"><span class="metric-label">Receive</span><span class="metric-value" style="color:#92400e">${fmt(locImp)}</span></div>
          <div class="metric"><span class="metric-label">D/R Ratio</span><span class="metric-value ${locRatio <= 75 ? "excellent" : "poor"}">${locRatio}%</span></div>
        </div>
      </div>`;
    });
    locationH += "</div>";
    document.getElementById("rpt-location").innerHTML = locationH;
    document.getElementById("rpt-loccompare").innerHTML = locH;

    rptExecutive();
    document.getElementById("rpt-daily-log").innerHTML = rptDailyLog();
    document.getElementById("rpt-group").innerHTML = rptGroup();
    document.getElementById("rpt-ranking").innerHTML = rptRanking();
    document.getElementById("rpt-peak").innerHTML = rptPeak();
    document.getElementById("rpt-flow").innerHTML = rptFlow();
    document.getElementById("rpt-dow").innerHTML = rptDow();
    document.getElementById("rpt-transfers").innerHTML = rptTransfers();
    document.getElementById("rpt-yoy").innerHTML = rptYoY();
    document.getElementById("rpt-auction").innerHTML = renderAuctionReport();

    updateFilterStatus();
    if (quiet) hideSkeleton("page-report");
    else hideLoading();
    } catch (e) {
      console.error("renderReport error:", e);
      if (quiet) hideSkeleton("page-report");
      else hideLoading();
      showErrorOverlay("Report generation failed: " + e.message);
    }
  }, quiet ? 0 : 300);
}

function toggleRptSection(id) {
  const sec = document.getElementById(id);
  if (!sec) return;
  const wasCollapsed = sec.classList.toggle("collapsed");
  const arrow = sec.querySelector(".rpt-sec-arrow");
  if (arrow) arrow.textContent = wasCollapsed ? "▾" : "▴";
}

// ════════════════════════════════════════════════════
//  REPORT SECTION RENDERERS  (all use rptMs / rptFocus)
// ════════════════════════════════════════════════════

function rptExecutive() {
  const allRows = [];
  rptMs.forEach((k) => { (DB[k] || []).forEach((r) => allRows.push(r)); });
  const workDays = allRows.filter((r) => !isRed(r.date)).length;
  const holDays = allRows.filter((r) => isRed(r.date)).length;
  let totDel = 0, totImp = 0, totBal = 0, totAuc = 0;
  rptMs.forEach((k) => {
    const s = summ(k);
    totDel += s.del;
    totImp += s.imp;
    totBal = s.bal;
  });
  allRows.forEach((r) => { totAuc += parseInt(r.av) || 0; });
  const aucShare = (totDel + totAuc) > 0 ? Math.round(totAuc / (totDel + totAuc) * 100) : 0;
  const aucDays = allRows.filter((r) => (parseInt(r.av) || 0) > 0).length;

  const avgDelWD = workDays > 0 ? Math.round(totDel / workDays) : 0;
  const avgRecWD = workDays > 0 ? Math.round(totImp / workDays) : 0;
  const net = totImp - totDel;
  const eff = totImp > 0 ? Math.round((totDel / totImp) * 100) : 0;
  const effColor = eff >= 100 ? "#16a34a" : eff >= 75 ? "#d97706" : "#dc2626";
  const ps = getCompareSumm();

  const kpi = (iconName, val, lbl, color, sub) =>
    `<div class="rpt-kpi-card" style="border-top:3px solid ${color}">
      <div class="rpt-kpi-icon" style="color:${color}">${icon(iconName, 20)}</div>
      <div class="rpt-kpi-val" style="color:${color}">${val}</div>
      <div class="rpt-kpi-lbl">${lbl}</div>
      ${sub ? `<div class="rpt-kpi-sub">${sub}</div>` : ""}
    </div>`;

  document.getElementById("rpt-executive").innerHTML = `
    <div class="rpt-kpi-grid">
      ${kpi("arrow-down", fmt(totImp), "Total Receive", "#dc2626", ps ? "Compare: " + fmt(ps.imp) : "")}
      ${kpi("arrow-up", fmt(totDel), "Total Delivery", "#2563eb", ps ? "Compare: " + fmt(ps.del) : "")}
      ${kpi("car", fmt(totAuc), "Auction Deliveries", "#ea580c", aucShare + "% of total · " + aucDays + " active days")}
      ${kpi("package", fmt(totBal), "Closing Balance", "#059669", "End-of-period stock")}
      ${kpi("zap", eff + "%", "Delivery Efficiency", effColor, "Delivery ÷ Receive")}
      ${kpi(net >= 0 ? "trending-up" : "trending-down", (net >= 0 ? "+" : "") + fmt(net), "Net Stock Change", net >= 0 ? "#16a34a" : "#dc2626", "Receive − Delivery")}
      ${kpi("calendar", workDays, "Working Days", "#0891b2", holDays + " holiday / off days")}
      ${kpi("truck", fmt(avgDelWD), "Avg Delivery / Day", "#d97706", "Per working day")}
      ${kpi("package", fmt(avgRecWD), "Avg Receive / Day", "#7c3aed", "Per working day")}
    </div>`;
}

function rptDailyLog() {
  const allRows = [];
  rptMs.forEach((k) => { (DB[k] || []).forEach((r) => allRows.push(r)); });
  if (!allRows.length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No data for the selected range.</p>';

  let totalDel = 0, totalRec = 0;
  let html = `<div class="simple-table-container"><table class="simple-table" style="min-width:900px;font-size:11px">
    <thead><tr>
      <th>Date</th><th>Day</th>
      ${LOCS.map((l) =>
        `<th>${l.replace("Warehouse-", "WH-").replace("Yard No-", "Yd").replace("Shed No-", "Sh")}<br><span style="font-weight:400;font-size:9px">Del/Rec</span></th>`
      ).join("")}
      <th>Total Del</th><th>Total Rec</th><th>Closing Bal</th><th>Note</th>
    </tr></thead><tbody>`;

  allRows.forEach((r) => {
    const red = isRed(r.date);
    const tDel = r.del.reduce((a, b) => a + b, 0);
    const tRec = r.imp.reduce((a, b) => a + b, 0);
    const closing = getClosing(r);
    totalDel += tDel;
    totalRec += tRec;
    const bg = red ? "background:#fef2f2;" : r.date === TODAY ? "background:#fef9c3;" : "";
    html += `<tr style="${bg}">
      <td style="font-weight:700;white-space:nowrap;color:${red ? "#991b1b" : "#1f2937"}">${fmtDMY(r.date)}</td>
      <td style="color:${red ? "#991b1b" : "#6b7280"}">${DAYS[dow(r.date)]}</td>
      ${LOCS.map((_, i) =>
        `<td><span style="color:#2563eb">${r.del[i] || 0}</span>/<span style="color:#dc2626">${r.imp[i] || 0}</span></td>`
      ).join("")}
      <td style="font-weight:700;color:#2563eb">${tDel || "—"}</td>
      <td style="font-weight:700;color:#dc2626">${tRec || "—"}</td>
      <td style="font-weight:700;color:#059669">${fmt(closing)}</td>
      <td style="font-size:10px;color:#6b7280;max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.al || "")}</td>
    </tr>`;
  });

  html += `<tr style="background:#f1f5f9;font-weight:700;border-top:2px solid #d1d5db">
    <td colspan="2" style="text-align:left;padding-left:10px">${icon("bar-chart-3", 11)} TOTAL</td>
    ${LOCS.map(() => "<td>—</td>").join("")}
    <td style="color:#2563eb;font-size:13px">${fmt(totalDel)}</td>
    <td style="color:#dc2626;font-size:13px">${fmt(totalRec)}</td>
    <td colspan="2"></td>
  </tr>`;
  return html + "</tbody></table></div>";
}

function rptGroup() {
  const allRows = [];
  rptMs.forEach((k) => { (DB[k] || []).forEach((r) => allRows.push(r)); });
  const compareKey = getCompareKey();
  const prevRows = compareKey ? (DB[compareKey] || []) : [];

  const groups = [
    { lbl: "Warehouse", lis: [0, 1], bg: "#1e4d7b", iconName: "building-2" },
    { lbl: "Yard",      lis: [2, 3], bg: "#1a5c3a", iconName: "truck" },
    { lbl: "Shed",      lis: [4, 5, 6, 7], bg: "#7c3c1a", iconName: "factory" },
  ];

  let html = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px">';

  groups.forEach((g) => {
    const totDel = allRows.reduce((s, r) => s + g.lis.reduce((a, i) => a + r.del[i], 0), 0);
    const totRec = allRows.reduce((s, r) => s + g.lis.reduce((a, i) => a + r.imp[i], 0), 0);
    const lastRow = rptMs.length ? (DB[rptMs[rptMs.length - 1]] || []).slice(-1)[0] : null;
    const curBal = lastRow ? g.lis.reduce((a, i) => a + lastRow.bal[i], 0) : 0;
    const eff = totRec > 0 ? Math.round((totDel / totRec) * 100) : 0;
    const prevDel = prevRows.reduce((s, r) => s + g.lis.reduce((a, i) => a + r.del[i], 0), 0);
    const prevRec = prevRows.reduce((s, r) => s + g.lis.reduce((a, i) => a + r.imp[i], 0), 0);
    const dDiff = totDel - prevDel, rDiff = totRec - prevRec;
    const effColor = eff >= 100 ? "#16a34a" : eff >= 75 ? "#d97706" : "#dc2626";

    html += `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.06)">
      <div style="background:${g.bg};color:#fff;padding:14px 16px;font-weight:700;font-size:14px;display:flex;align-items:center;gap:8px">
        ${icon(g.iconName, 16)} ${g.lbl}
        <span style="margin-left:auto;font-size:11px;opacity:0.75">${g.lis.map((i) => LOCS[i]).join(" · ")}</span>
      </div>
      <div style="padding:16px;display:grid;grid-template-columns:1fr 1fr;gap:12px">
        <div style="text-align:center;padding:12px;background:#eff6ff;border-radius:8px;border:1px solid #dbeafe">
          <div style="font-size:20px;font-weight:700;color:#2563eb">${fmt(totDel)}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px">Delivery</div>
          ${prevRows.length ? `<div style="font-size:10px;color:${dDiff >= 0 ? "#16a34a" : "#dc2626"};margin-top:2px">${dDiff >= 0 ? "↑" : "↓"}${fmt(Math.abs(dDiff))} vs prev</div>` : ""}
        </div>
        <div style="text-align:center;padding:12px;background:#fef2f2;border-radius:8px;border:1px solid #fecaca">
          <div style="font-size:20px;font-weight:700;color:#dc2626">${fmt(totRec)}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px">Receive</div>
          ${prevRows.length ? `<div style="font-size:10px;color:${rDiff >= 0 ? "#16a34a" : "#dc2626"};margin-top:2px">${rDiff >= 0 ? "↑" : "↓"}${fmt(Math.abs(rDiff))} vs prev</div>` : ""}
        </div>
        <div style="text-align:center;padding:12px;background:#f0fdf4;border-radius:8px;border:1px solid #bbf7d0">
          <div style="font-size:20px;font-weight:700;color:#059669">${fmt(curBal)}</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px">End Balance</div>
        </div>
        <div style="text-align:center;padding:12px;background:#f5f3ff;border-radius:8px;border:1px solid #ddd6fe">
          <div style="font-size:20px;font-weight:700;color:${effColor}">${eff}%</div>
          <div style="font-size:10px;color:#6b7280;margin-top:2px">Efficiency</div>
        </div>
      </div>
    </div>`;
  });

  return html + "</div>";
}

function rptRanking() {
  const lastRow = rptMs.length ? (DB[rptMs[rptMs.length - 1]] || []).slice(-1)[0] : null;

  const ranked = LOCS.map((loc, i) => {
    const totDel = rptMs.reduce((s, k) => s + (DB[k] || []).reduce((a, r) => a + r.del[i], 0), 0);
    const totRec = rptMs.reduce((s, k) => s + (DB[k] || []).reduce((a, r) => a + r.imp[i], 0), 0);
    const curBal = lastRow ? lastRow.bal[i] : 0;
    const eff = totRec > 0 ? Math.round((totDel / totRec) * 100) : 0;
    return { loc, i, totDel, totRec, curBal, eff };
  }).sort((a, b) => b.eff - a.eff);

  const rankTiers = ["gold", "silver", "bronze"];

  const rangeLbl = rptMs.length === 1
    ? `${MO[parseInt(rptMs[0].split("-")[1]) - 1]} ${rptMs[0].split("-")[0]}`
    : `${rptMs.length} months`;

  let html = `<div class="simple-table-container"><table class="simple-table">
    <thead><tr>
      <th>Rank</th>
      <th style="text-align:left">Location</th>
      <th>Delivery (${rangeLbl})</th>
      <th>Receive (${rangeLbl})</th>
      <th>Balance</th>
      <th>Efficiency</th>
      <th>Grade</th>
    </tr></thead><tbody>`;

  ranked.forEach((d, idx) => {
    const effCls = d.eff >= 100 ? "excellent" : d.eff >= 75 ? "good" : "poor";
    const grade = d.eff >= 100 ? "A+" : d.eff >= 90 ? "A" : d.eff >= 75 ? "B" : d.eff >= 60 ? "C" : "D";
    const gradeColor = d.eff >= 90 ? "#16a34a" : d.eff >= 75 ? "#d97706" : "#dc2626";
    html += `<tr>
      <td><span class="rank-badge${idx < 3 ? " rank-" + rankTiers[idx] : ""}">${idx + 1}</span></td>
      <td style="text-align:left;font-weight:700">
        <span style="display:inline-block;width:10px;height:10px;background:${LOC_CFG[d.loc].bg};border-radius:2px;margin-right:6px;vertical-align:middle"></span>${d.loc}
      </td>
      <td class="delivery">${fmt(d.totDel)}</td>
      <td class="receive">${fmt(d.totRec)}</td>
      <td class="balance">${fmt(d.curBal)}</td>
      <td><span class="efficiency ${effCls}">${d.eff}%</span></td>
      <td style="font-weight:700;font-size:14px;color:${gradeColor}">${grade}</td>
    </tr>`;
  });

  return html + "</tbody></table></div>";
}

function rptPeak() {
  const allRows = [];
  rptMs.forEach((k) => { (DB[k] || []).forEach((r) => allRows.push(r)); });
  if (!allRows.length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No data for the selected range.</p>';

  const enriched = allRows.map((r) => ({
    date: r.date,
    day: DAYS[dow(r.date)],
    tDel: r.del.reduce((a, b) => a + b, 0),
    tRec: r.imp.reduce((a, b) => a + b, 0),
  }));

  const topDel = [...enriched].sort((a, b) => b.tDel - a.tDel).slice(0, 5);
  const topRec = [...enriched].sort((a, b) => b.tRec - a.tRec).slice(0, 5);

  const half = (data, valKey, label, color) => `
    <div style="flex:1;min-width:240px">
      <div style="font-size:13px;font-weight:700;color:${color};margin-bottom:10px">${label}</div>
      <div class="simple-table-container"><table class="simple-table">
        <thead><tr><th>#</th><th>Date</th><th>Day</th><th>Count</th></tr></thead>
        <tbody>
          ${data.map((r, i) => `<tr>
            <td style="font-weight:700;color:${color}">#${i + 1}</td>
            <td style="font-weight:700">${fmtDMY(r.date)}</td>
            <td style="color:#6b7280">${r.day}</td>
            <td style="font-weight:700;color:${color};font-size:14px">${fmt(r[valKey])}</td>
          </tr>`).join("")}
        </tbody>
      </table></div>
    </div>`;

  return `<div style="display:flex;gap:24px;flex-wrap:wrap">
    ${half(topDel, "tDel", icon("trophy", 14) + " Top 5 Delivery Days", "#2563eb")}
    ${half(topRec, "tRec", icon("trophy", 14) + " Top 5 Receive Days", "#dc2626")}
  </div>`;
}

function rptFlow() {
  if (!rptMs.length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No data.</p>';

  let html = `<div class="simple-table-container"><table class="simple-table">
    <thead><tr>
      <th>Month</th>
      <th>Opening Balance</th>
      <th>+ Receive</th>
      <th>− Delivery</th>
      <th>Closing Balance</th>
      <th>Net Change</th>
    </tr></thead><tbody>`;

  rptMs.slice().reverse().forEach((k) => {
    const rows = DB[k] || [];
    if (!rows.length) return;
    const [y, m] = k.split("-").map(Number);
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    const opening = firstRow.bal ? firstRow.bal.reduce((a, b) => a + b, 0) : 0;
    const closing = getClosing(lastRow);
    const s = summ(k);
    const net = closing - opening;
    html += `<tr class="${k === cur ? "current" : ""}">
      <td class="month" ${k === rptFocus ? 'style="font-weight:900;color:#1d4ed8"' : ""}>${MO[m - 1]} ${y}${k === rptFocus ? " ★" : ""}</td>
      <td style="font-weight:700">${fmt(opening)}</td>
      <td style="color:#dc2626;font-weight:700">+${fmt(s.imp)}</td>
      <td style="color:#2563eb;font-weight:700">−${fmt(s.del)}</td>
      <td style="color:#059669;font-weight:700">${fmt(closing)}</td>
      <td style="font-weight:700;color:${net >= 0 ? "#16a34a" : "#dc2626"}">${net >= 0 ? "+" : ""}${fmt(net)}</td>
    </tr>`;
  });

  return html + "</tbody></table></div>";
}

function rptDow() {
  const stats = Array.from({ length: 7 }, (_, d) => ({ d, lbl: DAYS[d], del: 0, rec: 0, cnt: 0 }));

  rptMs.forEach((k) => {
    (DB[k] || []).forEach((r) => {
      const d = dow(r.date);
      stats[d].del += r.del.reduce((a, b) => a + b, 0);
      stats[d].rec += r.imp.reduce((a, b) => a + b, 0);
      stats[d].cnt++;
    });
  });

  const maxAvg = Math.max(...stats.map((s) => (s.cnt > 0 ? s.del / s.cnt : 0))) || 1;

  let html = `<div class="simple-table-container"><table class="simple-table">
    <thead><tr>
      <th>Weekday</th><th>Avg Delivery</th><th>Avg Receive</th><th>Days Counted</th><th>Activity</th>
    </tr></thead><tbody>`;

  [1, 2, 3, 4, 5, 6, 0].forEach((d) => {
    const s = stats[d];
    const avgDel = s.cnt > 0 ? Math.round(s.del / s.cnt) : 0;
    const avgRec = s.cnt > 0 ? Math.round(s.rec / s.cnt) : 0;
    const bar = Math.round((avgDel / maxAvg) * 100);
    const isOff = (d === 5 && sett.fri) || (d === 6 && sett.sat) || (d === 0 && sett.sun);
    html += `<tr style="${isOff ? "background:#fef2f2" : ""}">
      <td style="font-weight:700;color:${isOff ? "#991b1b" : "#1f2937"}">${s.lbl}${isOff ? ' <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#dc2626;vertical-align:middle"></span>' : ""}</td>
      <td style="color:#2563eb;font-weight:700">${fmt(avgDel)}</td>
      <td style="color:#dc2626;font-weight:700">${fmt(avgRec)}</td>
      <td style="color:#6b7280">${s.cnt}</td>
      <td style="min-width:130px;padding:8px 10px">
        <div style="background:#e5e7eb;border-radius:4px;height:10px;overflow:hidden">
          <div style="background:#3b82f6;height:100%;width:${bar}%;border-radius:4px"></div>
        </div>
        <span style="font-size:9px;color:#9ca3af">${bar}%</span>
      </td>
    </tr>`;
  });

  return html + "</tbody></table></div>";
}

function rptTransfers() {
  if (!sett.transfers || !Object.keys(sett.transfers).length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No transfers recorded.</p>';
  if (!rptMs.length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No data for the selected range.</p>';

  const rangeTxs = Object.entries(sett.transfers)
    .filter(([date]) => date >= rptMs[0] && date <= rptMs[rptMs.length - 1])
    .sort(([a], [b]) => a.localeCompare(b));

  if (!rangeTxs.length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No transfers recorded for the selected range.</p>';

  let totalQty = 0;
  let html = `<div class="simple-table-container"><table class="simple-table">
    <thead><tr>
      <th>Date</th><th>From</th><th>→</th><th>To</th><th>Qty</th><th>Note</th>
    </tr></thead><tbody>`;

  rangeTxs.forEach(([date, txs]) => {
    (txs || []).forEach((t) => {
      totalQty += t.qty || 0;
      const fromLoc = (t.from != null && LOCS[t.from]) ? LOCS[t.from] : (t.from || "—");
      const toLoc = (t.to != null && LOCS[t.to]) ? LOCS[t.to] : (t.to || "—");
      html += `<tr>
        <td style="font-weight:700">${fmtDMY(date)}</td>
        <td style="color:#dc2626;font-weight:600">${esc(fromLoc)}</td>
        <td style="color:#6b7280">→</td>
        <td style="color:#16a34a;font-weight:600">${esc(toLoc)}</td>
        <td style="font-weight:700;color:#7c3aed;font-size:14px">${fmt(t.qty || 0)}</td>
        <td style="color:#6b7280;font-size:11px">${esc(t.note || "")}</td>
      </tr>`;
    });
  });

  html += `<tr style="background:#f1f5f9;font-weight:700;border-top:2px solid #d1d5db">
    <td colspan="4" style="text-align:left;padding-left:10px">TOTAL</td>
    <td style="color:#7c3aed;font-size:14px">${fmt(totalQty)}</td><td></td>
  </tr>`;
  return html + "</tbody></table></div>";
}

function rptYoY() {
  if (!rptMs.length)
    return '<p style="color:#9ca3af;text-align:center;padding:20px">No data for the selected range.</p>';

  const prevMs = rptMs.map((k) => {
    const [y, m] = k.split("-").map(Number);
    return mk(y - 1, m);
  });

  const availablePrev = prevMs.filter((k) => DB[k] && DB[k].length);
  if (!availablePrev.length)
    return `<p style="color:#9ca3af;text-align:center;padding:20px">No previous year data — year-over-year comparison unavailable.</p>`;

  let totDel = 0, totImp = 0, prevDel = 0, prevImp = 0, totBal = 0;
  rptMs.forEach((k) => {
    const s = summ(k);
    totDel += s.del;
    totImp += s.imp;
    totBal = s.bal;
  });
  availablePrev.forEach((k) => {
    const s = summ(k);
    prevDel += s.del;
    prevImp += s.imp;
  });

  const [curY] = rptMs[0].split("-").map(Number);
  const [lastY] = prevMs[0].split("-").map(Number);
  const [lastM] = rptMs[rptMs.length - 1].split("-").map(Number);
  const rangeLbl = rptMs.length === 1
    ? `${MO[lastM - 1]} ${curY}`
    : `${MO[parseInt(rptMs[0].split("-")[1]) - 1]} ${curY} → ${MO[lastM - 1]} ${curY}`;
  const prevRangeLbl = rptMs.length === 1
    ? `${MO[lastM - 1]} ${lastY}`
    : `${MO[parseInt(rptMs[0].split("-")[1]) - 1]} ${lastY} → ${MO[lastM - 1]} ${lastY}`;

  const kpis = [
    { lbl: "Total Receive",  c: totImp, p: prevImp, col: "#dc2626" },
    { lbl: "Total Delivery", c: totDel, p: prevDel, col: "#2563eb" },
    { lbl: "Closing Balance",c: totBal, p: summ(availablePrev[availablePrev.length - 1]).bal, col: "#059669" },
    { lbl: "Efficiency %",   c: totImp ? Math.round((totDel / totImp) * 100) : 0,
                             p: prevImp ? Math.round((prevDel / prevImp) * 100) : 0,
                             col: "#7c3aed", pct: true },
    { lbl: "Net Change",     c: totImp - totDel, p: prevImp - prevDel, col: "#d97706" },
  ];

  let html = `<div class="simple-table-container"><table class="simple-table">
    <thead><tr>
      <th style="text-align:left">Metric</th>
      <th>${rangeLbl}</th>
      <th>${prevRangeLbl}</th>
      <th>Change</th>
      <th>% Change</th>
    </tr></thead><tbody>`;

  kpis.forEach((r) => {
    const diff = r.c - r.p;
    const pctV = r.p !== 0 ? Math.round((diff / r.p) * 100) : r.c > 0 ? 100 : 0;
    const dc = diff >= 0 ? "#16a34a" : "#dc2626";
    html += `<tr>
      <td style="text-align:left;font-weight:700;color:${r.col}">${r.lbl}</td>
      <td style="font-weight:700;color:${r.col}">${fmt(r.c)}${r.pct ? "%" : ""}</td>
      <td style="color:#64748b">${fmt(r.p)}${r.pct ? "%" : ""}</td>
      <td style="font-weight:700;color:${dc}">${diff >= 0 ? "+" : ""}${fmt(diff)}${r.pct ? "%" : ""}</td>
      <td style="font-weight:700;color:${dc}">${diff >= 0 ? "↑" : "↓"}${Math.abs(pctV)}%</td>
    </tr>`;
  });

  html += `<tr style="background:#f8fafc"><td colspan="5" style="text-align:left;font-weight:700;color:#374151;padding:10px">${icon("map-pin", 12)} Per-Location Delivery Comparison</td></tr>`;

  LOCS.forEach((loc, i) => {
    let cDel = 0, pDel = 0;
    rptMs.forEach((k) => { cDel += (DB[k] || []).reduce((s, r) => s + r.del[i], 0); });
    availablePrev.forEach((k) => { pDel += (DB[k] || []).reduce((s, r) => s + r.del[i], 0); });
    const diff = cDel - pDel;
    const pctV = pDel > 0 ? Math.round((diff / pDel) * 100) : cDel > 0 ? 100 : 0;
    const dc = diff >= 0 ? "#16a34a" : "#dc2626";
    html += `<tr>
      <td style="text-align:left;font-size:11px">
        <span style="display:inline-block;width:8px;height:8px;background:${LOC_CFG[loc].bg};border-radius:2px;margin-right:5px;vertical-align:middle"></span>${loc}
      </td>
      <td style="color:#2563eb;font-weight:700">${fmt(cDel)}</td>
      <td style="color:#64748b">${fmt(pDel)}</td>
      <td style="color:${dc};font-weight:700">${diff >= 0 ? "+" : ""}${fmt(diff)}</td>
      <td style="color:${dc};font-weight:700">${diff >= 0 ? "↑" : "↓"}${Math.abs(pctV)}%</td>
    </tr>`;
  });

  return html + "</tbody></table></div>";
}

// ════════════════════════════════════════════════════
//  AUCTION DELIVERY REPORT
// ════════════════════════════════════════════════════

function getAuctionRows() {
  const from = auctionFilter.from;
  const to = auctionFilter.to;
  const allRows = [];
  Object.keys(DB).sort().forEach(mk => {
    (DB[mk] || []).forEach(row => {
      if (!row.date) return;
      if (from && row.date < from) return;
      if (to && row.date > to) return;
      allRows.push({ ...row, mk });
    });
  });
  return allRows.sort((a, b) => a.date.localeCompare(b.date));
}

function renderAuctionReport() {
  const rows = getAuctionRows();

  // Aggregate stats (needed for hero even if no rows)
  const totalAuc = rows.reduce((s, r) => s + (parseInt(r.av) || 0), 0);
  const totalDel = rows.reduce((s, r) => s + (r.del || []).reduce((a, b) => a + (parseInt(b) || 0), 0), 0);
  const grandTotal = totalDel + totalAuc;
  const aucShare = grandTotal > 0 ? Math.round(totalAuc / grandTotal * 100) : 0;
  const activeDays = rows.filter(r => (parseInt(r.av) || 0) > 0).length;

  if (!rows.length) {
    return `
      <div class="auc-empty">
        <div class="auc-empty-icon">${icon("car", 44)}</div>
        <div class="auc-empty-title">No auction data found</div>
        <div class="auc-empty-sub">No records match the selected date range. Try a different filter.</div>
      </div>`;
  }

  // Location map
  const locMap = {};
  rows.forEach(r => {
    const v = parseInt(r.av) || 0;
    if (!v) return;
    const loc = (r.al || "").trim() || "Unknown";
    if (!locMap[loc]) locMap[loc] = { days: 0, total: 0 };
    locMap[loc].days++;
    locMap[loc].total += v;
  });
  const uniqueLocs = Object.keys(locMap).length;

  // Peak day
  let peakRow = null;
  rows.forEach(r => {
    const v = parseInt(r.av) || 0;
    if (!peakRow || v > (parseInt(peakRow.av) || 0)) peakRow = r;
  });
  const peakVal = peakRow ? (parseInt(peakRow.av) || 0) : 0;
  const peakDate = peakRow && peakVal > 0 ? peakRow.date : "—";
  const avgPerDay = rows.length > 0 ? (totalAuc / rows.length).toFixed(1) : "0.0";
  const avgActiveDay = activeDays > 0 ? (totalAuc / activeDays).toFixed(1) : "0.0";

  // ── KPI Grid ──────────────────────────────────────
  const kpiHtml = `
    <div class="auc-kpi-grid">
      <div class="auc-kpi-card">
        <div class="auc-kpi-top">
          <div class="auc-kpi-icon-wrap">${icon("car", 20)}</div>
          <span class="auc-kpi-tag">Total</span>
        </div>
        <div class="auc-kpi-val">${fmt(totalAuc)}</div>
        <div class="auc-kpi-lbl">Auction Deliveries</div>
      </div>
      <div class="auc-kpi-card">
        <div class="auc-kpi-top">
          <div class="auc-kpi-icon-wrap">${icon("bar-chart-3", 20)}</div>
          <span class="auc-kpi-tag">Share</span>
        </div>
        <div class="auc-kpi-val">${aucShare}%</div>
        <div class="auc-kpi-lbl">of All Deliveries</div>
        <div class="auc-kpi-sub">${fmt(totalDel)} regular</div>
      </div>
      <div class="auc-kpi-card">
        <div class="auc-kpi-top">
          <div class="auc-kpi-icon-wrap">${icon("calendar", 20)}</div>
          <span class="auc-kpi-tag">Activity</span>
        </div>
        <div class="auc-kpi-val">${activeDays}</div>
        <div class="auc-kpi-lbl">Active Auction Days</div>
        <div class="auc-kpi-sub">of ${rows.length} days in range</div>
      </div>
      <div class="auc-kpi-card">
        <div class="auc-kpi-top">
          <div class="auc-kpi-icon-wrap">${icon("trophy", 20)}</div>
          <span class="auc-kpi-tag">Peak</span>
        </div>
        <div class="auc-kpi-val">${fmt(peakVal)}</div>
        <div class="auc-kpi-lbl">Single Day Record</div>
        <div class="auc-kpi-sub">${peakDate}</div>
      </div>
      <div class="auc-kpi-card secondary">
        <div class="auc-kpi-top"><div class="auc-kpi-icon-wrap">${icon("map-pin", 18)}</div></div>
        <div class="auc-kpi-val">${uniqueLocs}</div>
        <div class="auc-kpi-lbl">Unique Locations</div>
      </div>
      <div class="auc-kpi-card secondary">
        <div class="auc-kpi-top"><div class="auc-kpi-icon-wrap">${icon("trending-up", 18)}</div></div>
        <div class="auc-kpi-val">${avgPerDay}</div>
        <div class="auc-kpi-lbl">Avg / All Days</div>
      </div>
      <div class="auc-kpi-card secondary">
        <div class="auc-kpi-top"><div class="auc-kpi-icon-wrap">${icon("zap", 18)}</div></div>
        <div class="auc-kpi-val">${avgActiveDay}</div>
        <div class="auc-kpi-lbl">Avg / Active Day</div>
      </div>
      <div class="auc-kpi-card secondary">
        <div class="auc-kpi-top"><div class="auc-kpi-icon-wrap">${icon("calendar-days", 18)}</div></div>
        <div class="auc-kpi-val">${rows.length}</div>
        <div class="auc-kpi-lbl">Days in Range</div>
      </div>
    </div>`;

  // ── Location Breakdown ────────────────────────────
  const sortedLocs = Object.entries(locMap).sort((a, b) => b[1].total - a[1].total);
  const maxLocTotal = sortedLocs[0]?.[1].total || 1;
  let locHtml = "";
  if (!sortedLocs.length) {
    locHtml = `<div class="auc-empty"><div class="auc-empty-sub">No auction deliveries recorded in this range.</div></div>`;
  } else {
    locHtml = `<div class="auc-loc-list">`;
    sortedLocs.forEach(([loc, d], i) => {
      const barW = Math.round(d.total / maxLocTotal * 100);
      const share = Math.round(d.total / (totalAuc || 1) * 100);
      const avg = (d.total / d.days).toFixed(1);
      locHtml += `
        <div class="auc-loc-row">
          <div class="auc-loc-rank ${i === 0 ? "top" : ""}">${i + 1}</div>
          <div class="auc-loc-name-cell">
            <span class="auc-loc-name">${esc(loc)}</span>
            <div class="auc-loc-bar-track">
              <div class="auc-loc-bar-fill" style="width:${barW}%"></div>
            </div>
          </div>
          <div class="auc-loc-stat-col">
            <div class="auc-loc-stat">${fmt(d.total)}</div>
            <div class="auc-loc-meta">${d.days}d · avg ${avg}</div>
          </div>
          <div class="auc-loc-share-pill">${share}%</div>
        </div>`;
    });
    locHtml += `</div>`;
  }

  // ── Monthly Trend ─────────────────────────────────
  const monthMap = {};
  rows.forEach(r => {
    const m = r.date?.substring(0, 7);
    if (!m) return;
    if (!monthMap[m]) monthMap[m] = { total: 0, activeDays: 0, totalDays: 0 };
    const v = parseInt(r.av) || 0;
    monthMap[m].total += v;
    monthMap[m].totalDays++;
    if (v > 0) monthMap[m].activeDays++;
  });
  const sortedMonths = Object.keys(monthMap).sort();
  const maxMonthTotal = Math.max(...sortedMonths.map(m => monthMap[m].total), 1);
  let monthHtml = "";
  if (sortedMonths.length > 1) {
    monthHtml = `<div class="auc-month-list">`;
    sortedMonths.forEach(m => {
      const d = monthMap[m];
      const barW = Math.round(d.total / maxMonthTotal * 100);
      monthHtml += `
        <div class="auc-month-row">
          <div class="auc-month-label">${m}</div>
          <div class="auc-month-bar-track">
            <div class="auc-month-bar-fill" style="width:${Math.max(barW, 2)}%"></div>
          </div>
          <div class="auc-month-val">${fmt(d.total)}</div>
          <div class="auc-month-days">${d.activeDays}d</div>
        </div>`;
    });
    monthHtml += `</div>`;
  }

  // ── Daily Breakdown ───────────────────────────────
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  let dailyHtml = `
    <div class="auc-daily-wrap">
    <table class="auc-daily-tbl">
      <thead><tr>
        <th>Date</th>
        <th>Auction Location</th>
        <th style="text-align:right">Auction Del.</th>
        <th style="text-align:right">Regular Del.</th>
        <th>Split</th>
      </tr></thead>
      <tbody>`;
  [...rows].reverse().forEach(r => {
    const aucV = parseInt(r.av) || 0;
    const regV = (r.del || []).reduce((s, v) => s + (parseInt(v) || 0), 0);
    const total = aucV + regV;
    const aucBarW = total > 0 ? Math.round(aucV / total * 100) : 0;
    const d = dow(r.date);
    const dayName = dayNames[d] ?? "";
    const isWeekend = d === 5 || d === 6;
    const hasLoc = !!(r.al && r.al.trim());
    dailyHtml += `
      <tr class="${isWeekend ? "weekend" : ""}">
        <td>
          <div class="auc-date-cell">
            <span class="auc-date-str">${fmtDMY(r.date)}</span>
            <span class="auc-day-tag ${isWeekend ? "is-weekend" : ""}">${dayName}</span>
          </div>
        </td>
        <td><span class="auc-loc-chip ${hasLoc ? "active" : ""}">${esc(r.al) || "—"}</span></td>
        <td style="text-align:right">
          ${aucV > 0 ? `<span class="auc-auc-val">${fmt(aucV)}</span>` : `<span class="auc-auc-nil">—</span>`}
        </td>
        <td style="text-align:right;font-weight:600;color:#475569;font-variant-numeric:tabular-nums">${fmt(regV)}</td>
        <td>
          <div class="auc-prop-wrap">
            <div class="auc-prop-bar">
              <div class="auc-prop-auc" style="width:${aucBarW}%"></div>
              <div class="auc-prop-reg" style="width:${100 - aucBarW}%"></div>
            </div>
            <div class="auc-prop-label">${aucBarW}% auction</div>
          </div>
        </td>
      </tr>`;
  });
  dailyHtml += `</tbody></table></div>`;

  return `
    ${kpiHtml}
    <div class="auc-section-card">
      <div class="auc-section-hdr">
        <div class="auc-section-icon">${icon("map-pin", 18)}</div>
        <h3 class="auc-section-title">By Auction Location</h3>
        <span class="auc-section-count">${sortedLocs.length} location${sortedLocs.length !== 1 ? "s" : ""}</span>
      </div>
      ${locHtml}
    </div>
    ${sortedMonths.length > 1 ? `
    <div class="auc-section-card">
      <div class="auc-section-hdr">
        <div class="auc-section-icon">${icon("calendar", 18)}</div>
        <h3 class="auc-section-title">Monthly Trend</h3>
        <span class="auc-section-count">${sortedMonths.length} months</span>
      </div>
      ${monthHtml}
    </div>` : ""}
    <div class="auc-section-card">
      <div class="auc-section-hdr">
        <div class="auc-section-icon">${icon("clipboard-list", 18)}</div>
        <h3 class="auc-section-title">Daily Breakdown</h3>
        <span class="auc-section-count">${rows.length} day${rows.length !== 1 ? "s" : ""}</span>
      </div>
      ${dailyHtml}
    </div>`;
}

// ════════════════════════════════════════════════════
//  EXPORT
// ════════════════════════════════════════════════════
function doExport() {
  document.getElementById("ov-export").classList.remove("on");
  const type = document.querySelector('input[name="exp"]:checked').value;
  const keys = type === "all" ? months() : [cur];
  const wb = XLSX.utils.book_new();
  keys.forEach((k) => {
    const [y, m] = k.split("-").map(Number);
    const rows = DB[k] || [];
    const h1 = [
      "Date",
      "Day",
      ...LOCS.flatMap((l) => [l, "", ""]),
      "Total Delivery",
      "Auction Loc",
      "Auction Val",
      "Closing Balance",
      "Total Import",
      "Rot No",
    ];
    const h2 = [
      "",
      "",
      ...LOCS.flatMap(() => ["Balance", "Delivery", "Import"]),
      "",
      "",
      "",
      "",
      "",
      "",
    ];
    const aoa = [h1, h2];
    rows.forEach((r) => {
      const row = [fmtDMY(r.date), DAYS[new Date(r.date + "T00:00:00").getDay()]];
      LOCS.forEach((_, li) => row.push(r.bal[li], r.del[li], r.imp[li]));
      row.push(
        r.del.reduce((a, b) => a + b, 0),
        r.al,
        r.av,
        getClosing(r),
        r.imp.reduce((a, b) => a + b, 0),
        r.rn || "",
      );
      aoa.push(row);
    });
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"] = [
      { wch: 12 },
      { wch: 5 },
      ...LOCS.flatMap(() => [{ wch: 9 }, { wch: 8 }, { wch: 8 }]),
      { wch: 12 },
      { wch: 10 },
      { wch: 10 },
      { wch: 14 },
      { wch: 12 },
      { wch: 12 },
    ];
    XLSX.utils.book_append_sheet(wb, ws, `${MO[m - 1]} ${y}`);
  });
  const [y, m] = cur.split("-").map(Number);
  XLSX.writeFile(
    wb,
    type === "all"
      ? "Car_Balance_All.xlsx"
      : `Car_Balance_${MO[m - 1]}_${y}.xlsx`,
  );
}

// ════════════════════════════════════════════════════
//  PAGE NAV
// ════════════════════════════════════════════════════
let curPage = "daily";
// Lightweight tab-switch loading state — a skeleton instead of the
// full-screen blocking overlay, which is reserved for save/load/cloud
// operations where blocking input is actually correct.
function showSkeleton(pageId) {
  const page = document.getElementById(pageId);
  if (!page || page.querySelector(".skeleton-overlay")) return;
  const el = document.createElement("div");
  el.className = "skeleton-overlay";
  el.innerHTML =
    '<div class="skeleton-row">' +
    Array(6).fill('<div class="skeleton-box skeleton-card"></div>').join("") +
    "</div>" +
    '<div class="skeleton-box skeleton-block"></div>' +
    '<div class="skeleton-box skeleton-block"></div>';
  page.appendChild(el);
}
function hideSkeleton(pageId) {
  const page = document.getElementById(pageId);
  const el = page && page.querySelector(".skeleton-overlay");
  if (el) el.remove();
}

function showPage(p, el) {
  curPage = p;
  document.querySelectorAll(".page").forEach((x) => x.classList.remove("on"));
  document.querySelectorAll(".ntab").forEach((x) => x.classList.remove("on"));
  document.getElementById("page-" + p).classList.add("on");
  el.classList.add("on");
  if (p === "chart") {
    killCharts();
    showSkeleton("page-chart");
    setTimeout(() => renderCharts(true), 60);
  }
  if (p === "report") {
    showSkeleton("page-report");
    renderReport(true);
  }
  if (p === "settings") renderSettings();
  if (p === "transfer") renderTransferPage();
}

// ════════════════════════════════════════════════════
//  KEYBOARD SHORTCUTS
// ════════════════════════════════════════════════════
const SHORTCUTS = {
  "Ctrl+S": () => doSave(),
  "Ctrl+Z": () => undoLast(),
  "Ctrl+E": () => document.getElementById("ov-export").classList.add("on"),
  1: () => showPage("daily", document.querySelector(".ntab")),
  2: () => showPage("chart", document.querySelectorAll(".ntab")[1]),
  3: () => showPage("report", document.querySelectorAll(".ntab")[2]),
  4: () => showPage("transfer", document.querySelectorAll(".ntab")[3]),
  5: () => showPage("settings", document.querySelectorAll(".ntab")[4]),
  Escape: () => {
    document.querySelectorAll(".ov.on").forEach((overlay) => {
      overlay.classList.remove("on");
    });
  },
  F1: () => showShortcutsHelp(),
  ArrowLeft: () => navigateMonth(-1),
  ArrowRight: () => navigateMonth(1),
};

function showShortcutsHelp() {
  const existing = document.getElementById("help-modal");
  if (existing) {
    existing.remove();
    return;
  }
  const modal = document.createElement("div");
  modal.id = "help-modal";
  modal.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.6);display:flex;justify-content:center;align-items:center;z-index:10001;";
  modal.innerHTML = `<div style="background:#fff;border-radius:12px;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25);max-width:480px;width:90%;padding:0;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#1a3a5c,#2d5a87);padding:20px 24px;color:#fff;display:flex;justify-content:space-between;align-items:center;">
      <h3 style="margin:0;font-size:18px;">Keyboard Shortcuts</h3>
      <button onclick="document.getElementById('help-modal').remove()" style="background:none;border:none;color:#fff;font-size:24px;cursor:pointer;line-height:1;padding:4px 8px;">&times;</button>
    </div>
    <div style="padding:24px;">
      <div style="display:grid;gap:12px;">
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Command palette</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">Ctrl+K</kbd>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Save data</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">Ctrl+S</kbd>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Undo last action</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">Ctrl+Z</kbd>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Export to Excel</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">Ctrl+E</kbd>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Logout</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">Ctrl+L</kbd>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Previous / Next month</span>
          <div style="display:flex;gap:4px;">
            <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">&larr;</kbd>
            <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">&rarr;</kbd>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Switch tabs (1-5)</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">1-5</kbd>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 12px;background:#f8fafc;border-radius:8px;">
          <span style="color:#475569;">Close modals</span>
          <kbd style="background:#e2e8f0;padding:4px 10px;border-radius:6px;font-family:monospace;font-size:13px;border:1px solid #cbd5e1;">Esc</kbd>
        </div>
      </div>
    </div>
    <div style="padding:16px 24px;border-top:1px solid #e2e8f0;text-align:center;">
      <span style="color:#64748b;font-size:13px;">Press <strong>F1</strong> anytime to show this help</span>
    </div>
  </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

function navigateMonth(direction) {
  const ms = months();
  const currentIndex = ms.indexOf(cur);
  if (direction === -1 && currentIndex > 0) {
    cur = ms[currentIndex - 1];
    renderAll();
  } else if (direction === 1 && currentIndex < ms.length - 1) {
    cur = ms[currentIndex + 1];
    renderAll();
  }
}

document.addEventListener("keydown", (e) => {
  // Command palette works even while a table cell is focused — checked
  // before the INPUT/TEXTAREA bail-out below.
  if (e.ctrlKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    openCommandPalette();
    return;
  }

  // Don't trigger shortcuts when typing in inputs
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") {
    return;
  }

  const key = [];
  if (e.ctrlKey) key.push("Ctrl");
  if (e.altKey) key.push("Alt");
  if (e.shiftKey) key.push("Shift");
  key.push(e.key);

  const shortcut = key.join("+");
  if (SHORTCUTS[shortcut]) {
    e.preventDefault();
    SHORTCUTS[shortcut]();
  }
});

// ════════════════════════════════════════════════════
//  LOADING MANAGEMENT
// ════════════════════════════════════════════════════
function showLoading(text = "Loading...") {
  const overlay = document.getElementById("loading-overlay");
  const loadingText = overlay.querySelector(".loading-text");
  const progressBar = document.getElementById("progress-bar");

  loadingText.textContent = text;
  overlay.classList.add("active");
  progressBar.classList.add("active");
}

function hideLoading() {
  const overlay = document.getElementById("loading-overlay");
  const progressBar = document.getElementById("progress-bar");

  overlay.classList.remove("active");
  progressBar.classList.remove("active");
}

function showErrorOverlay(msg) {
  let el = document.getElementById("error-overlay");
  if (!el) {
    el = document.createElement("div");
    el.id = "error-overlay";
    el.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);display:flex;align-items:center;justify-content:center;z-index:99999;opacity:0;transition:opacity 0.3s ease;";
    el.innerHTML = '<div style="background:#fff;border-radius:12px;padding:24px 32px;max-width:480px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.3);text-align:center"><div style="color:#ef4444;margin-bottom:8px;display:flex;justify-content:center">' + icon("alert-triangle", 32) + '</div><div id="error-msg" style="font-size:14px;color:#374151;margin-bottom:16px;word-break:break-word"></div><button onclick="document.getElementById(\'error-overlay\').style.display=\'none\'" style="background:#ef4444;color:#fff;border:none;padding:8px 24px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer">Dismiss</button></div>';
    document.body.appendChild(el);
    requestAnimationFrame(() => { el.style.opacity = "1"; });
  }
  document.getElementById("error-msg").textContent = msg;
  el.style.display = "flex";
  requestAnimationFrame(() => { el.style.opacity = "1"; });
}

function showButtonLoading(buttonId) {
  const button = document.getElementById(buttonId);
  if (button) {
    const originalContent = button.innerHTML;
    button.innerHTML = '<span class="mini-spinner"></span>Processing...';
    button.disabled = true;
    return () => {
      button.innerHTML = originalContent;
      button.disabled = false;
    };
  }
  return () => {};
}

// Function to manually fix month transitions (callable from console)
function fixMonthTransitions() {
  if (!confirm("This will recalculate all month transitions and overwrite any discrepancies. Continue?")) return;
  requireLogin(() => {
    const allMonths = Object.keys(DB).sort();
    let changesMade = false;

    for (let i = 0; i < allMonths.length; i++) {
      const currentMonth = allMonths[i];

      // Skip the first month
      if (i === 0) continue;

      const prevMonth = allMonths[i - 1];
      const prevMonthData = DB[prevMonth];
      const currentMonthData = DB[currentMonth];

      if (!prevMonthData || prevMonthData.length === 0) continue;
      if (!currentMonthData || currentMonthData.length === 0) continue;

      // Get closing balances from previous month
      const prevLastDay = prevMonthData[prevMonthData.length - 1];
      const prevClosingBalances = calcLocBals(
        prevLastDay.bal,
        prevLastDay.del,
        prevLastDay.imp,
      );

      // Get opening balances from current month
      const currentFirstDay = currentMonthData[0];
      const currentOpeningBalances = currentFirstDay.bal.slice();

      // Check if they match
      const balancesMatch = prevClosingBalances.every(
        (bal, idx) => bal === currentOpeningBalances[idx],
      );

      if (!balancesMatch) {
        // Fix the opening balances
        currentFirstDay.bal = prevClosingBalances.slice();

        // Recalculate all subsequent days in the month
        for (let dayIdx = 1; dayIdx < currentMonthData.length; dayIdx++) {
          const prevDay = currentMonthData[dayIdx - 1];
          const currentDay = currentMonthData[dayIdx];
          currentDay.bal = calcLocBals(prevDay.bal, prevDay.del, prevDay.imp);
        }

        changesMade = true;
      }
    }

    if (changesMade) {
      setDirty(true);
      renderAll();
      // Auto-save after fixing transitions
      doSave();
      showSuccess("Month transitions have been fixed and saved!");
    } else {
      showSuccess("No balance mismatches found.");
    }
  });
}

// ════════════════════════════════════════════════════
//  RENDER ALL
// ════════════════════════════════════════════════════
function renderAll() {
  showLoading("Loading data...");

  // Update current date display
  updateCurrentDate();

  // Use setTimeout to allow UI to update
  setTimeout(() => {
    renderMbar();
    renderSumCards();
    renderGrpCards();
    renderTable();
    if (curPage === "chart") {
      killCharts();
      setTimeout(renderCharts, 60);
    }
    if (curPage === "report") renderReport();
    if (curPage === "settings") renderSettings();

    // Add fade-in animation to the current page
    const currentPage = document.querySelector(".page.on");
    if (currentPage) {
      currentPage.classList.add("fade-in");
      setTimeout(() => currentPage.classList.remove("fade-in"), 300);
    }

    hideLoading();
  }, 100);
}

// ════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════
function updateCurrentDate() {
  const currentDate = new Date();
  const weekday = currentDate.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: sett.tz,
  });
  const ymd = currentDate.toLocaleDateString("en-CA", { timeZone: sett.tz });
  const formattedDate = `${weekday}, ${fmtDMY(ymd)}`;
  const tsubElement = document.getElementById("tsub");
  if (tsubElement) {
    tsubElement.textContent = formattedDate;
  }
}

function init() {
  showLoading("Initializing application...");

  // Update current date display
  updateCurrentDate();

  setTimeout(() => {
    // Performance: Check login status first
    const wasLoggedIn = checkLoginStatus();

    // Load saved admin hash if exists
    const savedHash = localStorage.getItem("adminHash");
    if (savedHash) {
      ADMIN_HASH = savedHash;
    }

    buildHist();

    // Load from Firebase for cloud sync
    loadFromFirebase(() => {
      const corrupted = validateDB();
      if (corrupted) {
        buildHist();
      }
      const n = new Date();
      const currentYear = n.getFullYear();
      const currentMonth = n.getMonth() + 1;
      autoGenerateMonths(currentYear, currentMonth);

      // Do not auto-fix month transitions on load to preserve saved state
      // Manual fix remains available via the Fix Balances button.

      if (isLoggedIn) {
        ensureMonth(currentYear, currentMonth);
        cur = mk(currentYear, currentMonth);
      } else {
        ensureMonth(currentYear, currentMonth);
        cur = mk(currentYear, currentMonth);
      }
      renderAll();
      // Always mark as clean after successful data load
      setDirty(false);

      // Show connected status
      if (firebaseDb) {
        document.getElementById("gs-status").innerHTML =
          '<span style="color:#059669;display:inline-flex;align-items:center;gap:6px">' +
          icon("check-circle", 14) +
          " Connected to cloud (GitHub)</span>";
        loadCloudHistory(false); // populate "Last saved" label
        const el = document.getElementById("conn-status");
        const setConn = (online) => {
          if (online) {
            el.textContent = "Online";
            el.style.color = "#4ade80";
            el.style.borderColor = "rgba(74,222,128,0.3)";
          } else {
            el.textContent = "Offline";
            el.style.color = "#f87171";
            el.style.borderColor = "rgba(248,113,113,0.3)";
          }
        };
        setConn(navigator.onLine);
        window.addEventListener("online", () => setConn(true));
        window.addEventListener("offline", () => setConn(false));
      } else {
        const el = document.getElementById("conn-status");
        el.textContent = "Local only";
        el.style.color = "#fbbf24";
        el.style.borderColor = "rgba(251,191,36,0.3)";
      }
    });
    const n = new Date();
    const todayInTz = n.toLocaleDateString("en-CA", { timeZone: sett.tz });
    document.getElementById("today-lbl").textContent = "Today: " + fmtDMY(todayInTz);

    // Initialize visual feedback
    initializeVisualFeedback();

    // Performance: Add keyboard shortcuts
    initializeKeyboardShortcuts();

    hideLoading();

    // Update login UI based on current state
    updateLoginUI();
    if (isLoggedIn) {
      showSuccess("Welcome back! You are logged in.");
    }
    warnIfDefaultPassword();

    // Show welcome message for first-time users
    if (!localStorage.getItem("car-balance-visited")) {
      showSuccess(
        "Welcome to Daily Car Balance Tracker! Press F1 for keyboard shortcuts.",
      );
      localStorage.setItem("car-balance-visited", "true");
    }
  }, 500);
}

// Performance optimization: Keyboard shortcuts
function initializeKeyboardShortcuts() {
  document.addEventListener("keydown", (e) => {
    // Ctrl+L for logout
    if (e.ctrlKey && e.key === "l") {
      e.preventDefault();
      if (isLoggedIn) {
        logout();
      }
    }
  });
}

// Generate next months seamlessly
function generateNextMonths() {
  if (!confirm("This will generate the next month based on the current month's closing balances. Continue?")) return;
  const now = new Date();
  const todayInTz = now.toLocaleDateString("en-CA", { timeZone: sett.tz });
  const [ty, tm, td] = todayInTz.split("-").map(Number);
  const currentYear = ty;
  const currentMonth = tm;

  // Check if current month exists and has data
  const currentMonthKey = mk(currentYear, currentMonth);
  const currentMonthData = DB[currentMonthKey];

  if (!currentMonthData || currentMonthData.length === 0) {
    showError("Current month data not found!");
    return;
  }

  // Check if current month is complete (has all days)
  const daysInCurrentMonth = dIn(currentYear, currentMonth);
  const hasAllDays = currentMonthData.length >= daysInCurrentMonth;

  if (!hasAllDays) {
    showError("Please complete current month data first!");
    return;
  }

  showLoading("Generating next month...");

  setTimeout(() => {
    // Calculate next month
    let nextMonth = currentMonth + 1;
    let nextYear = currentYear;

    if (nextMonth > 12) {
      nextYear++;
      nextMonth = 1;
    }

    const nextMonthKey = mk(nextYear, nextMonth);

    // Check if next month already exists
    if (DB[nextMonthKey]) {
      showInfo("Next month already exists!");
      hideLoading();
      return;
    }

    // Generate only the next month
    ensureMonth(nextYear, nextMonth);

    // Ensure all months have proper columns
    ensureAllMonthsHaveColumns();

    // Save to localStorage
    doSave();

    // Refresh the current view
    renderAll();

    hideLoading();
    showSuccess(
      `Successfully generated ${getMonthName(nextMonth)} ${nextYear}!`,
    );
  }, 500);
}

// Helper function to get month name
function getMonthName(month) {
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  return months[month - 1];
}

// Auto-generate months and ensure all have proper structure
function autoGenerateMonths(currentYear, currentMonth) {
  // Generate up to 12 months of historical data
  const today = new Date();
  const currentY = today.getFullYear();
  const currentM = today.getMonth() + 1;

  // Generate last 12 months (including current)
  for (let i = 0; i < 12; i++) {
    let month = currentM - i;
    let year = currentY;
    while (month <= 0) {
      month += 12;
      year -= 1;
    }
    ensureMonth(year, month);
  }

  // Also ensure the December before that exists for proper data flow
  ensureMonth(currentY - 1, 12);

  // Ensure all existing months have proper column structure
  ensureAllMonthsHaveColumns();
}

// Ensure all months have proper column structure
function checkAndFixMonthTransitions() {
  // Get all months sorted chronologically
  const allMonths = Object.keys(DB).sort();
  let changesMade = false;

  for (let i = 0; i < allMonths.length; i++) {
    const currentMonth = allMonths[i];
    const [year, month] = currentMonth.split("-").map(Number);

    // Skip the first month (no previous month to compare with)
    if (i === 0) continue;

    const prevMonth = allMonths[i - 1];
    const prevMonthData = DB[prevMonth];
    const currentMonthData = DB[currentMonth];

    if (!prevMonthData || prevMonthData.length === 0) continue;
    if (!currentMonthData || currentMonthData.length === 0) continue;

    // Get closing balances from previous month
    const prevLastDay = prevMonthData[prevMonthData.length - 1];
    const prevClosingBalances = calcLocBals(
      prevLastDay.bal || Array(LOCS.length).fill(0),
      prevLastDay.del || Array(LOCS.length).fill(0),
      prevLastDay.imp || Array(LOCS.length).fill(0),
    );

    // Get opening balances from current month (first day, from stored ob if available)
    const currentFirstDay = currentMonthData[0];
    // Compare against the ob (base) if available, else against current bal
    const compareBase = currentFirstDay.ob
      ? currentFirstDay.ob
      : currentFirstDay.bal.slice();

    // Check if base opening balances match prev month closing
    const balancesMatch = prevClosingBalances.every(
      (bal, idx) => bal === compareBase[idx],
    );

    if (!balancesMatch) {
      // Update stored opening balance and recompute with transfers
      currentFirstDay.ob = prevClosingBalances.slice();
      currentFirstDay.bal = prevClosingBalances.slice();
      applyTransfersToRow(currentFirstDay);

      for (let dayIdx = 1; dayIdx < currentMonthData.length; dayIdx++) {
        const prevDay = currentMonthData[dayIdx - 1];
        const currentDay = currentMonthData[dayIdx];
        currentDay.bal = calcLocBals(prevDay.bal, prevDay.del, prevDay.imp);
        applyTransfersToRow(currentDay);
      }
      changesMade = true;
    }
  }

  if (changesMade) {
    // Don't set dirty during initialization - this is automatic correction
  }
}

function ensureAllMonthsHaveColumns() {
  Object.keys(DB).forEach((monthKey) => {
    const [year, month] = monthKey.split("-").map(Number);
    const rows = DB[monthKey] || [];

    // Ensure each row has all required columns
    rows.forEach((row, rowIdx) => {
      // Ensure arrays have correct length for all locations
      if (!row.del || row.del.length !== LOCS.length) {
        row.del = LOCS.map(() => 0);
      }
      if (!row.imp || row.imp.length !== LOCS.length) {
        row.imp = LOCS.map(() => 0);
      }
      if (!row.bal || row.bal.length !== LOCS.length) {
        row.bal = LOCS.map(() => 0);
      }

      // Ensure other required fields exist
      if (!row.al) row.al = "";
      if (!row.av) row.av = "";
      if (!row.date) row.date = `${year}-${String(month).padStart(2, "0")}-01`;

      // Ensure day-1 has stored opening balance (ob) for transfer recalculation
      if (rowIdx === 0 && !row.ob) row.ob = row.bal.slice();
    });

    // Ensure month has all days
    const daysInMonth = dIn(year, month);
    if (rows.length < daysInMonth) {
      let lastRow = rows[rows.length - 1] || {
        del: LOCS.map(() => 0),
        imp: LOCS.map(() => 0),
        bal: LOCS.map(() => 0),
        al: "",
        av: "",
      };

      for (let d = rows.length + 1; d <= daysInMonth; d++) {
        const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        const newBals = calcLocBals(lastRow.bal, lastRow.del, lastRow.imp);

        DB[monthKey].push({
          date: dateStr,
          del: LOCS.map(() => 0),
          imp: LOCS.map(() => 0),
          bal: newBals,
          al: "",
          av: 0,
        });

        lastRow = DB[monthKey][DB[monthKey].length - 1];
      }
    }
  });
}
init();

// ════════════════════════════════════════════════════
//  SERVICE WORKER REGISTRATION & PWA SETUP
// ════════════════════════════════════════════════════
// Register service worker for offline functionality
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .then((registration) => {

        // Check for updates periodically
        setInterval(() => {
          registration.update();
        }, 60000); // Check every minute
      })
      .catch((error) => {
        console.warn("Service worker registration failed:", error);
      });
  });
}

// Handle PWA install prompt
let deferredPrompt;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  // Show install button or notification
});

// Handle successful app installation
window.addEventListener("appinstalled", () => {
  deferredPrompt = null;
});

// Listen for background sync messages
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data.type === "SYNC_START") {
    }
  });
}
