// planning.js
import { makeSupabaseClient, requireSession, signOut } from "./auth.js";
import { DB } from "./config.js";
import {
  el, escapeHtml, fmtDate, setStatus,
  getQueryParam, setQueryParam,
  startOfISOWeek, addDays, toISODate, parseISODate
} from "./utils.js";

const sb = makeSupabaseClient();

// ====== helpers ======
const TYPE_OPTIONS = [
  {value:"werk", label:"Werk", counts:true},
  {value:"verlof", label:"Verlof", counts:false},
  {value:"ziek", label:"Ziek", counts:false},
  {value:"inhuur", label:"Inhuur", counts:true},
  {value:"overig", label:"Overig", counts:false},
];

const WORK_TYPES = [
  {value:"prod", label:"Productie"},
  {value:"mont", label:"Montage"},
  {value:"reis", label:"Reis"},
  {value:"wvb", label:"Werkvoorbereiding"},
];

function countsTowardsCapacity(type){
  const t = TYPE_OPTIONS.find(x=>x.value===type);
  return t? !!t.counts : false;
}

function getEmployeeId(row){
  return row?.[DB.employeePkCol];
}

function getEmployeeName(row){
  const preferred = DB.employeeNameCol;
  if (preferred && row?.[preferred]) return row[preferred];
  for (const k of ["naam","name","full_name","fullname","email","username"]){
    if (row?.[k]) return row[k];
  }
  return String(getEmployeeId(row) || "(onbekend)");
}

function dayLabel(date){
  // NL compact
  const d = new Date(date+"T00:00:00");
  const wd = ["zo","ma","di","wo","do","vr","za"][d.getDay()];
  return `${wd} ${String(d.getDate()).padStart(2,"0")}-${String(d.getMonth()+1).padStart(2,"0")}`;
}

function parseNum(v){
  const n = Number(String(v).replace(",","."));
  return Number.isFinite(n) ? n : 0;
}

// ====== state ======
let session = null;
let weekStart = null; // ISO date
let days = []; // ISO dates
let employees = [];
let empById = new Map();

// caches
let capacityMap = new Map(); // key: `${empId}|${date}` -> {id, hours, type}
let workMap = new Map();     // key: `${section_id}|${date}` -> array entries
let projects = [];
let customers = new Map();
let sectionsByProject = new Map();

// ====== init ======
document.addEventListener("DOMContentLoaded", init);

async function init(){
  session = await requireSession(sb);
  if (!session) return;

  // UI hooks
  el("btnLogout").addEventListener("click", async()=>{ await signOut(sb); window.location.href = "login.html"; });
  el("btnPrev").addEventListener("click", ()=> shiftWeek(-1));
  el("btnNext").addEventListener("click", ()=> shiftWeek(1));
  el("btnToday").addEventListener("click", ()=> goToday());
  el("btnRefresh").addEventListener("click", ()=> loadAll());

  el("tabOverview").addEventListener("click", ()=> setTab("overview"));
  el("tabCapacity").addEventListener("click", ()=> setTab("capacity"));
  el("q").addEventListener("input", ()=> renderProjects());

  // default week
  const qp = getQueryParam("d");
  const base = qp ? parseISODate(qp) : new Date();
  const ws = startOfISOWeek(base);
  weekStart = toISODate(ws);
  setQueryParam("d", weekStart);
  computeDays();

  await loadAll();
  setTab(getQueryParam("tab") || "overview");
}

function setTab(name){
  const isOverview = name === "overview";
  el("tabOverview").classList.toggle("primary", isOverview);
  el("tabCapacity").classList.toggle("primary", !isOverview);
  el("overview").style.display = isOverview ? "block" : "none";
  el("capacity").style.display = !isOverview ? "block" : "none";
  setQueryParam("tab", name);
}

function shiftWeek(deltaWeeks){
  const base = parseISODate(weekStart);
  const next = addDays(base, deltaWeeks*7);
  weekStart = toISODate(startOfISOWeek(next));
  setQueryParam("d", weekStart);
  computeDays();
  loadAll();
}

