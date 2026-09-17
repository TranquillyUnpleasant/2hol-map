/* 2HOL Town Map – upgraded with Discord login, ownership, icons & visibility
   Plain HTML/JS. Admins are whitelisted in Firebase at /admins/{discordId} = true
   Change DISCORD_CLIENT_ID before sharing.
*/

// ---------- Discord auth via the Node helper (server.js) ----------
// Login goes to AUTH_SERVER_URL/login. That server talks to Discord and
// redirects back here with #discord_user=...
// Set this to the PUBLIC URL of your Node process (no trailing slash).
const AUTH_SERVER_URL = "https://aaaa.prof.ninja";
const DISCORD_GUILD_ID = "423293333864054833";  // official 2HOL guild
// Discord experience roles (name, /slash alias, and later the snowflake id).
// Higher number = more hours. Visibility "vet" means level >= Veteran.
// Paste role IDs as extra keys when you have them, e.g. "123456789012345678": 3
const ROLE_LEVELS = {
  "not completely lost": 1, "ncl": 1, "966381752614535178": 1,
  "well experienced": 2, "exp": 2, "710862113630847067": 2,
  "veteran": 3, "vet": 3, "710882519041441842": 3,
  "what is life?": 4, "what is life": 4, "wil": 4, "710888589612810332": 4,
  "admin": 5, "moderator": 5, "mod": 5
};
const VIS_LEVEL = {
  public: 0,
  ncl: 1, members: 1,
  exp: 2,
  vet: 3, vets: 3,
  wil: 4,
  private: 99
};
const VIS_LABEL = {
  public: "Public",
  ncl: "Not Completely Lost+",
  members: "Not Completely Lost+",
  exp: "Well Experienced+",
  vet: "Veteran+",
  vets: "Veteran+",
  wil: "What is life?+",
  private: "Private (owners)"
};

const ICON_STYLES = {
  default: { symbol: "circle", color: "#3b82f6", label: "Default" },
  star: { symbol: "star", color: "#ffea70", label: "Star" },
  tree: { symbol: "arrow", color: "#89ecad", label: "Tree / Nature" },
  tobacco: { symbol: "diamond", color: "#71480e", label: "Tobacco" },
  christmas: { symbol: "star", color: "#912121", label: "Christmas" },
  event: { symbol: "hexagon", color: "#b28eff", label: "Event" },
  outpost: { symbol: "square", color: "#64748b", label: "Road / Outpost" },
  special: { symbol: "diamond-wide", color: "#b80860", label: "Special" }
};

const firebaseConfig = {
  apiKey: "AIzaSyDsQ8twL_3Xu1d_Z81ejhq4tmGL7N8Hmv8",
  authDomain: "thisisanewproj.firebaseapp.com",
  databaseURL: "https://thisisanewproj.firebaseio.com",
  projectId: "thisisanewproj",
  storageBucket: "thisisanewproj.appspot.com",
  messagingSenderId: "257351124868",
  appId: "1:257351124868:web:04264194e22008b82ebfd1"
};

firebase.initializeApp(firebaseConfig);
const townRef = firebase.database().ref("/towns");
const reportRef = firebase.database().ref("/reports");

const MERGE_DIST = 2500; // same name + this close → same town id
const PUBLIC_ID = "public";

// ---------- State ----------
let rawTowns = {};     // /towns entities {id: {name,x,y,...}}
let rawReports = {};   // /reports pings
let rawData = {};      // alias used by admin table (reports)
let towns = {};        // computed map keyed by town id
let isAdmin = false;
let chartReady = false;
let currentUser = null;   // { id, username, discriminator, avatar, roles: string[], level: number }

