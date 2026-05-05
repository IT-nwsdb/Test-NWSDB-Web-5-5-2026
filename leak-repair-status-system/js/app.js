const DATA = globalThis.APP_DATA || { regions: [] };
const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const enc = encodeURIComponent;

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDjY5JruLWTfcHP6RjAYnMyDwtiZxwPU_c",
  authDomain: "nrw-water-leaks.firebaseapp.com",
  projectId: "nrw-water-leaks",
  storageBucket: "nrw-water-leaks.firebasestorage.app",
  messagingSenderId: "534970349569",
  appId: "1:534970349569:web:8fc15846b50e58aee86800"
};

const FIRESTORE_COLLECTION = "leakRepairStatus";
const FIREBASE_VERSION = "12.12.1";

let firebaseApi = null;
let firebaseReady = initFirebase();
let activeRegion = null;
let activeSheet = null;
let activeSavedData = null;

function regions() { return DATA.regions || []; }
function regionById(id) { return regions().find((r) => r.id === id) || regions()[0]; }
function sheets(region) { return region ? (region.sheets || []) : []; }
function text(v) { return v == null ? "" : String(v); }
function openLocations(regionId) { location.href = `locations.html?region=${enc(regionId)}`; }
function openEntry(regionId, sheetName) { location.href = `entry.html?region=${enc(regionId)}&sheet=${enc(sheetName)}`; }

function colName(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseRef(ref) {
  const m = String(ref).match(/^([A-Z]+)(\d+)$/);
  let c = 0;
  for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64;
  return { c, r: Number(m[2]) };
}

function makeDocId(regionId, sheetName) {
  return `${regionId}__${sheetName}`.replace(/[^A-Za-z0-9_-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}_`);
}

function originalValue(sheet, ref) {
  return text(sheet.cells && sheet.cells[ref] ? sheet.cells[ref].v : "");
}

function currentValue(sheet, saved, ref) {
  return saved && saved.cells && Object.prototype.hasOwnProperty.call(saved.cells, ref)
    ? text(saved.cells[ref])
    : originalValue(sheet, ref);
}

function setStatus(message, isError = false) {
  const el = $("status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("error", Boolean(isError));
}

function setBusy(isBusy) {
  ["saveTopBtn", "clearBtn", "switchSheet"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = Boolean(isBusy);
  });
}

function formatSavedAt(saved) {
  if (!saved) return "";
  if (saved.savedAt && typeof saved.savedAt.toDate === "function") {
    return saved.savedAt.toDate().toLocaleString();
  }
  if (saved.savedAtClient) return new Date(saved.savedAtClient).toLocaleString();
  return "unknown time";
}

async function initFirebase() {
  try {
    const [appMod, firestoreMod, authMod] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-firestore.js`),
      import(`https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/firebase-auth.js`)
    ]);

    const app = appMod.initializeApp(FIREBASE_CONFIG);
    const auth = authMod.getAuth(app);
    await authMod.signInAnonymously(auth);

    firebaseApi = {
      app,
      auth,
      db: firestoreMod.getFirestore(app),
      doc: firestoreMod.doc,
      getDoc: firestoreMod.getDoc,
      setDoc: firestoreMod.setDoc,
      deleteDoc: firestoreMod.deleteDoc,
      collection: firestoreMod.collection,
      query: firestoreMod.query,
      where: firestoreMod.where,
      getDocs: firestoreMod.getDocs,
      serverTimestamp: firestoreMod.serverTimestamp
    };

    return firebaseApi;
  } catch (error) {
    console.error("Firebase connection failed:", error);
    firebaseApi = null;
    return null;
  }
}

async function requireFirebase() {
  const api = await firebaseReady;
  if (!api) {
    throw new Error("Firebase connection failed. Check internet connection, enable Anonymous Authentication, and publish the Firestore rules.");
  }
  return api;
}