function goToday(){
  weekStart = toISODate(startOfISOWeek(new Date()));
  setQueryParam("d", weekStart);
  computeDays();
  loadAll();
}

function computeDays(){
  days = [];
  const ws = parseISODate(weekStart);
  for (let i=0;i<7;i++) days.push(toISODate(addDays(ws,i)));

  const label = `${dayLabel(days[0])}  →  ${dayLabel(days[6])}`;
  el("rangeLabel").textContent = label;
}

// ====== loading ======
async function loadAll(){
  setStatus(el("status"), "Laden...", "");

  try{
    await loadEmployees();
    await loadCapacityEntries();
    await loadProjectsCustomersSections();
    await loadSectionWork();

    renderOverview();
    renderCapacity();
    renderProjects();

    setStatus(el("status"), "", "");
  }catch(err){
    setStatus(el("status"), String(err?.message||err), "error");
    console.error(err);
  }
}

async function loadEmployees(){
  const { data, error } = await sb
    .from(DB.tables.employees)
    .select("*")
    .order(DB.employeeNameCol || "naam", { ascending:true });
  if (error) throw error;
  employees = data || [];
  empById = new Map(employees.map(e=>[getEmployeeId(e), e]));
}

async function loadCapacityEntries(){
  capacityMap = new Map();
  if (!DB.tables.capacityEntries) return;

  const from = days[0];
  const to = days[6];

  const { data, error } = await sb
    .from(DB.tables.capacityEntries)
    .select("id, work_date, werknemer_id, hours, type")
    .gte("work_date", from)
    .lte("work_date", to);
  if (error) throw error;
  for (const r of (data||[])){
    capacityMap.set(`${r.werknemer_id}|${r.work_date}`, r);
  }
}

async function loadProjectsCustomersSections(){
  // projects
  const { data: pr, error: perr } = await sb
    .from(DB.tables.projects)
    .select("*")
    .order(DB.projectNoCol, { ascending:false });
  if (perr) throw perr;

  // customers
  const { data: cu, error: cerr } = await sb
    .from(DB.tables.customers)
    .select("*");
  if (cerr) throw cerr;
  customers = new Map((cu||[]).map(c=>[c[DB.customerPkCol], c]));

  // filter: status=1 & opleverdatum
  projects = (pr||[]).filter(p=>{
    const status = String(p?.salesstatus ?? p?.status ?? "");
    const due = p?.completiondate || p?.opleverdatum || p?.deliverydate;
    // jouw uitgangspunt: status=1 en opleverdatum gevuld
    return status === "1" && !!due;
  });

  // sections per project
  const projectIds = projects.map(p=>p[DB.projectPkCol]).filter(Boolean);
  if (!projectIds.length){
    sectionsByProject = new Map();
    return;
  }

  const { data: se, error: serr } = await sb
    .from(DB.tables.sections)
    .select("*")
    .in(DB.sectionProjectFk, projectIds)
    .order("paragraaf", { ascending:true });
  if (serr) throw serr;

  sectionsByProject = new Map();
  for (const s of (se||[])){
    const pid = s[DB.sectionProjectFk];
    if (!sectionsByProject.has(pid)) sectionsByProject.set(pid, []);
    sectionsByProject.get(pid).push(s);
  }
}

async function loadSectionWork(){
  workMap = new Map();
  // if table missing, just skip
  if (!DB.tables.sectionWork) return;

  const from = days[0];
  const to = days[6];

  const { data, error } = await sb
    .from(DB.tables.sectionWork)
    .select("id, section_id, work_date, werknemer_id, work_type, hours")
    .gte("work_date", from)
    .lte("work_date", to);
  if (error){
    // Most likely table not created yet
    console.warn("section_work not available:", error.message);
    return;
  }

  for (const r of (data||[])){
    const key = `${r.section_id}|${r.work_date}`;
    if (!workMap.has(key)) workMap.set(key, []);
    workMap.get(key).push(r);
  }
}