// ---------- Helpers ----------
function sanitize(str) {
  return DOMPurify.sanitize(String(str || ""), { ALLOWED_TAGS: [] });
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function parseCoord(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function userLevel() {
  if (isAdmin) return 5;
  return currentUser ? (currentUser.level || 0) : 0;
}

function canSee(town) {
  const need = VIS_LEVEL[town.visibility] || 0;
  if (need === 0) return true;
  if (need === 99) { // private
    return isAdmin || (currentUser && town.owners && town.owners.includes(currentUser.id));
  }
  return userLevel() >= need;
}

function canEdit(town) {
  if (!town || town.id === PUBLIC_ID || town.name === "public town") return isAdmin;
  if (isAdmin) return true;
  if (!currentUser) return false;
  if (town.ownerId && town.ownerId === currentUser.id) return true;
  if (town.owners && town.owners.includes(currentUser.id)) return true;
  return false;
}

function requireAuth() {
  const uid = firebase.auth && firebase.auth().currentUser && firebase.auth().currentUser.uid;
  if (!uid || !currentUser) {
    alert("Log in with Discord before adding or editing towns.");
    return null;
  }
  return uid;
}

// ---------- Compute towns (id-keyed entities) ----------
function normalizeTown(id, rec, reportList) {
  const name = sanitize(rec.name || id);
  const reps = reportList || [];
  let x = rec.x, y = rec.y;
  if (typeof x !== "number") x = parseCoord(x);
  if (typeof y !== "number") y = parseCoord(y);
  if ((x === 0 && y === 0 && id !== PUBLIC_ID) || (rec.x == null && rec.y == null)) {
    if (reps.length) {
      x = Math.round(median(reps.map(r => r.absX)));
      y = Math.round(median(reps.map(r => r.absY)));
    }
  }
  const owners = [];
  if (rec.ownerId) owners.push(rec.ownerId);
  const ownerNames = [];
  if (rec.ownerName) ownerNames.push(rec.ownerName);
  return {
    id,
    name,
    x, y,
    icon: rec.icon || "default",
    visibility: rec.visibility || "public",
    type: rec.icon || "default",
    desc: rec.desc || "",
    descs: rec.desc ? [rec.desc] : [],
    ownerId: rec.ownerId || null,
    owners,
    ownerNames,
    reports: reps.length,
    reporters: reps.map(r => r.user).filter(Boolean),
    keys: reps.map(r => r.key),
    uncertain: false,
    maxDev: 0
  };
}

function computeTowns(townEntities, reports) {
  const result = {};
  const byTown = {};
  Object.keys(reports || {}).forEach(key => {
    const r = reports[key];
    if (!r) return;
    const tid = r.townId;
    if (!tid) return;
    if (!byTown[tid]) byTown[tid] = [];
    byTown[tid].push({
      key,
      absX: typeof r.absX === "number" ? r.absX : parseCoord(r.absX),
      absY: typeof r.absY === "number" ? r.absY : parseCoord(r.absY)
    });
  });

  Object.keys(townEntities || {}).forEach(id => {
    const rec = townEntities[id];
    if (!rec || rec.recv || rec.send) return; // skip leftover pre-wipe report-shaped rows
    result[id] = normalizeTown(id, rec, byTown[id]);
  });

  if (!result[PUBLIC_ID]) {
    result[PUBLIC_ID] = normalizeTown(PUBLIC_ID, {
      name: "public town", x: 0, y: 0, icon: "star", visibility: "public"
    }, []);
  }
  result[PUBLIC_ID].x = 0;
  result[PUBLIC_ID].y = 0;
  return result;
}

function findNearbySameName(name, x, y) {
  const want = name.trim().toLowerCase();
  let best = null, bestD = Infinity;
  Object.values(towns).forEach(t => {
    if (!t || t.id === PUBLIC_ID) return;
    if ((t.name || "").trim().toLowerCase() !== want) return;
    const d = Math.hypot((t.x || 0) - x, (t.y || 0) - y);
    if (d < bestD) { bestD = d; best = t; }
  });
  if (best && bestD <= MERGE_DIST) return best;
  return null;
}

function resolveFromHeard(heardId, rawX, rawY) {
  const heard = towns[heardId] || (heardId === "public town" ? towns[PUBLIC_ID] : null);
  if (!heard) return null;
  const hx = parseCoord(rawX);
  const hy = parseCoord(rawY);
  // Keep the original convention: coords typed as heard from public are used as stored map x/y.
  // Relative to another town: subtract the reference position (same as the old compute).
  if (heard.id === PUBLIC_ID || heard.name === "public town") {
    return { x: hx, y: hy };
  }
  return { x: hx - heard.x, y: hy - heard.y };
}

// ---------- Chart ----------
function drawChart(townMap) {
  const visible = Object.keys(townMap).filter(id => {
    const t = townMap[id];
    return t && t.id !== PUBLIC_ID && t.name !== "public town" && canSee(t);
  });
  const groups = {};
  visible.forEach(id => {
    const ic = townMap[id].icon || "default";
    if (!groups[ic]) groups[ic] = [];
    groups[ic].push(id);
  });

  const traces = [];

  // Origin
  traces.push({
    x: [0], y: [0],
    text: ["<b>public town</b><br>Origin (0, 0)"],
    mode: "markers", type: "scatter", name: "Origin",
    marker: { size: 16, color: "#22c55e", symbol: "star", line: { width: 1.5, color: "#fff" } },
    hoverinfo: "text",
    customdata: [PUBLIC_ID]
  });

  Object.keys(groups).forEach(ic => {
    const style = ICON_STYLES[ic] || ICON_STYLES.default;
    const names = groups[ic];
    traces.push({
      x: names.map(n => townMap[n].x),
      y: names.map(n => townMap[n].y),
      text: names.map(n => {
        const t = townMap[n];
        return `<b>${sanitize(t.name)}</b><br>` +
          `x: ${t.x}  y: ${t.y}<br>` +
          `${style.label} · ${t.reports} report${t.reports !== 1 ? "s" : ""}` +
          (t.visibility !== "public" ? `<br>Visibility: ${VIS_LABEL[t.visibility] || t.visibility}` : "") +
          (t.uncertain ? "<br><i style='color:#f59e0b'>position uncertain</i>" : "");
      }),
      customdata: names,
      mode: "markers", type: "scatter", name: style.label,
      marker: {
        size: names.map(n => Math.min(18, 8 + Math.sqrt(townMap[n].reports) * 3)),
        color: names.map(n => townMap[n].uncertain ? "#f59e0b" : style.color),
        symbol: style.symbol,
        opacity: 0.9,
        line: { width: 1, color: "rgba(255,255,255,0.35)" }
      },
      hoverinfo: "text"
    });
  });

  const allX = [0, ...visible.map(n => townMap[n].x)];
  const allY = [0, ...visible.map(n => townMap[n].y)];
  const absVals = [...allX, ...allY].map(Math.abs).sort((a, b) => a - b);
  let maxAbs = absVals[Math.floor(absVals.length * 0.97)] || 15000;
  maxAbs = Math.ceil(maxAbs / 5000) * 5000;
  maxAbs = Math.max(maxAbs, 20000);
  const trueMax = Math.max(...absVals, 0);
  if (trueMax > maxAbs * 2) maxAbs = Math.ceil((trueMax * 0.7) / 5000) * 5000;

  const layout = {
    paper_bgcolor: "#0f1419", plot_bgcolor: "#0f1419",
    font: { color: "#e7ecf3", family: "Inter, sans-serif" },
    margin: { t: 30, r: 20, b: 40, l: 50 },
    xaxis: {
      minallowed: -maxAbs * 2, maxallowed: maxAbs * 2,
      range: [-maxAbs, maxAbs],
      zeroline: true, zerolinecolor: "#6b7280", zerolinewidth: 2,
      gridcolor: "#1f2937", tickfont: { size: 11 },
      scaleanchor: "y", scaleratio: 1
    },
    yaxis: {
      minallowed: -maxAbs * 2, maxallowed: maxAbs * 2,
      range: [-maxAbs, maxAbs],
      zeroline: true, zerolinecolor: "#6b7280", zerolinewidth: 2,
      gridcolor: "#1f2937", tickfont: { size: 11 }
    },
    showlegend: true,
    legend: {
      bgcolor: "rgba(0,0,0,0)",
      bordercolor: "#2d3a4f",
      font: { size: 11 },
      x: 1, y: 1, xanchor: 'right'
    },
    hovermode: "closest", dragmode: "pan"
  };

  const config = {
    responsive: true, displayModeBar: true,
    modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
    displaylogo: false, scrollZoom: true
  };

  Plotly.newPlot("chart", traces, layout, config).then(() => {
    chartReady = true;
    document.getElementById("chart").on("plotly_click", (data) => {
      if (!data.points || !data.points.length) return;
      const name = data.points[0].customdata;
      if (name) showDetail(name);
    });
  });
}

function showDetail(id) {
  const t = towns[id];
  if (!t) return;
  const card = document.getElementById("town-detail");
  document.getElementById("detail-name").textContent = t.name;
  const style = ICON_STYLES[t.icon] || ICON_STYLES.default;
  let html = `
    <div class="meta"><strong>Position:</strong> ${t.x}, ${t.y}</div>
    <div class="meta"><strong>Type:</strong> ${style.label}</div>
    <div class="meta"><strong>Visibility:</strong> ${VIS_LABEL[t.visibility] || t.visibility}</div>
  `;
  if (t.ownerNames && t.ownerNames.length) {
    html += `<div class="meta"><strong>Owners:</strong> ${t.ownerNames.join(", ")}</div>`;
  }
  if (t.descs && t.descs.length) {
    html += `<div class="meta"><strong>Notes:</strong> ${t.descs.slice(0, 3).join(" · ")}</div>`;
  }
  if (t.uncertain) {
    html += `<div class="meta" style="color:var(--warning)">⚠ Reports disagree (max Δ ≈ ${Math.round(t.maxDev)}).</div>`;
  }
  document.getElementById("detail-body").innerHTML = html;

  const actions = document.getElementById("detail-actions");
  if (canEdit(t) || isAdmin) {
    actions.classList.remove("hidden");
    document.getElementById("btn-edit-town").onclick = () => openEditModal(t.id);
    let del = document.getElementById("btn-delete-town");
    if (!del) {
      del = document.createElement("button");
      del.id = "btn-delete-town";
      del.className = "del-btn";
      del.textContent = "Delete town";
      actions.appendChild(del);
    }
    del.classList.toggle("hidden", !isAdmin || t.id === PUBLIC_ID);
    del.onclick = () => deleteTown(t.id);
  } else {
    actions.classList.add("hidden");
  }
  card.classList.remove("hidden");
}

// ---------- Views ----------
function openMenu() {
  if (!window.matchMedia("max-width: 600px")) return;
  const nav = document.getElementById("nav");
  const auth_area = document.getElementById("auth-area");
  const shrink_btn = document.getElementById("shrink-button");
  if (nav.classList.contains("shrink")) {
    nav.classList.remove("shrink");
    auth_area.classList.remove("shrink");
    shrink_btn.innerHTML = "︿";
  } else {
    nav.classList.add("shrink");
    auth_area.classList.add("shrink");
    shrink_btn.innerHTML = "﹀";
  }
  if (document.getElementById("btn-map").classList.contains("active")) switchView("map");
}

function switchView(view) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  const el = document.getElementById(`view-${view}`);
  if (el) el.classList.add("active");
  const btn = document.getElementById(`btn-${view}`);
  if (btn) btn.classList.add("active");

  if (view === "list") renderTownList();
  if (view === "my") renderMyTowns();
  if (view === "admin") {
    updateAdminPanel();
  }
  if (view === "map" && chartReady) {
    setTimeout(() => Plotly.Plots.resize("chart"), 50);
  }
}

function renderTownList() {
  const tbody = document.querySelector("#towns-table tbody");
  const search = (document.getElementById("search-towns").value || "").toLowerCase();
  const sort = document.getElementById("sort-towns").value;

  let list = Object.values(towns).filter(t => t.name !== "public town" && canSee(t));
  if (search) {
    list = list.filter(t =>
      t.name.toLowerCase().includes(search) ||
      (t.reporters || []).some(r => r.toLowerCase().includes(search)) ||
      (t.ownerNames || []).some(o => o.toLowerCase().includes(search))
    );
  }
  list.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "reports") return b.reports - a.reports;
    if (sort === "x") return a.x - b.x;
    if (sort === "y") return a.y - b.y;
    if (sort === "type") return (a.icon || "").localeCompare(b.icon || "");
    return 0;
  });

  document.getElementById("list-count").textContent = `${list.length} towns`;
  tbody.innerHTML = list.map(t => {
    const style = ICON_STYLES[t.icon] || ICON_STYLES.default;
    return `<tr>
      <td><strong>${sanitize(t.name)}</strong>${t.uncertain ? " ⚠" : ""}</td>
      <td>${style.label}</td>
      <td class="num">${t.x}</td>
      <td class="num">${t.y}</td>
      <td class="num">${t.reports}</td>
      <td>${t.visibility}</td>
      <td>${sanitize((t.ownerNames || []).slice(0, 2).join(", ") || "—")}</td>
      <td>${sanitize((t.descs || [])[0] || "")}</td>
    </tr>`;
  }).join("");
}

