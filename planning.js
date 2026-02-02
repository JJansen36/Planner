import { makeSupabaseClient, requireSession } from "./auth.js";
import { startOfISOWeek, addDays, toISODate, parseISODate } from "./utils.js";

const sb = makeSupabaseClient();

const el = (id) => document.getElementById(id);
const gridEl = el("plannerGrid");
const statusEl = el("plannerStatus");

const RANGE_DAYS = 56; // 8 weken zoals je PDF-screens
let rangeStart = startOfISOWeek(new Date()); // maandag

// UI
el("btnMenu").onclick = () => (location.href = "./index.html");
el("btnLogout").onclick = async () => { await sb.auth.signOut(); location.href = "./login.html"; };
el("btnToday").onclick = () => { rangeStart = startOfISOWeek(new Date()); loadAndRender(); };
el("btnPrev").onclick = () => { rangeStart = addDays(rangeStart, -RANGE_DAYS); loadAndRender(); };
el("btnNext").onclick = () => { rangeStart = addDays(rangeStart, +RANGE_DAYS); loadAndRender(); };
el("btnRefresh").onclick = () => loadAndRender();

document.addEventListener("DOMContentLoaded", init);

async function init(){
  await requireSession(sb);
  loadAndRender();
}

function monthNameNL(m){
  return ["januari","februari","maart","april","mei","juni","juli","augustus","september","oktober","november","december"][m];
}
function dayNameNL(d){
  return ["zo","ma","di","wo","do","vr","za"][d];
}
function isWeekend(date){
  const d = date.getDay();
  return d === 0 || d === 6;
}
function weekNumberISO(date){
  // ISO week number
  const tmp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = tmp.getUTCDay() || 7;
  tmp.setUTCDate(tmp.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(tmp.getUTCFullYear(),0,1));
  return Math.ceil((((tmp - yearStart) / 86400000) + 1) / 7);
}

function formatDateNL(v){
  if(!v) return "";
  // v kan "YYYY-MM-DD" zijn (Supabase date), of timestamp.
  const d = parseISODate(String(v).slice(0,10));
  if(!d) return "";
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = d.getFullYear();
  return `${dd}-${mm}-${yy}`;
}


// -------- DATA LOAD --------
async function loadAndRender(){
  const start = new Date(rangeStart);
  const end = addDays(start, RANGE_DAYS - 1);
  const startISO = toISODate(start);
  const endISO = toISODate(end);

  statusEl.textContent = `Laden… (${startISO} t/m ${endISO})`;

  // 1) projecten
  const { data: projecten, error: pErr } = await sb
    .from("projecten")
    .select("*")
    .order("offerno", { ascending: true })
    .limit(500);

  if (pErr) { statusEl.textContent = "Fout projecten: " + pErr.message; return; }

  // 2) secties
  const { data: secties, error: sErr } = await sb
    .from("secties")
    .select("*")
    .limit(2000);

  if (sErr) { statusEl.textContent = "Fout secties: " + sErr.message; return; }

  // 3) section_work in range
  const { data: work, error: wErr } = await sb
    .from("section_work")
    .select("section_id, work_date, work_type, hours, werknemer_id")
    .gte("work_date", startISO)
    .lte("work_date", endISO)
    .limit(200000);

  if (wErr) { statusEl.textContent = "Fout planning: " + wErr.message; return; }

  // 4) capacity_entries in range
  const { data: cap, error: cErr } = await sb
    .from("capacity_entries")
    .select("work_date, werknemer_id, hours, type")
    .gte("work_date", startISO)
    .lte("work_date", endISO)
    .limit(200000);

  if (cErr) { statusEl.textContent = "Fout capaciteit: " + cErr.message; return; }

  // 5) werknemers (voor namen in capaciteitblok)
  const { data: werknemers, error: eErr } = await sb
    .from("werknemers")
    .select("*")
    .order("name", { ascending: true })
    .limit(500);

  if (eErr) { statusEl.textContent = "Fout werknemers: " + eErr.message; return; }

  statusEl.textContent = "";

  renderPlanner({
    start,
    days: RANGE_DAYS,
    projecten,
    secties,
    work,
    cap,
    werknemers
  });
}
/* ======================
   SECTION WORK MAP (section_id -> date -> rows[])
====================== */
function buildWorkMap(workRows){
  const map = new Map();
  if(!Array.isArray(workRows) || workRows.length===0) return map;

  const sidKey  = pickKey(workRows[0], ["section_id","sectionid","sectie_id","sectieid"]);
  const dateKey = pickKey(workRows[0], ["work_date","date","datum","dag"]);
  if(!sidKey || !dateKey) return map;

  for(const r of workRows){
    const sidRaw = r?.[sidKey];
    if(!sidRaw) continue;
    const sid = String(sidRaw);

    const d = parseISODate(String(r?.[dateKey] || ""));
    if(!d) continue;
    const iso = toISODate(d);

    if(!map.has(sid)) map.set(sid, new Map());
    const byDate = map.get(sid);
    if(!byDate.has(iso)) byDate.set(iso, []);
    byDate.get(iso).push(r);
  }
  return map;
}


