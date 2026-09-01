// ════════════════════════════════════════════════════
//  FORMULA ENGINE, CONSTANTS & UTILS
// ════════════════════════════════════════════════════
// Split out of app.js: the constants, date/format/escape utilities, the
// password-hashing helpers, and the pure balance-calculation core — the
// layer with no DOM access (no document., no innerHTML, no fetch/
// localStorage in the calculation path). This is what tests/formula.test.js
// exercises directly via `node --test`.
//
// Classic script (no bundler, no ES modules) defining globals, same as
// hist-data.js/icons.js/toast.js/command-palette.js — loaded before app.js.
// isRed() and verifyAgainstStoredHash() are the two exceptions to "no
// dependencies": isRed() reads the global `sett` object and
// verifyAgainstStoredHash() calls the legacy hash() function, both defined
// later in app.js — safe because neither is actually CALLED until well
// after every script has loaded (function declarations hoist within a
// shared global scope the same way across script tags as within one file).

const LOCS = [
  "Warehouse-A",
  "Warehouse-B",
  "Yard No-1",
  "Yard No-7",
  "Shed No-5",
  "Shed No-6",
  "Shed No-7",
  "Shed No-8",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];
function getToday() {
  try {
    return new Date().toLocaleDateString("en-CA", { timeZone: sett.tz });
  } catch {
    return new Date().toLocaleDateString("en-CA");
  }
}
// TODAY itself is computed in app.js, once `sett` (and its `.tz`) exists —
// see the STATE block there. Computing it before `sett` is declared would
// silently fall into the catch above and always use the browser's local
// timezone instead of the configured one.

const LOC_CFG = {
  "Warehouse-A": { bg: "#1e4d7b", lt: "#e8f1fb", cls: "wha" },
  "Warehouse-B": { bg: "#1a5f9e", lt: "#e8f1fb", cls: "whb" },
  "Yard No-1": { bg: "#1a5c3a", lt: "#e6f6ed", cls: "y1" },
  "Yard No-7": { bg: "#1f7a4a", lt: "#e6f6ed", cls: "y7" },
  "Shed No-5": { bg: "#7c3c1a", lt: "#fdf0e6", cls: "s5" },
  "Shed No-6": { bg: "#923f15", lt: "#fdf0e6", cls: "s6" },
  "Shed No-7": { bg: "#a84810", lt: "#fdf0e6", cls: "s7" },
  "Shed No-8": { bg: "#bf500a", lt: "#fdf0e6", cls: "s8" },
};
const GRP_SEC = [
  { lbl: "Warehouse", lis: [0, 1], bg: "#1e4d7b" },
  { lbl: "Yard", lis: [2, 3], bg: "#1a5c3a" },
  { lbl: "Shed", lis: [4, 5, 6, 7], bg: "#7c3c1a" },
];

// ── UTILS ──
const mk = (y, m) => `${y}-${String(m).padStart(2, "0")}`;
const dIn = (y, m) => new Date(y, m, 0).getDate();
const dow = (s) => new Date(s + "T00:00:00").getDay();
// App-wide display format: turn a stored "YYYY-MM-DD" date into "dd-mm-yyyy".
// (Storage/lookup keys stay "YYYY-MM-DD" — only the on-screen text changes.)
const fmtDMY = (s) => {
  if (!s) return "—";
  const [y, m, d] = String(s).split("-");
  return d && m && y ? `${d}-${m}-${y}` : s;
};

