// Tests for src/formula.js — the DOM-free layer of app.js (constants,
// date/format utilities, password hashing, and the balance-calculation
// core). No framework, no package.json: Node's built-in test runner.
//
//   node --test tests/
//
// formula.js is a classic script that defines browser globals; it exports
// the same names via `module.exports` only when `typeof module !==
// "undefined"` (i.e. only under Node), so requiring it here doesn't
// change how index.html loads it.
//
// isRed() and verifyAgainstStoredHash() read bare identifiers (`sett`,
// `hash`) that are globals in the browser (defined elsewhere in app.js)
// rather than parameters. To exercise them here, this file assigns to
// Node's `global` object before requiring formula.js — `global` is
// actually shared across modules, unlike a module-scoped `const`, so it
// reproduces the browser's shared-global-scope semantics.

const test = require("node:test");
const assert = require("node:assert/strict");

// Fixture `sett` for isRed() — Friday/Saturday are the default weekly
// holidays per CLAUDE.md, plus one custom holiday and one exception.
global.sett = {
  fri: true,
  sat: true,
  sun: false,
  hols: ["2026-12-25"], // custom red date (Christmas)
  excs: ["2026-09-04"], // a Friday explicitly forced back to a working day
};
// Minimal stand-in for app.js's legacy 32-bit hash(), used by
// verifyAgainstStoredHash()'s oldest-format fallback.
global.hash = function (str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h = h & h;
  }
  return h.toString(36);
};

const f = require("../src/formula.js");

test("calcLocBals — balance carries forward: prev - del + imp", () => {
  assert.deepEqual(f.calcLocBals([100, 200], [10, 0], [0, 5]), [90, 205]);
  assert.deepEqual(f.calcLocBals([0, 0], [0, 0], [0, 0]), [0, 0]);
  // Delivery can exceed the running balance (the app allows negative stock
  // rather than silently clamping — that's a real signal something's off
  // upstream, not something calcLocBals should hide).
  assert.deepEqual(f.calcLocBals([5], [10], [0]), [-5]);
});

test("calcClosing — sum(locBals) - sum(del) + sum(imp)", () => {
  assert.equal(f.calcClosing([100, 200], [10, 20], [5, 0]), 275);
  assert.equal(f.calcClosing([0], [0], [0]), 0);
});

test("getClosing — reads a DB row, defaults missing arrays to zero-filled LOCS-length", () => {
  assert.equal(f.getClosing({ bal: [100, 50], del: [10, 0], imp: [0, 0] }), 140);
  assert.equal(f.getClosing(null), 0);
  assert.equal(f.getClosing({}), 0); // bal/del/imp missing -> all-zero LOCS.length arrays
});

test("mk — builds a zero-padded YYYY-MM month key", () => {
  assert.equal(f.mk(2026, 9), "2026-09");
  assert.equal(f.mk(2026, 12), "2026-12");
  assert.equal(f.mk(2026, 1), "2026-01");
});

test("dIn — days in month, including February leap-year edge cases", () => {
  assert.equal(f.dIn(2026, 9), 30); // September
  assert.equal(f.dIn(2026, 1), 31); // January
  assert.equal(f.dIn(2024, 2), 29); // 2024 is a leap year
  assert.equal(f.dIn(2026, 2), 28); // 2026 is not
  assert.equal(f.dIn(2000, 2), 29); // divisible by 400 -> leap
  assert.equal(f.dIn(1900, 2), 28); // divisible by 100 but not 400 -> not leap
});

test("fmtDMY / isoToDMY / dmyToISO round-trip an ISO date", () => {
  assert.equal(f.fmtDMY("2026-09-02"), "02-09-2026");
  assert.equal(f.fmtDMY(""), "—");
  assert.equal(f.isoToDMY("2026-09-02"), "02/09/2026");
  assert.equal(f.isoToDMY(""), "");
  assert.equal(f.dmyToISO("02/09/2026"), "2026-09-02");
  assert.equal(f.dmyToISO("2026-09-02"), "2026-09-02"); // already ISO, passes through
  assert.equal(f.dmyToISO("31/13/2026"), ""); // invalid month
  assert.equal(f.dmyToISO("not a date"), "");

  // Full round trip: ISO -> dd/mm/yyyy -> ISO
  const iso = "2026-01-05";
  assert.equal(f.dmyToISO(f.isoToDMY(iso)), iso);
});