// -------- RENDER --------
function renderPlanner({ start, days, projecten, secties, work, cap, werknemers }){
  const dates = [];
  for(let i=0;i<days;i++) dates.push(addDays(start, i));

  // indexes
  const projIdKey = pickKey(projecten[0], ["project_id","id"]);
  const projNrKey = pickKey(projecten[0], ["offerno","projectnr","project_nr","nummer","nr"]);
  const projNameKey = pickKey(projecten[0], ["projectname","naam","name","omschrijving","titel","title"]);
  const klantKey = pickKey(projecten[0], ["klantnaam","klant_name","klant","customer","relatie"]);
  const completionKey = pickKey(projecten[0], ["completiondate","completion_date","opleverdatum","end_date"]);


  const sectIdKey   = pickKey(secties[0], ["id","section_id"]);
  const sectProjKey = pickKey(secties[0], ["project_id","projectid","project","project_ref"]);
  const sectNameKey = pickKey(secties[0], ["name","naam","section_name","sectionname","titel","title","omschrijving","description"]);


  console.log("secties keys:", Object.keys(secties?.[0] || {}));
  console.log("projecten keys:", Object.keys(projecten?.[0] || {}));
  console.log("sample sectie:", secties?.[0]);
  console.log("sample work row:", work?.[0]);
  console.log("sectIdKey:", sectIdKey, "sectProjKey:", sectProjKey, "sectNameKey:", sectNameKey);



  // Map: secties lookup zodat we altijd een juiste key hebben (id <-> section_id)
  const sectLookup = new Map(); // anyKey -> canonicalIdUsedInWork
  for (const s of secties || []) {
    if (s?.id) sectLookup.set(String(s.id), String(s.id));
    if (s?.section_id) sectLookup.set(String(s.section_id), String(s.section_id));
  }

  // map secties per project
  const sectiesByProject = new Map();
  for(const s of secties || []){
    const pid = s?.[sectProjKey];
    if(!pid) continue;
    if(!sectiesByProject.has(pid)) sectiesByProject.set(pid, []);
    sectiesByProject.get(pid).push(s);
  }

  // map work per section -> date -> {type->hours}
  const workMap = new Map(); // sectionId -> dateISO -> array rows
  for(const r of work || []){
    const rawSid = r.section_id;
    const d = r.work_date;
    const sid = rawSid ? sectLookup.get(String(rawSid)) || String(rawSid) : null;
    if(!sid || !d) continue;

    if(!workMap.has(sid)) workMap.set(sid, new Map());

    const dm = workMap.get(sid);
    if(!dm.has(d)) dm.set(d, []);
    dm.get(d).push(r);
  }

  // capacity: per werknemer per dag
  const capByEmp = new Map(); // empId -> dateISO -> sumHours
  for(const r of cap || []){
    const emp = r.werknemer_id;
    const d = r.work_date;
    const h = Number(r.hours || 0);
    // type filtering: alleen "werk" telt als capaciteit (pas aan als je anders wil)
    const t = String(r.type || "werk");
    const sign = (t === "werk") ? 1 : 1; // als je verlof/ziek als 0 wil tellen, maak sign=0
    if(!emp || !d) continue;
    if(!capByEmp.has(emp)) capByEmp.set(emp, new Map());
    const dm = capByEmp.get(emp);
    dm.set(d, (dm.get(d) || 0) + (h * sign));
  }

  // totals capaciteit per dag
  const capTotalByDay = {};
  for(const [emp, dm] of capByEmp){
    for(const [d,h] of dm){
      capTotalByDay[d] = (capTotalByDay[d] || 0) + h;
    }
  }

  // planned prod/mont per day
  const plannedProdByDay = {};
  const plannedMontByDay = {};
  for(const r of work || []){
    const d = r.work_date;
    const h = Number(r.hours || 0);
    const wt = String(r.work_type || "");
    if(!d) continue;
    if(isProdType(wt)) plannedProdByDay[d] = (plannedProdByDay[d] || 0) + h;
    if(isMontType(wt)) plannedMontByDay[d] = (plannedMontByDay[d] || 0) + h;
  }

  // build table
  const table = document.createElement("table");
  table.className = "planner-table";
  // fixed column widths so header == body
  const colgroup = document.createElement("colgroup");
  const colLeft = document.createElement("col");
  colLeft.style.width = "380px";
  colgroup.appendChild(colLeft);
  for(let i=0;i<dates.length;i++){
    const c = document.createElement("col");
    c.style.width = "32px";
    colgroup.appendChild(c);
  }
  table.appendChild(colgroup);


  // THEAD (3 rijen: maand / week / dag)
  const thead = document.createElement("thead");



  // Row: months
  const trMonth = document.createElement("tr");
  trMonth.className = "hdr hdr-month";
  trMonth.appendChild(hdrCell("Planning", "rowhdr sticky-left sticky-top"));
  let i = 0;
  while(i < dates.length){
    const m = dates[i].getMonth();
    const y = dates[i].getFullYear();
    let span = 1;
    while(i+span < dates.length && dates[i+span].getMonth() === m) span++;
    trMonth.appendChild(hdrCell(`${monthNameNL(m)} ${y}`, "sticky-top", span));
    i += span;
  }
  thead.appendChild(trMonth);

  // Row: weeks
  const trWeek = document.createElement("tr");
  trWeek.className = "hdr hdr-week";
  trWeek.appendChild(hdrCell("", "rowhdr sticky-left sticky-top2"));
  let j=0;
  while(j < dates.length){
    const wk = weekNumberISO(dates[j]);
    // span to next monday or end
    let span = 1;
    while(j+span < dates.length && dates[j+span].getDay() !== 1) span++;
    trWeek.appendChild(hdrCell(`Wk ${wk}`, "sticky-top2", span));
    j += span;
  }
  thead.appendChild(trWeek);

  // Row: days
  const trDay = document.createElement("tr");
  trDay.className = "hdr hdr-day";
  trDay.appendChild(hdrCell("", "rowhdr sticky-left sticky-top3"));
  for(const d of dates){
    const iso = toISODate(d);
    const cls = ["sticky-top3", isWeekend(d) ? "wknd" : ""].join(" ");
    trDay.appendChild(hdrCell(`${dayNameNL(d.getDay())}<br>${d.getDate()}-${d.getMonth()+1}`, cls));
  }
  thead.appendChild(trDay);
  table.appendChild(thead);

  // TBODY
  const tbody = document.createElement("tbody");

  // Projects + sections (expand/collapse)
  for(const p of projecten || []){
    const pid = p?.[projIdKey];
    const nr  = p?.[projNrKey] ?? "";
    const nm  = p?.[projNameKey] ?? "";
    const kl  = p?.[klantKey] ?? "";
    const complRaw = p?.[completionKey] ?? "";
    const complTxt = formatDateNL(complRaw);
    const complISO = String(complRaw || "").slice(0,10); // "2026-03-15"


    console.log("completionKey:", completionKey, "value:", p?.[completionKey]);


    const projRow = document.createElement("tr");
    projRow.className = "project-row";
    const left = document.createElement("td");
    left.className = "rowhdr sticky-left project-cell";
    left.innerHTML = `
      <button class="expander" data-proj="${escapeAttr(pid)}" aria-label="toggle">▶</button>
      <span class="projtext">
        ${escapeHtml(nr)} - ${escapeHtml(kl)} - ${escapeHtml(nm)}
        ${complTxt ? `<span class="completiondate"> • oplever: ${escapeHtml(complTxt)}</span>` : ""}
      </span>
    `;
    projRow.appendChild(left);

    // project-level: we render bars aggregated from all sections (simple view)
    const projLabels = buildDayLabelsForProject(pid, sectiesByProject, sectIdKey, workMap, dates);
    appendDayCells(projRow, dates, projLabels, complISO);
    tbody.appendChild(projRow);

        // ---- Project details row (hidden, shows on expand) ----
    const detailsRow = document.createElement("tr");
    detailsRow.className = "project-details-row hidden";
    detailsRow.dataset.parent = String(pid);

    const detailsLeft = document.createElement("td");
    detailsLeft.className = "rowhdr sticky-left project-details-cell";

    // simpele totals in huidige range (op basis van work[] die al in range is)
    let sumPrep = 0, sumProd = 0, sumMont = 0;
    for (const r of work || []) {
      // alleen rows die bij dit project horen via section -> project
      // (we lopen secList later nog; dus hier sneller: check via sectiesByProject)
    }
    // we rekenen via secties van dit project:
    const secsForPid = sectiesByProject.get(pid) || [];
    const secIds = new Set(secsForPid.map(s => String(s?.[sectIdKey] ?? s?.section_id ?? "")));

    for (const r of work || []) {
      const sid = String(r.section_id || "");
      if (!secIds.has(sid)) continue;

      const wt = String(r.work_type || "");
      const h = Number(r.hours || 0);
      if (isPrepType(wt)) sumPrep += h;
      if (isProdType(wt)) sumProd += h;
      if (isMontType(wt)) sumMont += h;
    }

    detailsLeft.innerHTML = `
      <div class="details-box">
        <div class="details-title">Sectie gegevens</div>
        <div class="details-line">Opleverdatum: <b>${escapeHtml(complTxt || "-")}</b></div>
        <div class="details-line">Werkvoorbereiding: <b>${escapeHtml(formatHoursCell(sumPrep))}</b> uur</div>
        <div class="details-line">Productie: <b>${escapeHtml(formatHoursCell(sumProd))}</b> uur</div>
        <div class="details-line">Montage: <b>${escapeHtml(formatHoursCell(sumMont))}</b> uur</div>
      </div>
    `;

    detailsRow.appendChild(detailsLeft);

    // rechts: 1 cel die over de hele kalender spant (leeg)
    const detailsFill = document.createElement("td");
    detailsFill.colSpan = dates.length;
    detailsFill.className = "cell details-fill";
    detailsRow.appendChild(detailsFill);

    tbody.appendChild(detailsRow);


    // section rows (hidden by default)
    const secList = (sectiesByProject.get(pid) || []).slice()
      .sort((a,b)=>String(a?.[sectNameKey]||"").localeCompare(String(b?.[sectNameKey]||"")));

    for (const s of secList) {
      const secRow = document.createElement("tr");
      secRow.className = "section-row hidden";
      secRow.dataset.parent = String(pid);

      const leftS = document.createElement("td");
      leftS.className = "rowhdr sticky-left section-cell";

      const sid = s?.[sectIdKey]
        ? String(s[sectIdKey])
        : (s?.section_id ? String(s.section_id) : null);

      const sn = s?.[sectNameKey] || "sectie";

      leftS.innerHTML = `<span class="sectext">↳ ${escapeHtml(sn)}</span>`;
      secRow.appendChild(leftS);

      const labels = buildDayLabelsForSection(sid, workMap, dates);
      appendDayCells(secRow, dates, labels);

      tbody.appendChild(secRow);
    }

  }

  // CAPACITY BLOCK
  tbody.appendChild(spacerRow(dates.length));

  // Header row "Capaciteit"
  tbody.appendChild(sectionHeaderRow("Capaciteit", dates.length));

  // per werknemer rows
  const empIdKey = pickKey(werknemers[0], ["id","werknemer_id","employee_id"]);
  const empNameKey = pickKey(werknemers[0], ["naam","name","fullname","display_name"]);

  for(const w of werknemers || []){
    const wid = w?.[empIdKey];
    const wnm = w?.[empNameKey] ?? String(wid ?? "");
    const tr = document.createElement("tr");
    tr.className = "cap-emp-row";

    tr.appendChild(leftRowHdrCell(wnm, "sticky-left cap-name"));

    for(const d of dates){
      const iso = toISODate(d);
      const h = capByEmp.get(wid)?.get(iso) || 0;
      const td = document.createElement("td");
      td.className = `cell cap-cell ${isWeekend(d) ? "wknd" : ""}`;
      td.textContent = formatHoursCell(h);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }

  // Totals / beschikbaar rows (zoals PDF onderin)
  tbody.appendChild(spacerRow(dates.length));

  // Uren beschikbaar (cap - gepland prod - gepland mont)
  tbody.appendChild(sectionHeaderRow("Uren beschikbaar", dates.length, true));

  const trAvail = document.createElement("tr");
  trAvail.className = "sum-row";
  trAvail.appendChild(leftRowHdrCell("", "sticky-left"));

  for(const d of dates){
    const iso = toISODate(d);
    const capT = capTotalByDay[iso] || 0;
    const prod = plannedProdByDay[iso] || 0;
    const mont = plannedMontByDay[iso] || 0;
    const avail = capT - (prod + mont);

    const td = document.createElement("td");
    td.className = `cell sum-cell ${availabilityClass(avail)} ${isWeekend(d) ? "wknd" : ""}`;
    td.textContent = formatHoursCell(avail);
    trAvail.appendChild(td);
  }
  tbody.appendChild(trAvail);

  // Gepland productie
  tbody.appendChild(labelRow("Gepland productie", dates, plannedProdByDay));

  // Gepland montage
  tbody.appendChild(labelRow("Gepland montage", dates, plannedMontByDay));

  // (optioneel) Capaciteit met nieuwe order / Nieuwe order: laat ik als “hook” staan
  // omdat ik jouw project_orders schema nog niet gezien heb.
  // Je kunt dit later 1-op-1 invullen.
  tbody.appendChild(spacerRow(dates.length));
  tbody.appendChild(sectionHeaderRow("Capaciteit met nieuwe order", dates.length, true));
  tbody.appendChild(infoRow("Nieuwe order (nog te koppelen)", dates.length));

  table.appendChild(tbody);

  // mount
  gridEl.innerHTML = "";
  gridEl.appendChild(table);

  // expanders
// expanders
gridEl.querySelectorAll(".expander").forEach(btn => {
  btn.addEventListener("click", () => {
    const pid = String(btn.dataset.proj || "");
    const open = btn.classList.toggle("open");
    btn.textContent = open ? "▼" : "▶";

    gridEl.querySelectorAll("tr.section-row, tr.project-details-row").forEach(tr => {
      if (String(tr.dataset.parent || "") === pid) {
        tr.classList.toggle("hidden", !open);
      }
    });

  });
});

}

// -------- RUN BUILDERS (bars via colspan) --------
function buildBarRunsForSection(sectionId, workMap, dates){
  // per dag label kiezen (dominant type), en contiguous dagen samenvoegen
  const dm = workMap.get(sectionId);
  const labels = dates.map(d=>{
    const iso = toISODate(d);
    const rows = dm?.get(iso) || [];
    if(!rows.length) return "";
    // label = type(s) samengevat
    const byType = {};
    for(const r of rows){
      const t = normalizeType(r.work_type);
      byType[t] = (byType[t]||0) + Number(r.hours||0);
    }
    // neem grootste type als label
    let bestT = "";
    let bestH = 0;
    for(const [t,h] of Object.entries(byType)){
      if(h > bestH){ bestH = h; bestT = t; }
    }
    return bestT ? `${bestT}` : "";
  });

  return compressRuns(labels);
}

function buildBarRunsForProject(projectId, sectiesByProject, sectIdKey, workMap, dates){
  // project: als er ergens iets gepland is, label op projectniveau
  // (simpel: kies per dag de meest voorkomende label over secties)
  const secs = sectiesByProject.get(projectId) || [];
  const dayLabels = dates.map(d=>{
    const iso = toISODate(d);
    const counts = {};
    for(const s of secs){
      const sid = s?.[sectIdKey];
      const rows = workMap.get(sid)?.get(iso) || [];
      for(const r of rows){
        const t = normalizeType(r.work_type);
        counts[t] = (counts[t]||0) + Number(r.hours||0);
      }
    }
    let bestT="", bestH=0;
    for(const [t,h] of Object.entries(counts)){
      if(h>bestH){ bestH=h; bestT=t; }
    }
    return bestT ? `${bestT}` : "";
  });

  return compressRuns(dayLabels);
}

function compressRuns(labels){
  // labels[] -> [{label, span}]
  const runs = [];
  let i=0;
  while(i<labels.length){
    const cur = labels[i];
    let span=1;
    while(i+span<labels.length && labels[i+span]===cur) span++;
    runs.push({ label: cur, span });
    i += span;
  }
  return runs;
}

function appendRunCells(tr, dates, runs){
  // runs align with dates length
  for(const run of runs){
    const td = document.createElement("td");
    td.colSpan = run.span;
    const label = run.label || "";
    td.className = `cell plan-cell ${label ? barClass(label) : ""}`;
    td.innerHTML = label ? `<div class="bar">${escapeHtml(label)}</div>` : "";
    tr.appendChild(td);
  }
}

function barClass(label){
  if(isProdType(label)) return "bar-prod";
  if(isMontType(label)) return "bar-mont";
  if(isPrepType(label)) return "bar-prep";
  if(isDeliveryType(label)) return "bar-delivery";
  return "bar-generic";
}

function normalizeType(t){
  const s = String(t||"").toLowerCase();
  if(!s) return "";
  // jouw PDF-termen
  if(s.includes("werkvoor")) return "werkvoorbereiding";
  if(s.includes("prod")) return "productie";
  if(s.includes("mont")) return "montage";
  if(s.includes("oplever")) return "oplevering";
  return s;
}

function isProdType(t){ const s=String(t||"").toLowerCase(); return s.includes("prod") || s==="productie"; }
function isMontType(t){ const s=String(t||"").toLowerCase(); return s.includes("mont") || s==="montage"; }
function isPrepType(t){ const s=String(t||"").toLowerCase(); return s.includes("werkvoor"); }
function isDeliveryType(t){ const s=String(t||"").toLowerCase(); return s.includes("oplever"); }

function availabilityClass(v){
  if (v >= 0) return "ok";
  if (v > -4) return "warn";
  return "bad";
}

// -------- small row helpers --------
function hdrCell(html, cls="", colspan=null){
  const th = document.createElement("th");
  th.className = ["hdr-cell", cls].filter(Boolean).join(" ");
  th.innerHTML = html ?? "";
  if (colspan) th.colSpan = colspan;
  return th;
}
function leftRowHdrCell(text, cls=""){
  const td = document.createElement("td");
  td.className = `rowhdr ${cls}`.trim();
  td.textContent = text;
  return td;
}
function spacerRow(cols){
  const tr = document.createElement("tr");
  tr.className = "spacer";
  const td = document.createElement("td");
  td.className = "rowhdr sticky-left";
  td.textContent = "";
  tr.appendChild(td);
  const td2 = document.createElement("td");
  td2.colSpan = cols;
  td2.className = "cell spacer-cell";
  tr.appendChild(td2);
  return tr;
}
function sectionHeaderRow(title, cols, compact=false){
  const tr = document.createElement("tr");
  tr.className = compact ? "row block-title compact" : "row block-title";
  const td = document.createElement("td");
  td.className = "rowhdr sticky-left block-hdr";
  td.innerHTML = `<span class="block-title-text">${escapeHtml(title)}</span>`;
  tr.appendChild(td);
  const fill = document.createElement("td");
  fill.colSpan = cols;
  fill.className = "cell block-fill";
  tr.appendChild(fill);
  return tr;
}
function labelRow(label, dates, byDay){
  const tr = document.createElement("tr");
  tr.className = "sum-row";
  tr.appendChild(leftRowHdrCell(label, "sticky-left sum-label"));
  for(const d of dates){
    const iso = toISODate(d);
    const h = byDay[iso] || 0;
    const td = document.createElement("td");
    td.className = `cell sum-cell ${isWeekend(d) ? "wknd" : ""}`;
    td.textContent = formatHoursCell(h);
    tr.appendChild(td);
  }
  return tr;
}
function infoRow(text, cols){
  const tr = document.createElement("tr");
  tr.className = "info-row";
  tr.appendChild(leftRowHdrCell(text, "sticky-left info-left"));
  const td = document.createElement("td");
  td.colSpan = cols;
  td.className = "cell info-cell";
  td.textContent = "";
  tr.appendChild(td);
  return tr;
}

function formatHoursCell(n){
  const v = Number(n||0);
  if(!v) return "0";
  // 2 decimal NL met komma, maar kort
  const s = (Math.round(v*100)/100).toString().replace(".", ",");
  return s;
}

function pickKey(obj, keys){
  if(!obj) return keys[0];
  for(const k of keys){
    if(Object.prototype.hasOwnProperty.call(obj, k)) return k;
  }
  return keys[0];
}

function escapeHtml(s){
  return String(s ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
function escapeAttr(s){
  return escapeHtml(String(s ?? "")).replaceAll('"', "&quot;");
}
function cssEsc(s){
  return String(s ?? "").replaceAll('"','\\"');
}

// -------- DAY LABEL BUILDERS (1 cel per dag) --------
function buildDayLabelsForSection(sectionId, workMap, dates){
  const dm = workMap.get(sectionId);
  return dates.map(d=>{
    const iso = toISODate(d);
    const rows = dm?.get(iso) || [];
    if(!rows.length) return "";
    const byType = {};
    for(const r of rows){
      const t = normalizeType(r.work_type);
      byType[t] = (byType[t]||0) + Number(r.hours||0);
    }
    let bestT = "", bestH = 0;
    for(const [t,h] of Object.entries(byType)){
      if(h > bestH){ bestH = h; bestT = t; }
    }
    return bestT || "";
  });
}

function buildDayLabelsForProject(projectId, sectiesByProject, sectIdKey, workMap, dates){
  const secs = sectiesByProject.get(projectId) || [];
  return dates.map(d=>{
    const iso = toISODate(d);
    const counts = {};
    for(const s of secs){
      const sid = s?.[sectIdKey];
      const rows = workMap.get(sid)?.get(iso) || [];
      for(const r of rows){
        const t = normalizeType(r.work_type);
        counts[t] = (counts[t]||0) + Number(r.hours||0);
      }
    }
    let bestT="", bestH=0;
    for(const [t,h] of Object.entries(counts)){
      if(h>bestH){ bestH=h; bestT=t; }
    }
    return bestT || "";
  });
}

function appendDayCells(tr, dates, labels, markerISO = ""){
  for(let i=0;i<dates.length;i++){
    const d = dates[i];
    const iso = toISODate(d);
    const label = labels[i] || "";

    const isStart = !!label && (i === 0 || labels[i-1] !== label);
    const isMarker = markerISO && iso === markerISO;

    const td = document.createElement("td");
    td.className = `cell plan-cell ${label ? barClass(label) : ""} ${isWeekend(d) ? "wknd" : ""}`.trim();

    // Bar tekst alleen op start van blok
    let html = "";
    if (isStart) html += `<div class="bar">${escapeHtml(label)}</div>`;

    // Oplever-marker: altijd tekenen als het die dag is
    if (isMarker) html += `<div class="deadline">oplever</div>`;

    td.innerHTML = html;
    tr.appendChild(td);
  }
}