function renderMyTowns() {
  const tbody = document.querySelector("#my-towns-table tbody");
  if (!currentUser) {
    tbody.innerHTML = "";
    document.getElementById("my-count").textContent = "0";
    return;
  }
  const list = Object.values(towns).filter(t =>
    t.name !== "public town" && t.owners && t.owners.includes(currentUser.id)
  );
  document.getElementById("my-count").textContent = `${list.length} towns`;
  tbody.innerHTML = list.map(t => {
    const style = ICON_STYLES[t.icon] || ICON_STYLES.default;
    return `<tr>
      <td><strong>${sanitize(t.name)}</strong></td>
      <td>${style.label}</td>
      <td class="num">${t.x}</td>
      <td class="num">${t.y}</td>
      <td>${t.visibility}</td>
      <td class="num">${t.reports}</td>
      <td>
        <button class="secondary-btn" data-edit="${sanitize(t.id)}" style="padding:0.25rem 0.6rem;font-size:0.8rem">Edit</button>
        <button class="del-btn" data-del="${sanitize(t.id)}" style="margin-left:0.35rem">Delete</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-edit]").forEach(btn => {
    btn.addEventListener("click", () => openEditModal(btn.dataset.edit));
  });
  tbody.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", () => deleteTown(btn.dataset.del));
  });
}

function analyzeReports(data) {
  // Group by town name for duplicate / mirror detection
  const byTown = {};
  Object.keys(data || {}).forEach(k => {
    const r = data[k];
    if (!r) return;
    const name = (r.townName || (r.recv && r.recv.name) || "").trim();
    if (!name) return;
    if (!byTown[name]) byTown[name] = [];
    byTown[name].push({
      key: k,
      x: parseCoord(r.x),
      y: parseCoord(r.y),
      send: r.heardName || (r.send && r.send.name) || "",
      user: r.user || ""
    });
  });

  const flags = {}; // key -> string[]
  const spamNames = /^(test|asdf|xxx|foo|bar|spam|delete\s*me|tmp|placeholder)$/i;
  const knownTowns = new Set(Object.keys(byTown));
  knownTowns.add("public town");

  Object.keys(byTown).forEach(name => {
    const list = byTown[name];
    // exact coord duplicates (keep first, flag rest)
    const seen = new Map();
    list.forEach(r => {
      const sig = `${r.x}|${r.y}|${r.send}`;
      if (!flags[r.key]) flags[r.key] = [];
      if (seen.has(sig)) {
        flags[r.key].push("dup");
      } else {
        seen.set(sig, r.key);
      }
    });
    // sign-flip mirrors: another report with approx (-x,-y) or (x,-y) or (-x,y)
    list.forEach(r => {
      if (flags[r.key].includes("dup")) return;
      const isMirror = list.some(o => {
        if (o.key === r.key) return false;
        const sameMag =
          (Math.abs(Math.abs(o.x) - Math.abs(r.x)) < 50 &&
            Math.abs(Math.abs(o.y) - Math.abs(r.y)) < 50);
        if (!sameMag) return false;
        // different sign pattern
        return (o.x !== r.x || o.y !== r.y) &&
          (Math.sign(o.x) !== Math.sign(r.x) || Math.sign(o.y) !== Math.sign(r.y) ||
            o.x === -r.x || o.y === -r.y);
      });
      if (isMirror) flags[r.key].push("mirror");
    });
    if (spamNames.test(name)) {
      list.forEach(r => flags[r.key].push("spam"));
    }
  });

  Object.keys(data || {}).forEach(k => {
    const r = data[k];
    if (!r) return;
    if (!flags[k]) flags[k] = [];
    const send = (r.send && r.send.name) || "";
    const recv = (r.recv && r.recv.name) || "";
    // orphan: relative to non-public town that has no reports of its own as recv
    if (send && send !== "public town" && !knownTowns.has(send)) {
      // also check if send appears as a resolved town name in computed towns
      if (!towns[send]) flags[k].push("orphan");
    }
    const x = Math.abs(parseCoord(r.x));
    const y = Math.abs(parseCoord(r.y));
    if (x > 80000 || y > 80000) flags[k].push("extreme");
  });

  return flags;
}

async function deleteTown(id) {
  id = String(id || "").trim();
  if (!id || id === "undefined" || id === "null") {
    alert("Delete failed: missing town id.");
    return;
  }
  let t = towns[id] || Object.values(towns).find(x => x && (x.id === id || x.name === id));
  if (t && t.id) id = t.id;
  if (!t) t = { id: id, name: id, ownerId: currentUser && currentUser.id };
  if (id === PUBLIC_ID || t.name === "public town") {
    alert("Cannot delete public town.");
    return;
  }
  if (!isAdmin && !canEdit(t)) {
    alert("You cannot delete this town.");
    return;
  }
  if (!confirm("Delete town \"" + t.name + "\" from the map?")) return;
  try {
    await townRef.child(id).remove();
    delete rawTowns[id];
    delete towns[id];
    const detail = document.getElementById("town-detail");
    if (detail) detail.classList.add("hidden");
    processAndRender();
    const reps = rawReports || {};
    for (const k of Object.keys(reps)) {
      const r = reps[k];
      if (!r || (r.townId !== id && r.townName !== t.name)) continue;
      try { await reportRef.child(k).remove(); } catch (_) { }
    }
  } catch (err) {
    alert("Delete failed: " + (err && err.message ? err.message : err));
  }
}

function renderReportsTable() {
  const tbody = document.querySelector("#reports-table tbody");
  if (!tbody) return;
  const search = (document.getElementById("search-reports").value || "").toLowerCase();

  let list = Object.values(towns).filter(t => t.id !== PUBLIC_ID && t.name !== "public town");
  if (search) {
    list = list.filter(t =>
      (t.name || "").toLowerCase().includes(search) ||
      (t.ownerName || "").toLowerCase().includes(search) ||
      (t.ownerNames || []).some(o => o.toLowerCase().includes(search)) ||
      (t.id || "").toLowerCase().includes(search)
    );
  }
  list.sort((a, b) => a.name.localeCompare(b.name));

  const countEl = document.getElementById("report-count");
  if (countEl) countEl.textContent = `${list.length} towns`;

  tbody.innerHTML = list.map(t => {
    return `<tr>
      <td><strong>${sanitize(t.name)}</strong></td>
      <td class="num">${t.x}</td>
      <td class="num">${t.y}</td>
      <td>${sanitize((t.ownerNames || [])[0] || t.ownerId || "—")}</td>
      <td class="num">${t.reports || 0}</td>
      <td style="font-size:0.65rem;max-width:90px;overflow:hidden;text-overflow:ellipsis" title="${t.id}">${t.id}</td>
      <td><button class="del-btn" data-del-town="${sanitize(t.id)}">Delete</button></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("[data-del-town]").forEach(btn => {
    btn.addEventListener("click", () => deleteTown(btn.dataset.delTown));
  });
}

function refreshSelect() {
  const sel = document.getElementById("stown");
  if (!sel) return;
  const current = sel.value || PUBLIC_ID;
  const list = Object.values(towns).filter(t => canSee(t) || t.id === PUBLIC_ID)
    .sort((a, b) => {
      if (a.id === PUBLIC_ID) return -1;
      if (b.id === PUBLIC_ID) return 1;
      return a.name.localeCompare(b.name);
    });
  sel.innerHTML = `<option value="" disabled>Select a known town…</option>` +
    list.map(t => {
      const label = t.id === PUBLIC_ID ? "public town (0, 0)" : `${t.name} (${t.x}, ${t.y})`;
      return `<option value="${sanitize(t.id)}" ${t.id === current ? "selected" : ""}>${sanitize(label)}</option>`;
    }).join("");
}

function checkNameSimilarity() {
  const input = document.getElementById("rtown").value.trim().toLowerCase();
  const warn = document.getElementById("name-warning");
  if (!input || input.length < 3) { warn.classList.add("hidden"); return; }
  const matches = Object.values(towns).filter(tw => {
    const ln = (tw.name || "").toLowerCase();
    return ln && (ln.includes(input) || input.includes(ln) || levenshtein(ln, input) <= 2);
  }).slice(0, 4);
  if (matches.length) {
    warn.innerHTML = `Similar existing: <strong>${matches.map(tw => sanitize(tw.name) + " (" + tw.x + "," + tw.y + ")").join(", ")}</strong> — same name far away will create a second town.`;
    warn.classList.remove("hidden");
  } else warn.classList.add("hidden");
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

// ---------- Edit modal ----------
function openEditModal(id) {
  const t = towns[id];
  if (!t || !canEdit(t)) return;
  document.getElementById("edit-original-name").value = t.id;
  document.getElementById("edit-name").value = t.name;
  document.getElementById("edit-x").value = t.x;
  document.getElementById("edit-y").value = t.y;
  document.getElementById("edit-icon").value = t.icon || "default";
  const vis = document.getElementById("edit-visibility");
  if (vis) vis.value = t.visibility || "public";
  document.getElementById("edit-desc").value = t.desc || (t.descs && t.descs[0]) || "";
  document.getElementById("edit-modal").classList.remove("hidden");
}

document.getElementById("edit-cancel").addEventListener("click", () => {
  document.getElementById("edit-modal").classList.add("hidden");
});

document.getElementById("edit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const uid = requireAuth();
  if (!uid) return;

  const id = document.getElementById("edit-original-name").value;
  const newName = document.getElementById("edit-name").value.trim();
  const x = document.getElementById("edit-x").value;
  const y = document.getElementById("edit-y").value;
  const icon = document.getElementById("edit-icon").value;
  const visEl = document.getElementById("edit-visibility");
  const visibility = visEl ? visEl.value : "public";
  const desc = document.getElementById("edit-desc").value.trim();

  if (!newName) return alert("Name required");
  const t = towns[id];
  if (!t || !canEdit(t)) return alert("You cannot edit this town.");

  const patch = {
    name: newName,
    icon: icon || "default",
    visibility: visibility || "public",
    updatedAt: Date.now()
  };
  if (desc) patch.desc = desc;
  else patch.desc = null;
  if (x !== "" && y !== "") {
    patch.x = parseInt(x, 10);
    patch.y = parseInt(y, 10);
  }
  // ownerId must stay the original owner or rules reject the write
  if (t.ownerId) patch.ownerId = t.ownerId;
  else patch.ownerId = uid;

  try {
    await townRef.child(id).update(patch);
    document.getElementById("edit-modal").classList.add("hidden");
  } catch (err) {
    alert("Save failed: " + err.message);
  }
});

// ---------- Discord Auth ----------
function levelFromRoles(roles) {
  let level = 0; // public only until an experience role is present
  (roles || []).forEach((r) => {
    const n = ROLE_LEVELS[String(r).toLowerCase()] || ROLE_LEVELS[String(r)] || 0;
    if (n > level) level = n;
  });
  return level;
}

function loginWithDiscord() {
  if (!AUTH_SERVER_URL) {
    alert("Set AUTH_SERVER_URL in script.js to your public Node auth server (the host running server.js), e.g. https://auth.prof.ninja");
    return;
  }
  window.location.href = AUTH_SERVER_URL.replace(/\/$/, "") + "/login";
}

async function handleDiscordCallback() {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return;

  const params = new URLSearchParams(hash);
  const err = params.get("discord_error");
  const packed = params.get("discord_user");

  // Always strip the hash so a refresh does not re-process it
  if (err || packed) {
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  if (err) {
    if (err === "not_in_guild") {
      alert("You need to be in the official 2HOL Discord to log in.");
    } else {
      alert("Discord login failed: " + err);
    }
    return;
  }
  if (!packed) return;

  try {
    const json = atob(packed.replace(/-/g, "+").replace(/_/g, "/"));
    const me = JSON.parse(json);
    let roles = me.roles || me.roleIds || [];
    let level = levelFromRoles(roles);
    try {
      if (me.firebaseToken && firebase.auth) {
        await firebase.auth().signInWithCustomToken(me.firebaseToken);
      }
      const snap = await firebase.database().ref(`/discordRoles/${me.id}`).once("value");
      const stored = snap.val();
      if (stored && Array.isArray(stored.roles)) {
        roles = stored.roles;
        level = Math.max(level, levelFromRoles(roles));
      } else if (stored && typeof stored.level === "number") {
        level = Math.max(level, stored.level);
      }
    } catch (_) { }

    currentUser = {
      id: me.id,
      username: me.nick || me.username,
      discriminator: me.discriminator,
      avatar: me.avatar,
      roles,
      roleIds: me.roleIds || [],
      level
    };
    localStorage.setItem("2hol_discord", JSON.stringify(currentUser));
    updateAuthUI();
    await checkAdminStatus();
    processAndRender();
  } catch (e) {
    console.error("Discord callback parse failed", e);
    alert("Discord login failed (could not read user payload).");
  }
}

function logout() {
  currentUser = null;
  isAdmin = false;
  localStorage.removeItem("2hol_discord");
  if (firebase.auth) firebase.auth().signOut().catch(() => { });
  updateAuthUI();
  updateAdminPanel();
  processAndRender();
}

function updateAuthUI() {
  const loginBtn = document.getElementById("btn-login");
  const menu = document.getElementById("user-menu");
  const myBtn = document.getElementById("btn-my");
  if (currentUser) {
    loginBtn.classList.add("hidden");
    menu.classList.remove("hidden");
    document.getElementById("user-name").textContent = currentUser.username;
    document.getElementById("user-avatar").src = currentUser.avatar;
    myBtn.classList.remove("hidden");
    document.getElementById("user").placeholder = currentUser.username;
    document.getElementById("btn-report").classList.remove("hidden");
    document.getElementById("view-report").classList.remove("hidden");
  } else {
    loginBtn.classList.remove("hidden");
    menu.classList.add("hidden");
    myBtn.classList.add("hidden");
    document.getElementById("btn-report").classList.add("hidden");
    document.getElementById("view-report").classList.add("hidden");
  }
}

function restoreSession() {
  // Discord localStorage is only a profile cache. Firebase Auth is the real session.
  // Wait for onAuthStateChanged in startAuthListener().
}

function applyFirebaseUser(fbUser) {
  if (!fbUser) {
    currentUser = null;
    isAdmin = false;
    localStorage.removeItem("2hol_discord");
    updateAuthUI();
    updateAdminPanel();
    processAndRender();
    return;
  }
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("2hol_discord") || "null"); } catch (_) { }
  if (!saved || saved.id !== fbUser.uid) {
    saved = {
      id: fbUser.uid,
      username: (saved && saved.username) || fbUser.displayName || fbUser.uid,
      avatar: (saved && saved.avatar) || "",
      roles: [],
      roleIds: [],
      level: 1
    };
  }
  currentUser = { ...saved, id: fbUser.uid };
  currentUser.level = Math.max(
    currentUser.level || 0,
    levelFromRoles(currentUser.roles),
    levelFromRoles(currentUser.roleIds)
  );
  localStorage.setItem("2hol_discord", JSON.stringify(currentUser));
  updateAuthUI();
  checkAdminStatus();
}

function startAuthListener() {
  if (!firebase.auth) return;
  firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => { });
  firebase.auth().onAuthStateChanged(applyFirebaseUser);
}