test("fmt / pct — display formatting and percent-change", () => {
  assert.equal(f.fmt(1234567), (1234567).toLocaleString());
  assert.equal(f.fmt(NaN), "—");
  assert.equal(f.pct(110, 100), 10);
  assert.equal(f.pct(90, 100), -10);
  assert.equal(f.pct(100, 0), null); // divide-by-zero guard
});

test("esc — escapes all five HTML-significant characters", () => {
  assert.equal(f.esc(`<script>alert("x")&'y'</script>`), "&lt;script&gt;alert(&quot;x&quot;)&amp;&#39;y&#39;&lt;/script&gt;");
  assert.equal(f.esc(null), "");
  assert.equal(f.esc(undefined), "");
  assert.equal(f.esc(123), "123");
});

test("validateNumber — clamps to [min, max] and flags invalid input", () => {
  assert.deepEqual(f.validateNumber("50", "Delivery", 0, 100), {
    isValid: true,
    error: null,
    value: 50,
  });
  assert.equal(f.validateNumber("-5", "Delivery", 0, 100).value, 0);
  assert.equal(f.validateNumber("-5", "Delivery", 0, 100).isValid, false);
  assert.equal(f.validateNumber("9999", "Delivery", 0, 100).value, 100);
  assert.equal(f.validateNumber("abc", "Delivery", 0, 100).isValid, false);
  assert.equal(f.validateNumber("abc", "Delivery", 0, 100).value, 0);
});

test("isRed — precedence: exception overrides weekly holiday overrides custom holiday", () => {
  // 2026-09-04 is a Friday, and Friday is a weekly holiday per the fixture,
  // but it's also listed in sett.excs — exceptions always win.
  assert.equal(f.isRed("2026-09-04"), false);
  // A different Friday (not excepted) is red.
  assert.equal(f.isRed("2026-09-11"), true);
  // A plain Wednesday with no holiday is not red.
  assert.equal(f.isRed("2026-09-02"), false);
  // A custom holiday date (not a Fri/Sat) is red.
  assert.equal(f.isRed("2026-12-25"), true);
});

test("hashPassword / verifyAgainstStoredHash — PBKDF2 round-trip and salting", async () => {
  const h1 = await f.hashPassword("MySecurePass123");
  assert.ok(f.isPBKDF2Hash(h1));
  assert.ok(await f.verifyAgainstStoredHash("MySecurePass123", h1));
  assert.ok(!(await f.verifyAgainstStoredHash("WrongPassword", h1)));

  // Same password, hashed twice, produces different output (random salt).
  const h2 = await f.hashPassword("MySecurePass123");
  assert.notEqual(h1, h2);
  assert.ok(await f.verifyAgainstStoredHash("MySecurePass123", h2));
});

test("verifyAgainstStoredHash — accepts the two older stored formats too", async () => {
  const bareSha256 = await f.sha256("admin");
  assert.ok(await f.verifyAgainstStoredHash("admin", bareSha256));
  assert.ok(!(await f.verifyAgainstStoredHash("notadmin", bareSha256)));

  const legacy = global.hash("admin");
  assert.ok(await f.verifyAgainstStoredHash("admin", legacy));
});

test("ADMIN_DEFAULT_SHA256-shaped constant matches a live sha256('admin')", async () => {
  // app.js hardcodes this exact value as the fresh-install default hash —
  // pinned here so a future edit to sha256() would be caught immediately.
  assert.equal(
    await f.sha256("admin"),
    "8c6976e5b5410415bde908bd4dee15dfb167a9c873fc4bb8a81f6f2ab448a918",
  );
});