async function getSaved(regionId, sheetName) {
  const api = await requireFirebase();
  const id = makeDocId(regionId, sheetName);
  const ref = api.doc(api.db, FIRESTORE_COLLECTION, id);
  const snap = await api.getDoc(ref);
  return snap.exists() ? snap.data() : null;
}

async function setSaved(region, sheet, cells) {
  const api = await requireFirebase();
  const id = makeDocId(region.id, sheet.name);
  const ref = api.doc(api.db, FIRESTORE_COLLECTION, id);
  const payload = {
    docId: id,
    regionId: region.id,
    regionName: region.name,
    sheetName: sheet.name,
    sheetType: sheet.type || "location",
    maxRows: Number(sheet.maxRows || 0),
    maxCols: Number(sheet.maxCols || 0),
    savedAt: api.serverTimestamp(),
    savedAtClient: new Date().toISOString(),
    cells
  };
  await api.setDoc(ref, payload, { merge: false });
  return payload;
}

async function deleteSaved(regionId, sheetName) {
  const api = await requireFirebase();
  const id = makeDocId(regionId, sheetName);
  const ref = api.doc(api.db, FIRESTORE_COLLECTION, id);
  await api.deleteDoc(ref);
}

async function getSavedSheetsForRegion(regionId) {
  const api = await requireFirebase();
  const q = api.query(
    api.collection(api.db, FIRESTORE_COLLECTION),
    api.where("regionId", "==", regionId)
  );
  const snap = await api.getDocs(q);
  const saved = new Map();
  snap.forEach((docSnap) => {
    const data = docSnap.data();
    if (data && data.sheetName) saved.set(data.sheetName, data);
  });
  return saved;
}

function statusTag(savedIndex, sheet, isChecking, hasError) {
  if (hasError) return `<span class="tag error-tag">DB error</span>`;
  if (isChecking) return `<span class="tag">Checking...</span>`;
  return savedIndex.has(sheet.name)
    ? `<span class="tag saved">Saved</span>`
    : `<span class="tag">Not saved</span>`;
}

function initHome() {
  const select = $("regionSelect");
  regions().forEach((r, i) => {
    const o = document.createElement("option");
    o.value = r.id;
    o.textContent = r.name;
    if (i === 0) o.selected = true;
    select.appendChild(o);
  });
  $("continueBtn").onclick = () => openLocations(select.value);
}

function initLocations() {
  const region = regionById(params.get("region"));
  if (!region) {
    document.body.innerHTML = '<div class="empty">Region not found.</div>';
    return;
  }

  $("regionName").textContent = region.name;
  const sheetSelect = $("sheetSelect");
  sheets(region).forEach((s) => {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = s.type === "summary" ? `Summary - ${s.name}` : s.name;
    sheetSelect.appendChild(o);
  });
  $("openBtn").onclick = () => openEntry(region.id, sheetSelect.value);

  let savedIndex = new Map();
  let isChecking = true;
  let hasError = false;

  function render(q = "") {
    q = q.toLowerCase();
    const body = $("sheetRows");
    body.innerHTML = "";

    sheets(region)
      .filter((s) => s.name.toLowerCase().includes(q))
      .forEach((s) => {
        const tr = document.createElement("tr");
        const type = s.type === "summary" ? '<span class="tag summary">Summary</span>' : '<span class="tag">Location</span>';
        tr.innerHTML = `<td><strong>${s.name}</strong></td><td>${type}</td><td>${s.maxRows}</td><td>${statusTag(savedIndex, s, isChecking, hasError)}</td><td><button class="btn primary">Open</button></td>`;
        tr.querySelector("button").onclick = () => openEntry(region.id, s.name);
        body.appendChild(tr);
      });

    if (!body.children.length) {
      body.innerHTML = '<tr><td colspan="5" class="empty">No sheet found.</td></tr>';
    }
  }

  render();
  $("searchBox").oninput = (e) => render(e.target.value);

  getSavedSheetsForRegion(region.id)
    .then((saved) => {
      savedIndex = saved;
      isChecking = false;
      render($("searchBox").value || "");
    })
    .catch((error) => {
      console.error(error);
      isChecking = false;
      hasError = true;
      render($("searchBox").value || "");
    });
}