// ---------- Main data ----------
async function ensurePublicTown() {
  if (!isAdmin) return;
  if (rawTowns[PUBLIC_ID] && rawTowns[PUBLIC_ID].name) return;
  const uid = firebase.auth && firebase.auth().currentUser && firebase.auth().currentUser.uid;
  if (!uid) return;
  try {
    await townRef.child(PUBLIC_ID).set({
      name: "public town",
      x: 0, y: 0,
      icon: "star",
      visibility: "public",
      ownerId: uid,
      ownerName: currentUser ? currentUser.username : "admin",
      createdAt: Date.now()
    });
  } catch (e) {
    console.warn("Could not seed public town", e);
  }
}

function processAndRender() {
  towns = computeTowns(rawTowns, rawReports);
  rawData = rawReports;
  drawChart(towns);
  refreshSelect();
  if (document.getElementById("view-list").classList.contains("active")) renderTownList();
  if (document.getElementById("view-my").classList.contains("active")) renderMyTowns();
  if (isAdmin && document.getElementById("view-admin").classList.contains("active")) renderReportsTable();
}

townRef.on("value", ss => {
  rawTowns = ss.val() || {};
  processAndRender();
});
reportRef.on("value", ss => {
  rawReports = ss.val() || {};
  processAndRender();
});

