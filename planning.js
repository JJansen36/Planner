/* styles.css – clean light UI */
:root{
  --bg:#f4f6fb;
  --panel:#ffffff;
  --text:#0f172a;
  --muted:#64748b;
  --line:#e2e8f0;

  --acc:#2563eb;
  --good:#16a34a;
  --warn:#f59e0b;
  --bad:#ef4444;

  --chip-blue:#dbeafe;
  --chip-green:#dcfce7;
  --chip-purple:#f5d0fe;import { makeSupabaseClient, requireSession } from "./auth.js";
import { startOfISOWeek, addDays, toISODate, parseISODate } from "./utils.js";

const sb = makeSupabaseClient();

const el = (id) => document.getElementById(id);
let gridEl = null;
let statusEl = null;

function ensureContainers(){
  gridEl = el("plannerGrid");
  statusEl = el("plannerStatus");

  // status kan ontbreken in HTML: maak hem aan
  if (!statusEl) {
    statusEl = document.createElement("div");
    statusEl.id = "plannerStatus";
    statusEl.style.margin = "8px 0";
  }

  // grid kan ontbreken in HTML: maak hem aan
  if (!gridEl) {
    gridEl = document.createElement("div");
    gridEl.id = "plannerGrid";
  }

  const host = document.querySelector(".planner-page") || document.querySelector("main") || document.body;
  if (!statusEl.parentElement) host.appendChild(statusEl);
  if (!gridEl.parentElement) host.appendChild(gridEl);
}

const RANGE_DAYS = 56; // 8 weken zoals je PDF-screens
let rangeStart = startOfISOWeek(new Date()); // maandag

function bindUI(){
  const btnMenu = el("btnMenu");
  if (btnMenu) btnMenu.onclick = () => (location.href = "./index.html");

  const btnLogout = el("btnLogout");
  if (btnLogout) btnLogout.onclick = async () => { await sb.auth.signOut(); location.href = "./login.html"; };

  const btnToday = el("btnToday");
  if (btnToday) btnToday.onclick = () => { rangeStart = startOfISOWeek(new Date()); loadAndRender(); };

  const btnPrev = el("btnPrev");
  if (btnPrev) btnPrev.onclick = () => { rangeStart = addDays(rangeStart, -RANGE_DAYS); loadAndRender(); };

  const btnNext = el("btnNext");
  if (btnNext) btnNext.onclick = () => { rangeStart = addDays(rangeStart, +RANGE_DAYS); loadAndRender(); };

  const btnRefresh = el("btnRefresh");
  if (btnRefresh) btnRefresh.onclick = () => loadAndRender();
}

document.addEventListener("DOMContentLoaded", init);

async function init(){
  await requireSession(sb);
  bindUI();
  ensureContainers();

  // als statusEl om wat voor reden dan ook nog ontbreekt: dummy zodat je script niet crasht
  if (!statusEl) statusEl = { textContent: "" };

  if (!gridEl) {
    console.error("plannerGrid ontbreekt in HTML (id='plannerGrid') en kon niet aangemaakt worden.");
    return;
  }

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

// -------- SECTION DETAILS MODAL (sectie gegevens) --------
let secModal = null;

function ensureSecModal(){
  if (secModal) return secModal;

  const wrap = document.getElementById("secModalBackdrop");
  if (!wrap) {
    console.warn("secModalBackdrop ontbreekt in planning.html");
    return null;
  }

  const close = () => wrap.classList.remove("show");

  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });

  const c1 = document.getElementById("secModalClose");
  const c2 = document.getElementById("secModalClose2");
  if (c1) c1.onclick = close;
  if (c2) c2.onclick = close;

  secModal = { wrap, close };
  return secModal;
}

function openSectionDetailsModal({ sid, dateISO, sectie, totals, complTxt }){
  const modal = ensureSecModal();
  if (!modal) return;

  const sub = document.getElementById("secModalSub");
  const body = document.getElementById("secModalBody");

  if (sub) sub.textContent = `${dateISO} • ${sectie || "sectie"} • ${sid}`;
  if (body) {
    body.innerHTML = `
      <div class="fieldgrid" style="grid-template-columns: 170px 1fr;">
        <div class="label">Opleverdatum</div><div class="value">${escapeHtml(complTxt || "-")}</div>
        <div class="label">Werkvoorbereiding</div><div class="value">${escapeHtml(formatHoursCell(totals.prep))} uur</div>
        <div class="label">Productie</div><div class="value">${escapeHtml(formatHoursCell(totals.prod))} uur</div>
        <div class="label">Montage</div><div class="value">${escapeHtml(formatHoursCell(totals.mont))} uur</div>
      </div>
    `;
  }

  modal.wrap.classList.add("show");
}

// -------- ASSIGNMENTS MODAL (productie/montage + collega's) --------
let assignModal = null;