// Manual date entry fields use dd/mm/yyyy (slashes) for display while the value
// is stored as yyyy-mm-dd. These helpers convert between the two and auto-insert
// slashes as the user types.
const isoToDMY = (s) => {
  if (!s) return "";
  const [y, m, d] = String(s).split("-");
  return d && m && y ? `${d}/${m}/${y}` : "";
};
function dmyToISO(s) {
  if (!s) return "";
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // already ISO
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return "";
  const d = m[1].padStart(2, "0"),
    mo = m[2].padStart(2, "0"),
    y = m[3];
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31) return "";
  return `${y}-${mo}-${d}`;
}
const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString() : "—");
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
// Escape untrusted data before inserting into HTML (data may come from
// other devices via Firebase sync, so treat all stored strings as untrusted)
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── Password storage (login only — see computeWriteAuth in app.js for the
// separate, unsalted cloud write-key derivation, which intentionally stays
// cheap since the Worker recomputes it on every save). ──
//
// Stored account passwords go through salted PBKDF2 instead of a single
// SHA-256 pass, which is fast enough to brute-force offline if the hash
// ever leaks (and it does leave the device — adminHash/users sync into
// data.json, which the Worker serves unauthenticated by design so viewers
// can load the app without logging in). Three formats can be found in
// ADMIN_HASH/users[u], oldest first: the 32-bit legacy hash() in app.js, a
// bare SHA-256 hex string, and "pbkdf2:<iterations>:<saltHex>:<hashHex>".
// verifyAgainstStoredHash() accepts all three; checkCred() in app.js
// upgrades to the PBKDF2 format on any successful login that wasn't
// already using it.
const PBKDF2_ITERATIONS = 150000;

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}
async function pbkdf2DeriveHex(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: saltBytes, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  );
  return bytesToHex(new Uint8Array(bits));
}
// Creates a new salted hash for storage.
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashHex = await pbkdf2DeriveHex(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2:${PBKDF2_ITERATIONS}:${bytesToHex(salt)}:${hashHex}`;
}
function isPBKDF2Hash(stored) {
  return typeof stored === "string" && stored.startsWith("pbkdf2:");
}
// Verifies `password` against `stored` in whichever of the three formats
// it's in. Does not upgrade the stored value — callers that persist do so.
async function verifyAgainstStoredHash(password, stored) {
  if (!stored) return false;
  if (isPBKDF2Hash(stored)) {
    const parts = stored.split(":");
    if (parts.length !== 4) return false;
    const iterations = parseInt(parts[1], 10);
    const salt = hexToBytes(parts[2]);
    const expectedHex = parts[3];
    const actualHex = await pbkdf2DeriveHex(password, salt, iterations);
    return actualHex === expectedHex;
  }
  if ((await sha256(password)) === stored) return true;
  if (hash(password) === stored) return true;
  return false;
}

function isRed(s) {
  if (sett.excs.includes(s)) return false;
  const d = dow(s);
  if ((d === 5 && sett.fri) || (d === 6 && sett.sat) || (d === 0 && sett.sun))
    return true;
  return sett.hols.includes(s);
}

// ════════════════════════════════════════════════════
//  FORMULA ENGINE — exact Excel logic
// ════════════════════════════════════════════════════
// loc_bal[i] for day-1 of month: ob[i]  (opening balance = hardcoded)
// loc_bal[i] for day-N (N>1): prev_loc_bal[i] - prev_del[i] + prev_imp[i]
// closing_balance = sum(loc_bals) - total_delivery_today + total_import_today

function calcLocBals(prevBals, del, imp) {
  // prevBals: loc bals from previous row (or opening if day 1)
  // This gives TODAY's loc bals = prevBals unchanged (loc bal carries from prev day)
  // Wait: loc_bal[N] = loc_bal[N-1] - del[N-1] + imp[N-1]
  // So when we call this for row N, we pass row[N-1] bals and row[N-1] del/imp
  return prevBals.map((b, i) => b - del[i] + imp[i]);
}

function calcClosing(locBals, del, imp) {
  // closing = sum(locBals) - sum(del) + sum(imp)
  const sumBal = locBals.reduce((a, b) => a + b, 0);
  const totDel = del.reduce((a, b) => a + b, 0);
  const totImp = imp.reduce((a, b) => a + b, 0);
  return sumBal - totDel + totImp;
}

function getClosing(row) {
  if (!row) return 0;
  const bal = Array.isArray(row.bal) ? row.bal : LOCS.map(() => 0);
  const del = Array.isArray(row.del) ? row.del : LOCS.map(() => 0);
  const imp = Array.isArray(row.imp) ? row.imp : LOCS.map(() => 0);
  return calcClosing(bal, del, imp);
}

// Self-heals one DB row against corruption that can arrive from a cloud
// sync (another device, a partial write, an old data format): pads/trims
// del/imp/bal to LOCS.length and maps NaN entries to 0, clears a malformed
// `ob`, and returns { row, issues } — issues is a list of human-readable
// strings for validateDB()'s corruption-count escalation. Returns
// { row: null, issues } for a row that isn't salvageable (not an object,
// or no date) so the caller can drop it instead of crashing on it.
function normalizeRow(row, rowLabel) {
  const issues = [];
  if (!row || typeof row !== "object" || !row.date) {
    issues.push(rowLabel + " missing date");
    return { row: null, issues };
  }
  const fixArr = (name) => {
    const arr = Array.isArray(row[name]) ? row[name] : [];
    if (!Array.isArray(row[name]) || row[name].length !== LOCS.length) {
      issues.push(rowLabel + " invalid " + name + "[]");
    }
    return LOCS.map((_, i) => {
      const n = Number(arr[i]);
      return Number.isFinite(n) ? n : 0;
    });
  };
  const out = Object.assign({}, row, {
    del: fixArr("del"),
    imp: fixArr("imp"),
    bal: fixArr("bal"),
  });
  if (out.ob != null) {
    const validOb =
      Array.isArray(out.ob) &&
      out.ob.length === LOCS.length &&
      out.ob.every((n) => Number.isFinite(Number(n)));
    if (!validOb) {
      issues.push(rowLabel + " invalid ob[], cleared");
      out.ob = null;
    }
  }
  return { row: out, issues };
}

function validateNumber(value, fieldName, min = 0, max = 99999) {
  const num = parseInt(value);

  if (isNaN(num)) {
    return {
      isValid: false,
      error: `${fieldName} must be a valid number`,
      value: 0,
    };
  }

  if (num < min) {
    return {
      isValid: false,
      error: `${fieldName} cannot be less than ${min}`,
      value: min,
    };
  }

  if (num > max) {
    return {
      isValid: false,
      error: `${fieldName} cannot exceed ${max}`,
      value: max,
    };
  }

  return {
    isValid: true,
    error: null,
    value: num,
  };
}

// Inert in the browser (`module` is undefined there) — lets
// `node --test` require() this file directly for tests/formula.test.js
// without affecting how index.html loads it as a classic script.
if (typeof module !== "undefined") {
  module.exports = {
    LOCS,
    DAYS,
    MO,
    LOC_CFG,
    GRP_SEC,
    getToday,
    mk,
    dIn,
    dow,
    fmtDMY,
    isoToDMY,
    dmyToISO,
    fmt,
    pct,
    esc,
    sha256,
    PBKDF2_ITERATIONS,
    bytesToHex,
    hexToBytes,
    pbkdf2DeriveHex,
    hashPassword,
    isPBKDF2Hash,
    verifyAgainstStoredHash,
    isRed,
    calcLocBals,
    calcClosing,
    getClosing,
    normalizeRow,
    validateNumber,
  };
}