function mergeMaps(sheet) {
  const starts = {};
  const covered = new Set();
  (sheet.merges || []).forEach((m) => {
    const st = parseRef(m.start);
    const en = parseRef(m.end);
    const colspan = en.c - st.c + 1;
    const rowspan = en.r - st.r + 1;
    starts[m.start] = { colspan, rowspan };
    for (let r = st.r; r <= en.r; r++) {
      for (let c = st.c; c <= en.c; c++) {
        const ref = colName(c) + r;
        if (ref !== m.start) covered.add(ref);
      }
    }
  });
  return { starts, covered };
}

function headerLike(r, c, val, sheet) {
  const v = text(val).toLowerCase();
  if (r === 1 || (sheet.type === "summary" && r <= 2)) return true;
  return ["date", "reported", "repaired", "balance", "manager", "scheme", "total"].some((x) => v.includes(x));
}

function visibleColumns(sheet) {
  if (Array.isArray(sheet.visibleCols) && sheet.visibleCols.length) return sheet.visibleCols;

  const counts = {};
  Object.keys(sheet.cells || {}).forEach((ref) => {
    const v = originalValue(sheet, ref).trim();
    if (!v) return;
    const p = parseRef(ref);
    if (p.r <= 8) {
      counts[p.r] = counts[p.r] || new Set();
      counts[p.r].add(p.c);
    }
  });

  let best = [];
  Object.values(counts).forEach((set) => {
    const a = [...set].sort((x, y) => x - y);
    if (a.length > best.length) best = a;
  });
  if (best.length) return best;

  const cols = new Set();
  Object.keys(sheet.cells || {}).forEach((ref) => {
    if (originalValue(sheet, ref).trim()) cols.add(parseRef(ref).c);
  });
  return [...cols].sort((x, y) => x - y);
}

function clampMerge(m, cols) {
  const allowed = new Set(cols);
  const st = parseRef(m.start);
  const en = parseRef(m.end);
  const mergeCols = cols.filter((c) => c >= st.c && c <= en.c && allowed.has(c));
  const colspan = mergeCols.length;
  const rowspan = en.r - st.r + 1;
  return colspan > 1 || rowspan > 1 ? { colspan, rowspan } : null;
}

