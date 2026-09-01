// Ctrl+K command palette — jump to a tab, month, location, report section,
// or run a common action without touching the mouse. Opened from the
// global keydown handler in app.js (checked before that handler's
// INPUT/TEXTAREA bail-out, so it also opens while a table cell is focused).

let cpItems = [];
let cpFiltered = [];
let cpActiveIndex = 0;

const RPT_SECTIONS = [
  ["rpt-sec-executive", "Executive Summary"],
  ["rpt-sec-monthly", "Monthly Trend Analysis"],
  ["rpt-sec-location", "Location Performance"],
  ["rpt-sec-loccompare", "Location vs Previous Month"],
  ["rpt-sec-group", "Group Performance (Warehouse / Yard / Shed)"],
  ["rpt-sec-ranking", "Location Efficiency Ranking"],
  ["rpt-sec-daily-log", "Daily Operations Log"],
  ["rpt-sec-peak", "Peak Activity Days"],
  ["rpt-sec-flow", "Monthly Balance Flow"],
  ["rpt-sec-dow", "Day-of-Week Activity Patterns"],
  ["rpt-sec-transfers", "Car Transfer History"],
  ["rpt-sec-yoy", "Year-over-Year Comparison"],
  ["rpt-sec-auction", "Auction Delivery Report"],
];

function cpGoToReportSection(id) {
  showPage("report", document.querySelectorAll(".ntab")[2]);
  setTimeout(() => {
    const sec = document.getElementById(id);
    if (!sec) return;
    sec.classList.remove("collapsed");
    const arrow = sec.querySelector(".rpt-sec-arrow");
    if (arrow) arrow.textContent = "▴";
    sec.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 350);
}

function getCommandPaletteItems() {
  const items = [];

  [
    ["daily", "Daily Entry", "calendar"],
    ["chart", "Charts", "bar-chart-3"],
    ["report", "Reports", "clipboard-list"],
    ["transfer", "Car Transfer", "arrow-left-right"],
    ["settings", "Settings", "settings"],
  ].forEach(([id, label, ic], i) => {
    items.push({
      group: "Go to tab",
      label,
      icon: ic,
      action: () => showPage(id, document.querySelectorAll(".ntab")[i]),
    });
  });

  months().forEach((k) => {
    const [y, m] = k.split("-").map(Number);
    items.push({
      group: "Jump to month",
      label: MO[m - 1] + " " + y,
      icon: "calendar",
      action: () => {
        cur = k;
        showPage("daily", document.querySelector(".ntab"));
        renderAll();
      },
    });
  });

  LOCS.forEach((loc, li) => {
    items.push({
      group: "Filter daily table to location",
      label: loc,
      icon: "map-pin",
      action: () => {
        showPage("daily", document.querySelector(".ntab"));
        locFilter = locFilter.map((_, i) => i === li);
        localStorage.setItem(LOC_FILTER_LS, JSON.stringify(locFilter));
        renderTable();
      },
    });
  });

  RPT_SECTIONS.forEach(([id, label]) => {
    items.push({
      group: "Report section",
      label,
      icon: "clipboard-list",
      action: () => cpGoToReportSection(id),
    });
  });

  items.push(
    { group: "Action", label: "Save", icon: "save", action: () => doSave() },
    {
      group: "Action",
      label: "Export to Excel",
      icon: "download",
      action: () => document.getElementById("ov-export").classList.add("on"),
    },
    { group: "Action", label: "Fix Balances", icon: "refresh-cw", action: () => fixMonthTransitions() },
    { group: "Action", label: "Generate Next Month", icon: "plus", action: () => generateNextMonths() },
    {
      group: "Action",
      label: "Load Bangladesh Holidays",
      icon: "calendar",
      action: () => {
        showPage("settings", document.querySelectorAll(".ntab")[4]);
        setTimeout(loadBDHolidays, 100);
      },
    },
    {
      group: "Action",
      label: "Version History",
      icon: "history",
      action: () => {
        showPage("settings", document.querySelectorAll(".ntab")[4]);
        setTimeout(showCloudHistory, 100);
      },
    },
    isLoggedIn
      ? { group: "Action", label: "Logout", icon: "log-out", action: () => logout() }
      : { group: "Action", label: "Login", icon: "lock", action: () => showLoginForm() },
  );

  return items;
}

function fuzzyMatch(label, query) {
  if (!query) return true;
  return label.toLowerCase().includes(query.toLowerCase());
}

function openCommandPalette() {
  closeCommandPalette();
  cpItems = getCommandPaletteItems();
  cpActiveIndex = 0;

  const overlay = document.createElement("div");
  overlay.id = "cmdk-overlay";
  overlay.className = "ov on";
  overlay.innerHTML =
    '<div class="cmdk-box" role="dialog" aria-modal="true" aria-label="Command palette">' +
    '<div class="cmdk-input-row">' +
    icon("search", 16) +
    '<input type="text" id="cmdk-input" placeholder="Jump to a tab, month, location, report section, or action…" autocomplete="off" />' +
    "</div>" +
    '<div class="cmdk-list" id="cmdk-list"></div>' +
    "</div>";
  overlay.onclick = (e) => {
    if (e.target === overlay) closeCommandPalette();
  };
  document.body.appendChild(overlay);

  renderCommandPaletteList("");
  const input = document.getElementById("cmdk-input");
  input.addEventListener("input", () => {
    cpActiveIndex = 0;
    renderCommandPaletteList(input.value);
  });
  input.addEventListener("keydown", cmdkInputKeydown);
  input.focus();
}

function closeCommandPalette() {
  const el = document.getElementById("cmdk-overlay");
  if (el) el.remove();
}

function renderCommandPaletteList(query) {
  cpFiltered = cpItems.filter((it) => fuzzyMatch(it.label, query) || fuzzyMatch(it.group, query));
  const list = document.getElementById("cmdk-list");
  if (!list) return;
  if (!cpFiltered.length) {
    list.innerHTML = '<div class="cmdk-empty">No matches</div>';
    return;
  }
  let lastGroup = null;
  let html = "";
  cpFiltered.forEach((it, i) => {
    if (it.group !== lastGroup) {
      html += `<div class="cmdk-group">${esc(it.group)}</div>`;
      lastGroup = it.group;
    }
    html += `<div class="cmdk-item${i === cpActiveIndex ? " active" : ""}" data-idx="${i}">${icon(it.icon, 15)}<span>${esc(it.label)}</span></div>`;
  });
  list.innerHTML = html;
  list.querySelectorAll(".cmdk-item").forEach((el) => {
    el.onclick = () => runCommandPaletteItem(parseInt(el.dataset.idx, 10));
  });
  const activeEl = list.querySelector(".cmdk-item.active");
  if (activeEl) activeEl.scrollIntoView({ block: "nearest" });
}

function runCommandPaletteItem(idx) {
  const item = cpFiltered[idx];
  if (!item) return;
  closeCommandPalette();
  item.action();
}

function cmdkInputKeydown(e) {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    cpActiveIndex = Math.min(cpActiveIndex + 1, cpFiltered.length - 1);
    renderCommandPaletteList(document.getElementById("cmdk-input").value);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    cpActiveIndex = Math.max(cpActiveIndex - 1, 0);
    renderCommandPaletteList(document.getElementById("cmdk-input").value);
  } else if (e.key === "Enter") {
    e.preventDefault();
    runCommandPaletteItem(cpActiveIndex);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeCommandPalette();
  }
}