// ====== render overview ======
function renderOverview(){
  // capacity summary per day
  const rowCap = el("rowCap");
  const rowPlanned = el("rowPlanned");
  const rowAvail = el("rowAvail");
  const rowConcept = el("rowConcept");

  rowCap.innerHTML = "";
  rowPlanned.innerHTML = "";
  rowAvail.innerHTML = "";
  rowConcept.innerHTML = "";

  for (const d of days){
    const cap = sumCapacityForDay(d);
    const planned = sumPlannedForDay(d, { includeConcept:false });
    const avail = cap - planned;

    rowCap.appendChild(cellNumber(cap));
    rowPlanned.appendChild(cellNumber(planned));
    rowAvail.appendChild(cellNumber(avail, true));

    // concept (voor later): nu tonen we 0; zodra project_plan in use, vullen we dit.
    rowConcept.appendChild(cellNumber(0));
  }
}

function cellNumber(n, color=false){
  const td = document.createElement("td");
  td.className = "cell";
  const wrap = document.createElement("div");
  wrap.innerHTML = `<div class="sum">${n.toFixed(2)}</div>`;
  if (color){
    const cls = n > 0 ? "cap-good" : (n === 0 ? "cap-warn" : "cap-bad");
    wrap.querySelector(".sum").classList.add(cls);
  }
  td.appendChild(wrap);
  return td;
}

function sumCapacityForDay(date){
  let total = 0;
  for (const e of employees){
    const id = getEmployeeId(e);
    const rec = capacityMap.get(`${id}|${date}`);
    if (!rec) continue;
    if (!countsTowardsCapacity(rec.type)) continue;
    total += parseNum(rec.hours);
  }
  return total;
}

function sumPlannedForDay(date, { includeConcept=false }={}){
  // MVP: we have no concept filter yet; includeConcept ignored for now.
  let total = 0;
  for (const [key, arr] of workMap.entries()){
    if (!key.endsWith(`|${date}`)) continue;
    for (const r of arr){
      const t = String(r.work_type);
      if (t === "reis" && DB.planning.addTravelToMontage) {
        total += parseNum(r.hours);
      } else if (DB.planning.plannedTypes.includes(t)) {
        total += parseNum(r.hours);
      }
    }
  }
  return total;
}

// ====== render capacity tab ======
function renderCapacity(){
  const table = el("capTable");
  const thead = el("capThead");
  const tbody = el("capTbody");

  // header
  thead.innerHTML = "";
  const trh = document.createElement("tr");
  trh.appendChild(thSticky("Medewerker", "col-name sticky-col"));
  for (const d of days){
    const th = document.createElement("th");
    th.className = "day";
    th.textContent = dayLabel(d);
    trh.appendChild(th);
  }
  thead.appendChild(trh);

  // rows
  tbody.innerHTML = "";
  for (const emp of employees){
    const empId = getEmployeeId(emp);
    const tr = document.createElement("tr");

    const tdName = document.createElement("td");
    tdName.className = "sticky-col col-name";
    tdName.innerHTML = `<div style="font-weight:850">${escapeHtml(getEmployeeName(emp))}</div>`;
    tr.appendChild(tdName);

    for (const d of days){
      const td = document.createElement("td");
      td.className = "cell";

      const rec = capacityMap.get(`${empId}|${d}`);
      const hours = rec ? rec.hours : "";
      const type = rec ? rec.type : "werk";

      const div = document.createElement("div");
      div.className = "split2";

      const inp = document.createElement("input");
      inp.className = "input";
      inp.type = "number";
      inp.step = "0.25";
      inp.placeholder = "0";
      inp.value = (hours ?? "");

      const sel = document.createElement("select");
      sel.className = "input";
      for (const o of TYPE_OPTIONS){
        const opt = document.createElement("option");
        opt.value = o.value;
        opt.textContent = o.label;
        if (o.value === type) opt.selected = true;
        sel.appendChild(opt);
      }

      const save = async()=>{
        const h = parseNum(inp.value);
        const t = sel.value;
        await upsertCapacity(empId, d, h, t);
        renderOverview();
      };

      inp.addEventListener("change", save);
      sel.addEventListener("change", save);

      div.appendChild(inp);
      div.appendChild(sel);
      td.appendChild(div);
      tr.appendChild(td);
    }

    tbody.appendChild(tr);
  }
}