// ---------- Form submit ----------
document.getElementById("bellreport").addEventListener("submit", async (evt) => {
  evt.preventDefault();
  const uid = requireAuth();
  if (!uid) return;

  const rtown = document.getElementById("rtown").value.trim();
  const heardId = document.getElementById("stown").value;
  const xcoord = document.getElementById("xcoord").value;
  const ycoord = document.getElementById("ycoord").value;
  const username = (document.getElementById("user").value.trim() || currentUser.username);
  const descEl = document.getElementById("desc");
  const desc = descEl ? descEl.value.trim() : "";
  const icon = (document.getElementById("icon") && document.getElementById("icon").value) || "default";
  const visibility = (document.getElementById("visibility") && document.getElementById("visibility").value) || "public";

  if (!rtown) return alert("Please provide a name for your town.");
  if (!heardId) return alert("Please select which town rang the bell.");
  if (xcoord === "" || ycoord === "") return alert("Please enter both coordinates.");

  const pos = resolveFromHeard(heardId, xcoord, ycoord);
  if (!pos) return alert("Unknown reference town. Pick a town from the list.");

  const existing = findNearbySameName(rtown, pos.x, pos.y);
  try {
    let townId;
    if (existing) {
      townId = existing.id;
    } else {
      const rec = {
        name: rtown,
        x: pos.x,
        y: pos.y,
        icon,
        visibility,
        ownerId: uid,
        ownerName: username,
        createdAt: Date.now()
      };
      if (desc) rec.desc = desc;
      const created = await townRef.push(rec);
      townId = created.key;
    }

    const report = {
      townId,
      heardId,
      townName: rtown,
      heardName: (towns[heardId] && towns[heardId].name) || heardId,
      x: parseCoord(xcoord),
      y: parseCoord(ycoord),
      absX: pos.x,
      absY: pos.y,
      userId: uid,
      user: username,
      createdAt: Date.now()
    };
    if (desc) report.desc = desc;
    await reportRef.push(report);

    alert(existing
      ? "Added a confirmation report to the existing town nearby with that name."
      : "Town added.");
    document.getElementById("rtown").value = "";
    document.getElementById("xcoord").value = "";
    document.getElementById("ycoord").value = "";
    if (descEl) descEl.value = "";
  } catch (err) {
    alert("Failed to save: " + err.message);
  }
});