function ensureAssignModal(){
  if (assignModal) return assignModal;

  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.innerHTML = `
    <div class="modal assign-modal">
      <div class="hd">
        <div>
          <div class="assign-title">Inplannen</div>
          <div class="assign-sub" id="amSub"></div>
        </div>
        <button class="btn small" id="amClose" type="button">✕</button>
      </div>
      <div class="bd">
        <div class="assign-tabs">
          <button class="btn small assign-tab" data-tab="productie" type="button">Productie</button>
          <button class="btn small assign-tab" data-tab="montage" type="button">Montage</button>
        </div>
        <div class="hr"></div>
        <div id="amList" class="assign-list"></div>
      </div>
      <div class="ft">
        <button class="btn" id="amCancel" type="button">Annuleren</button>
        <button class="btn primary" id="amSave" type="button">Opslaan</button>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  const close = () => wrap.classList.remove("show");
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  wrap.querySelector("#amClose").onclick = close;
  wrap.querySelector("#amCancel").onclick = close;

  assignModal = { wrap, close };
  return assignModal;
}

// -------- CAPACITY MODAL (uren per medewerker per week) --------
let capModal = null;

function ensureCapModal(){
  if (capModal) return capModal;

  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.id = "capModalBackdrop";
  wrap.innerHTML = `
    <div class="modal assign-modal" role="dialog" aria-modal="true" aria-labelledby="capModalTitle">
      <div class="hd">
        <div>
          <div id="capModalTitle" class="assign-title">Beschikbaarheid</div>
          <div id="capModalSub" class="assign-sub"></div>
        </div>
        <button class="btn small" id="capModalClose" type="button">✕</button>
      </div>

      <div class="bd">
        <div class="row" style="justify-content:space-between; gap:10px; align-items:center;">
          <button class="btn small" id="capPrevWeek" type="button">◀ Week</button>
          <div class="muted" id="capWeekLabel"></div>
          <button class="btn small" id="capNextWeek" type="button">Week ▶</button>
        </div>

      <div class="hr"></div>

      <div class="row" style="gap:8px; flex-wrap:wrap; margin-bottom:10px;">
        <button class="btn small" id="capApplyEven" type="button">Doorvoeren in even weken</button>
        <button class="btn small" id="capApplyOdd" type="button">Doorvoeren in oneven weken</button>
        <button class="btn small" id="capApplyAll" type="button">Doorvoeren in alle weken</button>
      </div>

      <div id="capForm"></div>

      </div>

      <div class="ft">
        <button class="btn" id="capCancel" type="button">Annuleren</button>
        <button class="btn primary" id="capSave" type="button">Opslaan</button>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  const close = () => wrap.classList.remove("show");
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("#capModalClose").onclick = close;
  wrap.querySelector("#capCancel").onclick = close;

  capModal = { wrap, close };
  return capModal;
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

  // 6) section_assignments in range (collega's per sectie/dag + type)
  const { data: assigns, error: aErr } = await sb
    .from("section_assignments")
    .select("section_id, work_date, werknemer_id, work_type")
    .gte("work_date", startISO)
    .lte("work_date", endISO)
    .limit(200000);

  // Als tabel nog niet bestaat of er zijn geen rechten, wil je de planner niet "slopen".
  // We gaan dan verder zonder assignments.
  const safeAssigns = aErr ? [] : (assigns || []);
  if (aErr) console.warn("section_assignments niet geladen:", aErr.message);

  statusEl.textContent = "";

  renderPlanner({
    start,
    days: RANGE_DAYS,
    projecten,
    secties,
    work,
    cap,
    werknemers,
    assigns: safeAssigns
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
function renderPlanner({ start, days, projecten, secties, work, cap, werknemers, assigns }){
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
  // snelle lookup: sectionId -> sectie object
  const sectById = new Map();
  for (const s of secties || []) {
    const sid = s?.[sectIdKey]
      ? String(s[sectIdKey])
      : (s?.section_id ? String(s.section_id) : null);
    if (sid) sectById.set(sid, s);
  }

  // snelle lookup: projectId -> { complTxt }
  const projById = new Map();
  for (const p of projecten || []) {
    const pid = p?.[projIdKey];
    if (!pid) continue;
    const complRaw = p?.[completionKey] ?? "";
    projById.set(String(pid), {
      complTxt: formatDateNL(complRaw),
    });
  }

  // helper: totals per sectie (op basis van workMap + huidige dates)
  function calcSectionTotals(sid){
    let sumPrepS = 0, sumProdS = 0, sumMontS = 0;
    const dmS = workMap.get(String(sid));
    if (dmS) {
      for (const d of dates) {
        const iso = toISODate(d);
        const rows = dmS.get(iso) || [];
        for (const r of rows) {
          const wt = String(r.work_type || "");
          const h  = Number(r.hours || 0);
          if (isPrepType(wt)) sumPrepS += h;
          if (isProdType(wt)) sumProdS += h;
          if (isMontType(wt)) sumMontS += h;
        }
      }
    }
    return { prep: sumPrepS, prod: sumProdS, mont: sumMontS };
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

  // assignments map: sectionId -> dateISO -> {productie:Set(empId), montage:Set(empId)}
  const assignMap = new Map();
  for (const a of assigns || []) {
    const sid = String(a.section_id || "");
    const d = String(a.work_date || "");
    const emp = String(a.werknemer_id || "");
    const wt = String(a.work_type || "").toLowerCase();
    if (!sid || !d || !emp || !wt) continue;

    if (!assignMap.has(sid)) assignMap.set(sid, new Map());
    const dmA = assignMap.get(sid);
    if (!dmA.has(d)) dmA.set(d, { productie: new Set(), montage: new Set() });

    if (wt === "productie") dmA.get(d).productie.add(emp);
    if (wt === "montage") dmA.get(d).montage.add(emp);
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
  // -> op basis van section_assignments + capacity_entries (capByEmp)
  const plannedProdByDay = {};
  const plannedMontByDay = {};

  for (const a of assigns || []) {
    const d = String(a.work_date || "");
    const emp = String(a.werknemer_id || "");
    const wt = String(a.work_type || "").toLowerCase();
    if (!d || !emp || !wt) continue;

    const h = Number(capByEmp.get(emp)?.get(d) || 0);

    if (wt === "productie") plannedProdByDay[d] = (plannedProdByDay[d] || 0) + h;
    if (wt === "montage")  plannedMontByDay[d]  = (plannedMontByDay[d]  || 0) + h;
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
      </span>
    `;
    projRow.appendChild(left);

   

    
// tel ingeplande mensen per dag op over alle secties van dit project
const projAssignByDay = {};
const secs = sectiesByProject.get(pid) || [];

for (const dd of dates) {
  const iso = toISODate(dd);
  let prod = 0, mont = 0;

  for (const s of secs) {
    const sid = s?.[sectIdKey]
      ? String(s[sectIdKey])
      : (s?.section_id ? String(s.section_id) : null);
    if (!sid) continue;

    const entry = assignMap.get(String(sid))?.get(iso);
    if (entry) {
      prod += entry.productie.size;
      mont += entry.montage.size;
    }
  }

  projAssignByDay[iso] = { prod, mont };
}

// ✅ labels voor projectregel: op basis van assignments
// - alleen prod => "productie"
// - alleen mont => "montage"
// - beide => "productie" (of kies "bar-generic" als je liever neutraal wil)
const projLabels = dates.map(d => {
  const iso = toISODate(d);
  const prod = Number(projAssignByDay?.[iso]?.prod || 0);
  const mont = Number(projAssignByDay?.[iso]?.mont || 0);

  if (prod > 0 && mont === 0) return "productie";
  if (mont > 0 && prod === 0) return "montage";
  if (prod > 0 && mont > 0) return "productie"; // of return "" en kleur generic
  return "";
});

appendProjectDayCells(projRow, dates, projLabels, complISO, projAssignByDay);
tbody.appendChild(projRow);


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

     leftS.innerHTML = `
        <button class="expander expander-sec" data-sect="${escapeAttr(sid)}" aria-label="toggle sectie">▶</button>
        <span class="sectext sectname" data-sect="${escapeAttr(sid)}">↳ ${escapeHtml(sn)}</span>
      `;

      secRow.appendChild(leftS);

      const labels = buildDayLabelsForSection(sid, workMap, dates);
      
      // badge = aantal ingeplande collega's per type (productie / montage)
      const dmA = assignMap.get(String(sid));
      const assignByDay = {};
      for (const dd of dates) {
        const iso = toISODate(dd);
        const entry = dmA?.get(iso);
        assignByDay[iso] = {
          prod: entry ? entry.productie.size : 0,
          mont: entry ? entry.montage.size : 0,
        };
      }

      appendSectionDayCells(secRow, dates, labels, sid, assignByDay, assignMap, werknemers);



      tbody.appendChild(secRow);

    }
  }

  // CAPACITY BLOCK
tbody.appendChild(spacerRow(dates.length));

// Header row "Capaciteit"
tbody.appendChild(sectionHeaderRow("Capaciteit", dates.length));

// ---- Totaal rij eerst (met dropdown) ----
const capKey = "cap"; // unieke key voor deze groep

const trTotal = document.createElement("tr");
trTotal.className = "cap-total-row";

const tdTotalLeft = document.createElement("td");
tdTotalLeft.className = "rowhdr sticky-left cap-total-left";
tdTotalLeft.innerHTML = `
  <button class="expander cap-expander" data-cap="${capKey}" aria-label="toggle capaciteit">▶</button>
  <b>Totaal</b>
`;
trTotal.appendChild(tdTotalLeft);

// totalen per dag (som van alle medewerkers)
for (const d of dates){
  const iso = toISODate(d);
  const td = document.createElement("td");
  td.className = `cell sum-cell ${isWeekend(d) ? "wknd" : ""}`;
  td.textContent = formatHoursCell(capTotalByDay[iso] || 0);
  trTotal.appendChild(td);
}
tbody.appendChild(trTotal);

// ---- medewerker rijen (standaard verborgen) ----
const empIdKey = "id";
const empNameKey = pickKey(werknemers[0], ["naam","name","fullname","display_name"]);

for (const w of werknemers || []) {
  const wid = w?.[empIdKey];
  const wnm = w?.[empNameKey] ?? String(wid ?? "");

  const tr = document.createElement("tr");
  tr.className = "cap-emp-row hidden";
  tr.dataset.capParent = capKey; // koppeling aan totaal-row

  tr.appendChild(leftRowHdrCell(wnm, "sticky-left cap-name"));

  for (const d of dates){
    const iso = toISODate(d);
    const h = capByEmp.get(wid)?.get(iso) || 0;
    const td = document.createElement("td");
    td.className = `cell cap-cell ${isWeekend(d) ? "wknd" : ""}`;
    td.textContent = formatHoursCell(h);
    tr.appendChild(td);
  }

  tbody.appendChild(tr);
}


  // ---- Totaal capaciteit (som medewerkers per dag) ----
{
  const trTot = document.createElement("tr");
  trTot.className = "cap-total-row";

  const leftTot = leftRowHdrCell("Totaal", "sticky-left cap-name");
  trTot.appendChild(leftTot);

  for (const d of dates) {
    const iso = toISODate(d);
    const td = document.createElement("td");
    td.className = `cell cap-cell ${isWeekend(d) ? "wknd" : ""}`;
    td.textContent = formatHoursCell(capTotalByDay[iso] || 0);
    trTot.appendChild(td);
  }

  tbody.appendChild(trTot);
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



  // click on section cell -> assignments modal
  gridEl.onclick = async (ev) => {

    // klik op sectienaam (links) => sectie gegevens popup
const nameEl = ev.target.closest(".sectname");
if (nameEl) {
  const sid = String(nameEl.dataset.sect || "");
  if (!sid) return;

  const sObj = sectById.get(sid);
  const sectieNaam = sObj?.[sectNameKey] || sObj?.name || sObj?.naam || "sectie";

  const pid = sObj?.[sectProjKey] ? String(sObj[sectProjKey]) : "";
  const complTxt = projById.get(pid)?.complTxt || "";

  const totals = calcSectionTotals(sid);

  // datum voor in de header van popup (ik pak de start van je range)
  const dateISO = toISODate(start);

  openSectionDetailsModal({
    sid,
    dateISO,
    sectie: sectieNaam,
    totals,
    complTxt
  });
  return;
}

  // click op medewerkernaam (capaciteit) => popup week-invoer
  const empTd = ev.target.closest("td.cap-emp-click");
  if (empTd) {
    const empId = String(empTd.dataset.empId || "");
    const empName = String(empTd.dataset.empName || empId);
    if (!empId) return;

    const modal = ensureCapModal();
    const subEl = modal.wrap.querySelector("#capModalSub");
    const weekLabelEl = modal.wrap.querySelector("#capWeekLabel");
    const formEl = modal.wrap.querySelector("#capForm");
    const btnPrevW = modal.wrap.querySelector("#capPrevWeek");
    const btnNextW = modal.wrap.querySelector("#capNextWeek");
    const btnSave  = modal.wrap.querySelector("#capSave");
    const btnApplyEven = modal.wrap.querySelector("#capApplyEven");
    const btnApplyOdd  = modal.wrap.querySelector("#capApplyOdd");
    const btnApplyAll  = modal.wrap.querySelector("#capApplyAll");


    // start bij week van huidige view
    let wkStart = startOfISOWeek(new Date(rangeStart));

    const buildWeekDays = () => {
      const days = [];
      for (let i=0;i<7;i++) days.push(addDays(wkStart, i));
      return days;
    };

    const renderWeek = () => {
      const days = buildWeekDays();
      const startISO = toISODate(days[0]);
      const endISO = toISODate(days[6]);

      if (subEl) subEl.textContent = `${empName} • ${startISO} t/m ${endISO}`;
      if (weekLabelEl) weekLabelEl.textContent = `Week ${weekNumberISO(days[0])}`;

      // bestaande waarden ophalen uit capByEmp map
      const empMap = capByEmp.get(Number(empId)) || capByEmp.get(empId) || new Map();

      formEl.innerHTML = `
        <div class="fieldgrid" style="grid-template-columns: 120px 1fr;">
          ${days.map(d=>{
            const iso = toISODate(d);
            const val = Number(empMap.get(iso) || 0);
            return `
              <div class="label">${dayNameNL(d.getDay())} ${d.getDate()}-${d.getMonth()+1}</div>
              <div class="value" style="gap:10px;">
                <input
                  class="input"
                  type="text"
                  inputmode="decimal"
                  pattern="[0-9]*[.,]?[0-9]*"
                  data-iso="${iso}"
                  value="${val ? String(val).replace(".", ",") : ""}"
                  placeholder="0"
                />
              </div>
            `;
          }).join("")}
        </div>
      `;

      formEl.querySelectorAll('input.input[data-iso]').forEach(inp => {
  // Tijdens typen: NIET formatteren, alleen ongeldige tekens blokkeren
  inp.addEventListener("input", () => {
    inp.value = inp.value
      .replace(/[^0-9.,]/g, "")   // alleen cijfers + , .
      .replace(/(.*)[.,].*[.,]/, "$1$2"); // max 1 komma/punt
  });

  // Pas formatteren als je het veld verlaat (optioneel)
  inp.addEventListener("blur", () => {
    // maak het netjes NL: punt -> komma (maar pas na typen!)
    inp.value = inp.value.replace(".", ",");
  });
});


      // kleine hulp: komma naar punt bij typen
      formEl.querySelectorAll("input[data-iso]").forEach(inp=>{
        inp.addEventListener("input", ()=>{
          inp.value = inp.value.replace(",", ".");
        });
      });
    };

    btnPrevW.onclick = () => { wkStart = addDays(wkStart, -7); renderWeek(); };
    btnNextW.onclick = () => { wkStart = addDays(wkStart, +7); renderWeek(); };

    btnApplyEven.onclick = () => applyToFutureWeeks("even");
    btnApplyOdd.onclick  = () => applyToFutureWeeks("odd");
    btnApplyAll.onclick  = () => applyToFutureWeeks("all");

    // haal huidige ingevulde week uit de inputs
    const readCurrentWeekInputs = () => {
      const inputs = Array.from(formEl.querySelectorAll("input[data-iso]"));
      const values = []; // index 0..6
      for (const inp of inputs) {
        const raw = String(inp.value || "").trim().replace(",", ".");
        const hours = raw ? Number(raw) : 0;
        const hoursRounded = Math.round(hours * 4) / 4; // 0.25 stappen

        values.push(Number.isFinite(hoursRounded) ? hoursRounded : 0);

      }
      // garandeer 7 waarden
      while (values.length < 7) values.push(0);
      return values.slice(0,7);
    };

    // schrijft dezelfde 7 waarden naar een week-start (maandag)
    const writeWeekToRows = (wkStartDate, values7) => {
      const rows = [];
      for (let i=0;i<7;i++){
        const iso = toISODate(addDays(wkStartDate, i));
        const h = Number(values7[i] || 0);
        if (h > 0) {
          rows.push({
            work_date: iso,
            werknemer_id: Number(empId),
            hours: h,
            type: "werk"
          });
        }
      }
      return rows;
    };

    // voer door naar toekomstige weken binnen huidige horizon (range) — alleen toekomst
    const applyToFutureWeeks = async (mode /* "even"|"odd"|"all" */) => {
      const values7 = readCurrentWeekInputs();

      // toekomst = vanaf vandaag (ISO-week maandag van vandaag)
      const today = new Date();
      const todayWkStart = startOfISOWeek(today);

      // we beperken tot jouw planner horizon: eind van huidige view-range
      const viewEnd = addDays(new Date(rangeStart), RANGE_DAYS - 1);

      // start vanaf de week NA de huidige geselecteerde week
      let iter = addDays(wkStart, 7);

      // collect rows + delete windows
      const allInsertRows = [];
      const deleteRanges = []; // [{startISO,endISO}] per week

      while (iter <= viewEnd) {
        // alleen toekomstige weken
        if (iter >= todayWkStart) {
          const wkNr = weekNumberISO(iter);

          const ok =
            mode === "all" ||
            (mode === "even" && wkNr % 2 === 0) ||
            (mode === "odd"  && wkNr % 2 === 1);

          if (ok) {
            const startISO = toISODate(iter);
            const endISO = toISODate(addDays(iter, 6));
            deleteRanges.push({ startISO, endISO });
            allInsertRows.push(...writeWeekToRows(iter, values7));
          }
        }

        iter = addDays(iter, 7);
      }

      if (!deleteRanges.length) {
        alert("Geen toekomstige weken in bereik om door te voeren.");
        return;
      }

      // 1) eerst verwijderen per week (simpel en veilig)
      for (const r of deleteRanges) {
        const del = await sb
          .from("capacity_entries")
          .delete()
          .eq("werknemer_id", Number(empId))
          .eq("type", "werk")
          .gte("work_date", r.startISO)
          .lte("work_date", r.endISO);

        if (del.error) { alert("Fout verwijderen: " + del.error.message); return; }
      }

      // 2) insert alles (als er uren > 0 zijn)
      if (allInsertRows.length) {
        const ins = await sb.from("capacity_entries").insert(allInsertRows);
        if (ins.error) { alert("Fout opslaan: " + ins.error.message); return; }
      }

      modal.close();
      loadAndRender();
    };

    btnSave.onclick = async () => {
      const days = buildWeekDays();
      const startISO = toISODate(days[0]);
      const endISO   = toISODate(days[6]);

      const inputs = Array.from(formEl.querySelectorAll("input[data-iso]"));
      const rows = [];

      for (const inp of inputs) {
        const iso = String(inp.dataset.iso || "");
        const raw = String(inp.value || "").trim().replace(",", ".");
        const h = raw ? Number(raw) : 0;
        if (!iso) continue;
        if (h > 0) {
          rows.push({
            work_date: iso,
            werknemer_id: Number(empId),
            hours: h,
            type: "werk"
          });
        }
      }

      // Eerst oude weekregels weg, dan nieuwe erin (veilig zonder unieke constraints)
      const del = await sb
        .from("capacity_entries")
        .delete()
        .eq("werknemer_id", Number(empId))
        .eq("type", "werk")
        .gte("work_date", startISO)
        .lte("work_date", endISO);

      if (del.error) { alert("Fout verwijderen: " + del.error.message); return; }

      if (rows.length) {
        const ins = await sb.from("capacity_entries").insert(rows);
        if (ins.error) { alert("Fout opslaan: " + ins.error.message); return; }
      }

      modal.close();
      loadAndRender();
    };

    renderWeek();
    modal.wrap.classList.add("show");
    return;
  }

    const td = ev.target.closest("td.section-click");
    if (!td) return;

    const sid = String(td.dataset.sectionId || "");
    const dateISO = String(td.dataset.workDate || "");
    if (!sid || !dateISO) return;

        // ALT+klik => sectie gegevens popup (laat assignments modal met gewone klik)



    const modal = ensureAssignModal();
    modal.wrap.classList.add("show");

    // current selection
    const cur = assignMap.get(sid)?.get(dateISO) || { productie: new Set(), montage: new Set() };
    const selected = {
      productie: new Set(cur.productie),
      montage: new Set(cur.montage),
    };

    const subEl = modal.wrap.querySelector("#amSub");
    const listEl = modal.wrap.querySelector("#amList");
    const tabs = Array.from(modal.wrap.querySelectorAll(".assign-tab"));
    const saveBtn = modal.wrap.querySelector("#amSave");

    subEl.textContent = `${dateISO} • sectie`;

const empIdKey = "id"; // INTEGER pk in werknemers
const empNameKey = pickKey(werknemers?.[0], ["naam","name","fullname","display_name"]);

    let activeTab = "productie";

    const renderList = () => {
      tabs.forEach(t => t.classList.toggle("primary", t.dataset.tab === activeTab));
      listEl.innerHTML = "";

      for (const w of werknemers || []) {
        const eid = String(w?.[empIdKey] || "");
        const name = String(w?.[empNameKey] || eid);
        if (!eid) continue;

        const row = document.createElement("label");
        row.className = "assign-item";
        const checked = selected[activeTab].has(eid);
        row.innerHTML = `
          <input type="checkbox" ${checked ? "checked" : ""} data-eid="${escapeAttr(eid)}" />
          <span>${escapeHtml(name)}</span>
        `;
        row.querySelector("input").onchange = (e) => {
          const id = String(e.target.dataset.eid || "");
          if (!id) return;
          if (e.target.checked) selected[activeTab].add(id);
          else selected[activeTab].delete(id);
        };
        listEl.appendChild(row);
      }
    };

    tabs.forEach(t => {
      t.onclick = () => {
        activeTab = String(t.dataset.tab || "productie");
        renderList();
      };
    });

    renderList();

    saveBtn.onclick = async () => {
      // delete existing for this section+day
      const del = await sb
        .from("section_assignments")
        .delete()
        .eq("section_id", sid)
        .eq("work_date", dateISO);

      if (del.error) { alert("Fout verwijderen: " + del.error.message); return; }



    const rows = [];

    for (const eid of selected.productie) {
      const werknemerId = Number(eid);
      if (!Number.isFinite(werknemerId)) {
        alert(`Onjuiste werknemer_id (geen getal): "${eid}". Check werknemers.id`);
        console.log("Gekozen eid:", eid, "werknemers[0]:", werknemers?.[0]);
        return;
      }
      rows.push({ section_id: sid, work_date: dateISO, werknemer_id: werknemerId, work_type: "productie" });
    }

    for (const eid of selected.montage) {
      const werknemerId = Number(eid);
      if (!Number.isFinite(werknemerId)) {
        alert(`Onjuiste werknemer_id (geen getal): "${eid}". Check werknemers.id`);
        console.log("Gekozen eid:", eid, "werknemers[0]:", werknemers?.[0]);
        return;
      }
      rows.push({ section_id: sid, work_date: dateISO, werknemer_id: werknemerId, work_type: "montage" });
    }


      if (rows.length) {
        const ins = await sb.from("section_assignments").insert(rows);
        if (ins.error) { alert("Fout opslaan: " + ins.error.message); return; }
      }

      modal.close();
      loadAndRender();
    };
  };

// expanders (projects)
gridEl.querySelectorAll('.expander[data-proj]').forEach(btn => {
  btn.addEventListener("click", () => {
    const pid = String(btn.dataset.proj || "");
    const open = btn.classList.toggle("open");
    btn.textContent = open ? "▼" : "▶";

    gridEl.querySelectorAll("tr.section-row, tr.section-details-row").forEach(tr => {
      if (String(tr.dataset.parent || "") === pid) {
        // als project dicht gaat: alles weg
        tr.classList.toggle("hidden", !open);

        // extra: als project dicht is, zorg dat sectie-details ook dicht blijft
        if (!open && tr.classList.contains("section-details-row")) {
          tr.classList.add("hidden");
        }
      }
    });

    // als project dichtklapt: zet sectie-pijltjes terug op ▶
    if (!open) {
      gridEl.querySelectorAll(`tr.section-row[data-parent="${cssEsc(pid)}"] .expander-sec`).forEach(b => {
        b.textContent = "▶";
      });
    }


  });
});


// section expanders
gridEl.querySelectorAll(".expander-sec").forEach(btn => {
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();

    const sid = String(btn.dataset.sect || "");
    const parentTr = btn.closest("tr");
    const pid = String(parentTr?.dataset?.parent || "");

    // vind de details row van deze sectie
    const rows = Array.from(gridEl.querySelectorAll("tr.section-details-row"));
    const match = rows.find(r => String(r.dataset.sect || "") === sid && String(r.dataset.parent || "") === pid);
    if (!match) return;

    const nowHidden = match.classList.toggle("hidden");
    btn.textContent = nowHidden ? "▶" : "▼";
  });
});


// capacity dropdown (Totaal ▶ / ▼)
gridEl.querySelectorAll(".cap-expander").forEach(btn => {
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    const key = String(btn.dataset.cap || "");
    const open = btn.classList.toggle("open");
    btn.textContent = open ? "▼" : "▶";
    toggleRowsByKey(key, open);
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

function isUuid(v){
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""));
}

function getEmployeeUuidKey(werknemers){
  const row = werknemers?.[0] || {};
  // voorkeur: werknemer_id (uuid) → employee_id → auth_user_id
  const candidates = ["werknemer_id", "employee_id", "auth_user_id", "user_id"];
  for (const k of candidates){
    if (k in row) return k;
  }
  return null; // niets gevonden
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

function toggleRowsByKey(key, open){
  const rows = gridEl.querySelectorAll(`tr[data-cap-parent="${cssEsc(key)}"]`);
  rows.forEach(r => r.classList.toggle("hidden", !open));
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
      const sid = s?.[sectIdKey]
        ? String(s[sectIdKey])
        : (s?.section_id ? String(s.section_id) : null);

      if(!sid) continue;

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

function appendProjectDayCells(tr, dates, labels, markerISO = "", assignByDay = {}) {
  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const iso = toISODate(d);

    const prod = Number(assignByDay?.[iso]?.prod || 0);
    const mont = Number(assignByDay?.[iso]?.mont || 0);

    const label = labels[i] || "";
    const isStart = !!label && (i === 0 || labels[i - 1] !== label);
    const isMarker = markerISO && iso === markerISO;

    const td = document.createElement("td");

    // cel-kleur bepalen op basis van assignments (niet alleen label)
    let cls = `cell plan-cell ${isWeekend(d) ? "wknd" : ""}`.trim();
    if (prod > 0 && mont > 0) cls += " bar-both";
    else if (prod > 0) cls += " bar-prod";
    else if (mont > 0) cls += " bar-mont";
    else if (label) cls += ` ${barClass(label)}`; // fallback

    td.className = cls;

    let html = "";

    // deadline marker
    if (isMarker) html += `<div class="deadline">oplever</div>`;

    // bar tekenen als er iets gepland is
    if (prod > 0 || mont > 0 || label) {
      if (prod > 0 && mont > 0) {
        // split bar (2 lijntjes samen hoogte van 1 blokje)
        html += `
          <div class="bar bar-split">
            <div class="bar-half prod"></div>
            <div class="bar-half mont"></div>
          </div>
        `;
      } else {
        // normale bar, tekst alleen op start
        const txt = isStart ? (label || (prod > 0 ? "pro" : "mon")) : "&nbsp;";
        html += `<div class="bar">${txt}</div>`;
      }
    }

    // badges (aantallen)
    if (prod > 0) html += `<div class="assign-badge prod">${prod}</div>`;
    if (mont > 0) html += `<div class="assign-badge mont">${mont}</div>`;

    td.innerHTML = html;
    tr.appendChild(td);
  }
}




// like appendDayCells, but makes section-day cells clickable for assignments
function appendSectionDayCells(tr, dates, labels, sectionId, assignCountByDay, assignMap, werknemers) {

    // map werknemer_id -> naam (1x per render)
  const empIdKey = "id";
  const empNameKey = pickKey(werknemers?.[0], ["naam","name","fullname","display_name"]);
  const empNameById = new Map((werknemers || []).map(w => [String(w?.[empIdKey]), String(w?.[empNameKey] || w?.[empIdKey] || "")]));


  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const iso = toISODate(d);

    const prod = Number(assignCountByDay?.[iso]?.prod || 0);
    const mont = Number(assignCountByDay?.[iso]?.mont || 0);

    const label = labels[i] || "";
    const isStart = !!label && (i === 0 || labels[i - 1] !== label);

    const td = document.createElement("td");
    td.dataset.sectionId = String(sectionId || "");
    td.dataset.workDate = iso;

        // tooltip met namen (alleen tonen als er assignments zijn)
    const entry = assignMap?.get(String(sectionId))?.get(iso);
    if (entry) {
      const prodNames = Array.from(entry.productie || []).map(id => empNameById.get(String(id)) || String(id));
      const montNames = Array.from(entry.montage || []).map(id => empNameById.get(String(id)) || String(id));

      let tip = "";
      if (prodNames.length) tip += `Productie:\n- ${prodNames.join("\n- ")}`;
      if (montNames.length) tip += (tip ? "\n\n" : "") + `Montage:\n- ${montNames.join("\n- ")}`;

      if (tip) td.dataset.tip = tip;
    }


    // cel-kleur bepalen op basis van assignments, zodat het altijd klopt
    let cls = `cell plan-cell section-click ${isWeekend(d) ? "wknd" : ""}`.trim();
    if (prod > 0 && mont > 0) cls += " bar-both";
    else if (prod > 0) cls += " bar-prod";
    else if (mont > 0) cls += " bar-mont";
    else if (label) cls += ` ${barClass(label)}`;

    td.className = cls;

    let html = "";

    // bar tekenen
    if (prod > 0 && mont > 0) {
      html += `
        <div class="bar bar-split">
          <div class="bar-half prod"></div>
          <div class="bar-half mont"></div>
        </div>
      `;
    } else if (prod > 0 || mont > 0 || label) {
      // normale bar (tekst alleen op start)
      const txt = isStart ? (label || (prod > 0 ? "pro" : "mon")) : "&nbsp;";
      html += `<div class="bar">${txt}</div>`;
    }

    // badges
    if (prod > 0) html += `<div class="assign-badge prod">${prod}</div>`;
    if (mont > 0) html += `<div class="assign-badge mont">${mont}</div>`;

    td.innerHTML = html;
    tr.appendChild(td);
  }
}




  --radius:14px;
  --shadow: 0 8px 28px rgba(2,6,23,.08);
}

*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  background:var(--bg);
  color:var(--text);
}

a{color:inherit; text-decoration:none}

.container.full-width{
  max-width: none !important;
  width: 100%;
}

.topbar{
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
  padding:14px 16px;
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius);
  box-shadow:var(--shadow);
}

.brand{
  display:flex;
  align-items:center;
  gap:10px;
  font-weight:800;
  letter-spacing:.2px;
}
.brand .dot{
  width:11px;height:11px;border-radius:50%;
  background:var(--acc);
  box-shadow:0 0 0 4px rgba(37,99,235,.15);
}

.btn{
  border:1px solid var(--line);
  background:var(--panel);
  color:var(--text);
  padding:10px 12px;
  border-radius:12px;
  cursor:pointer;
  font-weight:650;
}
.btn:hover{border-color:#cbd5e1}
.btn.primary{
  background:var(--acc);
  border-color:var(--acc);
  color:#fff;
}
.btn.primary:hover{filter:brightness(.98)}
.btn.ghost{
  background:transparent;
}
.btn.small{padding:8px 10px; border-radius:10px; font-weight:650;}

.card{
  margin-top:14px;
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:var(--radius);
  box-shadow:var(--shadow);
  overflow:hidden;
}

.card .hd{
  padding:14px 16px;
  border-bottom:1px solid var(--line);
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:12px;
}

.card .hd h1, .card .hd h2{margin:0; font-size:18px}
.card .bd{padding:16px}

.grid{
  display:grid;
  gap:14px;
}
.grid.cols-2{grid-template-columns: 1fr 1fr;}
.grid.cols-3{grid-template-columns: 1fr 1fr 1fr;}
@media (max-width: 980px){
  .grid.cols-2,.grid.cols-3{grid-template-columns:1fr}
}

.kpi-title{
  font-size:14px;
  color:var(--muted);
  margin:0 0 8px;
}

.fieldgrid{
  display:grid;
  grid-template-columns: 220px 1fr;
  gap:8px 12px;
  align-items:center;
}
@media (max-width: 720px){
  .fieldgrid{grid-template-columns: 1fr}
}

.label{
  color:var(--muted);
  font-size:13px;
}
.value{
  background: #f8fafc;
  border:1px solid var(--line);
  border-radius:10px;
  padding:8px 10px;
  min-height: 36px;
  display:flex;
  align-items:center;
  overflow:hidden;
  white-space:nowrap;
  text-overflow:ellipsis;
}

.chip{
  display:inline-flex;
  align-items:center;
  gap:8px;
  padding:10px 12px;
  border-radius:12px;
  font-weight:800;
  letter-spacing:.2px;
  border:1px solid var(--line);
}
.chip.blue{background:var(--chip-blue)}
.chip.green{background:var(--chip-green)}
.chip.purple{background:var(--chip-purple)}

.muted{color:var(--muted)}
.row{
  display:flex;
  gap:10px;
  flex-wrap:wrap;
  align-items:center;
}

.input{
  width:100%;
  padding:10px 12px;
  border-radius:12px;
  border:1px solid var(--line);
  background:#fff;
  outline:none;
}
.input:focus{border-color:#93c5fd; box-shadow:0 0 0 4px rgba(147,197,253,.25)}

.table{
  width:100%;
  border-collapse:collapse;
  border:1px solid var(--line);
  border-radius:12px;
  overflow:hidden;
}
.table th, .table td{
  padding:10px 10px;
  border-bottom:1px solid var(--line);
  font-size:14px;
  vertical-align:top;
}
.table th{
  text-align:left;
  color:var(--muted);
  font-weight:700;
  background:#f8fafc;
}
.table tr:hover td{background:#f8fafc}

.pill{
  padding:4px 8px;
  border-radius:999px;
  font-size:12px;
  font-weight:750;
  border:1px solid var(--line);
  background:#fff;
}

.accordion-row{
  cursor:pointer;
}
.section-details{
  padding:0 0 0 0;
}
.section-details .inner{
  padding:14px 12px;
  background:#f8fafc;
  border-top:1px solid var(--line);
}

/* Modal */
.modal-backdrop{
  position:fixed; inset:0;
  background:rgba(15,23,42,.35);
  display:none;
  align-items:center;
  justify-content:center;
  padding:18px;
  z-index:50;
}
.modal-backdrop.show{display:flex;}
.modal{
  width:min(720px, 100%);
  background:var(--panel);
  border:1px solid var(--line);
  border-radius:18px;
  box-shadow:var(--shadow);
  overflow:hidden;
}
.modal .hd{padding:14px 16px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between; gap:10px;}
.modal .bd{padding:16px;}
.modal .ft{padding:14px 16px; border-top:1px solid var(--line); display:flex; justify-content:flex-end; gap:10px;}

.split2{display:grid; grid-template-columns:1fr 1fr; gap:10px;}
@media (max-width:720px){.split2{grid-template-columns:1fr}}
.hr{height:1px;background:var(--line);margin:10px 0}

.notice{
  padding:10px 12px;
  border:1px solid #bae6fd;
  background:#eff6ff;
  border-radius:12px;
  color:#0c4a6e;
}
.error{
  padding:10px 12px;
  border:1px solid #fecaca;
  background:#fff1f2;
  border-radius:12px;
  color:#7f1d1d;
}

/* =========================
   PLANNER (table-based) — SINGLE SOURCE OF TRUTH
   Doel: header (maand/week/dag) exact uitgelijnd met body dagcellen
========================= */
/* planner vars (los van theme vars) */
.planner-table{
  --left-w: 380px;
  --day-w: 32px;
  --hdr-month-h: 26px;
  --hdr-week-h: 26px;
  --hdr-day-h: 40px;
  --cell-h: 18px;
  --grid-line: #e6eaf0;
  --hdr-bg: #f2f4f7;
  --wknd-bg: #dbeafe;
}


.planner-table{
  width: 100%;
  border-collapse: collapse;   /* <-- dit is de fix */
  table-layout: fixed;
}

/* linker kolom (hoek + rijlabels) */
.planner-table th.rowhdr,
.planner-table td.rowhdr{
  width: var(--left-w);
  min-width: var(--left-w);
  max-width: var(--left-w);
  box-sizing: border-box;
  padding: 0 6px;
  text-align: left;
  background: #fff;
}


/* maand/week rows: colspan mag bepalen */
.planner-table thead tr.hdr-month th.hdr-cell{
  height: var(--hdr-month-h);
  line-height: var(--hdr-month-h);
  padding: 0 4px;
  font-size: 12px;
}
.planner-table thead tr.hdr-week th.hdr-cell{
  height: var(--hdr-week-h);
  line-height: var(--hdr-week-h);
  padding: 0 4px;
  font-size: 11px;
}

/* dag header rij: vaste width = dagcel width */
.planner-table thead tr.hdr-day th.hdr-cell{
  width: var(--day-w);
  min-width: var(--day-w);
  max-width: var(--day-w);
  height: var(--hdr-day-h);
  padding: 0 !important;
  font-size: 11px;
  line-height: 1.1;
  vertical-align: bottom;
}

.planner-table th.hdr-cell,
.planner-table td.cell{
  border: 1px solid #e6eaf0;
  box-sizing: border-box;
}

/* weekend */
.planner-table td.cell.wknd{ background: var(--wknd-bg) !important; }

/* planning bars */
.plan-cell{ padding:0 !important; }
.plan-cell .bar{
  height: var(--cell-h);
  line-height: var(--cell-h);
  margin: 0;
  border-radius: 6px;
  font-size: 11px;
  overflow: hidden;
}

/* sticky headers (3 rijen) — offsets matchen exact met headerhoogtes */
.sticky-top{
  position: sticky;
  top: 0;
  z-index: 60;
  background: var(--hdr-bg);
}
.sticky-top2{
  position: sticky;
  top: var(--hdr-month-h);
  z-index: 59;
  background: var(--hdr-bg);
}
.sticky-top3{
  position: sticky;
  top: calc(var(--hdr-month-h) + var(--hdr-week-h));
  z-index: 58;
  background: var(--hdr-bg);
}

/* sticky linkerkolom (als gebruikt) */
.sticky-left{
  position: sticky;
  left: 0;
  z-index: 40;
  background: #fff;
  box-shadow: 1px 0 0 var(--grid-line);
}




/* =========================
   PLANNER (PDF-style grid)
========================= */
.planner-page{ background:#fff; color:#111; min-height:100vh; }
.planner-topbar{
  display:flex; align-items:center; justify-content:space-between;
  padding:14px 18px; border-bottom:1px solid #e6e8ef; position:sticky; top:0; background:#fff; z-index:50;
}
.planner-title{ font-weight:700; font-size:18px; margin-left:10px; }
.planner-topbar-left{ display:flex; align-items:center; gap:10px; }
.planner-topbar-right{ display:flex; gap:10px; flex-wrap:wrap; }

.planner-wrap{ padding:12px 10px 30px; }
.planner-status{ color:#667085; padding:6px 2px; }

.planner-grid{ overflow:auto; border:1px solid #e6e8ef; border-radius:12px; background:#fff; }


.planner-table th, .planner-table td{
  border:1px solid #e6e8ef;
  padding:3px 4px;
  text-align:center;
  white-space:nowrap;
}
.rowhdr{
  text-align:left !important;
  background:#fff;
}
.hdr-cell{
  background:#f2f4f7;
  font-weight:700;
}
.hdr-month th{ font-size:12px; }
.hdr-week th{ font-size:11px; }
.hdr-day th{ font-size:11px; font-weight:600; }


.project-cell{ background:#fff; font-weight:700; }
.section-cell{ background:#fff; color:#344054; }
.sectext{ opacity:.95; }

.expander{
  border:1px solid #d0d5dd; background:#fff; border-radius:8px;
  width:26px; height:22px; cursor:pointer; margin-right:8px;
}
.projtext{ vertical-align:middle; }

.hidden{ display:none; }

.cell{ min-width:32px; max-width:32px; }
.wknd{ background:#dbeafe !important; } /* weekend-blauw zoals je PDF */

/* leeg = wit, weekend = blauw */
.planner-table td.cell:not(.wknd){
  background:#fff !important;
}

.plan-cell{ background:#fff; }
.plan-cell .bar{
  width:100%; height:18px; line-height:18px;
  border-radius:6px; font-size:11px;
  overflow:hidden; text-overflow:ellipsis;
  padding:0 6px;
  text-align:left;
}
.bar-prep .bar{ background:#c7e0ff; }
.bar-prod .bar{ background:#b7f0c2; }
.bar-mont .bar{ background:#f6c1f3; }
.bar-delivery .bar{ background:#ffd7b5; }
.bar-generic .bar{ background:#e5e7eb; }

.spacer td{ border:none; padding:6px 0; }
.spacer-cell{ background:#fff; }

.block-title .block-hdr{
  background:#f2f4f7;
  font-weight:800;
}
.block-title .block-fill{ background:#f2f4f7; }
.block-title.compact .block-hdr{ font-weight:700; }

.cap-emp-row .cap-name{ background:#fff; font-weight:600; }
.cap-cell{ background:#fff; }

.sum-row .sum-label{ background:#fff; font-weight:700; }
.sum-cell{ background:#fff7d6; } /* lichtgeel zoals PDF */
.sum-cell.ok{ background:#c7f7cf; }
.sum-cell.warn{ background:#ffe7b5; }
.sum-cell.bad{ background:#ffc6c6; }

.info-row .info-left{ color:#667085; font-style:italic; }


/* --- Sticky header: stabiel bij horizontaal scrollen --- */
.planner-topbar{ height:56px; }              /* belangrijk: vaste hoogte */
.planner-grid{ position:relative; }          /* zorgt voor stabiele sticky context */

.sticky-left{
  position: sticky;
  left: 0;
  z-index: 40;
  background: #fff;
}

/* 3 header-rijen: maand / week / dag */
.sticky-top{ position: sticky; top: 0;  z-index: 60; background:#f2f4f7; }
/* linker header-cellen moeten boven alles blijven */
.hdr-cell.sticky-left{ z-index: 80; background:#f2f4f7; }

/* rijlabels links in body moeten boven body-cellen maar onder header */
td.rowhdr.sticky-left{ z-index: 50; background:#fff; }

/* voorkom “doorzicht”/flikkeren */
.planner-table th, .planner-table td{
  background-clip: padding-box;
}


.hdr-cell{
  height: 26px;
  vertical-align: middle;
}
.hdr-day .hdr-cell{ height: 40px; }

/* === DEFINITIEVE FIX: alleen echte dagcellen hebben vaste breedte === */


/* body dagcellen */
.planner-table td.cell{
  width: 32px;
  min-width: 32px;
  max-width: 32px;
  box-sizing: border-box;
  padding: 0;
  text-align: center;
  border: 1px solid #e6eaf0;
}

/* alleen de DAG header rij (niet maand/week met colspan!) */
.planner-table thead tr.hdr-day th.hdr-cell{
  width: 32px;
  min-width: 32px;
  max-width: 32px;
  box-sizing: border-box;
  padding: 0;
  text-align: center;
  border: 1px solid #e6eaf0;

  background:#f2f4f7;
  font-size:11px;
  line-height:1.1;
  height: 40px;
  vertical-align: bottom;
}

/* maand/week header cells NIET forceren (colspan moet werken) */
.planner-table thead tr.hdr-month th.hdr-cell,
.planner-table thead tr.hdr-week  th.hdr-cell{
  width: auto;
  min-width: 0;
  max-width: none;
  padding: 3px 4px;
}

/* linker kolom exact vast */
.planner-table th.rowhdr,
.planner-table td.rowhdr{
  width: 380px;
  min-width: 380px;
  max-width: 380px;
}



/* dagcellen strak */
.planner-table td.cell{
  width: 32px;
  min-width: 32px;
  max-width: 32px;

  height: 18px;         /* <- kies 18/20/22 */
  line-height: 18px;

  padding: 0 !important;
  margin: 0;
  box-sizing: border-box;

  background: #fff;     /* leeg = wit */
}

.planner-table thead tr.hdr-day th.hdr-cell{
  padding: 0;
}

.plan-cell{
  padding: 0 !important;
}

.plan-cell .bar{
  height: 18px;
  line-height: 18px;
  margin: 0;
  border-radius: 6px;
}

.completiondate{
  opacity: .75;
  font-size: 12px;
  margin-left: 6px;
  white-space: nowrap;
}

.deadline{
  display:inline-block;
  padding:2px 6px;
  border-radius:6px;
  font-size:11px;
  line-height:1.2;
  background:#f6a623;   /* oranje */
  color:#111;
  font-weight:600;
  white-space:nowrap;
}

.project-details-cell .details-box{
  padding:6px 8px;
  font-size:12px;
  line-height:1.3;
}
.details-title{
  font-weight:700;
  margin-bottom:4px;
}
.details-line{
  opacity:.9;
}
.details-fill{
  background:#fff;
  padding: 10px;
}

.expander-sec{ margin-right:6px; }
.section-details-cell .details-box{ padding:6px 8px; font-size:12px; line-height:1.3; }

.details-box{
  margin: 0 !important;
  display: inline-block; /* voorkomt rare stretch/center gedrag */
}
/* =========================
   Section assignments popup
========================= */
td.section-click{
  position: relative;
  cursor: pointer;
}
.assign-badge{
  position: absolute;
  right: 2px;
  bottom: 2px;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
  background: #111827;
  color: #fff;
  opacity: .85;
}

.modal.assign-modal{
  width: 460px;
  max-width: calc(100vw - 24px);
}
.assign-modal .hd{
  display:flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 12px;
}
.assign-title{ font-weight: 700; }
.assign-sub{ font-size: 12px; opacity: .75; }
.assign-tabs{
  display:flex;
  gap: 8px;
  flex-wrap: wrap;
}
.assign-list{
  margin-top: 8px;
  max-height: 50vh;
  overflow: auto;
  display:flex;
  flex-direction: column;
  gap: 6px;
}
.assign-item{
  display:flex;
  align-items:center;
  gap: 10px;
  padding: 6px 8px;
  border: 1px solid rgba(0,0,0,.12);
  border-radius: 10px;
}
.assign-item input{ transform: scale(1.05); }



/* groen = productie */
.assign-badge.prod{
  background: #2fbf71;
}

/* paars = montage */
.assign-badge.mont{
  background: #7b61ff;
}




.bar.bar-split .bar-half{
  flex:1;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:11px;              /* match jouw bar-tekst */
  line-height:1;
}

/* Zorg dat boven/onder afgerond blijven */
.bar.bar-split .bar-half:first-child{
  border-top-left-radius:999px;
  border-top-right-radius:999px;
}
.bar.bar-split .bar-half:last-child{
  border-bottom-left-radius:999px;
  border-bottom-right-radius:999px;
}


.bar.bar-split .bar-half{
  flex: 1;
}


/* split bar: 2 lijntjes samen even hoog als 1 bar */
.bar.bar-split{
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  height: 18px;            /* pas aan als jouw bar hoger/lager is */
  justify-content: center;
}

.bar.bar-split .bar-half{
  height: calc((18px - 2px) / 2);  /* 2 helften + gap */
  border-radius: 6px;
  width: 100%;
}

.bar.bar-split .bar-half.prod{ background: #86efac; }  /* zelfde groen als productie */
.bar.bar-split .bar-half.mont{ background: #a78bfa; }  /* zelfde paars als montage */

/* optioneel: als je een neutrale cel-achtergrond wil bij beide */
td.bar-both{ background: rgba(0,0,0,.02); }/* laat leeg of geef subtiele achtergrond */ 

/* ===== Split bar (productie + montage in 1 cel) ===== */

/* Zorg dat split niet wordt “gesloopt” door .plan-cell .bar */
.plan-cell .bar.bar-split{
  padding:0 !important;
  text-align: initial !important;
  height: 18px !important;          /* match .plan-cell .bar hoogte */
  line-height: normal !important;
  display:flex !important;
  flex-direction: column !important;
  gap: 2px;
  overflow:hidden;
  border-radius:6px;
}

/* 2 helften samen exact 18px hoog */
.plan-cell .bar.bar-split .bar-half{
  height: calc((18px - 2px) / 2);
  width: 100%;
  border-radius: 6px;
}

/* kleuren exact gelijk aan je bestaande bar-prod / bar-mont */
.plan-cell .bar.bar-split .bar-half.prod{ background:#b7f0c2; }
.plan-cell .bar.bar-split .bar-half.mont{ background:#f6c1f3; }


/* 2-koloms layout: links vaste breedte, rechts de dagen */
.grid-row{
  display:grid;
  grid-template-columns: 360px 1fr; /* pas aan naar wens */
  align-items: stretch;
}

.row-left{
  padding: 10px 12px;
  border-right: 1px solid var(--line, #e5e7eb);
}

.row-cells{
  display:grid;
  grid-template-columns: repeat(var(--days, 7), 1fr);
}

.day-cell{
  min-height: 34px;
  border-right: 1px solid var(--line, #e5e7eb);
  border-bottom: 1px solid var(--line, #e5e7eb);
}


.planning-grid{
  width: 100%;
  overflow-x: auto; /* handig bij veel dagen */
}

table.planner-table{
  width: 100%;
  border-collapse: collapse;
}

td.details-fill{
  text-align:left !important;
  vertical-align: top;
}


/* verberg de nummer-badges */
.assign-badge{ display:none !important; }


/* tooltip op planningcellen */
td.section-click{
  position: relative;           /* had je al, maar houden */
}

td.section-click[data-tip]:hover::after{
  content: attr(data-tip);
  position: absolute;
  left: 6px;
  top: calc(100% + 6px);
  z-index: 200;
  background: #111827;
  color: #fff;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.25;
  white-space: pre-line;        /* \n tonen als nieuwe regel */
  min-width: 160px;
  max-width: 320px;
  box-shadow: 0 10px 26px rgba(0,0,0,.18);
}

td.section-click[data-tip]:hover::before{
  content: "";
  position: absolute;
  left: 14px;
  top: calc(100% + 2px);
  border: 6px solid transparent;
  border-bottom-color: #111827;
  z-index: 201;
}

/* --- Sectie gegevens: écht tegen de linkerkant van de kalenderzone --- */
td.details-fill-wide{
  text-align: left !important;
  padding: 0 !important;              /* kill inherited td padding */
}

td.details-fill-wide .details-box{
  display: block !important;
  margin: 0 !important;
  padding: 8px 10px;                  /* padding binnen de box, niet in de td */
}

td.details-fill-wide .details-box{
  transform: translateX(-1px);
}

/* ===== Sectie gegevens: force links in de brede details-cel ===== */
td.details-fill,
td.details-fill-wide{
  padding: 0 !important;
  text-align: left !important;
  vertical-align: top !important;
}

td.details-fill .details-wrap,
td.details-fill-wide .details-wrap{
  display: block !important;
  width: 100% !important;
  margin: 0 !important;
  padding: 8px 10px !important;     /* padding hier, niet op td */
  text-align: left !important;
}

td.cap-emp-click{
  cursor:pointer;
}
td.cap-emp-click:hover{
  background:#f8fafc;
}
/* Kleinere tekst in capaciteit + totalen (zelfde gevoel als planning) */
.planner-table td.cap-cell,
.planner-table td.sum-cell {
  font-size: 12px;          /* pas aan naar 11px als je 'm nog kleiner wilt */
  line-height: 1.1;
  font-variant-numeric: tabular-nums; /* netjes uitlijnen van cijfers */
}

/* optioneel: als je ook de linker namen (Berry/Luuk/...) kleiner wilt */
.planner-table td.cap-name,
.planner-table td.sum-label {
  font-size: 12px;
}

.cap-total-row .cap-total-left{
  background: #fff; /* of jouw panel kleur */
}

.cap-expander{
  margin-right: 8px;
}