function buildTable(region, sheet, saved) {
  const maps = mergeMaps(sheet);
  const cols = visibleColumns(sheet);
  const table = document.createElement("table");
  table.className = "excel-table";
  table.dataset.visibleCols = JSON.stringify(cols);
  table.dataset.maxRows = String(sheet.maxRows || 0);

  const thead = document.createElement("thead");
  const hr = document.createElement("tr");
  hr.innerHTML = '<th class="row-head"></th>';
  cols.forEach((c) => {
    const th = document.createElement("th");
    th.textContent = colName(c);
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 1; r <= sheet.maxRows; r++) {
    const tr = document.createElement("tr");
    const rh = document.createElement("th");
    rh.className = "row-head";
    rh.textContent = r;
    tr.appendChild(rh);

    cols.forEach((c) => {
      const ref = colName(c) + r;
      if (maps.covered.has(ref) && !maps.starts[ref]) return;

      const td = document.createElement("td");
      td.contentEditable = "true";
      td.spellcheck = false;
      td.dataset.ref = ref;
      td.dataset.row = String(r);
      td.dataset.col = String(c);
      td.dataset.original = originalValue(sheet, ref);
      td.textContent = currentValue(sheet, saved, ref);

      if (c === cols[0]) td.classList.add("date");
      if (headerLike(r, c, td.textContent, sheet)) td.classList.add("header");
      if (saved && saved.cells && Object.prototype.hasOwnProperty.call(saved.cells, ref)) td.classList.add("changed");

      const rawMerge = maps.starts[ref];
      const m = rawMerge
        ? clampMerge({
            start: ref,
            end: colName(parseRef(ref).c + rawMerge.colspan - 1) + (parseRef(ref).r + rawMerge.rowspan - 1)
          }, cols)
        : null;
      if (m) {
        td.colSpan = m.colspan;
        td.rowSpan = m.rowspan;
      }

      td.addEventListener("input", () => td.classList.add("changed"));
      td.addEventListener("keydown", handleCellKeyNavigation);
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }

  table.appendChild(tbody);
  return table;
}

function getCaretOffsetWithin(element) {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  const range = selection.getRangeAt(0);
  const preRange = range.cloneRange();
  preRange.selectNodeContents(element);
  preRange.setEnd(range.startContainer, range.startOffset);
  return preRange.toString().length;
}

function getCellTextLength(cell) {
  return text(cell.textContent).length;
}

function focusAndSelectCell(cell) {
  if (!cell) return;
  cell.focus({ preventScroll: true });

  const range = document.createRange();
  range.selectNodeContents(cell);
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);

  cell.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function focusNearestCell(currentCell, targetRow, targetCol) {
  const table = currentCell.closest("table");
  if (!table) return false;

  const maxRows = Number(table.dataset.maxRows || 0);
  const cols = JSON.parse(table.dataset.visibleCols || "[]");
  const colIndex = cols.indexOf(targetCol);
  if (targetRow < 1 || targetRow > maxRows || colIndex < 0) return false;

  const rowStep = targetRow === Number(currentCell.dataset.row) ? 0 : Math.sign(targetRow - Number(currentCell.dataset.row));
  const colStep = colIndex === cols.indexOf(Number(currentCell.dataset.col)) ? 0 : Math.sign(colIndex - cols.indexOf(Number(currentCell.dataset.col)));

  let r = targetRow;
  let ci = colIndex;
  while (r >= 1 && r <= maxRows && ci >= 0 && ci < cols.length) {
    const ref = colName(cols[ci]) + r;
    const nextCell = table.querySelector(`[data-ref="${CSS.escape(ref)}"]`);
    if (nextCell) {
      focusAndSelectCell(nextCell);
      return true;
    }

    if (rowStep !== 0) r += rowStep;
    else if (colStep !== 0) ci += colStep;
    else break;
  }

  return false;
}

function handleCellKeyNavigation(event) {
  const keyMoves = {
    ArrowUp: [-1, 0],
    ArrowDown: [1, 0],
    ArrowLeft: [0, -1],
    ArrowRight: [0, 1]
  };

  if (!keyMoves[event.key] || event.altKey || event.ctrlKey || event.metaKey) return;

  const cell = event.currentTarget;
  const cellLength = getCellTextLength(cell);
  const caretOffset = getCaretOffsetWithin(cell);
  const selection = window.getSelection();
  const hasSelectedText = selection && !selection.isCollapsed;

  // When editing longer text, allow Left/Right to move the text cursor until the user reaches the edge.
  // If the whole cell is selected after keyboard navigation, the next arrow key still moves to the next cell.
  if (!hasSelectedText && event.key === "ArrowLeft" && caretOffset > 0 && cellLength > 1) return;
  if (!hasSelectedText && event.key === "ArrowRight" && caretOffset < cellLength && cellLength > 1) return;

  const table = cell.closest("table");
  if (!table) return;

  const cols = JSON.parse(table.dataset.visibleCols || "[]");
  const currentRow = Number(cell.dataset.row);
  const currentCol = Number(cell.dataset.col);
  const currentColIndex = cols.indexOf(currentCol);
  const [rowDelta, colDelta] = keyMoves[event.key];

  const targetRow = currentRow + rowDelta;
  const targetCol = colDelta === 0 ? currentCol : cols[currentColIndex + colDelta];
  if (!targetCol) return;

  const moved = focusNearestCell(cell, targetRow, targetCol);

  if (moved) event.preventDefault();
}

function collectChanges() {
  const cells = {};
  document.querySelectorAll("[data-ref]").forEach((td) => {
    const v = text(td.textContent);
    if (v !== text(td.dataset.original)) cells[td.dataset.ref] = v;
  });
  return cells;
}

async function loadSheet(region, sheet) {
  activeRegion = region;
  activeSheet = sheet;
  activeSavedData = null;

  $("sheetTitle").textContent = sheet.name;
  $("sheetInfo").textContent = `${region.name} · ${sheet.maxRows} rows · ${visibleColumns(sheet).length} columns`;
  $("excelTable").innerHTML = '<div class="empty">Loading saved data from Firestore...</div>';
  setStatus("Connecting to Firestore and loading saved data...");
  setBusy(true);

  try {
    const saved = await getSaved(region.id, sheet.name);
    activeSavedData = saved;
    $("excelTable").innerHTML = "";
    $("excelTable").appendChild(buildTable(region, sheet, saved));
    setStatus(saved ? `Loaded saved data from Firestore: ${formatSavedAt(saved)}. Use arrow keys to move between cells.` : "No saved data found. Click a cell, enter data, use arrow keys to move, then save.");
  } catch (error) {
    console.error(error);
    $("excelTable").innerHTML = "";
    $("excelTable").appendChild(buildTable(region, sheet, null));
    setStatus(error.message || "Could not load Firestore data.", true);
  } finally {
    setBusy(false);
  }
}

async function saveSheet() {
  if (!activeRegion || !activeSheet) return;

  const cells = collectChanges();
  setBusy(true);
  setStatus("Saving to Firestore...");

  try {
    const payload = await setSaved(activeRegion, activeSheet, cells);
    activeSavedData = payload;
    setStatus(`Saved ${Object.keys(cells).length} changed cell(s) to Firestore at ${new Date().toLocaleString()}.`);
    document.querySelectorAll("[data-ref]").forEach((td) => {
      td.classList.toggle("changed", Object.prototype.hasOwnProperty.call(cells, td.dataset.ref));
    });
  } catch (error) {
    console.error(error);
    setStatus(error.message || "Save failed. Check Firebase configuration, Firestore rules, and internet connection.", true);
  } finally {
    setBusy(false);
  }
}

function initEntry() {
  const region = regionById(params.get("region"));
  const sheet = sheets(region).find((s) => s.name === params.get("sheet")) || sheets(region)[0];
  if (!region || !sheet) {
    document.body.innerHTML = '<div class="empty">Sheet not found.</div>';
    return;
  }

  $("backLink").href = `locations.html?region=${enc(region.id)}`;
  const switcher = $("switchSheet");
  sheets(region).forEach((s) => {
    const o = document.createElement("option");
    o.value = s.name;
    o.textContent = s.type === "summary" ? `Summary - ${s.name}` : s.name;
    o.selected = s.name === sheet.name;
    switcher.appendChild(o);
  });

  switcher.onchange = () => {
    const s = sheets(region).find((x) => x.name === switcher.value);
    loadSheet(region, s);
  };

  $("saveTopBtn").onclick = saveSheet;
  $("clearBtn").onclick = async () => {
    if (!activeRegion || !activeSheet) return;
    if (!confirm("Clear saved data for this sheet from Firestore?")) return;

    setBusy(true);
    setStatus("Deleting saved data from Firestore...");
    try {
      await deleteSaved(activeRegion.id, activeSheet.name);
      await loadSheet(activeRegion, activeSheet);
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Could not delete saved data from Firestore.", true);
      setBusy(false);
    }
  };

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveSheet();
    }
  });

  loadSheet(region, sheet);
}

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "home") initHome();
  if (page === "locations") initLocations();
  if (page === "entry") initEntry();
});