// ---------- Wiring ----------
document.querySelectorAll(".nav-btn[data-view]").forEach(btn => {
  btn.addEventListener("click", () => switchView(btn.dataset.view));
});
document.querySelector(".close-detail").addEventListener("click", () => {
  document.getElementById("town-detail").classList.add("hidden");
});
document.getElementById("search-towns").addEventListener("input", renderTownList);
document.getElementById("sort-towns").addEventListener("change", renderTownList);
document.getElementById("search-reports").addEventListener("input", renderReportsTable);
document.getElementById("filter-problems")?.addEventListener("change", renderReportsTable);
document.getElementById("rtown").addEventListener("input", checkNameSimilarity);
document.getElementById("shrink-button").addEventListener("click", openMenu);
document.getElementById("btn-login").addEventListener("click", loginWithDiscord);
document.getElementById("btn-logout").addEventListener("click", logout);

document.getElementById("recompute-btn").addEventListener("click", () => {
  processAndRender();
  alert("Map recomputed.");
});

if (currentUser) {
  document.getElementById("user").placeholder = currentUser.username;
}

// ---------- Admin whitelist (Firebase /admins/{discordId} = true) ----------
async function checkAdminStatus() {
  isAdmin = false;
  if (!currentUser || !currentUser.id) {
    updateAdminPanel();
    return;
  }
  try {
    const snap = await firebase.database().ref(`/admins/${currentUser.id}`).once("value");
    isAdmin = !!snap.val();
  } catch (err) {
    console.warn("Could not check admin status", err);
    isAdmin = false;
  }
  updateAdminPanel();
  if (isAdmin) ensurePublicTown();
  processAndRender();
}

function updateAdminPanel() {
  const adminTab = document.getElementById("btn-admin");
  const denied = document.getElementById("admin-denied");
  const panel = document.getElementById("admin-panel");
  const hint = document.getElementById("admin-denied-hint");
  if (!denied || !panel) return;

  if (isAdmin) {
    adminTab.classList.remove("hidden");
    denied.classList.add("hidden");
    panel.classList.remove("hidden");
    renderReportsTable();
  } else {
    denied.classList.remove("hidden");
    panel.classList.add("hidden");
    adminTab.classList.add("hidden");
    if (hint) {
      if (!currentUser) {
        hint.textContent = "Log in with Discord first. Then ask an existing admin to add your Discord ID under /admins/{id} = true in Firebase.";
      } else {
        hint.textContent = `Logged in as ${currentUser.username} (${currentUser.id}). This ID is not in /admins. Ask an existing admin to whitelist you.`;
      }
    }
  }
}

// Boot
handleDiscordCallback().then(() => {
  startAuthListener();
});
switchView("map");
updateAuthUI();