function thSticky(text, cls){
  const th = document.createElement("th");
  th.textContent = text;
  th.className = cls || "";
  return th;
}

async function upsertCapacity(empId, date, hours, type){
  if (!empId) return;
  const key = `${empId}|${date}`;
  const existing = capacityMap.get(key);

  const payload = {
    work_date: date,
    werknemer_id: empId,
    hours,
    type,
  };

  let res;
  if (existing?.id){
    res = await sb.from(DB.tables.capacityEntries).update(payload).eq("id", existing.id).select().maybeSingle();
  } else {
    // Prefer upsert on unique(work_date, werknemer_id)
    res = await sb.from(DB.tables.capacityEntries).upsert(payload, { onConflict: "work_date,werknemer_id" }).select().maybeSingle();
  }
  if (res.error) throw res.error;
  const saved = res.data;
  if (saved) capacityMap.set(key, saved);
}

// ====== render projects list ======
function renderProjects(){
  const wrap = el("projectsWrap");
  wrap.innerHTML = "";

  const q = (el("q").value || "").trim().toLowerCase();

  const filtered = projects.filter(p=>{
    const cust = customers.get(p[DB.projectCustomerFk]);
    const s = [
      p?.[DB.projectNoCol],
      p?.[DB.projectNameCol],
      cust?.[DB.customerNameCol],
    ].filter(Boolean).join(" ").toLowerCase();
    return !q || s.includes(q);
  });

  if (!filtered.length){
    wrap.innerHTML = `<div class="notice">Geen projecten gevonden voor deze filter.</div>`;
    return;
  }

  for (const p of filtered){
    wrap.appendChild(projectCard(p));
  }
}

function projectCard(p){
  const pid = p[DB.projectPkCol];
  const cust = customers.get(p[DB.projectCustomerFk]);
  const title = `${p[DB.projectNoCol] || ""} — ${cust?.[DB.customerNameCol] || ""} — ${p[DB.projectNameCol] || ""}`.replace(/^\s*—\s*/,"...");

  const due = p?.completiondate || p?.opleverdatum;

  const card = document.createElement("div");
  card.className = "card";
  card.style.marginTop = "14px";

  const hd = document.createElement("div");
  hd.className = "hd";
  hd.innerHTML = `
    <div>
      <div style="font-weight:900">${escapeHtml(title)}</div>
      <div class="muted" style="font-size:13px">Opleverdatum: <b>${escapeHtml(fmtDate(due) || "-")}</b></div>
    </div>
    <div class="row">
      <a class="btn small" href="project.html?project=${encodeURIComponent(pid)}">Open project</a>
      <button class="btn small" data-act="toggle">Secties</button>
    </div>
  `;

  const bd = document.createElement("div");
  bd.className = "bd";
  bd.style.display = "none";

  const se = sectionsByProject.get(pid) || [];
  if (!se.length){
    bd.innerHTML = `<div class="notice">Geen secties gevonden voor dit project.</div>`;
  } else {
    bd.appendChild(sectionsTable(se));
  }

  hd.querySelector('[data-act="toggle"]').addEventListener("click", ()=>{
    bd.style.display = bd.style.display === "none" ? "block" : "none";
  });

  card.appendChild(hd);
  card.appendChild(bd);
  return card;
}

function sectionsTable(sections){
  const container = document.createElement("div");
  container.className = "planner";

  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  trh.appendChild(thSticky("Sectie", "sticky-col col-name"));
  trh.appendChild(thSticky("Totaal (prod+mont)", "sticky-col2 col-meta"));
  for (const d of days){
    const th = document.createElement("th");
    th.className = "day";
    th.textContent = dayLabel(d);
    trh.appendChild(th);
  }
  thead.appendChild(trh);

  const tbody = document.createElement("tbody");

  for (const s of sections){
    tbody.appendChild(sectionRow(s));
  }

  table.appendChild(thead);
  table.appendChild(tbody);
  container.appendChild(table);
  return container;
}

function sectionRow(s){
  const sid = s[DB.sectionPkCol];
  const tr = document.createElement("tr");

  const name = `${s.paragraaf ?? ""} — ${(s.beschrijving ?? s.Beschrijving ?? "").toString().slice(0,60)}`;

  const tdName = document.createElement("td");
  tdName.className = "sticky-col col-name";
  tdName.innerHTML = `
    <div style="font-weight:900">${escapeHtml(name)}</div>
    <div class="muted" style="font-size:12px">${escapeHtml(String(s.aantal ?? ""))}</div>
  `;
  tr.appendChild(tdName);

  // total meta
  const total = parseNum(s.uren_prod) + parseNum(s.uren_montage) + (DB.planning.addTravelToMontage ? parseNum(s.uren_reis) : 0);
  const tdMeta = document.createElement("td");
  tdMeta.className = "sticky-col2 col-meta";
  tdMeta.innerHTML = `<div class="sum">${total.toFixed(2)}u</div><div class="tiny">(uit sectie)</div>`;
  tr.appendChild(tdMeta);

  for (const d of days){
    const td = document.createElement("td");
    td.className = "cell";

    const entries = workMap.get(`${sid}|${d}`) || [];
    const planned = entries.reduce((acc,r)=> acc + parseNum(r.hours), 0);

    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = "+";
    btn.title = "Uren toevoegen";
    btn.addEventListener("click", ()=> openWorkModal({section:s, date:d}));

    const list = document.createElement("div");
    list.style.marginTop = "6px";
    list.innerHTML = entries.length
      ? entries.map(r=>{
          const emp = empById.get(r.werknemer_id);
          const nm = emp ? getEmployeeName(emp) : "(onbekend)";
          return `<div class="tiny">${escapeHtml(nm)} — ${escapeHtml(r.work_type)} — ${parseNum(r.hours).toFixed(2)}u</div>`;
        }).join("")
      : `<div class="tiny">—</div>`;

    const sum = document.createElement("div");
    sum.className = "sum";
    sum.textContent = planned ? `${planned.toFixed(2)}u` : "";

    td.appendChild(btn);
    td.appendChild(sum);
    td.appendChild(list);
    tr.appendChild(td);
  }

  return tr;
}

// ====== modal: add work ======
function openWorkModal({section, date}){
  el("mTitle").textContent = `Uren toevoegen — ${section.paragraaf ?? ""}`;
  el("mDate").textContent = dayLabel(date);

  // fill employee select
  const selEmp = el("mEmployee");
  selEmp.innerHTML = "";
  const opt0 = document.createElement("option");
  opt0.value = "";
  opt0.textContent = "Kies werknemer...";
  selEmp.appendChild(opt0);
  for (const e of employees){
    const opt = document.createElement("option");
    opt.value = getEmployeeId(e);
    opt.textContent = getEmployeeName(e);
    selEmp.appendChild(opt);
  }

  const selType = el("mWorkType");
  selType.innerHTML = "";
  for (const o of WORK_TYPES){
    const opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    selType.appendChild(opt);
  }
  selType.value = "prod";

  el("mHours").value = "";
  el("mNote").value = "";
  el("mError").textContent = "";

  const backdrop = el("modal");
  backdrop.classList.add("show");

  const close = ()=>{
    backdrop.classList.remove("show");
    el("mSave").onclick = null;
  };

  el("mClose").onclick = close;
  el("mCancel").onclick = close;

  el("mSave").onclick = async()=>{
    try{
      const werknemer_id = selEmp.value;
      const work_type = selType.value;
      const hours = parseNum(el("mHours").value);
      if (!werknemer_id) throw new Error("Kies een werknemer.");
      if (!(hours > 0)) throw new Error("Vul uren in (>0).");

      const payload = {
        section_id: section[DB.sectionPkCol],
        work_date: date,
        werknemer_id,
        work_type,
        hours,
      };

      const { data, error } = await sb.from(DB.tables.sectionWork).insert(payload).select().maybeSingle();
      if (error) throw error;

      const key = `${payload.section_id}|${date}`;
      if (!workMap.has(key)) workMap.set(key, []);
      workMap.get(key).push(data);

      close();
      renderOverview();
      renderProjects();
    }catch(err){
      el("mError").textContent = String(err?.message || err);
    }
  };
}

