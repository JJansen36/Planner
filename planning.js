  import { makeSupabaseClient, requireSession } from "./auth.js";
  

  function parseISODate(iso){
    if(!iso) return null;
    const m = String(iso).slice(0,10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(!m) return null;
    const y = Number(m[1]), mo = Number(m[2]) - 1, d = Number(m[3]);
    return new Date(y, mo, d); // lokaal, geen UTC shift
  }

  function addDays(date, n){
    // NIET muteren + altijd lokale midnight
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    d.setDate(d.getDate() + n);
    return d;
  }

  function startOfISOWeek(date){
    // maandag = start
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const day = d.getDay();              // zo=0, ma=1, ..., za=6
    const diff = (day === 0 ? -6 : 1 - day);
    d.setDate(d.getDate() + diff);
    return d;
  }

  function toISODate(date){
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`; // lokaal, geen toISOString()
  }


  const sb = makeSupabaseClient();

  const el = (id) => document.getElementById(id);
  let gridEl = null;
  let statusEl = null;
  let ordersBySection = new Map();
  let __wasDragging = false;
  // ===== Extra kolom: uren (uit Supabase) vs gepland =====
  let hoursColOpen = true; // alleen handmatig via pijltje boven de orders




function getIncludePlanningColumn(rows){
  const candidates = ["in_planning", "include_in_planning", "show_in_planning", "planning_visible"];
  const keys = rows?.[0] ? Object.keys(rows[0]) : [];
  return candidates.find(c => keys.includes(c)) || candidates[0];
}

function sectionIsIncludedInPlanning(section, col){
  const raw = section?.[col];
  if (raw === null || raw === undefined) return true;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return !["0", "false", "nee", "no", "off"].includes(v);
  }
  return Boolean(raw);
}
  // ======================
// UNDO (Ctrl+Z) voor drag & drop
// ======================
const undoStack = [];   // laatste actie achteraan
const UNDO_LIMIT = 50;  // max acties bewaren

function pushUndo(action){
  undoStack.push(action);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
}

async function undoLast(){
  const action = undoStack.pop();
  if (!action) return;

  try{
    if (action.kind === "section") {
      // delete op "to" en insert terug naar "from"
      await sb
        .from("section_assignments")
        .delete()
        .eq("section_id", action.section_id)
        .eq("work_date", action.to_date);

      if (action.rows?.length) {
        const backRows = action.rows.map(r => ({
          section_id: action.section_id,
          work_date: action.from_date,
          werknemer_id: r.werknemer_id,
          work_type: r.work_type
        }));
        await sb.from("section_assignments").insert(backRows);
      }
    }

    if (action.kind === "project-montage") {
      await sb
        .from("project_assignments")
        .delete()
        .eq("project_id", action.project_id)
        .eq("work_date", action.to_date)
        .eq("work_type", "montage");

      if (action.rows?.length) {
        const backRows = action.rows.map(r => ({
          project_id: action.project_id,
          work_date: action.from_date,
          werknemer_id: r.werknemer_id,
          work_type: r.work_type
        }));
        await sb.from("project_assignments").insert(backRows);
      }
    }

    loadAndRender();
  } catch(e){
    console.warn("Undo error:", e);
    alert("Undo mislukt. Check console.");
  }
}

// Ctrl+Z handler (alleen als je niet in een input/textarea zit)
document.addEventListener("keydown", (e) => {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  const mod = isMac ? e.metaKey : e.ctrlKey;

  if (!mod || e.key.toLowerCase() !== "z") return;

  const tag = (document.activeElement?.tagName || "").toLowerCase();
  const typing = tag === "input" || tag === "textarea" || document.activeElement?.isContentEditable;
  if (typing) return; // laat normale Ctrl+Z in inputs

  e.preventDefault();
  undoLast();
});

  // ===== Open/close state bewaren =====
  let openState = {
    projects: new Set(),
    sections: new Set(),
    orders: new Set(), // key: `${sid}||${bn}`
    caps: new Set(),
  };

function captureOpenState(){
  const st = {
    projects: new Set(),
    sections: new Set(),
    orders: new Set(),
    caps: new Set(),        // ✅ deze miste
  };

  // capaciteit (betrouwbaar: kijk naar het symbool)
  gridEl?.querySelectorAll('.cap-expander[data-cap]').forEach(b=>{
    if (b.textContent === "▼") {
      const key = String(b.dataset.cap || "");
      if (key) st.caps.add(key);
    }
  });

  // projecten (betrouwbaar: kijk naar het symbool)
  gridEl?.querySelectorAll('.expander[data-proj]').forEach(b=>{
    if (b.textContent === "▼") {
      const pid = String(b.dataset.proj || "");
      if (pid) st.projects.add(pid);
    }
  });

  // secties
  gridEl?.querySelectorAll('.expander-sec').forEach(b=>{
    if (b.textContent === "▼") {
      const sid = String(b.dataset.sect || "");
      if (sid) st.sections.add(sid);
    }
  });

  // orders
  gridEl?.querySelectorAll('.expander-order').forEach(b=>{
    if (b.textContent === "▼") {
      const sid = String(b.dataset.sect || "");
      const bn  = String(b.dataset.orderbn || "");
      if (sid && bn) st.orders.add(`${sid}||${bn}`);
    }
  });

  openState = st;
}


function applyZebraVisible(){
  const tbody = gridEl?.querySelector(".planner-table tbody");
  if (!tbody) return;

  const rows = Array.from(tbody.querySelectorAll("tr"));
  let i = 0;

  for (const tr of rows) {
    // rijen die je nooit zebra wil geven
    if (
      tr.classList.contains("spacer") ||
      tr.classList.contains("block-title") ||
      tr.classList.contains("info-row")
    ){
      tr.classList.remove("zebra");
      continue;
    }

    // verborgen rijen tellen NIET mee
    if (tr.classList.contains("hidden")){
      tr.classList.remove("zebra");
      continue;
    }

    tr.classList.toggle("zebra", (i % 2) === 1);
    i++;
  }
}

function restoreOpenState(){
  if (!gridEl) return;

  // 1) projecten openklappen
  for (const pid of (openState.projects || [])) {
    const btn = gridEl.querySelector(`.expander[data-proj="${cssEsc(pid)}"]`);
    if (btn && btn.textContent !== "▼") btn.click();
  }

  // 2) secties openklappen
  for (const sid of (openState.sections || [])) {
    const btn = gridEl.querySelector(`.expander-sec[data-sect="${cssEsc(sid)}"]`);
    if (btn && btn.textContent !== "▼") btn.click();
  }

  // 3) orders openklappen
  for (const key of (openState.orders || [])) {
    const [sid, bn] = String(key).split("||");
    const btn = gridEl.querySelector(
      `.expander-order[data-sect="${cssEsc(sid)}"][data-orderbn="${cssEsc(bn)}"]`
    );
    if (btn && btn.textContent !== "▼") btn.click();
  }

  // 4) capaciteit openklappen
  for (const key of (openState.caps || [])) {
    const btn = gridEl.querySelector(`.cap-expander[data-cap="${cssEsc(key)}"]`);
    if (btn && btn.textContent !== "▼") btn.click();
  }


  applyZebraVisible();
}



  const HOURS_PER_PERSON_DAY = 7.75;

  // ---- Settings (uitbreidbaar) ----
  const SETTINGS_KEY = "lovd_planner_settings_v1";

  
  const DUMMY_EMP_ID = 999999;
  const DUMMY_SEC_ID = 999998;
  const DUMMY_EMP_NAME = "Concept";

  
  const INHUUR_TABLE = "inhuur_krachten";
  const INHUUR_ENTRIES_TABLE = "inhuur_entries";


const defaultSettings = {
  planFactor: 0.80, // 80%
  orderTypeFilter: [], // ✅ nieuw: lijst met geselecteerde 'soort'
};

  function loadSettings(){
    try{
      const raw = localStorage.getItem(SETTINGS_KEY);
      if(!raw) return { ...defaultSettings };
      const s = JSON.parse(raw);
      return { ...defaultSettings, ...s };
    }catch(e){
      return { ...defaultSettings };
    }
  }

  function saveSettings(s){
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  let settings = loadSettings();

  function openSettingsModal(){
    const modal = el("settingsModal");
    const back = el("settingsBackdrop");
    const slider = el("planFactor");
    const label = el("planFactorLabel");

    slider.value = Math.round((settings.planFactor ?? 0.8) * 100);
    label.textContent = `${slider.value}%`;

    slider.oninput = () => { label.textContent = `${slider.value}%`; };
    
    // ✅ nieuw: soorten-filter UI vullen
    fillOrderTypeFilterUI();

    back.hidden = false;
    modal.hidden = false;
  }

  function closeSettingsModal(){
    el("settingsBackdrop").hidden = true;
    el("settingsModal").hidden = true;
  }

function buildPlannedSetsByDay(planningItems){
  const out = Object.create(null);

  for (const it of (planningItems || [])) {
    const d = String(it.work_date || "").trim();
    const wid = String(it.werknemer_id ?? "").trim();
    const kind = String(it.work_type || it.kind || it.type || "").toLowerCase().trim();

    if (!d || !wid) continue;

    const bucket =
      (kind === "pro" || kind === "productie" || kind === "werk") ? "pro" :
      (kind === "mo"  || kind === "montage")   ? "mo"  :
      (kind === "cnc")                         ? "cnc" :
      (kind === "reis")                        ? "reis":
      null;

    if (!bucket) continue;

    if (!out[d]) out[d] = {
      pro: new Set(), mo: new Set(), cnc: new Set(), reis: new Set(),
      dummyPro: 0, dummyMo: 0, dummyCnc: 0, dummyReis: 0
    };

    const isProjectDummy = (String(wid) === String(DUMMY_EMP_ID));
    const isSectionDummy = (String(wid) === String(DUMMY_SEC_ID));

    if (isProjectDummy || isSectionDummy) {
      if (bucket === "pro")  out[d].dummyPro += 1;
      if (bucket === "mo")   out[d].dummyMo  += 1;
      if (bucket === "cnc")  out[d].dummyCnc += 1;
      if (bucket === "reis") out[d].dummyReis+= 1;
    } else {
      out[d][bucket].add(String(wid));
    }
  }

  return out;
}


  function fmtHours(n){
    // 31 -> "31", 23.25 -> "23,25"
    const v = Math.round((n + Number.EPSILON) * 100) / 100;
    const s = (v % 1 === 0) ? String(v) : v.toFixed(2);
    return s.replace(".", ",").replace(/,00$/, "");
  }

  // Dit is de "haak" die jij straks laat verwijzen naar je eigen render-functie
  function refreshAfterSettingsChange(){
    // VERVANG DIT door jouw bestaande functie(s):
    // bv: loadAndRender(); of renderAll(); of renderPlanner();
    if (typeof loadAndRender === "function") loadAndRender();
    else if (typeof renderAll === "function") renderAll();
  }
    
  function initSettingsUI(){
    el("btnSettings")?.addEventListener("click", openSettingsModal);
    el("btnSettingsClose")?.addEventListener("click", closeSettingsModal);
    el("btnSettingsCancel")?.addEventListener("click", closeSettingsModal);
    el("settingsBackdrop")?.addEventListener("click", closeSettingsModal);

    el("btnSettingsSave")?.addEventListener("click", () => {
      const pct = parseInt(el("planFactor").value, 10);
      settings.planFactor = Math.max(0.1, Math.min(2.0, pct / 100));
    
      // ✅ nieuw: geselecteerde soorten uitlezen
      const box = el("orderTypeList");
      const picked = box
        ? [...box.querySelectorAll('input[type="checkbox"]:checked')].map(x => x.value)
        : [];
      settings.orderTypeFilter = picked;
    
      saveSettings(settings);
      closeSettingsModal();
    
      refreshAfterSettingsChange();
    });

  }
async function fillOrderTypeFilterUI(){
  const box = el("orderTypeList");
  if(!box) return;

  // haal unieke soorten uit DB
  const res = await sb
    .from("section_orders")
    .select("soort")
    .not("soort", "is", null);

  const soorten = [...new Set((res.data || [])
    .map(r => String(r.soort || "").trim())
    .filter(Boolean)
  )].sort();

  const selected = new Set(settings.orderTypeFilter || []);

  box.innerHTML = soorten.length ? soorten.map(s => `
    <label class="order-type-item">
      <input type="checkbox" value="${escapeAttr(s)}" ${selected.has(s) ? "checked" : ""}>
      <span>${escapeHtml(s)}</span>
    </label>
  `).join("") : `<div class="muted">Geen soorten gevonden.</div>`;
}


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
function ensureHoverTip(){
  let tip = document.getElementById("hoverTip");
  if (tip) return tip;

  tip = document.createElement("div");
  tip.id = "hoverTip";
  tip.style.display = "none";
  document.body.appendChild(tip);
  return tip;
}

  const RANGE_DAYS = 100;
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

    initSettingsUI();

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


function asISODate(v){
  if(!v) return "";
  const s = String(v).trim();
  // Pak altijd alleen de datumcomponent (YYYY-MM-DD), voorkomt timezone-shift
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : "";
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
            <div class="label">CNC</div><div class="value">${escapeHtml(formatHoursCell(totals.cnc))} uur</div>

            <div class="label">Montage</div><div class="value">${escapeHtml(formatHoursCell(totals.mont))} uur</div>
            <div class="label">Reis</div><div class="value">${escapeHtml(formatHoursCell(totals.reis))} uur</div>
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
          <div class="assign-grid-2">
            <!-- LINKS -->
            <div class="assign-stack">
              <div class="assign-col">
                <div class="assign-col-title">Productie</div>
                <div id="amListProd" class="assign-list"></div>
              </div>

              <div class="hr"></div>

              <div class="assign-col">
                <div class="muted" style="margin:6px 0 6px;">Inhuur → Productie</div>
                <div id="amInhuurProdPick" class="assign-list"></div>
              </div>

              <div class="assign-col">
                <div class="assign-col-title" style="display:flex; align-items:center; justify-content:space-between;">
                  <span>Onderaanneming</span>
                  <button class="btn small" id="amAddSubc" type="button">+</button>
                </div>
                <div id="amSubcPick" class="assign-list" style="padding-bottom:8px;"></div>
                <div id="amListSubc" class="assign-list"></div>
              </div>
            </div>

            <!-- RECHTS -->
            <div class="assign-stack">
              <div class="assign-col">
                <div class="assign-col-title">Montage</div>
                <div id="amListMont" class="assign-list"></div>
              </div>

              <div class="hr"></div>

              <div class="assign-col">
                <div class="muted" style="margin:6px 0 6px;">Inhuur → Montage</div>
                <div id="amInhuurMontPick" class="assign-list"></div>
              </div>

              <!-- optioneel: lege ruimte zodat onderkant gelijk voelt -->
              <div class="assign-col right-empty"></div>
            </div>
          </div>
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

// -------- INHUUR MODAL (uren per inhuur per week) --------
let inhuurModal = null;

function ensureInhuurModal(){
  if (inhuurModal) return inhuurModal;

  const wrap = document.createElement("div");
  wrap.className = "modal-backdrop";
  wrap.id = "inhuurModalBackdrop";
  wrap.innerHTML = `
    <div class="modal assign-modal" role="dialog" aria-modal="true">
      <div class="hd">
        <div>
          <div class="assign-title">Inhuur plannen</div>
          <div class="assign-sub" id="imSub"></div>
        </div>
        <button class="btn small" id="imClose" type="button">✕</button>
      </div>

      <div class="bd">
        <div class="row" style="justify-content:space-between; gap:10px; align-items:center;">
          <button class="btn small" id="imPrevWeek" type="button">◀ Week</button>
          <div class="muted" id="imWeekLabel"></div>
          <button class="btn small" id="imNextWeek" type="button">Week ▶</button>
        </div>

        <div class="hr"></div>

        <div class="row" style="gap:10px; align-items:center; margin:10px 0;">
          <select class="input" id="imSelect" style="flex:1;"></select>
          <button class="btn small" id="imNew" type="button">+ Nieuw</button>
        </div>

        <div id="imForm"></div>
      </div>

      <div class="ft">
        <button class="btn" id="imCancel" type="button">Annuleren</button>
        <button class="btn primary" id="imSave" type="button">Opslaan</button>
      </div>
    </div>
  `;

  document.body.appendChild(wrap);

  const close = () => wrap.classList.remove("show");
  wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
  wrap.querySelector("#imClose").onclick = close;
  wrap.querySelector("#imCancel").onclick = close;

  inhuurModal = { wrap, close };
  return inhuurModal;
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

async function loadAllInhuurKrachtenForModal(){
  const sel = document.getElementById("imSelect");
  if (!sel) return;

  const { data, error } = await sb
    .from(INHUUR_TABLE)
    .select("inhuur_id,name")
    .eq("is_active", true)
    .order("name", { ascending: true })
    .limit(5000);

  if (error) {
    console.warn("Fout inhuur_krachten modal:", error.message);
    sel.innerHTML = `<option value="">(fout)</option>`;
    return;
  }

  const opts = (data || []).map(r => `<option value="${r.inhuur_id}">${escapeHtml(r.name)}</option>`).join("");
  sel.innerHTML = opts || `<option value="">(geen inhuur)</option>`;
}

async function openInhuurModalAtWeek(wkStart){
  const modal = ensureInhuurModal();
  const subEl = modal.wrap.querySelector("#imSub");
  const weekLabelEl = modal.wrap.querySelector("#imWeekLabel");
  const formEl = modal.wrap.querySelector("#imForm");
  const selEl = modal.wrap.querySelector("#imSelect");

  let curWkStart = startOfISOWeek(new Date(wkStart));

  const buildWeekDays = () => {
    const ds = [];
    for (let i=0;i<7;i++) ds.push(addDays(curWkStart, i));
    return ds;
  };

  const renderWeek = async () => {
    const days = buildWeekDays();
    const startISO = toISODate(days[0]);
    const endISO = toISODate(days[6]);

    if (subEl) subEl.textContent = `${startISO} t/m ${endISO}`;
    if (weekLabelEl) weekLabelEl.textContent = `Week ${weekNumberISO(days[0])}`;

    const iid = String(selEl.value || "");

 // helpers voor chips (binnen renderWeek)
    function buildPlanLabel({ pid, sid, type }) {
      const ctx = window.__plannerCtx || {};

      // ✅ projectnr + projectnaam uit projMetaById
      const pMeta = ctx.projMetaById?.get(String(pid)) || {};
      const nr = String(pMeta.nr || "").trim();
      const nm = String(pMeta.nm || "").trim();

      // ✅ sectie (nr + naam)
      let sectTxt = "";
      if (sid) {
        const sObj = ctx.sectById?.get(String(sid)) || {};
        const sName = String(sObj?.[ctx.sectNameKey] || sObj?.name || "").trim();
        const sNr   = String(sObj?.[ctx.sectParaKey] || sObj?.paragraph || "").trim();
        sectTxt = [sNr, sName].filter(Boolean).join(" ").trim();
      }

      const top = [nr, nm].filter(Boolean).join(" - ").trim();
      const out = [top, sectTxt].filter(Boolean).join("\n");

      return out || (type === "montage" ? "Montage" : "Productie");
    }

function getPlannedForInhuurDate(inhuurIdStr, dateISO) {
  const ctx = window.__plannerCtx || {};
  const out = []; // { type:'productie'|'montage', text:string }

  const aMap = ctx.assignMap || new Map();
  const pMap = ctx.projectAssignMap || new Map();

  // 1) sectie assignments
  for (const [sid, dm] of aMap) {
    const entry = dm?.get(dateISO);
    if (!entry) continue;

    const hasProd = entry.inhuurProdIds?.has(String(inhuurIdStr));
    const hasMont = entry.inhuurMontIds?.has(String(inhuurIdStr));

    if (hasProd || hasMont) {
      const sObj = ctx.sectById?.get(String(sid));
      const pid = String(sObj?.[ctx.sectProjKey] || "").trim();
      if (!pid) continue;

      if (hasProd) out.push({ type: "productie", text: buildPlanLabel({ pid, sid, type: "productie" }) });
      if (hasMont) out.push({ type: "montage",  text: buildPlanLabel({ pid, sid, type: "montage"  }) });
    }
  }

  // 2) project assignments
  for (const [pid, dm] of pMap) {
    const entry = dm?.get(dateISO);
    if (!entry) continue;

    if (entry.inhuurProdIds?.has(String(inhuurIdStr))) {
      out.push({ type: "productie", text: buildPlanLabel({ pid, sid: null, type: "productie" }) });
    }
    if (entry.inhuurMontIds?.has(String(inhuurIdStr))) {
      out.push({ type: "montage", text: buildPlanLabel({ pid, sid: null, type: "montage" }) });
    }
  }

  // dedupe
  const seen = new Set();
  return out.filter(it => {
    const k = `${it.type}||${it.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

    formEl.innerHTML = `
      <div class="cap-weeklist">
        ${days.map(d => {
          const iso = toISODate(d);

          const planned = iid ? getPlannedForInhuurDate(iid, iso) : [];
          const plannedHtml = planned.length
            ? planned.map(p => `
                <div class="cap-planchip ${p.type === "montage" ? "mont" : "prod"}">
                  ${escapeHtml(String(p.text)).replace(/\n/g, "<br>")}
                </div>
              `).join("")
            : `<div class="cap-planempty">—</div>`;

          return `
            <div class="cap-dayrow">
              <div class="cap-left">
                <div class="cap-daylabel">${dayNameNL(d.getDay())} ${d.getDate()}-${d.getMonth()+1}</div>
                <input class="input cap-hours" type="text" inputmode="decimal" data-iso="${iso}" placeholder="0" />
              </div>
              <div class="cap-right">
                ${plannedHtml}
              </div>
            </div>
          `;
        }).join("")}
      </div>
    `;
    // load bestaande waarden
    if (iid) {
      const { data, error } = await sb
        .from(INHUUR_ENTRIES_TABLE)
        .select("work_date,hours")
        .eq("inhuur_id", iid)
        .gte("work_date", startISO)
        .lte("work_date", endISO);

      if (!error && data) {
        const map = new Map(data.map(r => [String(r.work_date), Number(r.hours || 0)]));
        formEl.querySelectorAll("input[data-iso]").forEach(inp => {
          const iso = String(inp.dataset.iso || "");
          const v = map.get(iso) || 0;
          inp.value = v ? String(v).replace(".", ",") : "";
        });
      }
    }

    // input sanitation
    formEl.querySelectorAll('input.input[data-iso]').forEach(inp => {
      inp.addEventListener("input", () => {
        inp.value = inp.value.replace(/[^0-9.,]/g, "");
      });
      inp.addEventListener("blur", () => { inp.value = inp.value.replace(".", ","); });
    });
  };

  await loadAllInhuurKrachtenForModal();
  await renderWeek();

  modal.wrap.querySelector("#imPrevWeek").onclick = async () => { curWkStart = addDays(curWkStart, -7); await renderWeek(); };
  modal.wrap.querySelector("#imNextWeek").onclick = async () => { curWkStart = addDays(curWkStart, +7); await renderWeek(); };

  selEl.onchange = async () => { await renderWeek(); };

  modal.wrap.querySelector("#imNew").onclick = async () => {
    const name = prompt("Naam ingehuurde kracht:");
    if (!name) return;
    const { data, error } = await sb.from(INHUUR_TABLE).insert({ name: name.trim(), is_active: true }).select("inhuur_id").single();
    if (error) { alert("Fout opslaan: " + error.message); return; }
    await loadAllInhuurKrachtenForModal();
    selEl.value = data.inhuur_id;
    await renderWeek();
  };

    modal.wrap.querySelector("#imSave").onclick = async () => {
    const btn = modal.wrap.querySelector("#imSave");
    btn.disabled = true;
    btn.textContent = "Opslaan…";

    try {
      const iid = String(selEl.value || "");
      if (!iid) { alert("Kies een ingehuurde kracht."); return; }

      const days = buildWeekDays();
      const startISO = toISODate(days[0]);
      const endISO   = toISODate(days[6]);

      const del = await sb
        .from(INHUUR_ENTRIES_TABLE)
        .delete()
        .eq("inhuur_id", iid)
        .gte("work_date", startISO)
        .lte("work_date", endISO);

      if (del.error) throw new Error("Verwijderen: " + del.error.message);

      const rows = [];
      modal.wrap.querySelectorAll("#imForm input[data-iso]").forEach(inp => {
        const iso = String(inp.dataset.iso || "");
        const raw = String(inp.value || "").trim().replace(",", ".");
        const h = raw ? Number(raw) : 0;
        if (iso && h > 0) rows.push({ inhuur_id: iid, work_date: iso, hours: h });
      });

      if (rows.length) {
        const ins = await sb.from(INHUUR_ENTRIES_TABLE).insert(rows);
        if (ins.error) throw new Error("Opslaan: " + ins.error.message);
      }

      await loadAndRender();   // ✅ dit maakt het direct zichtbaar.
      modal.close();           // ✅ sluit modal automatisch
    } catch (e) {
      console.warn("Inhuur save error:", e);
      alert(String(e.message || e));
    } finally {
      btn.disabled = false;
      btn.textContent = "Opslaan";
    }
  };


  modal.wrap.classList.add("show");
}

  // -------- DATA LOAD --------
  async function loadAndRender(){
    const start = new Date(rangeStart);
    const end = addDays(start, RANGE_DAYS - 1);
    const startISO = toISODate(start);
    const endISO = toISODate(end);
    const todayISO = toISODate(new Date());


    captureOpenState();  // ✅ hier direct

    statusEl.textContent = `Laden… (${startISO} t/m ${endISO})`;

    // 1) projecten
    const { data: projecten, error: pErr } = await sb
      .from("projecten_planner")
      .select("*")
      .in("salesstatus", [3,4,5,6,7,8])
      .gte("completiondate_d", todayISO)
      .order("offerno", { ascending: true })
      .limit(500);


    if (pErr) { statusEl.textContent = "Fout projecten: " + pErr.message; return; }

    // 2) secties
    const projectIds = (projecten || []).map(p => p.project_id ?? p.id).filter(Boolean);

    const { data: secties, error: sErr } = await sb
      .from("secties")
      .select("*")
      .in("project_id", projectIds)
      .limit(2000);


    if (sErr) { statusEl.textContent = "Fout secties: " + sErr.message; return; }

    const includePlanningCol = getIncludePlanningColumn(secties || []);
    const visibleSecties = (secties || []).filter(s => sectionIsIncludedInPlanning(s, includePlanningCol));

    // 2b) section_orders voor alle zichtbare secties in dit project
    const sectionIds = visibleSecties
      .map(s => String(s.id ?? s.section_id ?? ""))   // pak id/section_id (wat er is)
      .filter(Boolean);

    let orders = [];

    if (sectionIds.length) {
      const { data: oData, error: oErr } = await sb
        .from("section_orders")
        .select("id, section_id, bestel_nummer, leverdatum, omschrijving, aantal, leverancier, soort, created_at")
        .in("section_id", sectionIds)
        .order("bestel_nummer", { ascending: true })
        .order("created_at", { ascending: true })
        .limit(20000);

      if (oErr) {
        console.warn("Fout section_orders:", oErr.message);
        orders = [];
      } else {
        orders = oData || [];
      }
    }


    
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

      // 4b) inhuur_entries in range (alleen uren > 0) + bijbehorende namen
      let inhuurEntries = [];
      let inhuurPeopleVisible = [];

      try {
        const { data: iData, error: iErr } = await sb
          .from(INHUUR_ENTRIES_TABLE)
          .select("work_date, inhuur_id, hours")
          .gt("hours", 0)
          .gte("work_date", startISO)
          .lte("work_date", endISO)
          .limit(200000);

        if (iErr) {
          console.warn("Fout inhuur_entries:", iErr.message);
          inhuurEntries = [];
        } else {
          inhuurEntries = iData || [];
        }

      // ✅ altijd alle actieve inhuur, zodat namen er altijd staan
      const { data: pDataAll, error: pErrAll } = await sb
        .from(INHUUR_TABLE)
        .select("inhuur_id, name")
        .eq("is_active", true)
        .order("name", { ascending: true })
        .limit(5000);

      if (pErrAll) {
        console.warn("Fout inhuur_krachten:", pErrAll.message);
        inhuurPeopleVisible = [];
      } else {
        inhuurPeopleVisible = pDataAll || [];
      }
        
      } catch (e) {
        console.warn("Inhuur load exception:", e);
        inhuurEntries = [];
        inhuurPeopleVisible = [];
      }


    if (cErr) { statusEl.textContent = "Fout capaciteit: " + cErr.message; return; }

    // 5) werknemers (voor namen in capaciteitblok)
    const { data: werknemers, error: eErr } = await sb
    
      .from("werknemers")
      .select("*")
      .order("name", { ascending: true })
      .limit(500);

    if (eErr) { statusEl.textContent = "Fout werknemers: " + eErr.message; return; }
    // ✅ Dummy medewerker toevoegen (altijd beschikbaar in UI)
    if (!werknemers.some(w => String(w.id) === String(DUMMY_EMP_ID))) {
      werknemers.push({ id: DUMMY_EMP_ID, name: DUMMY_EMP_NAME });
    }

    // ✅ Voor capaciteit: dummy NIET meenemen
    const werknemersCap = (werknemers || []).filter(w => String(w.id) !== String(DUMMY_EMP_ID));

        // 6) section_assignments in range (collega's per sectie/dag + type)
    const { data: assigns, error: aErr } = await sb
      .from("section_assignments")
      .select("section_id, work_date, werknemer_id, work_type, note")
      .gte("work_date", startISO)
      .lte("work_date", endISO)
      .limit(200000);
      
    
    // Als tabel nog niet bestaat of er zijn geen rechten, wil je de planner niet "slopen".
    // We gaan dan verder zonder assignments.
    const safeAssigns = aErr ? [] : (assigns || []);
    if (aErr) console.warn("section_assignments niet geladen:", aErr.message);

    // 6b) project_assignments in range (projectniveau planning zoals "↳ Montage"-regel)
    const { data: pAssigns, error: paErr } = await sb
      .from("project_assignments")
      .select("project_id, work_date, werknemer_id, work_type, note")
      .gte("work_date", startISO)
      .lte("work_date", endISO)
      .limit(200000);

    const safePAssigns = paErr ? [] : (pAssigns || []);
    if (paErr) console.warn("project_assignments niet geladen:", paErr.message);


    statusEl.textContent = "";

    renderPlanner({
      start,
      days: RANGE_DAYS,
      projecten,
      secties: visibleSecties,
      work,
      cap,
      werknemers,
      werknemersCap,
      assigns: safeAssigns,
      pAssigns: safePAssigns,
      orders,
      inhuurEntries,
      inhuurPeopleVisible
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

          // ===== Zebra rows (om-en-om rij achtergrond) =====
        let zebraIndex = 0;

        function resetZebra(){
          zebraIndex = 0;
        }

        function markZebra(tr){
          tr.classList.toggle("zebra", (zebraIndex % 2) === 1);
          zebraIndex++;
        }



 async function consumeProjectConceptMontage(projectId, dateISO, consumeCount){
  try{
    const pid = String(projectId || "").trim();
    const d   = String(dateISO || "").trim();
    const n   = Number(consumeCount || 0);

    if (!pid || !d || n <= 0) return;

    // 1) pak ID's van dummy montage rows (max N)
    const { data: rows, error: selErr } = await sb
      .from("project_assignments")
      .select("id")
      .eq("project_id", pid)
      .eq("work_date", d)
      .eq("work_type", "montage")
      // LET OP: geen Number() gebruiken → exact dezelfde waarde als je insert
      .eq("werknemer_id", DUMMY_EMP_ID)
      .limit(n);

    if (selErr) {
      console.warn("consumeProjectConceptMontage: select error", selErr.message);
      return;
    }

    const ids = (rows || []).map(r => r.id).filter(Boolean);
    if (!ids.length) {
      console.log("[consume] geen dummy montage om af te boeken", { pid, d, n });
      return;
    }

    // 2) delete alleen die N rows
    const { error: delErr } = await sb
      .from("project_assignments")
      .delete()
      .in("id", ids);

    if (delErr) {
      console.warn("consumeProjectConceptMontage: delete error", delErr.message);
      return;
    }

    console.log("[consume] dummy montage afgeboekt:", ids.length, { pid, d });

  } catch(e){
    console.warn("consumeProjectConceptMontage exception:", e);
  }
}

function parseSectionNo(v){
  // accepteert bv: "01.", "01", " 02 ", "M05.", "m07", "MW01", etc.
  const s = String(v ?? "").trim().toUpperCase();

  // pak eerste match: optioneel 'M', dan 1-3 cijfers
  const m = s.match(/^(M)?\s*0*([0-9]{1,3})/);
  if (!m) return null;

  return {
    isMeerwerk: !!m[1],
    num: Number(m[2] || 0)
  };
}

    // ===== Onderaanneming suggesties (per project cache) =====
    const _subcSuggestCache = new Map(); // projectId -> [names]

    function getProjectSectionIds(pid, sectiesByProject, sectIdKey, sectLookup){
      const secs = sectiesByProject.get(pid) || [];
      return secs.map(s => {
        const raw = s?.[sectIdKey] ? String(s[sectIdKey]) : String(s?.section_id || "");
        const canon = sectLookup.get(raw) || raw;
        return canon;
      }).filter(Boolean);
    }

    async function fetchSubcSuggestionsForProject(projectId, sectiesByProject, sectIdKey, sectLookup){
      const pid = String(projectId || "").trim();
      if (!pid) return [];
      if (_subcSuggestCache.has(pid)) return _subcSuggestCache.get(pid);

      const sectionIds = getProjectSectionIds(pid, sectiesByProject, sectIdKey, sectLookup);
      if (!sectionIds.length) { _subcSuggestCache.set(pid, []); return []; }

      const { data, error } = await sb
        .from("section_assignments")
        .select("note, section_id")
        .eq("work_type", "onderaanneming")
        .in("section_id", sectionIds)
        .not("note", "is", null)
        .limit(5000);

      if (error) {
        console.warn("fetchSubcSuggestionsForProject error:", error.message);
        _subcSuggestCache.set(pid, []);
        return [];
      }

      const names = [...new Set((data || [])
        .map(r => String(r.note || "").trim())
        .filter(Boolean)
      )].sort((a,b)=>a.localeCompare(b, "nl"));

      _subcSuggestCache.set(pid, names);
      return names;
    }

    // -------- DAY MODAL (wie is ingepland op deze dag) --------
    let dayModal = null;

    function ensureDayModal(){
      if (dayModal) return dayModal;

      const wrap = document.createElement("div");
      wrap.className = "modal-backdrop";
      wrap.id = "dayModalBackdrop";
      wrap.innerHTML = `
        <div class="modal day-modal" role="dialog" aria-modal="true">
          <div class="hd">
            <div>
              <div class="assign-title" id="dmTitle">Dag</div>
              <div class="assign-sub" id="dmSub"></div>
            </div>
            <button class="btn small" id="dmClose" type="button">✕</button>
          </div>
          <div class="bd">
            <div id="dmBody"></div>
          </div>
        </div>
      `;

      document.body.appendChild(wrap);

      const close = () => wrap.classList.remove("show");
      wrap.addEventListener("click", (e) => { if (e.target === wrap) close(); });
      wrap.querySelector("#dmClose").onclick = close;

      dayModal = { wrap, close };
      return dayModal;
    }


    function openDayModal({
      dateISO,
      werknemers,
      inhuurById,
      inhuurPeopleVisible,   // ✅ toevoegen
      assignMap,
      projectAssignMap,
      sectById,
      projMetaById,
      sectProjKey,
      sectParaKey,
      sectNameKey
    }){

      
    const modal = ensureDayModal();
    const titleEl = modal.wrap.querySelector("#dmTitle");
    const subEl   = modal.wrap.querySelector("#dmSub");
    const bodyEl  = modal.wrap.querySelector("#dmBody");

    const d = parseISODate(dateISO) || new Date();
    const dayName = d.toLocaleDateString("nl-NL", { weekday:"long" });
    const nice = d.toLocaleDateString("nl-NL", { day:"numeric", month:"numeric" });

    if (titleEl) titleEl.textContent = dayName.charAt(0).toUpperCase() + dayName.slice(1);
    if (subEl) subEl.textContent = nice;

    // naam maps
    const empNameById = new Map((werknemers || []).map(w => [String(w.id), String(w.name || "").trim()]));
    const inhuurNameById = new Map();

    // A) uit inhuurPeopleVisible (array met {inhuur_id, name})
    for (const p of (inhuurPeopleVisible || [])) {
      const id = String(p?.inhuur_id ?? p?.id ?? "").trim();
      const nm = String(p?.name ?? p?.naam ?? "").trim();
      if (id) inhuurNameById.set(id, nm || "Inhuur");
    }

    // B) daarnaast ook uit inhuurById (Map) als die bestaat
    if (inhuurById instanceof Map) {
      for (const [iid, obj] of inhuurById.entries()) {
        const id = String(iid ?? "").trim();
        const nm = String(obj?.name ?? "").trim();
        if (id && !inhuurNameById.has(id)) inhuurNameById.set(id, nm || "Inhuur");
      }
    }
    // helper: label (zoals jouw chips)
    const buildLabel = (pid, sid) => {
      const pm = projMetaById?.get(String(pid)) || {};
      const top = [String(pm.nr||"").trim(), String(pm.nm||"").trim()].filter(Boolean).join(" - ").trim();

      let sect = "";
      if (sid) {
        const sObj = sectById?.get(String(sid));
        const sNr = String(sObj?.[sectParaKey] ?? sObj?.paragraph ?? "").trim();
        const sNm = String(sObj?.[sectNameKey] ?? sObj?.name ?? "").trim();
        sect = [sNr, sNm].filter(Boolean).join(" ").trim();
      }
      return [top, sect].filter(Boolean).join("\n");
    };

    // verzamelen: empId -> items[]
    const byEmp = new Map(); // empId => [{type, text}]
    const addEmpItem = (empId, type, text) => {
      const k = String(empId);
      if (!byEmp.has(k)) byEmp.set(k, []);
      byEmp.get(k).push({ type, text });
    };

    // 1) sectie-niveau (assignMap)
    for (const [sid, dm] of (assignMap || new Map())) {
      const entry = dm?.get(dateISO);
      if (!entry) continue;

      const sObj = sectById?.get(String(sid));
      const pid = String(sObj?.[sectProjKey] || "").trim();
      if (!pid) continue;

      const txt = buildLabel(pid, sid);

      // echte medewerkers
      for (const eid of (entry.productie || [])) addEmpItem(eid, "productie", txt);
      for (const eid of (entry.montage || []))   addEmpItem(eid, "montage", txt);
      for (const eid of (entry.cnc || []))       addEmpItem(eid, "cnc", txt);
      for (const eid of (entry.reis || []))      addEmpItem(eid, "reis", txt);

          // inhuur (we zetten ze als “pseudo medewerker” met prefix)
    for (const iid of (entry.inhuurProdIds || [])) addEmpItem(`inhuur:${String(iid).trim()}`, "productie", txt);
    for (const iid of (entry.inhuurMontIds || [])) addEmpItem(`inhuur:${String(iid).trim()}`, "montage", txt);
        }

    // 2) project-niveau (projectAssignMap)
    for (const [pid, dm] of (projectAssignMap || new Map())) {
      const entry = dm?.get(dateISO);
      if (!entry) continue;

      const txt = buildLabel(pid, null);

      for (const eid of (entry.productie || [])) addEmpItem(eid, "productie", txt);
      for (const eid of (entry.montage || []))   addEmpItem(eid, "montage", txt);
      for (const iid of (entry.inhuurProdIds || [])) addEmpItem(`inhuur:${String(iid).trim()}`, "productie", txt);
      for (const iid of (entry.inhuurMontIds || [])) addEmpItem(`inhuur:${String(iid).trim()}`, "montage", txt);
    }

    // ✅ ook tonen: iedereen met beschikbaarheid (uren > 0) op deze dag
    const ctx = window.__plannerCtx || {};
    const capByEmp = ctx.capByEmp || new Map();
    const inhuurByEmp = ctx.inhuurByEmp || new Map();

    // vaste medewerkers met capaciteit > 0
    for (const w of (werknemers || [])) {
      const eid = String(w?.id ?? "").trim();
      if (!eid) continue;

      const h = Number(capByEmp.get(eid)?.get(dateISO) || 0);
      if (h > 0) {
        if (!byEmp.has(eid)) byEmp.set(eid, []); // leeg = beschikbaar maar niets ingepland
      }
    }

    // inhuur met uren > 0
    for (const [iid, dm] of (inhuurByEmp || new Map())) {
      const h = Number(dm?.get(dateISO) || 0);
      if (h > 0) {
        const key = `inhuur:${String(iid).trim()}`;
        if (!byEmp.has(key)) byEmp.set(key, []);
      }
    }

    // Render
    const rows = [];

    const keysSorted = Array.from(byEmp.keys()).sort((a,b)=>{
      const aIn = a.startsWith("inhuur:");
      const bIn = b.startsWith("inhuur:");

      // ✅ vaste medewerkers eerst
      if (aIn !== bIn) return aIn ? 1 : -1;

      const aId = aIn ? a.slice(6).trim() : "";
      const bId = bIn ? b.slice(6).trim() : "";

      const an = aIn ? (inhuurNameById.get(aId) || "Inhuur") : (empNameById.get(a) || a);
      const bn = bIn ? (inhuurNameById.get(bId) || "Inhuur") : (empNameById.get(b) || b);

      return String(an).localeCompare(String(bn), "nl", { sensitivity:"base" });
    });

    for (const k of keysSorted) {
    const isInhuur = k.startsWith("inhuur:");
    const iid = isInhuur ? k.slice(6).trim() : "";

    const name = isInhuur
      ? `${inhuurNameById.get(iid) || "Inhuur"} (inhuur)`
      : (empNameById.get(k) || k);

    // dedupe per werknemer (zelfde type+text)
    const seen = new Set();
    const items = (byEmp.get(k) || []).filter(it=>{
      const kk = `${it.type}||${it.text}`;
      if (seen.has(kk)) return false;
      seen.add(kk);
      return true;
    });

    rows.push(`
      <div class="dm-row">
        <div class="dm-name">${escapeHtml(name)}</div>
        <div class="dm-items">
          ${items.length
            ? items.map(it => `
                <div class="dm-card ${it.type === "montage" ? "mont" : it.type === "productie" ? "prod" : ""}">
                  ${escapeHtml(it.text).replace(/\n/g,"<br>")}
                </div>
              `).join("")
            : `<div class="muted">Beschikbaar</div>`
          }
        </div>
      </div>
    `);
  }

    bodyEl.innerHTML = rows.length
      ? `<div class="dm-list">${rows.join("")}</div>`
      : `<div class="muted">Geen ingeplande medewerkers op deze dag.</div>`;

    modal.wrap.classList.add("show");
  }


    // -------- RENDER --------
    function renderPlanner({ start, days, projecten, secties, work, cap, werknemers, werknemersCap, assigns, pAssigns, orders, inhuurEntries, inhuurPeopleVisible }) {
    const DEBUG_OFFNR = "2600013";   // <-- zet hier jouw projectnr uit de screenshot
    const DEBUG_ISO   = null;        // bv "2026-02-12" of null = alle dagen in range



    const dates = [];
    for(let i=0;i<days;i++) dates.push(addDays(start, i));

    const totalDays = dates.length;
    document.documentElement.style.setProperty('--days', String(totalDays));

      console.log("DATES preview:", dates.slice(0,14).map(d => toISODate(d)).join(", "));

    resetZebra(); // ✅ hier

    // indexes
    const projIdKey = pickKey(projecten[0], ["project_id","id"]);
    const projNrKey = pickKey(projecten[0], ["offerno","projectnr","project_nr","nummer","nr"]);
    const projNameKey = pickKey(projecten[0], ["projectname","naam","name","omschrijving","titel","title"]);
    const klantKey = pickKey(projecten[0], ["deliveryname", "klantnaam","klant_name","klant","customer","relatie"]);


    const completionKey = pickKey(projecten[0], ["completiondate_d","completiondate","completion_date","opleverdatum","end_date"]);
    const deliveryKey   = pickKey(projecten[0], ["deliverydate_d","deliverydate","delivery_date","leverdatum"]);



    const sectIdKey   = pickKey(secties[0], ["id","section_id"]);
    const sectProjKey = pickKey(secties[0], ["project_id","projectid","project","project_ref"]);
    const sectNameKey = pickKey(secties[0], ["name","naam","section_name","sectionname","titel","title","omschrijving","description"]);
    const sectParaKey = pickKey(secties[0], ["paragraph","paragraaf","sectienr","sectie_nr"]);


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

    // ✅ ordersBySection: section_id -> Map(bestel_nummer -> rows[])
    ordersBySection = new Map();

    for (const r of (orders || [])) {
      const rawSid = r.section_id;
      if (!rawSid) continue;

      // gebruik dezelfde sid als de rest van je planner (sectLookup)
      const sid = sectLookup.get(String(rawSid)) || String(rawSid);

      if (!ordersBySection.has(sid)) ordersBySection.set(sid, new Map());
      const byBN = ordersBySection.get(sid);

      const bn = String(r.bestel_nummer || "").trim() || "Onbekend";
      if (!byBN.has(bn)) byBN.set(bn, []);
      byBN.get(bn).push(r);
    }

    // ✅ headers maken NA vullen ordersBySection
    const orderHeadersBySection = new Map(); // sid -> [{bn, leverISO, items}]
    for (const [sid, byBN] of ordersBySection.entries()) {
      const headers = [];

      for (const [bn, items] of byBN.entries()) {
        // pak 1e leverdatum die gevuld is
        const lever = items.map(x => x.leverdatum).find(Boolean);

        headers.push({
          bn,
          leverISO: lever ? asISODate(lever) : "",
          items
        });
      }

      headers.sort((a,b)=> String(a.leverISO||"").localeCompare(String(b.leverISO||"")));
      orderHeadersBySection.set(sid, headers);
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
        nr: String(p?.[projNrKey] ?? "").trim(),
        nm: String(p?.[projNameKey] ?? "").trim(),
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

    

    // assignments map: sectionId -> dateISO -> {productie:Set(empId), montage:Set(empId), dummyProd:number, dummyMont:number}
    const assignMap = new Map();

    for (const a of assigns || []) {
      const rawSid = String(a.section_id || "").trim();
      const sid = sectLookup.get(rawSid) || rawSid;   // ✅ canoniek
      const d   = String(a.work_date || "").trim();
      const emp = String(a.werknemer_id ?? "").trim();
      const wt  = String(a.work_type || "").toLowerCase().trim();

      if (!sid || !d || !emp || !wt) continue;

      if (!assignMap.has(sid)) assignMap.set(sid, new Map());
      const dmA = assignMap.get(sid);

      if (!dmA.has(d)) dmA.set(d, {
        productie: new Set(), cnc: new Set(), montage: new Set(), reis: new Set(),
        dummyProd: 0, dummyCnc: 0, dummyMont: 0, dummyReis: 0,
        dummySub: 0, subcNames: [],
        inhuurProdIds: new Set(),
        inhuurMontIds: new Set(),
        
      });
      const entry = dmA.get(d);

      const isDummy = (emp === String(DUMMY_SEC_ID)); // ✅ sectie dummy alleen


const note = String(a.note || ""); // <- zet deze regel boven je wt checks (1x)

      if (wt === "productie") {
        if (isDummy && note.startsWith("inhuur:")) {
          const iid = note.slice("inhuur:".length).trim();
          if (iid) entry.inhuurProdIds.add(iid);     // ✅ inhuur, NIET concept
        } else if (isDummy) {
          entry.dummyProd += 1;                      // ✅ echte concept
        } else {
          entry.productie.add(emp);
        }
      }

      if (wt === "montage") {
        if (isDummy && note.startsWith("inhuur:")) {
          const iid = note.slice("inhuur:".length).trim();
          if (iid) entry.inhuurMontIds.add(iid);     // ✅ inhuur, NIET concept
        } else if (isDummy) {
          entry.dummyMont += 1;                      // ✅ echte concept
        } else {
          entry.montage.add(emp);
        }
      }
      if (wt === "cnc") {
        if (isDummy) entry.dummyCnc += 1;
        else entry.cnc.add(emp);
      }
      if (wt === "reis") {
        if (isDummy) entry.dummyReis += 1;
        else entry.reis.add(emp);
      }
      if (wt === "onderaanneming") {
        if (isDummy) {
          // ✅ Altijd tellen, naam is optioneel
          const nm = String(a.note || "").trim();
          entry.subcNames.push(nm); // mag leeg zijn
        }
      }

    }

    // ======================
    // ✅ Split-counts: per project + dag + type + medewerker
    // (hoeveel secties binnen dit project heeft deze medewerker die dag)
    // ======================
    const splitCount = new Map(); // key -> count

    function _k(pid, dateISO, wt, empId){
      return `${pid}||${dateISO}||${wt}||${empId}`;
    }
    function incSplit(pid, dateISO, wt, empId){
      const key = _k(pid, dateISO, wt, empId);
      splitCount.set(key, (splitCount.get(key) || 0) + 1);
    }
    function getSplit(pid, dateISO, wt, empId){
      return splitCount.get(_k(pid, dateISO, wt, empId)) || 1;
    }

    // vul splitCount vanuit assignMap (alleen echte medewerkers; concept/inhuur laten we buiten splitten)
    for (const [sid, dm] of assignMap) {
      const sObj = sectById.get(String(sid));
      const pid = String(sObj?.[sectProjKey] || "").trim();
      if (!pid) continue;

      for (const [dateISO, entry] of dm) {
        for (const emp of (entry.productie || [])) incSplit(pid, dateISO, "productie", String(emp));
        for (const emp of (entry.montage   || [])) incSplit(pid, dateISO, "montage",   String(emp));
        for (const emp of (entry.cnc       || [])) incSplit(pid, dateISO, "cnc",       String(emp));
        for (const emp of (entry.reis      || [])) incSplit(pid, dateISO, "reis",      String(emp));
      }
    }

function dbgSectionKeysForProject(pid){
  const secs = sectiesByProject.get(pid) || [];

  const secIdsFromSecties = secs.map(s => {
    const raw = s?.[sectIdKey] ? String(s[sectIdKey]) : (s?.section_id ? String(s.section_id) : "");
    const canon = sectLookup.get(raw) || raw;
    return { raw, canon };
  });

  const assignKeys = Array.from(assignMap.keys());

  console.log("DEBUG sectiesByProject sectionIds:", secIdsFromSecties);
  console.log("DEBUG assignMap keys (first 20):", assignKeys.slice(0,20));

  console.log("DEBUG matches:", secIdsFromSecties.map(x => ({
    ...x,
    inAssignMap: assignMap.has(x.canon)
  })));
}


    // busyByDay: dateISO -> Set(empId) (ongeacht type)
    const busyByDay = new Map();

    for (const [sid, dm] of assignMap) {
      for (const [dateISO, entry] of dm) {
        if (!busyByDay.has(dateISO)) busyByDay.set(dateISO, new Set());
        const set = busyByDay.get(dateISO);

        for (const id of (entry.productie || [])) set.add(String(id));
        for (const id of (entry.montage || [])) set.add(String(id));
      }
    }

    // ======================
    // ✅ busy per dag per project (zodat dezelfde medewerker wel op meerdere secties
    // binnen hetzelfde project kan, maar NIET in een ander project)
    // ======================
    const busyByDayByProject = new Map(); // dateISO -> Map(projectId -> Set(empId))

    for (const [sid, dm] of assignMap) {
      const secObj = sectById.get(String(sid));
      const pid = String(secObj?.[sectProjKey] || "").trim();
      if (!pid) continue;

      for (const [dateISO, entry] of dm) {
        if (!busyByDayByProject.has(dateISO)) busyByDayByProject.set(dateISO, new Map());
        const pm = busyByDayByProject.get(dateISO);

        if (!pm.has(pid)) pm.set(pid, new Set());
        const set = pm.get(pid);

        for (const id of (entry.productie || [])) set.add(String(id));
        for (const id of (entry.montage || [])) set.add(String(id));
        for (const id of (entry.cnc || [])) set.add(String(id));
        for (const id of (entry.reis || [])) set.add(String(id));
      }
    }

    // helper: busy set maar dan alleen "andere projecten"
    function getBusyOtherProjects(dateISO, projectId){
      const all = busyByDay.get(dateISO) || new Set();
      const pm = busyByDayByProject.get(dateISO);
      const same = pm?.get(String(projectId)) || new Set();

      const out = new Set();
      for (const id of all) {
        if (!same.has(id)) out.add(id);
      }
      return out;
    }


    // ======================
// projectAssignMap: project_id -> dateISO -> { productie:Set, montage:Set, dummyProd:number, dummyMont:number }
// ======================
const projectAssignMap = new Map();

for (const a of (pAssigns || [])) {
  const pid = String(a.project_id || "").trim();
  const d   = String(a.work_date || "").trim();
  const emp = String(a.werknemer_id ?? "").trim();
  const wt  = String(a.work_type || "").toLowerCase().trim();
  if (!pid || !d || !emp || !wt) continue;

  if (!projectAssignMap.has(pid)) projectAssignMap.set(pid, new Map());
  const dmP = projectAssignMap.get(pid);

    if (!dmP.has(d)) dmP.set(d, {
      productie: new Set(), cnc: new Set(), montage: new Set(), reis: new Set(),
      dummyProd: 0, dummyCnc: 0, dummyMont: 0, dummyReis: 0,
      dummySub: 0,
      inhuurProdIds: new Set(),
      inhuurMontIds: new Set()
    });

  const entry = dmP.get(d);

  const isDummy = (emp === String(DUMMY_EMP_ID)); // ✅ project dummy alleen

const note = String(a.note || "");

if (wt === "productie") {
  if (isDummy && note.startsWith("inhuur:")) {
    const iid = note.slice("inhuur:".length).trim();
    if (iid) entry.inhuurProdIds.add(iid);
  } else if (isDummy) {
    entry.dummyProd += 1;
  } else {
    entry.productie.add(emp);
  }
}

if (wt === "montage") {
  if (isDummy && note.startsWith("inhuur:")) {
    const iid = note.slice("inhuur:".length).trim();
    if (iid) entry.inhuurMontIds.add(iid);
  } else if (isDummy) {
    entry.dummyMont += 1;
  } else {
    entry.montage.add(emp);
  }
}
  if (wt === "cnc") {
  if (isDummy) entry.dummyCnc += 1;
  else entry.cnc.add(emp);
  }
  if (wt === "reis") {
    if (isDummy) entry.dummyReis += 1;
    else entry.reis.add(emp);
  }
  if (wt === "onderaanneming") {
    if (isDummy) {
      const nm = String(a.note || "").trim();
      if (nm) entry.subcNames.push(nm);
    }
  }

}

(function quickDebug(){
  const anyPid = (projecten?.[0]?.[projIdKey]) ? String(projecten[0][projIdKey]) : null;
  const anyDate = dates?.[0] ? toISODate(dates[0]) : null;
  if(!anyPid || !anyDate) return;

  const pe = projectAssignMap.get(anyPid)?.get(anyDate);
  console.log("[DBG] sample project_assign day", { anyPid, anyDate, pe });

  const anySec = (sectiesByProject.get(anyPid) || [])[0];
  if(anySec){
    const raw = anySec?.[sectIdKey] ? String(anySec[sectIdKey]) : String(anySec?.section_id||"");
    const sidC = sectLookup.get(raw) || raw;
    const se = assignMap.get(sidC)?.get(anyDate);
    console.log("[DBG] sample section_assign day", { raw, sidC, anyDate, se });
  }
})();

      // --- project meta voor labels (offerno + projectnaam)
      const projMetaById = new Map();
      for (const p of (projecten || [])) {
        const pid = String(p?.[projIdKey] ?? "").trim();
        if (!pid) continue;
        projMetaById.set(pid, {
          nr: String(p?.[projNrKey] ?? "").trim(),
          nm: String(p?.[projNameKey] ?? "").trim(),
        });
      }

    // capacity: per werknemer per dag  (KEYS ALS STRING!)
    const capByEmp = new Map(); // empIdStr -> dateISO -> sumHours
    for (const r of cap || []) {
      const empStr = String(r.werknemer_id ?? "").trim();

      // ✅ Dummy nooit meenemen in capaciteit
      if (empStr === String(DUMMY_EMP_ID)) continue;

      const d = String(r.work_date || "").trim();
      const h = Number(r.hours || 0);
      const t = String(r.type || "werk");
      const sign = (t === "werk") ? 1 : 1;

      if (!empStr || !d) continue;

      if (!capByEmp.has(empStr)) capByEmp.set(empStr, new Map());
      const dm = capByEmp.get(empStr);
      dm.set(d, (dm.get(d) || 0) + (h * sign));
    }


    // totals capaciteit per dag
    const capTotalByDay = {};
    for(const [emp, dm] of capByEmp){
      for(const [d,h] of dm){
        capTotalByDay[d] = (capTotalByDay[d] || 0) + h;
      }
    }

    // ===== Inhuur aggregatie (per inhuur_id per dag + totaal per dag) =====
    const inhuurById = new Map(); // inhuur_id -> { name }
    for (const p of (inhuurPeopleVisible || [])) {
      inhuurById.set(String(p.inhuur_id), { name: String(p.name || "").trim() || "Inhuur" });
    }



    const inhuurByEmp = new Map(); // inhuur_id -> Map(dateISO -> hours)
    const inhuurTotalByDay = {};   // dateISO -> hours

    for (const r of (inhuurEntries || [])) {
      const iid = String(r.inhuur_id || "").trim();
      const d = String(r.work_date || "").trim();
      const h = Number(r.hours || 0);
      if (!iid || !d || !(h > 0)) continue;

      if (!inhuurByEmp.has(iid)) inhuurByEmp.set(iid, new Map());
      const dm = inhuurByEmp.get(iid);
      dm.set(d, (dm.get(d) || 0) + h);

      inhuurTotalByDay[d] = (inhuurTotalByDay[d] || 0) + h;
    }

    // ✅ Inhuur meenemen in "Uren beschikbaar" totals
    for (const k of Object.keys(inhuurTotalByDay)) {
      capTotalByDay[k] = (capTotalByDay[k] || 0) + (inhuurTotalByDay[k] || 0);
    }


    // planned prod/mont per day (unieke medewerkers per dag * 7,75 * planFactor)
    const plannedProdByDay = {};
    const plannedMontByDay = {};

    // ✅ ook projectniveau mee nemen (↳ Montage / ↳ Productie)
    const plannedSetsByDay = buildPlannedSetsByDay([...(assigns || []), ...(pAssigns || [])]);

    const pf = (settings.planFactor ?? 1);

    for (const d of dates) {
      const dayISO = toISODate(d);
      const sets = plannedSetsByDay[dayISO] || { pro: new Set(), mo: new Set(), dummyPro: 0, dummyMo: 0 };

      plannedProdByDay[dayISO]  = (sets.pro.size + (sets.dummyPro || 0)) * HOURS_PER_PERSON_DAY * pf;
      plannedMontByDay[dayISO]  = (sets.mo.size + (sets.dummyMo  || 0)) * HOURS_PER_PERSON_DAY * pf;
    }



    // per dag: welke medewerkers ingepland zijn (gebruik dezelfde bron als plannedProd/Mont)
    const empAssignByDay = Object.create(null);
    // { "YYYY-MM-DD": { prod:Set(empIdStr), mont:Set(empIdStr) } }

    for (const d of dates) {
      const iso = toISODate(d);
      const sets = plannedSetsByDay[iso] || { pro: new Set(), mo: new Set() };

      empAssignByDay[iso] = {
        prod: new Set(Array.from(sets.pro || []).map(x => String(x).trim())),
        mont: new Set(Array.from(sets.mo  || []).map(x => String(x).trim())),
      };
    }

    // ✅ per dag: welke INHUUR ingepland is (prod/mont)
    const inhuurAssignByDay = Object.create(null);
    // { "YYYY-MM-DD": { prod:Set(inhuurIdStr), mont:Set(inhuurIdStr) } }

    for (const d of dates) {
      const iso = toISODate(d);
      inhuurAssignByDay[iso] = { prod: new Set(), mont: new Set() };
    }

    // sectie-niveau (section_assignments)
    for (const [, dm] of assignMap) {
      for (const [dateISO, entry] of dm) {
        if (!inhuurAssignByDay[dateISO]) inhuurAssignByDay[dateISO] = { prod: new Set(), mont: new Set() };

        for (const iid of (entry.inhuurProdIds || [])) inhuurAssignByDay[dateISO].prod.add(String(iid));
        for (const iid of (entry.inhuurMontIds || [])) inhuurAssignByDay[dateISO].mont.add(String(iid));
      }
    }

    // project-niveau (project_assignments)
    for (const [, dm] of projectAssignMap) {
      for (const [dateISO, entry] of dm) {
        if (!inhuurAssignByDay[dateISO]) inhuurAssignByDay[dateISO] = { prod: new Set(), mont: new Set() };

        for (const iid of (entry.inhuurProdIds || [])) inhuurAssignByDay[dateISO].prod.add(String(iid));
        for (const iid of (entry.inhuurMontIds || [])) inhuurAssignByDay[dateISO].mont.add(String(iid));
      }
    }


    // build table
    const table = document.createElement("table");
    table.className = "planner-table";
    const colgroup = document.createElement("colgroup");
    const colLeft = document.createElement("col");
    colLeft.style.width = "380px";
    colgroup.appendChild(colLeft);

    // extra kolom met uren (uit Supabase | gepland)
    const colHours = document.createElement("col");
    colHours.style.width = hoursColOpen ? "120px" : "0px";
    colgroup.appendChild(colHours);

    for(let i=0;i<dates.length;i++){
      const c = document.createElement("col");
      c.style.width = "32px";
      colgroup.appendChild(c);
    }
    table.appendChild(colgroup);



    // THEAD (3 rijen: maand / week / dag)
    const thead = document.createElement("thead");

    
      // --- maak context globaal beschikbaar voor modals (inhuur/capacity chips)
      window.__plannerCtx = {
        projMetaById,
        sectById,
        sectProjKey,
        sectNameKey,
        sectParaKey,
        assignMap,
        projectAssignMap,

        // ✅ nieuw: beschikbaarheid
        capByEmp,
        inhuurByEmp,
      };



    // Row: months
    const trMonth = document.createElement("tr");
    trMonth.className = "hdr hdr-month";
    trMonth.appendChild(hdrCell(
      `<div class="rowhdr-flex">
        <span>Planning</span>
        <button class="hourscol-toggle" id="btnHoursCol" type="button" title="Urenkolom tonen/verbergen">
          ${hoursColOpen ? "◀" : "▶"}
        </button>
      </div>`,
      "hdr-cell rowhdr sticky-left sticky-top"
    ));

// uren-kolom header blijft leeg (maar kolom bestaat wel)
trMonth.appendChild(hdrCell("", `hdr-cell hourscol sticky-top sticky-left2 ${hoursColOpen ? "" : "hourscol-collapsed"}`.trim()));




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
    trWeek.appendChild(hdrCell("", `hdr-cell hourscol sticky-top2 sticky-left2 ${hoursColOpen ? "" : "hourscol-collapsed"}`.trim()));

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
    trDay.appendChild(hdrCell("",  `hdr-cell hourscol sticky-top3 sticky-left2 ${hoursColOpen ? "" : "hourscol-collapsed"}`.trim()));
    for(const d of dates){
      const iso = toISODate(d);
      const cls = ["sticky-top3", "dayhead", isWeekend(d) ? "wknd" : ""].filter(Boolean).join(" ");
      trDay.appendChild(hdrCell(
        `<button type="button" class="dayhead-btn" data-iso="${escapeAttr(iso)}">
          ${dayNameNL(d.getDay())}<br>${d.getDate()}-${d.getMonth()+1}
        </button>`,
        cls
      ));
    }
    thead.appendChild(trDay);
    table.appendChild(thead);

    // TBODY
    const tbody = document.createElement("tbody");



    // Projects + sections (expand/collapse)
    for(const p of projecten || []){
      const pid = p?.[projIdKey];
      const nr  = p?.[projNrKey] ?? "";
      const isDebugProj = String(nr).includes(DEBUG_OFFNR);
      if (isDebugProj) dbgSectionKeysForProject(String(pid));


      const nm  = p?.[projNameKey] ?? "";
      const kl = String(p?.deliveryname || p?.[klantKey] || "").trim();
      const complRaw = p?.[completionKey] ?? "";
      const complTxt = formatDateNL(complRaw);
      const complISO0 = asISODate(complRaw);
      const complISO  = complISO0 ? toISODate(addDays(parseISODate(complISO0), -1)) : "";
      const deliveryRaw = p?.[deliveryKey] ?? "";
      const deliveryISO = asISODate(deliveryRaw);

      console.log("RAW completion:", complRaw, "=> ISO:", complISO);



      console.log("completionKey:", completionKey, "value:", p?.[completionKey]);


      const projRow = document.createElement("tr");
      projRow.className = "project-row";
      projRow.classList.add("project-topline"); // ✅ altijd een bovenlijn voor de order/project
      let lastRowOfProject = projRow; // <-- ook meteen B1 (zie hieronder)
      markZebra(projRow);
      const left = document.createElement("td");
      left.className = "rowhdr sticky-left project-cell";
      left.classList.add("project-topline-cell");
      if (projRow.classList.contains("project-bottomline")) left.classList.add("project-bottomline-cell");
      left.innerHTML = `
        <button class="expander" data-proj="${escapeAttr(pid)}" aria-label="toggle">▶</button>
        <span class="projtext" data-proj="${escapeAttr(pid)}">
          <div class="projline1">${escapeHtml(nr)} - ${escapeHtml(kl)}</div>
          <div class="projline2">${escapeHtml(nm)}</div>
        </span>
      `;

      projRow.appendChild(left);

      
// uren-kolom cel (project)
const hoursTd = document.createElement("td");
hoursTd.className = "cell hourscol sticky-left2";
hoursTd.style.left = "380px";
if (!hoursColOpen) hoursTd.style.display = "none";
projRow.appendChild(hoursTd);

// ===== required (bron) uren uit secties optellen =====
const secsForProj = (sectiesByProject.get(pid) || []);

const req = { prod: 0, cnc: 0, mont: 0, reis: 0 };
for (const s of secsForProj) {
  req.prod += Number(s?.uren_prod ?? 0);
  req.cnc  += Number(s?.uren_cnc ?? s?.uren_cnc_prod ?? 0);
  req.mont += Number(s?.uren_montage ?? s?.uren_mont ?? 0);
  req.reis += Number(s?.uren_reis ?? 0);
}
 

// ===== planned (gepland) uren voor project (uit assignments) =====
const pfP = (settings.planFactor ?? 1);
const plP = { prod: 0, cnc: 0, mont: 0, reis: 0 };

const secsP = (sectiesByProject.get(pid) || []);

for (const dd of dates) {
  const iso = toISODate(dd);

  for (const s of secsP) {
    const sidRaw = s?.[sectIdKey]
      ? String(s[sectIdKey])
      : (s?.section_id ? String(s.section_id) : null);
    if (!sidRaw) continue;

    const sidC = sectLookup.get(String(sidRaw)) || String(sidRaw);
    const e = assignMap.get(sidC)?.get(iso);
    if (!e) continue;

    // echte medewerkers (splitten binnen project)
    for (const emp of (e.productie || [])) {
      plP.prod += (HOURS_PER_PERSON_DAY * pfP) / getSplit(String(pid), iso, "productie", String(emp));
    }
    for (const emp of (e.cnc || [])) {
      plP.cnc += (HOURS_PER_PERSON_DAY * pfP) / getSplit(String(pid), iso, "cnc", String(emp));
    }
    for (const emp of (e.montage || [])) {
      plP.mont += (HOURS_PER_PERSON_DAY * pfP) / getSplit(String(pid), iso, "montage", String(emp));
    }
    for (const emp of (e.reis || [])) {
      plP.reis += (HOURS_PER_PERSON_DAY * pfP) / getSplit(String(pid), iso, "reis", String(emp));
    }

    // concept (dummy) telt gewoon als “personen”
    plP.prod += Number(e.dummyProd || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.cnc  += Number(e.dummyCnc  || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.mont += Number(e.dummyMont || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.reis += Number(e.dummyReis || 0) * HOURS_PER_PERSON_DAY * pfP;

    // inhuur telt ook als “personen” (zelfde factor)
    plP.prod += Number(e.inhuurProdIds?.size || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.mont += Number(e.inhuurMontIds?.size || 0) * HOURS_PER_PERSON_DAY * pfP;
  }

  // projectniveau (↳ regels) ook meenemen
  const pe = projectAssignMap.get(String(pid))?.get(iso);
  if (pe) {
    for (const emp of (pe.productie || [])) plP.prod += HOURS_PER_PERSON_DAY * pfP;
    for (const emp of (pe.cnc || []))       plP.cnc  += HOURS_PER_PERSON_DAY * pfP;
    for (const emp of (pe.montage || []))   plP.mont += HOURS_PER_PERSON_DAY * pfP;
    for (const emp of (pe.reis || []))      plP.reis += HOURS_PER_PERSON_DAY * pfP;

    plP.prod += Number(pe.dummyProd || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.cnc  += Number(pe.dummyCnc  || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.mont += Number(pe.dummyMont || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.reis += Number(pe.dummyReis || 0) * HOURS_PER_PERSON_DAY * pfP;

    plP.prod += Number(pe.inhuurProdIds?.size || 0) * HOURS_PER_PERSON_DAY * pfP;
    plP.mont += Number(pe.inhuurMontIds?.size || 0) * HOURS_PER_PERSON_DAY * pfP;
  }
}

// vullen!
hoursTd.innerHTML = miniHoursHtml(req, plP);

  // tel ingeplande mensen per dag op over alle secties van dit project
  const projAssignByDay = {};
  const secs = sectiesByProject.get(pid) || [];

for (const dd of dates) {
  const iso = toISODate(dd);

  let prod = 0, mont = 0;
  let dummyProd = false, dummyMont = false;

  // 1) sectie-niveau (section_assignments)
  for (const s of secs) {
    const sid = s?.[sectIdKey]
      ? String(s[sectIdKey])
      : (s?.section_id ? String(s.section_id) : null);
    if (!sid) continue;

    const sidC = sectLookup.get(String(sid)) || String(sid);
    const entry = assignMap.get(sidC)?.get(iso);

    if (entry) {
      prod += entry.productie.size + (entry.dummyProd || 0) + (entry.inhuurProdIds?.size || 0);
      mont += entry.montage.size + (entry.dummyMont || 0) + (entry.inhuurMontIds?.size || 0);

      if ((entry.dummyProd || 0) > 0) dummyProd = true;
      if ((entry.dummyMont || 0) > 0) dummyMont = true;
    }
  }

  // 2) project-niveau (project_assignments)  ✅ dit miste
  const pe = projectAssignMap.get(String(pid))?.get(iso);
  if (pe) {
    prod += pe.productie.size + (pe.dummyProd || 0) + (pe.inhuurProdIds?.size || 0);
    mont += pe.montage.size + (pe.dummyMont || 0) + (pe.inhuurMontIds?.size || 0);

    if ((pe.dummyProd || 0) > 0) dummyProd = true;
    if ((pe.dummyMont || 0) > 0) dummyMont = true;
  }

  projAssignByDay[iso] = { prod, mont, dummyProd, dummyMont };
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

  appendProjectDayCells(projRow, dates, projLabels, complISO, deliveryISO, projAssignByDay);
  tbody.appendChild(projRow);
  lastRowOfProject = projRow;     // ✅ alleen assignen (mag ook weg, is al projRow)


  // section rows (hidden by default)
    const secList = (sectiesByProject.get(pid) || []).slice()
      .sort((a,b)=>{
        // haal paragraph / sectienr op (wat jij gebruikt)
        const pa = parseSectionNo(a?.[sectParaKey] ?? a?.paragraph ?? "");
        const pb = parseSectionNo(b?.[sectParaKey] ?? b?.paragraph ?? "");

        // 1) secties zonder nummer helemaal onderaan binnen hun groep
        const hasA = !!pa, hasB = !!pb;
        if (hasA && !hasB) return -1;
        if (!hasA && hasB) return  1;

        // als beiden geen nummer: val terug op naam
        if (!hasA && !hasB){
          return String(a?.[sectNameKey]||"").localeCompare(String(b?.[sectNameKey]||""));
        }

        // 2) normaal eerst, meerwerk onderaan
        if (pa.isMeerwerk !== pb.isMeerwerk){
          return pa.isMeerwerk ? 1 : -1; // meerwerk = later
        }

        // 3) nummer oplopend
        if (pa.num !== pb.num) return pa.num - pb.num;

        // 4) tie-breaker: naam
        return String(a?.[sectNameKey]||"").localeCompare(String(b?.[sectNameKey]||""));
      });

    const secIdsForProject = secList.map(s => String(s?.[sectIdKey] ?? s?.section_id ?? "")).filter(Boolean);



      for (const s of secList) {
        const secRow = document.createElement("tr");
        secRow.className = "section-row hidden";
        markZebra(secRow);
        secRow.dataset.parent = String(pid);

        const leftS = document.createElement("td");
        leftS.className = "rowhdr sticky-left section-cell";

        const sidRaw = s?.[sectIdKey]
          ? String(s[sectIdKey])
          : (s?.section_id ? String(s.section_id) : null);

        const sid = sidRaw ? (sectLookup.get(String(sidRaw)) || String(sidRaw)) : null;


        const para = String(s?.[sectParaKey] ?? "").trim();   // bv "02."
        const sn0  = s?.[sectNameKey] || "sectie";
        const paraHtml = para ? `<span class="secNo">${escapeHtml(para)}</span>` : "";
        leftS.innerHTML = `
          <button class="expander expander-sec" data-sect="${escapeAttr(sid)}" aria-label="toggle sectie">▶</button>
          <span class="sectext sectname" data-sect="${escapeAttr(sid)}">↳ ${paraHtml}${escapeHtml(sn0)}</span>
        `;


        secRow.appendChild(leftS);

      // ===== lege uren-kolom cel (sectie) =====
      const hoursTdS = document.createElement("td");
      hoursTdS.className = "cell hourscol sticky-left2";
      hoursTdS.style.left = "380px";
      if (!hoursColOpen) hoursTdS.style.display = "none";

      // ===== Sectie uren: required (bron) vs gepland (section_assignments) =====
      const reqS = {
        prod: Number(s?.uren_prod ?? 0),
        cnc:  Number(s?.uren_cnc ?? s?.uren_cnc_prod ?? 0),
        mont: Number(s?.uren_montage ?? s?.uren_mont ?? 0),
        reis: Number(s?.uren_reis ?? 0),
      };

      const pfS = (settings.planFactor ?? 1);
      const plS = { prod: 0, cnc: 0, mont: 0, reis: 0 };

      const sidC = sectLookup.get(String(sid)) || String(sid);
      const dmSec = assignMap.get(sidC);

      if (dmSec) {
        for (const dd of dates) {
          const iso = toISODate(dd);
          const e = dmSec.get(iso);
          if (!e) continue;

// ✅ split per medewerker (alleen echte medewerkers)
const pidS = String(pid || "").trim();

for (const emp of (e.productie || [])) {
  const div = getSplit(pidS, iso, "productie", String(emp));
  plS.prod += (HOURS_PER_PERSON_DAY * pfS) / div;
}
for (const emp of (e.cnc || [])) {
  const div = getSplit(pidS, iso, "cnc", String(emp));
  plS.cnc += (HOURS_PER_PERSON_DAY * pfS) / div;
}
for (const emp of (e.montage || [])) {
  const div = getSplit(pidS, iso, "montage", String(emp));
  plS.mont += (HOURS_PER_PERSON_DAY * pfS) / div;
}
for (const emp of (e.reis || [])) {
  const div = getSplit(pidS, iso, "reis", String(emp));
  plS.reis += (HOURS_PER_PERSON_DAY * pfS) / div;
}

// concept (dummy) zoals het was
plS.prod += Number(e.dummyProd || 0) * HOURS_PER_PERSON_DAY * pfS;
plS.cnc  += Number(e.dummyCnc  || 0) * HOURS_PER_PERSON_DAY * pfS;
plS.mont += Number(e.dummyMont || 0) * HOURS_PER_PERSON_DAY * pfS;
plS.reis += Number(e.dummyReis || 0) * HOURS_PER_PERSON_DAY * pfS;
        }
      }

      hoursTdS.innerHTML = miniHoursHtml(reqS, plS);
      secRow.appendChild(hoursTdS);



        const labels = buildDayLabelsForSection(sid, workMap, dates);
        
        // badge = aantal ingeplande collega's per type (productie / montage)
        const dmA = assignMap.get(String(sid));
        const assignByDay = {};
        for (const dd of dates) {
          const iso = toISODate(dd);
          const entry = dmA?.get(iso);
        assignByDay[iso] = {
          prod: entry ? (entry.productie.size + (entry.dummyProd || 0) + (entry.inhuurProdIds?.size || 0)) : 0,
          mont: entry ? (entry.montage.size + (entry.dummyMont || 0) + (entry.inhuurMontIds?.size || 0)) : 0,
          subc: entry ? Number(entry.subcNames?.length || 0) : 0,
        };

        }

        appendSectionDayCells(secRow, dates, labels, sid, String(pid), assignByDay, assignMap, werknemers, inhuurById);




        tbody.appendChild(secRow);
        lastRowOfProject = secRow;


    // ======================
    // ✅ BESTELLINGEN ALS ECHTE KALENDER-RIJEN
    // ======================
    const headers = orderHeadersBySection.get(String(sid)) || [];

    for (const oh of headers) {

      // 1) Bestelling header-rij
      const orderRow = document.createElement("tr");
      orderRow.className = "order-row hidden";
      orderRow.classList.add("order-topline"); // ✅ bovenlijn
      markZebra(orderRow);
      orderRow.dataset.parent = String(pid);
      orderRow.dataset.orderParent = String(sid);
      orderRow.dataset.orderBn = String(oh.bn || "");

      const tdLeft = document.createElement("td");
      tdLeft.className = "rowhdr sticky-left section-cell";
      tdLeft.innerHTML =
        `<button class="expander expander-order" ` +
        `data-sect="${escapeAttr(sid)}" ` +
        `data-parent="${escapeAttr(pid)}" ` +
        `data-orderbn="${escapeAttr(oh.bn)}" ` +
        `aria-label="toggle order">▶</button>` +
        `<span class="sectext"> ↳ Bestelling ${escapeHtml(oh.bn)}</span>`;

      orderRow.appendChild(tdLeft);
      // ===== lege uren-kolom cel (order header) =====
      const hoursTdO = document.createElement("td");
      hoursTdO.className = "cell hourscol sticky-left2";
      hoursTdO.style.left = "380px";
      if (!hoursColOpen) hoursTdO.style.display = "none";
      hoursTdO.innerHTML = "";
      orderRow.appendChild(hoursTdO);

      appendOrderDayCells(orderRow, dates, oh.leverISO, secIdsForProject, assignMap);
      tbody.appendChild(orderRow);
      lastRowOfProject = orderRow;



    const items = (oh.items || []);
    items.forEach((it, idx) => {
      const isLast = (idx === items.length - 1);

      const lineRow = document.createElement("tr");
      lineRow.className = "order-line-row hidden";
      if (isLast) lineRow.classList.add("order-bottomline");

      markZebra(lineRow);

      lineRow.dataset.parent = String(pid);
      lineRow.dataset.orderParent = String(sid);
      lineRow.dataset.orderBn = String(oh.bn || "");

      const tdL = document.createElement("td");
      tdL.className = "rowhdr sticky-left section-cell";
      tdL.innerHTML =
        `<span class="sectext">  ↳ ${escapeHtml(it.aantal ?? 1)} — ${escapeHtml(it.omschrijving || "")}</span>`;

      lineRow.appendChild(tdL);

      // ===== lege uren-kolom cel (order line) =====
      const hoursTdL = document.createElement("td");
      hoursTdL.className = "cell hourscol sticky-left2";
      hoursTdL.style.left = "380px";
      if (!hoursColOpen) hoursTdL.style.display = "none";
      hoursTdL.innerHTML = "";
      lineRow.appendChild(hoursTdL);


      const leverLineISO = it.leverdatum ? asISODate(it.leverdatum) : oh.leverISO;
      appendOrderDayCells(lineRow, dates, leverLineISO, [String(sid)], assignMap);

      tbody.appendChild(lineRow);
      lastRowOfProject = lineRow;
    });


    }
      }


    // ======================
    // ✅ EXTRA "↳ Montage" SAMENVATTINGSREGEL PER PROJECT
    // (alleen tonen als er montage-uren bestaan in dit project)
    // ======================
    const hasMontageHours = (secList || []).some(s => {
      const v =
        Number(s?.uren_montage ?? s?.uren_mont ?? s?.uren_montage_prod ?? 0);
      return v > 0;
    });
    // ✅ check montage gepland via secties (section_assignments)
    const hasMontagePlanned = dates.some(dd => {
      const iso = toISODate(dd);
      return Number(projAssignByDay?.[iso]?.mont || 0) > 0;
    });

    // ✅ check project_assignments (↳ Montage regel)
    const hasProjectMontPlanned = dates.some(dd => {
      const iso = toISODate(dd);
      const e = projectAssignMap.get(String(pid))?.get(iso);
      const montCnt = (e ? (e.montage.size + (e.dummyMont || 0)) : 0);
      return montCnt > 0;
    });

    if (hasMontageHours || hasMontagePlanned || hasProjectMontPlanned) {

    // ✅ montage-summary toont RESTANT: projectniveau - sectieniveau
    const projMontByDay = {};
    const secsForProj = sectiesByProject.get(pid) || [];

    for (const dd of dates) {
      const iso = toISODate(dd);

      // 1) projectniveau montage (project_assignments)
      const pe = projectAssignMap.get(String(pid))?.get(iso);
      const projMont = pe ? (pe.montage.size + Number(pe.dummyMont || 0)) : 0;
      const projDummyMont = pe ? Number(pe.dummyMont || 0) : 0;

      // 2) sectieniveau montage (section_assignments) optellen
      let sectMont = 0;
      for (const s of secsForProj) {
      const sidRaw = s?.[sectIdKey]
        ? String(s[sectIdKey])
        : (s?.section_id ? String(s.section_id) : null);

      if (!sidRaw) continue;

      // ✅ canonieke sid (zelfde als assignMap / ordersBySection)
      const sid = sectLookup.get(String(sidRaw)) || String(sidRaw);
        const se = assignMap.get(String(sid))?.get(iso);
        if (!se) continue;

        sectMont += (se.montage.size + Number(se.dummyMont || 0));
      }

      // 3) restant (nooit negatief tonen)
      const remaining = Math.max(0, projMont - sectMont);

      // hatch alleen als er nog dummy over is (ruw maar werkt visueel)
      const dummyRemaining = Math.max(0, projDummyMont - Math.max(0, sectMont - (projMont - projDummyMont)));
      const dummy = dummyRemaining > 0;

      projMontByDay[iso] = { mont: remaining, dummyMont: dummy };
    }



      const montRow = document.createElement("tr");
      montRow.className = "section-row hidden montage-summary-row";
      montRow.dataset.parent = String(pid);
      markZebra(montRow);

      const leftM = document.createElement("td");
      leftM.className = "rowhdr sticky-left section-cell";
      leftM.innerHTML = `<span class="sectext">↳ Montage</span>`;
      montRow.appendChild(leftM);

      // ===== lege uren-kolom cel (montage samenvatting) =====
      const hoursTdM = document.createElement("td");
      hoursTdM.className = "cell hourscol sticky-left2";
      hoursTdM.style.left = "380px";
      if (!hoursColOpen) hoursTdM.style.display = "none";
      hoursTdM.innerHTML = "";
      montRow.appendChild(hoursTdM);


      appendProjectMontageSummaryDayCells(montRow, dates, projMontByDay, String(pid));


      tbody.appendChild(montRow);
      lastRowOfProject = montRow;
    }


      if (lastRowOfProject) lastRowOfProject.classList.add("project-bottomline");
      // ✅ ook linker kolom mee laten tekenen
      const leftCell = lastRowOfProject?.querySelector("td.rowhdr");
      if (leftCell) leftCell.classList.add("project-bottomline-cell");

      // ✅ voor de project header zelf ook altijd bovenlijn (zekerheid)
      const projLeft = projRow?.querySelector("td.project-cell");
      if (projLeft) projLeft.classList.add("project-topline-cell");


      } // ✅ sluit: for(const p of projecten || []){ ... }
          

    // CAPACITY BLOCK
  tbody.appendChild(spacerRow(dates.length));

  // Header row "Capaciteit"
  tbody.appendChild(sectionHeaderRow("Capaciteit", dates.length));

  // ---- Totaal rij eerst (met dropdown) ----
  const capKey = "cap"; // unieke key voor deze groep

  const trTotal = document.createElement("tr");
  trTotal.className = "cap-total-row";
  markZebra(trTotal); // ✅ ZEBRA HIER

  const tdTotalLeft = document.createElement("td");
  tdTotalLeft.className = "rowhdr sticky-left cap-total-left";
  tdTotalLeft.innerHTML = `
    <button class="expander cap-expander" data-cap="${capKey}" aria-label="toggle capaciteit">▶</button>
    <b>Uren beschikbaar</b>
    <button class="btn small" id="btnInhuurPlus" type="button" style="margin-left:8px;">+</button>
  `;

  trTotal.appendChild(tdTotalLeft);

  // uren-kolom placeholder (totaal capaciteit)
  const hoursTdTotal = document.createElement("td");
  hoursTdTotal.className = "cell hourscol sticky-left2";
  hoursTdTotal.style.left = "380px";
  if (!hoursColOpen) hoursTdTotal.style.display = "none";
  hoursTdTotal.innerHTML = "";
  trTotal.appendChild(hoursTdTotal);

  // totalen per dag (som van alle medewerkers)
  for (const d of dates){
    const iso = toISODate(d);
    const td = document.createElement("td");
    td.className = `cell sum-cell ${isWeekend(d) ? "wknd" : ""}`;
    td.textContent = fmt0(capTotalByDay[iso] || 0);
    trTotal.appendChild(td);
  }
  tbody.appendChild(trTotal);

    // ---- medewerker rijen (standaard verborgen) ----
    const empIdKey = "id";
    const empNameKey = pickKey((werknemersCap?.[0] || werknemers?.[0]), ["naam","name","fullname","display_name"]);

    for (const w of (werknemersCap || [])) {
      const empId = w?.[empIdKey];                 // <-- vaste naam
      const empName = w?.[empNameKey] ?? String(empId ?? "");

      const tr = document.createElement("tr");
      tr.className = "cap-emp-row hidden";
      tr.dataset.capParent = capKey;

      markZebra(tr);

      const leftEmp = document.createElement("td");
      leftEmp.className = "rowhdr sticky-left cap-name cap-emp-click";
      leftEmp.textContent = empName;
      leftEmp.dataset.empId = String(empId ?? "");
      leftEmp.dataset.empName = String(empName ?? "");
      tr.appendChild(leftEmp);

      // ===== lege uren-kolom cel (capaciteit medewerker) =====
      const hoursTdCap = document.createElement("td");
      hoursTdCap.className = "cell hourscol sticky-left2";
      hoursTdCap.style.left = "380px";
      if (!hoursColOpen) hoursTdCap.style.display = "none";
      hoursTdCap.innerHTML = "";
      tr.appendChild(hoursTdCap);


      const empIdStr = String(empId ?? "").trim();

      for (const d of dates) {
        const dayISO = toISODate(d);
        const h = capByEmp.get(empIdStr)?.get(dayISO) || 0;


        const td = document.createElement("td");
        td.className = `cell cap-cell cap-cell-click ${isWeekend(d) ? "wknd" : ""}`;

        // ✅ nodig voor click op cel
        td.dataset.empId = String(empId ?? "");
        td.dataset.empName = String(empName ?? "");
        td.dataset.workDate = dayISO;

        const inProd = !!empAssignByDay[dayISO]?.prod?.has(empIdStr);
        const inMont = !!empAssignByDay[dayISO]?.mont?.has(empIdStr);

        if (inProd && inMont) td.classList.add("cap-assigned-both");
        else if (inProd) td.classList.add("cap-assigned-prod");
        else if (inMont) td.classList.add("cap-assigned-mont");

        td.textContent = fmt0(h);
        tr.appendChild(td);
      }

      tbody.appendChild(tr);
    }

    // ---- Inhuur rijen (alleen zichtbaar als er uren in view zijn) ----
    for (const [iid, dm] of (inhuurByEmp || new Map())) {
      // extra zekerheid: geen uren => geen rij
      let hasAny = false;
      for (const d of dates) {
        const iso = toISODate(d);
        if (Number(dm.get(iso) || 0) > 0) { hasAny = true; break; }
      }
      if (!hasAny) continue;

      const name = inhuurById.get(String(iid))?.name || "Inhuur";

      const trI = document.createElement("tr");
      trI.className = "cap-emp-row hidden";     // ✅ valt onder hetzelfde expand/collapse
      trI.dataset.capParent = capKey;
      markZebra(trI);

      const leftI = document.createElement("td");
      leftI.className = "rowhdr sticky-left cap-name";
      leftI.innerHTML = `🧑‍🔧 ${escapeHtml(name)}`;
      trI.appendChild(leftI);

      // ===== lege uren-kolom cel (inhuur capaciteit) =====
      const hoursTdInhuur = document.createElement("td");
      hoursTdInhuur.className = "cell hourscol sticky-left2";
      hoursTdInhuur.style.left = "380px";
      if (!hoursColOpen) hoursTdInhuur.style.display = "none";
      hoursTdInhuur.innerHTML = "";
      trI.appendChild(hoursTdInhuur);


      for (const d of dates) {
        const iso = toISODate(d);
        const h = Number(dm.get(iso) || 0);

        const td = document.createElement("td");
        td.className = `cell cap-cell inhuur-cell-click ${isWeekend(d) ? "wknd" : ""}`;

        // ✅ kleur als ingepland (zoals vaste werknemers)
        const iidStr = String(iid).trim();
        const inProd = !!inhuurAssignByDay[iso]?.prod?.has(iidStr);
        const inMont = !!inhuurAssignByDay[iso]?.mont?.has(iidStr);

        if (inProd && inMont) td.classList.add("cap-assigned-both");
        else if (inProd) td.classList.add("cap-assigned-prod");
        else if (inMont) td.classList.add("cap-assigned-mont");


        // ✅ nodig om op cel te kunnen klikken
        td.dataset.inhuurId = String(iid);
        td.dataset.workDate = iso;

        td.textContent = fmt0(h);
        trI.appendChild(td);

      }

      tbody.appendChild(trI);
    }



    // Gepland productie
    tbody.appendChild(labelRow("Gepland productie", dates, plannedProdByDay, "planned-prod"));

    // Gepland montage
    tbody.appendChild(labelRow("Gepland montage", dates, plannedMontByDay, "planned-mont"));

    // Saldo (capaciteit - gepland)
    const saldoByDay = {};
    for (const d of dates) {
      const iso = toISODate(d);
      const capTot = Number(capTotalByDay?.[iso] || 0);
      const planned = Number(plannedProdByDay?.[iso] || 0) + Number(plannedMontByDay?.[iso] || 0);
      // afronden op 2 decimalen om “-0” en float-ruis te vermijden
      saldoByDay[iso] = Math.round((capTot - planned) * 100) / 100;
    }
    tbody.appendChild(balanceRow("Saldo", dates, saldoByDay));

    // (optioneel) Capaciteit met nieuwe order / Nieuwe order: laat ik als “hook” staan
    // omdat ik jouw project_orders schema nog niet gezien heb.
    // Je kunt dit later 1-op-1 invullen.
    tbody.appendChild(spacerRow(dates.length));
    tbody.appendChild(sectionHeaderRow("Capaciteit met nieuwe order", dates.length, true));
    tbody.appendChild(infoRow("Nieuwe order (nog te koppelen)", dates.length));

    table.appendChild(tbody);

    if (!hoursColOpen) {
      table.querySelectorAll("th.hourscol, td.hourscol").forEach((cell) => {
        cell.style.display = "table-cell";
        cell.classList.add("hourscol-collapsed");
      });
    }

    // =========================
    // EXPANDERS BINDEN (na render)
    // =========================

     applyZebraVisible();


    function renderInhuurPickerTo(wrap, selected, dateISO, inhuurByEmp, inhuurById){
    const src = (inhuurByEmp || new Map());

    function renderOne(containerId, targetSet){
      const el = wrap.querySelector(containerId);
      if (!el) return;

      const rows = [];
      for (const [iid, dm] of src) {
        const id = String(iid);
        const hours = Number(dm?.get(dateISO) || 0);
        const name = inhuurById?.get(id)?.name || "Inhuur";

        const checked = targetSet.has(id);          // ✅ check in productie/montage set
        const shouldShow = checked || hours > 0;    // toon als beschikbaar of al gekozen
        if (!shouldShow) continue;

        rows.push(`
          <label class="assign-item" style="display:flex; gap:10px; align-items:center; justify-content:space-between;">
            <span style="display:flex; gap:10px; align-items:center;">
              <input type="checkbox" class="inhuur-pick" data-iid="${escapeAttr(id)}" ${checked ? "checked" : ""} />
              <span>${escapeHtml(name)}</span>
            </span>
            <span class="muted">${hours > 0 ? (hours + "u") : ""}</span>
          </label>
        `);
      }

      el.innerHTML = rows.length
        ? rows.join("")
        : `<div class="muted" style="padding:6px 2px;">Geen inhuur-uren beschikbaar op deze dag.</div>`;

      el.querySelectorAll("input.inhuur-pick").forEach(chk => {
        chk.onchange = () => {
          const iid = String(chk.dataset.iid || "").trim();
          if (!iid) return;

          if (chk.checked) targetSet.add(iid);   // ✅ nu nooit undefined
          else targetSet.delete(iid);
        };
      });
    }

    // ✅ Inhuur -> Productie/Montage sets (bestaan al)
    renderOne("#amInhuurProdPick", selected.productie);
    renderOne("#amInhuurMontPick", selected.montage);
  }
    // click on section cell -> assignments modal
    gridEl.onclick = async (ev) => {


          // ✅ klik op dagheader => dagmodal
    const dayBtn = ev.target.closest(".dayhead-btn[data-iso]");
    if (dayBtn) {
      ev.stopPropagation();
      const dateISO = String(dayBtn.dataset.iso || "");
      if (!dateISO) return;

      openDayModal({
        dateISO,
        werknemers,
        inhuurById,
        inhuurPeopleVisible,
        assignMap,
        projectAssignMap,
        sectById,
        projMetaById,
        sectProjKey,
        sectParaKey,
        sectNameKey
      });
      return;
    }

      // ✅ Inhuur "+" knop (naast Uren beschikbaar)
      const inBtn = ev.target.closest("#btnInhuurPlus");
      if (inBtn) {
        ev.stopPropagation();
        openInhuurModalAtWeek(new Date(rangeStart)); // start week van huidige view
        return;
      }

      // ✅ click op INHUUR-capaciteit cel => open inhuur modal op week + selecteer persoon
      const inhuurCell = ev.target.closest("td.inhuur-cell-click");
      if (inhuurCell) {
        ev.stopPropagation();

        const iid = String(inhuurCell.dataset.inhuurId || "");
        const dateISO = String(inhuurCell.dataset.workDate || "");
        if (!iid || !dateISO) return;

        // week van aangeklikte datum
        const wkStart = startOfISOWeek(parseISODate(dateISO) || new Date());

        // open modal
        await openInhuurModalAtWeek(wkStart);

        // selecteer de juiste inhuur in de dropdown
        const sel = document.getElementById("imSelect");
        if (sel) {
          sel.value = iid;
          // trigger onchange zodat week opnieuw rendert met juiste waarden
          sel.dispatchEvent(new Event("change", { bubbles: true }));
        }

        return;
      }


     // ✅ klik op bestelling pijltje => toon/verberg orderregel-rijen
    const obtn = ev.target.closest(".expander-order");
    if (obtn) {
      ev.stopPropagation();

      const sid = String(obtn.dataset.sect || "");
      const bn  = String(obtn.dataset.orderbn || "");

      const tr = obtn.closest("tr");
      const pid = String(tr?.dataset?.parent || "");

      const open = obtn.textContent !== "▼";
      obtn.textContent = open ? "▼" : "▶";

      // ✅ dit is de header-rij van de order
      if (tr) tr.classList.toggle("is-open", open);

      gridEl.querySelectorAll(
        `tr.order-line-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"][data-order-bn="${cssEsc(bn)}"]`
      ).forEach(r => r.classList.toggle("hidden", !open));

      applyZebraVisible();
      return;
    }


    // ✅ klik op sectie pijltje => toon/verberg bestellingen (order-row) + reset order-lines
    const sbtn = ev.target.closest(".expander-sec");
    if (sbtn) {
      ev.stopPropagation();

      const sid = String(sbtn.dataset.sect || "");
      const tr  = sbtn.closest("tr");
      const pid = String(tr?.dataset?.parent || "");
      if (!sid || !pid) return;

      const open = sbtn.textContent !== "▼";
      sbtn.textContent = open ? "▼" : "▶";

      // toon/verberg order headers onder deze sectie
      gridEl.querySelectorAll(
        `tr.order-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"]`
      ).forEach(r => r.classList.toggle("hidden", !open));

      // als sectie dicht gaat: verberg ook orderregels + pijltjes resetten
      if (!open) {
        gridEl.querySelectorAll(
          `tr.order-line-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"]`
        ).forEach(r => r.classList.add("hidden"));

        gridEl.querySelectorAll(
          `.expander-order[data-sect="${cssEsc(sid)}"]`
        ).forEach(b => b.textContent = "▶");
      }

      applyZebraVisible();
      return;
    }

    // ✅ click op order accordion head (in details)
    const oh = ev.target.closest(".order-head");
    if (oh) {
      ev.stopPropagation();
      const card = oh.closest(".order-card");
      const body = card?.querySelector(".order-body");
      const arrow = oh.querySelector(".order-arrow");
      if(!body) return;

      const open = !body.hasAttribute("hidden");
      if(open){
        body.setAttribute("hidden", "");
        if(arrow) arrow.textContent = "▾";
      } else {
        body.removeAttribute("hidden");
        if(arrow) arrow.textContent = "▴";
      }
      return;
    }


    const expBtn = ev.target.closest(".expander[data-proj]");
    if (expBtn) {
      ev.stopPropagation();
      const pid = String(expBtn.dataset.proj || "");
      if (pid) toggleProject(pid);
      return;
    }

    const projHit = ev.target.closest("[data-proj]");
    if (projHit) {
      const pid = String(projHit.dataset.proj || "");
      if (!pid) return;

      // ✅ togglen (open ↔ dicht) bij klik op regel/naam
      toggleProject(pid);
      return;
    }




      // klik op sectienaam (links) => sectie gegevens popup
      const nameEl = ev.target.closest(".sectname");
      if (nameEl) {
        const sid = String(nameEl.dataset.sect || "");
        if (!sid) return;

        const sObj = sectById.get(sid);
        const sectieNaam = sObj?.[sectNameKey] || sObj?.name || sObj?.naam || "sectie";

        const pid = sObj?.[sectProjKey] ? String(sObj[sectProjKey]) : "";
        const complTxt = projById.get(pid)?.complTxt || "";

        const pick = (obj, keys) => {
          for (const k of keys) {
            const v = obj?.[k];
            if (v !== null && v !== undefined && v !== "") return v;
          }
          return null;
        };

const totals = {
  prep: Number(pick(sObj, ["uren_wvb"]) ?? 0),
  prod: Number(pick(sObj, ["uren_prod"]) ?? 0),
  cnc:  Number(pick(sObj, ["uren_cnc", "uren_cnc_prod", "cnc_uren"]) ?? 0),
  mont: Number(pick(sObj, ["uren_montage", "uren_mont"]) ?? 0),
  reis: Number(pick(sObj, ["uren_reis", "reis_uren"]) ?? 0),
};


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


      // ✅ click op capaciteit-cel => open modal (zelfde als klik op medewerkernaam)
const capCell = ev.target.closest("td.cap-cell-click");
if (capCell) {
  const empId = String(capCell.dataset.empId || "");
  const empName = String(capCell.dataset.empName || empId);
  const dateISO = String(capCell.dataset.workDate || "");
  if (!empId || !dateISO) return;

  // hergebruik exact dezelfde flow als je cap-emp-click,
  // maar start week op basis van aangeklikte datum
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

  // ✅ start bij week van de aangeklikte datum (niet rangeStart)
  let wkStart = startOfISOWeek(parseISODate(dateISO) || new Date());

  const buildWeekDays = () => {
    const days = [];
    for (let i=0;i<7;i++) days.push(addDays(wkStart, i));
    return days;
  };

// --- helper: nette label voor chip ---
function buildPlanLabel({ pid, sid, type }) {
  const pObj = projById.get(String(pid || "")) || {};
  const nr = String(pObj.nr || "").trim();
  const nm = String(pObj.nm || "").trim();

  let sectTxt = "";
  if (sid) {
    const sObj = sectById.get(String(sid)) || {};
    const sName = String(sObj?.[sectNameKey] || sObj?.name || "").trim();
    const sNr   = String(sObj?.[sectParaKey] || sObj?.paragraph || "").trim(); // ✅ FIX
    sectTxt = [sNr, sName].filter(Boolean).join(" ").trim();
  }

  const top = [nr, nm].filter(Boolean).join(" - ").trim();
  const out = [top, sectTxt].filter(Boolean).join("\n");
  return out || (type === "montage" ? "Montage" : "Productie");
}

// --- helper: geplande items voor medewerker op datum ---
function getPlannedForEmpDate(empIdStr, dateISO) {
  const out = []; // { type:'productie'|'montage', text:string }

  // 1) sectie assignments (assignMap: sid -> dateISO -> entry)
  for (const [sid, dm] of (assignMap || new Map())) {
    const entry = dm?.get(dateISO);
    if (!entry) continue;

const emp = String(empIdStr).trim();

if (entry.productie?.has(emp)) {
  const sObj = sectById.get(String(sid));
  const pid = String(sObj?.[sectProjKey] || "").trim();
  if (pid) out.push({ type: "productie", text: buildPlanLabel({ pid, sid, type: "productie" }) });
}

if (entry.montage?.has(emp)) {
  const sObj = sectById.get(String(sid));
  const pid = String(sObj?.[sectProjKey] || "").trim();
  if (pid) out.push({ type: "montage", text: buildPlanLabel({ pid, sid, type: "montage" }) });
}
  }

  // 2) project assignments (projectAssignMap: pid -> dateISO -> entry)
  for (const [pid, dm] of (projectAssignMap || new Map())) {
    const entry = dm?.get(dateISO);
    if (!entry) continue;

    if (entry.productie?.has(empIdStr)) {
      out.push({ type: "productie", text: buildPlanLabel({ pid, sid: null, type: "productie" }) });
    }
    if (entry.montage?.has(empIdStr)) {
      out.push({ type: "montage", text: buildPlanLabel({ pid, sid: null, type: "montage" }) });
    }
  }

  // kleine dedupe (zelfde tekst/type)
  const seen = new Set();
  return out.filter(it => {
    const k = `${it.type}||${it.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}


  const renderWeek = () => {
    const days = buildWeekDays();
    const startISO = toISODate(days[0]);
    const endISO = toISODate(days[6]);

    if (subEl) subEl.textContent = `${empName} • ${startISO} t/m ${endISO}`;
    if (weekLabelEl) weekLabelEl.textContent = `Week ${weekNumberISO(days[0])}`;

    const empMap = capByEmp.get(String(empId)) || new Map();

formEl.innerHTML = `
  <div class="cap-weeklist">
    ${days.map(d => {
      const iso = toISODate(d);
      const val = Number(empMap.get(iso) || 0);

      const planned = getPlannedForEmpDate(String(empId).trim(), iso);
      const plannedHtml = planned.length
        ? planned.map(p => `
            <div class="cap-planchip ${p.type === "montage" ? "mont" : "prod"}">
              ${String(p.text).replace(/\n/g, "<br>")}
            </div>
          `).join("")
        : `<div class="cap-planempty">—</div>`;

      return `
        <div class="cap-dayrow">
          <div class="cap-left">
            <div class="cap-daylabel">${dayNameNL(d.getDay())} ${d.getDate()}-${d.getMonth()+1}</div>
            <div class="cap-hourswrap">
              <input
                class="input cap-hours"
                type="text"
                inputmode="decimal"
                pattern="[0-9]*[.,]?[0-9]*"
                data-iso="${iso}"
                value="${val ? String(val).replace(".", ",") : ""}"
                placeholder="0"
              />
            </div>
          </div>
          <div class="cap-right">${plannedHtml}</div>
        </div>
      `;
    }).join("")}
  </div>
`;

    formEl.querySelectorAll('input.input[data-iso]').forEach(inp => {
      inp.addEventListener("input", () => {
        inp.value = inp.value.replace(/[^0-9.,]/g, "");
      });
      inp.addEventListener("blur", () => {
        inp.value = inp.value.replace(".", ",");
      });
    });
  };

  btnPrevW.onclick = () => { wkStart = addDays(wkStart, -7); renderWeek(); };
  btnNextW.onclick = () => { wkStart = addDays(wkStart, +7); renderWeek(); };

  btnApplyEven.onclick = () => applyToFutureWeeks("even");
  btnApplyOdd.onclick  = () => applyToFutureWeeks("odd");
  btnApplyAll.onclick  = () => applyToFutureWeeks("all");

  const readCurrentWeekInputs = () => {
    const inputs = Array.from(formEl.querySelectorAll("input[data-iso]"));
    const values = [];
    for (const inp of inputs) {
      const raw = String(inp.value || "").trim().replace(",", ".");
      const hours = raw ? Number(raw) : 0;
      const hoursRounded = Math.round(hours * 4) / 4;
      values.push(Number.isFinite(hoursRounded) ? hoursRounded : 0);
    }
    while (values.length < 7) values.push(0);
    return values.slice(0,7);
  };

  const writeWeekToRows = (wkStartDate, values7) => {
    const rows = [];
    for (let i=0;i<7;i++){
      const iso = toISODate(addDays(wkStartDate, i));
      const h = Number(values7[i] || 0);
      if (h > 0) rows.push({ work_date: iso, werknemer_id: Number(empId), hours: h, type: "werk" });
    }
    return rows;
  };

  const applyToFutureWeeks = async (mode) => {
    const values7 = readCurrentWeekInputs();
    const today = new Date();
    const todayWkStart = startOfISOWeek(today);
    const viewEnd = addDays(new Date(rangeStart), RANGE_DAYS - 1);
    let iter = addDays(wkStart, 7);

    const allInsertRows = [];
    const deleteRanges = [];

    while (iter <= viewEnd) {
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

    if (!deleteRanges.length) { alert("Geen toekomstige weken in bereik om door te voeren."); return; }

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

    if (allInsertRows.length) {
      const ins = await sb.from("capacity_entries").insert(allInsertRows);
      if (ins.error) { alert("Fout opslaan: " + ins.error.message); return; }
    }

    //modal.close();
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
      if (h > 0) rows.push({ work_date: iso, werknemer_id: Number(empId), hours: h, type: "werk" });
    }

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
        const empMap = capByEmp.get(String(empId).trim()) || new Map();

formEl.innerHTML = `
  <div class="cap-weeklist">
    ${days.map(d => {
      const iso = toISODate(d);
      const val = Number(empMap.get(iso) || 0);

      const planned = getPlannedForEmpDate(String(empId).trim(), iso);
      const plannedHtml = planned.length
        ? planned.map(p => `
            <div class="cap-planchip ${p.type === "montage" ? "mont" : "prod"}">
              ${String(p.text).replace(/\n/g, "<br>")}
            </div>
          `).join("")
        : `<div class="cap-planempty">—</div>`;

      return `
        <div class="cap-dayrow">
          <div class="cap-left">
            <div class="cap-daylabel">${dayNameNL(d.getDay())} ${d.getDate()}-${d.getMonth()+1}</div>
            <div class="cap-hourswrap">
              <input
                class="input cap-hours"
                type="text"
                inputmode="decimal"
                pattern="[0-9]*[.,]?[0-9]*"
                data-iso="${iso}"
                value="${val ? String(val).replace(".", ",") : ""}"
                placeholder="0"
              />
            </div>
          </div>
          <div class="cap-right">${plannedHtml}</div>
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

        //modal.close();
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

        //modal.close();
        loadAndRender();
      };

      renderWeek();
      modal.wrap.classList.add("show");
      return;
    }
// ======================
// ✅ klik op project-montage regel (↳ Montage) => zelfde modal, opslaan naar project_assignments
// ======================
const ptd = ev.target.closest("td.project-montage-click");
if (ptd) {
  if (__wasDragging) return;
  const projectId = String(ptd.dataset.projectId || "");
  const dateISO   = String(ptd.dataset.workDate || "");
  if (!projectId || !dateISO) return;

  const modal = ensureAssignModal();
  modal.wrap.classList.add("show");

  // current selection uit projectAssignMap
  const cur = projectAssignMap.get(projectId)?.get(dateISO) || { productie: new Set(), montage: new Set(), dummyProd: 0, dummyMont: 0 };

  const selected = {
    productie: new Set(cur.productie),
    montage: new Set(cur.montage),
    dummyProd: Number(cur.dummyProd || 0),
    dummyMont: Number(cur.dummyMont || 0),

    subcNames: Array.isArray(cur.subcNames) ? [...cur.subcNames] : [],

  };

  for (const iid of (cur.inhuurProdIds || [])) selected.productie.add(String(iid));
  for (const iid of (cur.inhuurMontIds || [])) selected.montage.add(String(iid));

  const subEl   = modal.wrap.querySelector("#amSub");
  const listProd = modal.wrap.querySelector("#amListProd");
  const listMont = modal.wrap.querySelector("#amListMont");
  const saveBtn  = modal.wrap.querySelector("#amSave");

  if (subEl) subEl.textContent = `${dateISO} • ${projectId} • Montage (project)`;



  function renderInhuurPicker(){
  const pickInhuur = modal.wrap.querySelector("#amInhuurPick");
  if (!pickInhuur) return;

  const src = (inhuurByEmp || new Map());
  const rows = [];

  for (const [iid, dm] of src) {
    const id = String(iid);
    const hours = Number(dm?.get(dateISO) || 0);
    const name = inhuurById?.get(id)?.name || "Inhuur";

    const checked = selected.inhuurIds?.has(id);
    const shouldShow = checked || hours > 0;
    if (!shouldShow) continue;

    rows.push(`
      <label class="assign-item" style="display:flex; gap:10px; align-items:center; justify-content:space-between;">
        <span style="display:flex; gap:10px; align-items:center;">
          <input type="checkbox" class="inhuur-pick" data-iid="${escapeAttr(id)}" ${checked ? "checked" : ""} />
          <span>${escapeHtml(name)}</span>
        </span>
        <span class="muted">${hours > 0 ? (hours + "u") : ""}</span>
      </label>
    `);
  }

  pickInhuur.innerHTML = rows.length
    ? rows.join("")
    : `<div class="muted" style="padding:6px 2px;">Geen inhuur-uren beschikbaar op deze dag.</div>`;

  pickInhuur.querySelectorAll("input.inhuur-pick").forEach(chk => {
    chk.onchange = () => {
      const iid = String(chk.dataset.iid || "").trim();
      if (!iid) return;
      if (chk.checked) selected.inhuurIds.add(iid);
      else selected.inhuurIds.delete(iid);
    };
  });
}
  // hergebruik jouw bestaande renderBothLists() (zelfde als sectie)
  // TIP: haal jouw renderBothLists() functie omhoog zodat je hem 2x kunt gebruiken.
  // Snelste: kopieer renderBothLists() uit je sectie branch, en plak hem hier 1-op-1.
  const renderBothLists = () => {
    listProd.innerHTML = "";
    listMont.innerHTML = "";

    const isDummy = (eid) => String(eid) === String(DUMMY_EMP_ID);


    for (const w of werknemers || []) {
      const eid = String(w?.id ?? "").trim();
      const name = String(w?.name ?? eid).trim();
      if (!eid) continue;

      // ✅ bij projectniveau: GEEN busy filter op secties
      // (anders kun je nooit meerdere secties tegelijk plannen)
      const empCap = capByEmp.get(String(eid)) || new Map();
      const availHours = Number(empCap.get(dateISO) || 0);
      const isAvailable = isDummy(eid) ? true : (availHours > 0);

      // alleen verbergen als niet beschikbaar én niet geselecteerd (dummy nooit verbergen)
      const mustShow = selected.productie.has(eid) || selected.montage.has(eid);
      if (!isDummy(eid) && !mustShow && !isAvailable) continue;

      // ✅ Concept teller i.p.v. checkbox
      if (isDummy(eid)) {
        const rowM = document.createElement("div");
        rowM.className = "assign-item";
        rowM.style.display = "flex";
        rowM.style.justifyContent = "space-between";
        rowM.style.alignItems = "center";
rowM.innerHTML = `
  <span>${escapeHtml(name)}</span>
  <span style="display:flex; gap:6px; align-items:center;">
    <button type="button" class="btn small concept-minus">−</button>
    <span class="concept-count" style="min-width:18px; text-align:center;">${selected.dummyMont || 0}</span>
    <button type="button" class="btn small concept-plus">+</button>
  </span>
`;

const minusM = rowM.querySelector(".concept-minus");
const plusM  = rowM.querySelector(".concept-plus");
const countM = rowM.querySelector(".concept-count");


        plusM.onclick  = () => { selected.dummyMont = Number(selected.dummyMont || 0) + 1; countM.textContent = String(selected.dummyMont); };
        minusM.onclick = () => { selected.dummyMont = Math.max(0, Number(selected.dummyMont || 0) - 1); countM.textContent = String(selected.dummyMont); };

        // ✅ bij project-montage wil je eigenlijk alleen montage-kolom tonen:
        // daarom alleen in listMont plaatsen
        listMont.appendChild(rowM);
        continue;
      }

      // Montage checkbox
      const rowM = document.createElement("label");
      rowM.className = "assign-item";
      rowM.innerHTML = `
        <input type="checkbox" ${selected.montage.has(eid) ? "checked" : ""} data-eid="${escapeAttr(eid)}" data-type="montage" />
        <span>${escapeHtml(name)}</span>
      `;
      rowM.querySelector("input").onchange = (e) => {
        const id = String(e.target.dataset.eid || "");
        if (!id) return;
        if (e.target.checked) selected.montage.add(id);
        else selected.montage.delete(id);
      };
      listMont.appendChild(rowM);
    }

    // optioneel: verberg productie-kolom visueel
    listProd.innerHTML = `<div class="muted" style="padding:8px;">(n.v.t.)</div>`;
  };

  renderBothLists();

  saveBtn.onclick = async () => {
    // delete bestaande projectniveau planning voor deze dag
    const del = await sb
      .from("project_assignments")
      .delete()
      .eq("project_id", projectId)
      .eq("work_date", dateISO);

    if (del.error) { alert("Fout verwijderen: " + del.error.message); return; }

    const rows = [];

    for (const eid of selected.montage) {
      const werknemerId = Number(eid);

      if (Number.isFinite(werknemerId)) {
        rows.push({ project_id: projectId, work_date: dateISO, werknemer_id: werknemerId, work_type: "montage" });
      } else {
        rows.push({
          project_id: projectId,
          work_date: dateISO,
          werknemer_id: Number(DUMMY_EMP_ID),
          work_type: "montage",
          note: "inhuur:" + String(eid)
        });
      }
    }

    // concepten (dummy) meerdere keren opslaan
    const dummyMontCount = Number(selected.dummyMont || 0);
    for (let i = 0; i < dummyMontCount; i++) {
      rows.push({ project_id: projectId, work_date: dateISO, werknemer_id: Number(DUMMY_EMP_ID), work_type: "montage" });
    }

    if (rows.length) {
      const ins = await sb.from("project_assignments").insert(rows);
      if (ins.error) { alert("Fout opslaan: " + ins.error.message); return; }
    }

    // ✅ onderaanneming-snelkeuze meteen updaten (cache weggooien voor dit project)
    _subcSuggestCache.delete(String(projectId));

    
    modal.close();
    await loadAndRender();
  };

  return;
}
      if (__wasDragging) return;

      const td = ev.target.closest("td.section-click");
      if (!td) return;

      const sid = String(td.dataset.sectionId || "");
      const dateISO = String(td.dataset.workDate || "");
      if (!sid || !dateISO) return;

      const sObj = sectById.get(sid);
      const projectId = String(td.dataset.projectId || "");

      const modal = ensureAssignModal();
      modal.wrap.classList.add("show");

      // current selection
      const cur = assignMap.get(sid)?.get(dateISO) || {
        productie: new Set(), montage: new Set(),
        dummyProd: 0, dummyMont: 0, dummySub: 0
      };

      const selected = {
        productie: new Set(cur.productie),
        montage: new Set(cur.montage),
        dummyProd: Number(cur.dummyProd || 0),
        dummyMont: Number(cur.dummyMont || 0),

        // ✅ onderaanneming: meerdere namen
        subcNames: Array.isArray(cur.subcNames) ? [...cur.subcNames] : []
      };

      // ✅ Inhuur die in assignMap zit ook meenemen als selectie, zodat checkboxes aangevinkt zijn
      for (const iid of (cur.inhuurProdIds || [])) selected.productie.add(String(iid));
      for (const iid of (cur.inhuurMontIds || [])) selected.montage.add(String(iid));

      // ✅ snapshot: hoeveel montage stond er al op deze sectie (incl concept)
      const prevSectMontCount = (cur?.montage?.size || 0) + Number(cur?.dummyMont || 0);

      const subEl = modal.wrap.querySelector("#amSub");
      const listProd = modal.wrap.querySelector("#amListProd");
      const listMont = modal.wrap.querySelector("#amListMont");
      const saveBtn = modal.wrap.querySelector("#amSave");
      const listSubc = modal.wrap.querySelector("#amListSubc");
      const pickSubc = modal.wrap.querySelector("#amSubcPick");
      if (subEl) subEl.textContent = `${dateISO} • ${sid}`;


      const renderBothLists = () => {
        listProd.innerHTML = "";
        listMont.innerHTML = "";
        if (listSubc) listSubc.innerHTML = "";

        // ✅ Alleen "busy" in ANDERE projecten blokkeert.
        // Binnen hetzelfde project mag dezelfde medewerker op meerdere secties.
        const busySet = getBusyOtherProjects(dateISO, projectId);

        const keepVisible = new Set([
          ...Array.from(selected.productie),
          ...Array.from(selected.montage),
        ]);

        const isDummy = (eid) => String(eid) === String(DUMMY_EMP_ID);

        for (const w of werknemers || []) {
          const eid = String(w?.[empIdKey] ?? "").trim();
          const name = String(w?.[empNameKey] ?? eid).trim();
          if (!eid) continue;

          const empCap = capByEmp.get(String(eid)) || new Map();
          const availHours = Number(empCap.get(dateISO) || 0);

          const isAvailable = availHours > 0;
          const isBusy = busySet.has(eid);
          const mustShow = keepVisible.has(eid);

          // Dummy nooit verbergen; rest: alleen tonen als beschikbaar of al geselecteerd, en niet busy
          const shouldHide = (!isDummy(eid)) && (!mustShow) && (!isAvailable || isBusy);
          if (shouldHide) continue;

          
      if (isDummy(eid)) {

        // Productie concept row
        const rowP = document.createElement("div");
        rowP.className = "assign-item";
        rowP.style.display = "flex";
        rowP.style.justifyContent = "space-between";
        rowP.style.alignItems = "center";
        rowP.innerHTML = `
          <span>${escapeHtml(name)}</span>
          <span style="display:flex; gap:6px; align-items:center;">
            <button type="button" class="btn small concept-minus">−</button>
            <span class="concept-count" style="min-width:18px; text-align:center;">${Number(selected.dummyProd || 0)}</span>
            <button type="button" class="btn small concept-plus">+</button>
          </span>
        `;

        const minusP = rowP.querySelector(".concept-minus");
        const plusP  = rowP.querySelector(".concept-plus");
        const countP = rowP.querySelector(".concept-count");

        plusP.onclick = () => {
          selected.dummyProd = Number(selected.dummyProd || 0) + 1;
          countP.textContent = String(selected.dummyProd);
        };
        minusP.onclick = () => {
          selected.dummyProd = Math.max(0, Number(selected.dummyProd || 0) - 1);
          countP.textContent = String(selected.dummyProd);
        };

        listProd.appendChild(rowP);

        // Montage concept row
        const rowM = document.createElement("div");
        rowM.className = "assign-item";
        rowM.style.display = "flex";
        rowM.style.justifyContent = "space-between";
        rowM.style.alignItems = "center";
        rowM.innerHTML = `
          <span>${escapeHtml(name)}</span>
          <span style="display:flex; gap:6px; align-items:center;">
            <button type="button" class="btn small concept-minus">−</button>
            <span class="concept-count" style="min-width:18px; text-align:center;">${Number(selected.dummyMont || 0)}</span>
            <button type="button" class="btn small concept-plus">+</button>
          </span>
        `;

        const minusM = rowM.querySelector(".concept-minus");
        const plusM  = rowM.querySelector(".concept-plus");
        const countM = rowM.querySelector(".concept-count");

        plusM.onclick = () => {
          selected.dummyMont = Number(selected.dummyMont || 0) + 1;
          countM.textContent = String(selected.dummyMont);
        };
        minusM.onclick = () => {
          selected.dummyMont = Math.max(0, Number(selected.dummyMont || 0) - 1);
          countM.textContent = String(selected.dummyMont);
        };


        listMont.appendChild(rowM);

        continue; // ✅ belangrijk: geen checkbox voor concept
      }


          // --- Productie rij ---
          const rowP = document.createElement("label");
          rowP.className = "assign-item";
          rowP.innerHTML = `
            <input type="checkbox" ${selected.productie.has(eid) ? "checked" : ""} data-eid="${escapeAttr(eid)}" data-type="productie" />
            <span>${escapeHtml(name)}</span>
          `;
          rowP.querySelector("input").onchange = (e) => {
            const id = String(e.target.dataset.eid || "");
            if (!id) return;

            if (e.target.checked) {
              selected.montage.delete(id);
              const other = listMont?.querySelector(`input[data-eid="${cssEsc(id)}"]`);
              if (other) other.checked = false;
              selected.productie.add(id);
            } else {
              selected.productie.delete(id);
            }
          };
          listProd.appendChild(rowP);

          // --- Montage rij ---
          const rowM = document.createElement("label");
          rowM.className = "assign-item";
          rowM.innerHTML = `
            <input type="checkbox" ${selected.montage.has(eid) ? "checked" : ""} data-eid="${escapeAttr(eid)}" data-type="montage" />
            <span>${escapeHtml(name)}</span>
          `;
          rowM.querySelector("input").onchange = (e) => {
            const id = String(e.target.dataset.eid || "");
            if (!id) return;

            if (e.target.checked) {
              selected.productie.delete(id);
              const other = listProd?.querySelector(`input[data-eid="${cssEsc(id)}"]`);
              if (other) other.checked = false;
              selected.montage.add(id);
            } else {
              selected.montage.delete(id);
            }
          };
          listMont.appendChild(rowM);
        }

// --- Onderaanneming: snelle keuze (aanvinken) + meerdere regels (+ / ✕) ---
if (listSubc) {
  const btnAdd = modal.wrap.querySelector("#amAddSubc");

  const renderSubcList = () => {
    listSubc.innerHTML = "";

    if (!selected.subcNames) selected.subcNames = [];

    if (selected.subcNames.length === 0) {
      const hint = document.createElement("div");
      hint.className = "muted";
      hint.style.padding = "6px 2px";
      hint.textContent = "Klik op + of vink een naam aan bij Snelle keuze.";
      listSubc.appendChild(hint);
      return;
    }

    selected.subcNames.forEach((name, idx) => {
      const row = document.createElement("div");
      row.className = "assign-item";
      row.style.display = "flex";
      row.style.gap = "8px";
      row.style.alignItems = "center";

      row.innerHTML = `
        <input class="input subc-name" type="text"
          placeholder="Naam onderaannemer…"
          value="${escapeAttr(name || "")}"
          style="flex:1;"
        />
        <button type="button" class="btn small subc-del" title="Verwijderen">✕</button>
      `;

      const inp = row.querySelector("input.subc-name");
      const del = row.querySelector(".subc-del");

      inp.oninput = () => { selected.subcNames[idx] = String(inp.value || ""); };
      del.onclick = () => {
        selected.subcNames.splice(idx, 1);
        renderSubcList();
        renderSubcPicker(); // ✅ sync checkboxes
      };

      listSubc.appendChild(row);
    });
  };

  // + knop: voeg lege regel toe (bind ALTIJD opnieuw, geen _bound)
  if (btnAdd) {
    btnAdd.onclick = () => {
      if (!selected.subcNames) selected.subcNames = [];
      selected.subcNames.push("");
      renderSubcList();
      setTimeout(() => {
        const inputs = listSubc.querySelectorAll("input.subc-name");
        inputs[inputs.length - 1]?.focus();
      }, 0);
    };
  }

  // Snelle keuze (checkboxes) op basis van project-historie
  const renderSubcPicker = async () => {
    if (!pickSubc) return;

    pickSubc.innerHTML = `<div class="muted" style="padding:6px 2px;">Snelle keuze laden…</div>`;

    const suggestions = await fetchSubcSuggestionsForProject(
      projectId,
      sectiesByProject,
      sectIdKey,
      sectLookup
    );

    if (!suggestions.length) {
      pickSubc.innerHTML = `<div class="muted" style="padding:6px 2px;">Geen eerdere onderaannemers in dit project.</div>`;
      return;
    }

    // huidige selectie (trim + unique)
    const curSet = new Set((selected.subcNames || []).map(x => String(x || "").trim()).filter(Boolean));

    pickSubc.innerHTML = `
      <div class="muted" style="margin-bottom:6px;">Snelle keuze (vink aan):</div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        ${suggestions.map(nm => {
          const checked = curSet.has(nm) ? "checked" : "";
          return `
            <label class="assign-item" style="display:flex; gap:10px; align-items:center;">
              <input type="checkbox" class="subc-pick" data-name="${escapeAttr(nm)}" ${checked} />
              <span>${escapeHtml(nm)}</span>
            </label>
          `;
        }).join("")}
      </div>
    `;

    // bind changes
    pickSubc.querySelectorAll("input.subc-pick").forEach(chk => {
      chk.onchange = () => {
        const nm = String(chk.dataset.name || "").trim();
        if (!nm) return;

        if (!selected.subcNames) selected.subcNames = [];
        const set = new Set(selected.subcNames.map(x => String(x || "").trim()).filter(Boolean));

        if (chk.checked) set.add(nm);
        else set.delete(nm);

        selected.subcNames = [...set]; // unique
        renderSubcList();
      };
    });
  };

  // init
  renderSubcList();
  renderSubcPicker(); // async
  renderInhuurPickerTo(modal.wrap, selected, dateISO, inhuurByEmp, inhuurById);
}

      };
      
      renderBothLists();
 
      saveBtn.onclick = async () => {
        // delete existing for this section+day
        const del = await sb
          .from("section_assignments")
          .delete()
          .eq("section_id", sid)
          .eq("work_date", dateISO);

        if (del.error) { alert("Fout verwijderen: " + del.error.message); return; }



      const rows = [];

      // ✅ Productie: echte medewerker (nummer) of inhuur (tekst/uuid)
      for (const eid of selected.productie) {
        const werknemerId = Number(eid);

        if (Number.isFinite(werknemerId)) {
          rows.push({ section_id: sid, work_date: dateISO, werknemer_id: werknemerId, work_type: "productie" });
        } else {
          // inhuur -> opslaan als dummy met herkenbare note
          rows.push({
            section_id: sid,
            work_date: dateISO,
            werknemer_id: Number(DUMMY_SEC_ID),
            work_type: "productie",
            note: "inhuur:" + String(eid)
          });
        }
      }

      // ✅ Montage: echte medewerker (nummer) of inhuur (tekst/uuid)
      for (const eid of selected.montage) {
        const werknemerId = Number(eid);

        if (Number.isFinite(werknemerId)) {
          rows.push({ section_id: sid, work_date: dateISO, werknemer_id: werknemerId, work_type: "montage" });
        } else {
          // inhuur -> opslaan als dummy met herkenbare note
          rows.push({
            section_id: sid,
            work_date: dateISO,
            werknemer_id: Number(DUMMY_SEC_ID),
            work_type: "montage",
            note: "inhuur:" + String(eid)
          });
        }
      }

            // ✅ Concepten (dummy) als meerdere regels opslaan
      const dummyProdCount = Number(selected.dummyProd || 0);
      const dummyMontCount = Number(selected.dummyMont || 0);

      for (let i = 0; i < dummyProdCount; i++) {
        rows.push({ section_id: sid, work_date: dateISO, werknemer_id: Number(DUMMY_SEC_ID), work_type: "productie" });
      }
      for (let i = 0; i < dummyMontCount; i++) {
        rows.push({ section_id: sid, work_date: dateISO, werknemer_id: Number(DUMMY_SEC_ID), work_type: "montage" });
      }
      // ✅ Onderaanneming: lees ALLE inputs uit de modal (betrouwbaar, ook bij meerdere)
      const subcNames = Array.from(modal.wrap.querySelectorAll("#amListSubc input.subc-name"))
        .map(inp => String(inp.value || "").trim())
        .filter(Boolean);

      for (const nm of subcNames) {
        rows.push({
          section_id: sid,
          work_date: dateISO,
          werknemer_id: Number(DUMMY_SEC_ID),
          work_type: "onderaanneming",
          note: nm
        });

      }

if (rows.length) {
  const ins = await sb.from("section_assignments").insert(rows);
  if (ins.error) { alert("Fout opslaan: " + ins.error.message); return; }
}

// ✅ onderaanneming-snelkeuze meteen updaten voor dit project
const pidKey = String(projectId || "").trim();
if (pidKey) {
  const existing = _subcSuggestCache.get(pidKey) || [];
  const merged = [...new Set([...existing, ...subcNames])]
    .filter(Boolean)
    .map(s => String(s).trim())
    .filter(Boolean)
    .sort((a,b)=>a.localeCompare(b, "nl"));
  _subcSuggestCache.set(pidKey, merged);
}

const newSectMontCount = Number(selected.montage.size || 0) + Number(dummyMontCount || 0);
const deltaMont = newSectMontCount - Number(prevSectMontCount || 0);

console.log("[sectie-save] prevSectMontCount:", prevSectMontCount);
console.log("[sectie-save] newSectMontCount :", newSectMontCount);
console.log("[sectie-save] deltaMont        :", deltaMont, { projectId, dateISO, sid });


console.log("DBG deltaMont:", {
  sid, projectId, dateISO,
  prevSectMontCount,
  newSectMontCount,
  deltaMont
});

await dbgProjectDummyMontageCount(projectId, dateISO);






modal.close();
loadAndRender();


      };
    };

  function toggleProject(pid, forceOpen = null){
    const btn = gridEl.querySelector(`.expander[data-proj="${cssEsc(pid)}"]`);
    if (!btn) return;

    const open = (forceOpen !== null) ? forceOpen : !btn.classList.contains("open");

    btn.classList.toggle("open", open);
    btn.textContent = open ? "▼" : "▶";

    // ✅ projectregel highlighten als open
    const projRow = btn.closest("tr");
    if (projRow) projRow.classList.toggle("is-open", open);


    gridEl.querySelectorAll("tr.section-row, tr.section-details-row").forEach(tr => {
      if (String(tr.dataset.parent || "") === pid) {
        tr.classList.toggle("hidden", !open);
        applyZebraVisible();


        if (!open && tr.classList.contains("section-details-row")) {
          tr.classList.add("hidden");
        }
      }
    });

    if (!open) {
      gridEl.querySelectorAll(`tr.section-row[data-parent="${cssEsc(pid)}"] .expander-sec`).forEach(b => {
        b.textContent = "▶";
      });

      applyZebraVisible();

    }
  }


  gridEl.querySelectorAll('.expander[data-proj]').forEach(btn => {
    btn.addEventListener("click", () => {
      toggleProject(String(btn.dataset.proj || ""));
    });
  });




  function bindExpandersAndClicks(){

  // Project expander
  gridEl.querySelectorAll('.expander[data-proj]').forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      toggleProject(String(btn.dataset.proj || ""));
      applyZebraVisible();
    });
  });

  // Sectie expander
  gridEl.querySelectorAll(".expander-sec").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const sid = String(btn.dataset.sect || "");
      const parentTr = btn.closest("tr");
      const pid = String(parentTr?.dataset?.parent || "");
      if (!sid || !pid) return;

      const open = btn.textContent !== "▼";
      btn.textContent = open ? "▼" : "▶";

      gridEl.querySelectorAll(
        `tr.order-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"]`
      ).forEach(r => r.classList.toggle("hidden", !open));

      // als sectie dicht gaat: ook order-lines verbergen + pijltjes reset
      if (!open) {
        gridEl.querySelectorAll(
          `tr.order-line-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"]`
        ).forEach(r => r.classList.add("hidden"));

        gridEl.querySelectorAll(
          `.expander-order[data-sect="${cssEsc(sid)}"]`
        ).forEach(b => b.textContent = "▶");
      }

      applyZebraVisible();
    });
  });

  // Order expander: toont order-line-rijen
  gridEl.querySelectorAll(".expander-order").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const sid = String(btn.dataset.sect || "");
      const bn  = String(btn.dataset.orderbn || "");
      const tr  = btn.closest("tr");
      const pid = String(tr?.dataset?.parent || "");
      if (!sid || !bn || !pid) return;

      const open = btn.textContent !== "▼";
      btn.textContent = open ? "▼" : "▶";

      gridEl.querySelectorAll(
        `tr.order-line-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"][data-order-bn="${cssEsc(bn)}"]`
      ).forEach(r => r.classList.toggle("hidden", !open));

      applyZebraVisible();
    });
  });

  // Capaciteit expander
  gridEl.querySelectorAll(".cap-expander").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const key = String(btn.dataset.cap || "");
      const open = btn.classList.toggle("open");
      btn.textContent = open ? "▼" : "▶";
      toggleRowsByKey(key, open);
      applyZebraVisible();
    });
  });

  // Eén centrale click handler (die had je al) mag blijven,
  // MAAR: haal hieruit elke restoreOpenState() weg.
}



    // ✅ maak context globaal beschikbaar voor modals
    window.__plannerCtx = {
      projMetaById,
      sectById,

      // keys
      sectProjKey,
      sectNameKey,
      sectParaKey,

      // planning maps
      assignMap,
      projectAssignMap,

      // ✅ beschikbaarheid
      capByEmp,
      inhuurByEmp,
      inhuurById, // (handig, maar niet verplicht)
    };


    // mount
    gridEl.innerHTML = "";
    gridEl.appendChild(table);
    applyMiniHoursOverrunColors(gridEl);

    const btnHoursCol = gridEl.querySelector("#btnHoursCol");
    if (btnHoursCol) {
      btnHoursCol.onclick = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        hoursColOpen = !hoursColOpen;
        loadAndRender();
      };
    }



function bindHoverTips(){
  const tip = ensureHoverTip();

  const show = (text, x, y) => {
    tip.textContent = text;
    tip.style.left = (x + 12) + "px";
    tip.style.top  = (y + 12) + "px";
    tip.style.display = "block";
  };

  const hide = () => { tip.style.display = "none"; };

  // eerst eventuele oude listeners verwijderen (simpel: vlag)
  if (gridEl._hoverTipsBound) return;
  gridEl._hoverTipsBound = true;

  gridEl.addEventListener("pointerover", (e) => {
    const td = e.target.closest("td.section-click");
    if (!td) return;

    const t = String(td.dataset.tip || "").trim();
    if (!t) return;

    show(t, e.clientX, e.clientY);
  }, true);

  gridEl.addEventListener("pointermove", (e) => {
    if (tip.style.display === "block") {
      tip.style.left = (e.clientX + 12) + "px";
      tip.style.top  = (e.clientY + 12) + "px";
    }
  }, true);

  gridEl.addEventListener("pointerout", (e) => {
    if (e.target.closest("td.section-click")) hide();
  }, true);

  // safety: bij scroll/escape ook weg
  window.addEventListener("scroll", hide, true);
  document.addEventListener("keydown", (ev)=>{ if(ev.key === "Escape") hide(); });
}

    bindExpandersAndClicks();
    applyZebraVisible();
    wireDragDrop(gridEl);
    bindHoverTips(); 
    restoreOpenState();

  

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
  function isCncType(t){ const s=String(t||"").toLowerCase(); return s.includes("cnc"); }
  function isReisType(t){ const s=String(t||"").toLowerCase(); return s.includes("reis") || s.includes("travel") || s.includes("rit"); }

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

  const tdLeft = document.createElement("td");
  tdLeft.className = "rowhdr sticky-left";
  tdLeft.textContent = "";
  tr.appendChild(tdLeft);

  // ✅ uren-kolom placeholder
  const tdHours = document.createElement("td");
  tdHours.className = "cell hourscol sticky-left2";
  tdHours.style.left = "380px";
  if (!hoursColOpen) tdHours.style.display = "none";
  tdHours.innerHTML = "";
  tr.appendChild(tdHours);

  // ✅ dagen vullen
  const td2 = document.createElement("td");
  td2.colSpan = cols;                // <-- alleen dagen
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

  // ✅ uren-kolom placeholder
  const tdHours = document.createElement("td");
  tdHours.className = "cell hourscol sticky-left2";
  tdHours.style.left = "380px";
  if (!hoursColOpen) tdHours.style.display = "none";
  tdHours.innerHTML = "";
  tr.appendChild(tdHours);

  // ✅ dagen fill
  const fill = document.createElement("td");
  fill.colSpan = cols;               // <-- alleen dagen
  fill.className = "cell block-fill";
  tr.appendChild(fill);

  return tr;
}


    function labelRow(label, dates, byDay, kind = "") {
      const tr = document.createElement("tr");
      tr.className = `sum-row ${kind ? "planned-row " + kind : ""}`.trim();

      tr.appendChild(leftRowHdrCell(label, "sticky-left sum-label"));

      // uren-kolom placeholder
      const hoursTd = document.createElement("td");
      hoursTd.className = "cell hourscol sticky-left2";
      hoursTd.style.left = "380px";
      if (!hoursColOpen) hoursTd.style.display = "none";
      hoursTd.innerHTML = "";
      tr.appendChild(hoursTd);


      for (const d of dates) {
        const iso = toISODate(d);
        const h = Number(byDay?.[iso] || 0);

        const td = document.createElement("td");

        // basis: zelfde structuur als nu, maar zonder “altijd geel” via CSS override
        td.className = `cell sum-cell ${isWeekend(d) ? "wknd" : ""}`.trim();

        // ✅ kleur alleen als er waarde is
        if (h > 0 && kind) td.classList.add("has-val");

        td.textContent = fmt0(h);
        tr.appendChild(td);
      }

      return tr;
    }

function infoRow(text, cols){
  const tr = document.createElement("tr");
  tr.className = "info-row";

  tr.appendChild(leftRowHdrCell(text, "sticky-left info-left"));

  // ✅ uren-kolom placeholder
  const hoursTd = document.createElement("td");
  hoursTd.className = "cell hourscol sticky-left2";
  hoursTd.style.left = "380px";
  if (!hoursColOpen) hoursTd.style.display = "none";
  hoursTd.innerHTML = "";
  tr.appendChild(hoursTd);

  // ✅ dagen fill
  const td = document.createElement("td");
  td.colSpan = cols;
  td.className = "cell info-cell";
  td.textContent = "";
  tr.appendChild(td);

  return tr;
}

  function balanceRow(label, dates, byDay){
    const tr = document.createElement("tr");
    tr.className = "balance-row";
    tr.appendChild(leftRowHdrCell(label, "sticky-left balance-label"));

    // uren-kolom placeholder
    const hoursTd = document.createElement("td");
    hoursTd.className = "cell hourscol sticky-left2";
    hoursTd.style.left = "380px";
    if (!hoursColOpen) hoursTd.style.display = "none";
    hoursTd.innerHTML = "";
    tr.appendChild(hoursTd);


    for(const d of dates){
      const iso = toISODate(d);
      const v = Number(byDay?.[iso] || 0);

      const td = document.createElement("td");
      td.className = `cell balance-cell ${isWeekend(d) ? "wknd" : ""}`;

      // status op basis van resultaat
      const eps = 0.001; // tolerant voor -0.00001 etc.
      if (v > eps) td.classList.add("pos");
      else if (v < -eps) td.classList.add("neg");
      else td.classList.add("zero");

      td.textContent = fmt0(v);
      tr.appendChild(td);
    
    }
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

function buildPlanLabelFromCtx(ctx, { pid, sid }) {
  const p = ctx?.projMetaById?.get(String(pid)) || {};
  const top = [p.nr, p.nm].filter(Boolean).join(" - ");

  let sectTxt = "";
  if (sid) {
    const sObj = ctx?.sectById?.get(String(sid)) || {};
    const sNr  = String(sObj?.[ctx.sectParaKey] ?? "").trim();   // bv "03."
    const sNm  = String(sObj?.[ctx.sectNameKey] ?? sObj?.name ?? "").trim();
    sectTxt = [sNr, sNm].filter(Boolean).join(" ");
  }

  return [top, sectTxt].filter(Boolean).join("\n");
}

function getPlannedForInhuurDate(inhuurIdStr, dateISO) {
  const ctx = window.__plannerCtx;
  if (!ctx) return [];

  const iid = String(inhuurIdStr || "").trim();
  const iso = String(dateISO || "").trim();
  const out = [];

  // 1) sectie-niveau: section_assignments -> assignMap (inhuurProdIds / inhuurMontIds)
  for (const [sid, dm] of (ctx.assignMap || new Map())) {
    const entry = dm?.get(iso);
    if (!entry) continue;

    const sObj = ctx.sectById.get(String(sid));
    const pid = String(sObj?.[ctx.sectProjKey] || "").trim();
    if (!pid) continue;

    if (entry.inhuurProdIds?.has(iid)) {
      out.push({ type: "productie", text: buildPlanLabelFromCtx(ctx, { pid, sid }) });
    }
    if (entry.inhuurMontIds?.has(iid)) {
      out.push({ type: "montage", text: buildPlanLabelFromCtx(ctx, { pid, sid }) });
    }
  }

  // 2) project-niveau: project_assignments -> projectAssignMap (inhuurProdIds / inhuurMontIds)
  for (const [pid, dm] of (ctx.projectAssignMap || new Map())) {
    const entry = dm?.get(iso);
    if (!entry) continue;

    if (entry.inhuurProdIds?.has(iid)) {
      out.push({ type: "productie", text: buildPlanLabelFromCtx(ctx, { pid, sid: null }) });
    }
    if (entry.inhuurMontIds?.has(iid)) {
      out.push({ type: "montage", text: buildPlanLabelFromCtx(ctx, { pid, sid: null }) });
    }
  }

  // dedupe
  const seen = new Set();
  return out.filter(x => {
    const k = `${x.type}||${x.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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
    applyZebraVisible();
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

function appendProjectDayCells(tr, dates, labels, markerISO = "", deliveryISO = "", assignByDay = {}) {

  // bepaal per dag: welke "bar-status" is dit?
  const keys = dates.map((d, i) => {
    const iso = toISODate(d);
    const prod = Number(assignByDay?.[iso]?.prod || 0);
    const mont = Number(assignByDay?.[iso]?.mont || 0);


    const label = labels[i] || "";

    if (prod > 0 && mont > 0) return "both";
    if (prod > 0) return "prod";
    if (mont > 0) return "mont";
    if (label) return `lbl:${label}`;
    return "";
  });

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const iso = toISODate(d);

    const prod = Number(assignByDay?.[iso]?.prod || 0);
    const mont = Number(assignByDay?.[iso]?.mont || 0);
    const label = labels[i] || "";

    const key = keys[i];
    const prevKey = (i > 0) ? keys[i - 1] : "";
    const nextKey = (i < keys.length - 1) ? keys[i + 1] : "";

    const isMarker = markerISO && iso === markerISO;
    const isDelivery = deliveryISO && iso === deliveryISO;


    const td = document.createElement("td");
    // ✅ project scheidingslijnen op TD (altijd zichtbaar)
    if (tr.classList.contains("project-topline")) td.classList.add("project-topline-cell");
    if (tr.classList.contains("project-bottomline")) td.classList.add("project-bottomline-cell");

    td.dataset.proj = tr.querySelector(".expander")?.dataset?.proj || "";

    // cel-kleur
    let cls = `cell plan-cell ${isWeekend(d) ? "wknd" : ""}`.trim();
    if (key === "both") cls += " bar-both";
    else if (key === "prod") cls += " bar-prod";
    else if (key === "mont") cls += " bar-mont";
    else if (key.startsWith("lbl:")) cls += ` ${barClass(label)}`;
    td.className = cls;

    let html = `<div class="plan-stack">`;

    // markers samen op 1 regel
    html += `<div class="marker-row">`;
    html += isDelivery
      ? `<div class="marker delivery"></div>`
      : `<div class="marker delivery placeholder">lever</div>`;
    html += isMarker
      ? `<div class="marker deadline" title="${iso}"></div>`
      : `<div class="marker deadline placeholder">oplever</div>`;

    html += `</div>`;



    // bars: toon prod en/of mont als eigen blok (stacked)
    if (key) {
      const isStart = key !== prevKey;
      const isEnd = key !== nextKey;

      const startCls = isStart ? " bar-start" : "";
      const endCls = isEnd ? " bar-end" : "";

      const dummyProd = !!assignByDay?.[iso]?.dummyProd;
      const dummyMont = !!assignByDay?.[iso]?.dummyMont;

    if (key === "both") {
      const prodTxt = prod > 0 ? String(prod) : "&nbsp;";
      const montTxt = mont > 0 ? String(mont) : "&nbsp;";

      html += `<div class="bar bar-prod${startCls}${endCls}${dummyProd ? " dummy-hatch" : ""}">${prodTxt}</div>`;
      html += `<div class="bar bar-mont${startCls}${endCls}${dummyMont ? " dummy-hatch" : ""}">${montTxt}</div>`;
    } else if (key === "prod") {
      const prodTxt = prod > 0 ? String(prod) : "&nbsp;";
      const dummyCls = dummyProd ? " dummy-hatch" : "";
      html += `<div class="bar bar-prod${startCls}${endCls}${dummyCls}">${prodTxt}</div>`;
    } else if (key === "mont") {
      const montTxt = mont > 0 ? String(mont) : "&nbsp;";
      const dummyCls = dummyMont ? " dummy-hatch" : "";
      html += `<div class="bar bar-mont${startCls}${endCls}${dummyCls}">${montTxt}</div>`;
    } else if (key.startsWith("lbl:")) {
      // als je labels hebt (bijv. andere soorten), laat je dit staan of maak je ook een getal
      html += `<div class="bar${startCls}${endCls}">${escapeHtml(label)}</div>`;
      }
    }

    html += `</div>`;
    td.innerHTML = html;
    tr.appendChild(td);
  }
}





function appendSectionDayCells(tr, dates, labels, sectionId, projectId, assignCountByDay, assignMap, werknemers, inhuurById) {
  const empIdKey = "id";
  const empNameKey = pickKey(werknemers?.[0], ["naam","name","fullname","display_name"]);
  const empNameById = new Map((werknemers || []).map(w => [
    String(w?.[empIdKey] ?? "").trim(),
    String(w?.[empNameKey] || w?.[empIdKey] || "")
  ]));

  // keys (voor rounded start/end van prod/mont)
  const keys = dates.map((d, i) => {
    const iso = toISODate(d);
    const prod = Number(assignCountByDay?.[iso]?.prod || 0);
    const mont = Number(assignCountByDay?.[iso]?.mont || 0);
    const label = labels[i] || "";

    if (prod > 0 && mont > 0) return "both";
    if (prod > 0) return "prod";
    if (mont > 0) return "mont";
    if (label) return `lbl:${label}`;
    return "";
  });

    // ✅ alle unieke onderaannemers in deze sectie binnen dit zichtbare bereik (vaste volgorde)
    const dmSub = assignMap?.get(String(sectionId)) || new Map();
    const subcNamesAll = [...new Set(dates.flatMap(dd => {
      const iso = toISODate(dd);
      const e = dmSub.get(iso);
      return (e?.subcNames || []).map(x => String(x||"").trim()).filter(Boolean);
    }))].sort((a,b)=>a.localeCompare(b, "nl"));

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const iso = toISODate(d);

    const prod = Number(assignCountByDay?.[iso]?.prod || 0);
    const mont = Number(assignCountByDay?.[iso]?.mont || 0);
    const subc = Number(assignCountByDay?.[iso]?.subc || 0);
    const label = labels[i] || "";

    const key = keys[i];
    const prevKey = (i > 0) ? keys[i - 1] : "";
    const nextKey = (i < keys.length - 1) ? keys[i + 1] : "";

    const td = document.createElement("td");
    td.dataset.sectionId = String(sectionId || "");
    td.dataset.projectId = String(projectId || "");
    td.dataset.workDate  = iso;

    // tooltip met namen (prod/mont)
    const entry = assignMap?.get(String(sectionId))?.get(iso);
    const dummyProd = (entry?.dummyProd || 0) > 0;
    const dummyMont = (entry?.dummyMont || 0) > 0;

    if (entry) {
    const prodNames = Array.from(entry.productie || []).map(id => empNameById.get(String(id)) || String(id));
    const montNames = Array.from(entry.montage || []).map(id => empNameById.get(String(id)) || String(id));

    const inhuurProdNames = Array.from(entry.inhuurProdIds || [])
      .map(id => inhuurById?.get(String(id))?.name || String(id));

    const inhuurMontNames = Array.from(entry.inhuurMontIds || [])
      .map(id => inhuurById?.get(String(id))?.name || String(id));

    let tip = "";
    if (prodNames.length) tip += `Productie:\n- ${prodNames.join("\n- ")}`;
    if (inhuurProdNames.length) tip += (tip ? "\n\n" : "") + `Inhuur productie:\n- ${inhuurProdNames.join("\n- ")}`;

    if (montNames.length) tip += (tip ? "\n\n" : "") + `Montage:\n- ${montNames.join("\n- ")}`;
    if (inhuurMontNames.length) tip += (tip ? "\n\n" : "") + `Inhuur montage:\n- ${inhuurMontNames.join("\n- ")}`;
      if (tip) td.dataset.tip = tip;
      td.removeAttribute("title");
    }

    let cls = `cell plan-cell section-click ${isWeekend(d) ? "wknd" : ""}`.trim();
    // géén bar-prod/mont/both op de TD, alleen de bars zelf kleuren
    td.className = cls;

    // Drag&Drop metadata
    td.classList.add("dd-dropzone");
    td.dataset.ddKind = "section";
    td.dataset.ddKey  = key || "";

    const hasPlan = (prod > 0) || (mont > 0) || (subc > 0);
    if (hasPlan) {
      td.setAttribute("draggable", "true");
      td.classList.add("dd-draggable");
    } else {
      td.removeAttribute("draggable");
      td.classList.remove("dd-draggable");
    }

    // ===== HTML: vaste layout met placeholders =====
    let html = `<div class="plan-stack">`;

    // markers (vaste hoogte)
    html += `
      <div class="marker-row">
        <div class="marker delivery placeholder">lever</div>
        <div class="marker deadline placeholder">oplever</div>
      </div>
    `;

    // PROD slot
    {
      const isProd = (key === "prod" || key === "both");
      const isStart = isProd && key !== prevKey;
      const isEnd   = isProd && key !== nextKey;
      const startCls = isStart ? " bar-start" : "";
      const endCls   = isEnd   ? " bar-end"   : "";
      const dummyCls = dummyProd ? " dummy-hatch" : "";

      if (isProd) {
        const prodTxt = prod > 0 ? String(prod) : "\u00A0";
        html += `<div class="bar bar-prod${startCls}${endCls}${dummyCls}">${prodTxt}</div>`;
      } else {
        html += `<div class="bar bar-prod placeholder">\u00A0</div>`;
      }
    }

    // MONT slot
    {
      const isMont = (key === "mont" || key === "both");
      const isStart = isMont && key !== prevKey;
      const isEnd   = isMont && key !== nextKey;
      const startCls = isStart ? " bar-start" : "";
      const endCls   = isEnd   ? " bar-end"   : "";
      const dummyCls = dummyMont ? " dummy-hatch" : "";

      if (isMont) {
        const montTxt = mont > 0 ? String(mont) : "\u00A0";
        html += `<div class="bar bar-mont${startCls}${endCls}${dummyCls}">${montTxt}</div>`;
      } else {
        html += `<div class="bar bar-mont placeholder">\u00A0</div>`;
      }
    }

// SUBC slot: altijd paars, altijd onderaan, 1 bar per onderaannemer (geen "2" meer)
{
  if (subcNamesAll.length === 0) {
    // geen onderaanneming in hele range => niets renderen
  } else {
    const entryToday = assignMap?.get(String(sectionId))?.get(iso);
    const todaySet = new Set(
      (entryToday?.subcNames || []).map(x => String(x||"").trim()).filter(Boolean)
    );

    const prevISO = (i > 0) ? toISODate(dates[i-1]) : "";
    const nextISO = (i < dates.length - 1) ? toISODate(dates[i+1]) : "";

    const prevSet = new Set(
      ((assignMap?.get(String(sectionId))?.get(prevISO)?.subcNames) || [])
        .map(x => String(x||"").trim()).filter(Boolean)
    );
    const nextSet = new Set(
      ((assignMap?.get(String(sectionId))?.get(nextISO)?.subcNames) || [])
        .map(x => String(x||"").trim()).filter(Boolean)
    );

    for (const nm of subcNamesAll) {
      const has = todaySet.has(nm);

      if (!has) {
        // placeholder: houdt hoogte/uitlijning, maar geen kleur
        html += `<div class="bar bar-subc subc-ph" aria-hidden="true"></div>`;
        continue;
      }

      const isStartS = !prevSet.has(nm);
      const isEndS   = !nextSet.has(nm);

      const startClsS = isStartS ? " bar-start" : "";
      const endClsS   = isEndS   ? " bar-end"   : "";

      // tekst alleen aan begin van doorlopende reeks
      const txt = isStartS ? nm : "\u00A0";

      html += `<div class="bar bar-subc${startClsS}${endClsS}">${escapeHtml(txt)}</div>`;
    }
  }
}
    html += `</div>`; // plan-stack altijd sluiten!
    td.innerHTML = html;
    tr.appendChild(td);
  }
}

    function appendProjectMontageSummaryDayCells(tr, dates, projMontByDay = {}, projectId = "") {

      // key: wel/geen montage zodat start/einde afgerond blijft
      const keys = dates.map(d => {
        const iso = toISODate(d);
        const mont = Number(projMontByDay?.[iso]?.mont || 0);
        return mont > 0 ? "mont" : "";
      });

      for (let i = 0; i < dates.length; i++) {
        const d = dates[i];
        const iso = toISODate(d);

        const mont = Number(projMontByDay?.[iso]?.mont || 0);
        const dummyMont = !!projMontByDay?.[iso]?.dummyMont;

        const key = keys[i];
        const prevKey = (i > 0) ? keys[i - 1] : "";
        const nextKey = (i < keys.length - 1) ? keys[i + 1] : "";

        const td = document.createElement("td");
        td.className = `cell plan-cell ${isWeekend(d) ? "wknd" : ""}`.trim();
        td.classList.add("project-montage-click");
        td.dataset.projectId = String(projectId || "");
        td.dataset.workDate = iso;

        // ✅ Drag & Drop metadata
        td.classList.add("dd-dropzone");
        td.dataset.ddKind = "project-montage";

        // alleen draggable als er montage gepland is
        td.dataset.ddKey = key || "";  // bij montage is key = "mont"

        if (mont > 0) {
          td.setAttribute("draggable", "true");
          td.classList.add("dd-draggable");
        }


        let html = `<div class="plan-stack">`;

        // vaste hoogte zoals je andere cellen
        html += `<div class="marker-row">
          <div class="marker delivery placeholder">lever</div>
          <div class="marker deadline placeholder">oplever</div>
        </div>`;

        if (key) {
          const isStart = key !== prevKey;
          const isEnd   = key !== nextKey;
          const startCls = isStart ? " bar-start" : "";
          const endCls   = isEnd   ? " bar-end"   : "";
          const dummyCls = dummyMont ? " dummy-hatch" : "";

          // ✅ altijd het aantal tonen (niet "mon" en niet alleen bij start)
          html += `<div class="bar bar-mont${startCls}${endCls}${dummyCls}">${mont}</div>`;
        }

        html += `</div>`;
        td.innerHTML = html;
        tr.appendChild(td);
      }
    }


function appendOrderDayCells(tr, dates, leverISO, sectionIds, assignMap){
  const isTop = tr.classList.contains("order-topline");
  const isBottom = tr.classList.contains("order-bottomline");

  const sectionList = (sectionIds || []).map(x => String(x));

  function getSectionPlanned(iso){
    let prod = 0, mont = 0, dummyProd = false, dummyMont = false;

    for (const sid of sectionList){
      const e = assignMap?.get(String(sid))?.get(iso);
      if (!e) continue;

      prod += (e.productie?.size || 0) + (e.dummyProd || 0);
      mont += (e.montage?.size || 0)  + (e.dummyMont || 0);

      if ((e.dummyProd || 0) > 0) dummyProd = true;
      if ((e.dummyMont || 0) > 0) dummyMont = true;
    }

    return { prod, mont, dummyProd, dummyMont };
  }

  // keys op basis van section_assignments (som van meegegeven secties)
  const keys = dates.map(d => {
    const iso = toISODate(d);
    const sums = getSectionPlanned(iso);

    if (sums.prod > 0 && sums.mont > 0) return "both";
    if (sums.prod > 0) return "prod";
    if (sums.mont > 0) return "mont";
    return "";
  });

  for (let i=0;i<dates.length;i++){
    const d = dates[i];
    const iso = toISODate(d);

    const key = keys[i];
    const prevKey = (i>0) ? keys[i-1] : "";
    const nextKey = (i<keys.length-1) ? keys[i+1] : "";

    const sums = getSectionPlanned(iso);
    const dummyProd = !!sums.dummyProd;
    const dummyMont = !!sums.dummyMont;

    const td = document.createElement("td");
    td.className = `cell plan-cell ${isWeekend(d) ? "wknd" : ""}`.trim();

    if (isTop) td.classList.add("order-topline-cell");
    if (isBottom) td.classList.add("order-bottomline-cell");

    // basis kleur op type
    if (key === "both") td.classList.add("bar-both");
    else if (key === "prod") td.classList.add("bar-prod");
    else if (key === "mont") td.classList.add("bar-mont");

    let html = `<div class="plan-stack">`;

    // lever marker
    if (leverISO && iso === leverISO) {
      html += `<div class="bar bar-order">lever</div>`;
    }

    // projectniveau balkjes: toon aantallen, met start/einde afronding
    if (key) {
      const isStart = key !== prevKey;
      const isEnd   = key !== nextKey;
      const startCls = isStart ? " bar-start" : "";
      const endCls   = isEnd   ? " bar-end"   : "";

      const prodCnt = sums.prod;
      const montCnt = sums.mont;

      if (key === "both") {
        html += `<div class="bar bar-prod${startCls}${endCls}${dummyProd ? " dummy-hatch" : ""}">${prodCnt || "&nbsp;"}</div>`;
        html += `<div class="bar bar-mont${startCls}${endCls}${dummyMont ? " dummy-hatch" : ""}">${montCnt || "&nbsp;"}</div>`;
      } else if (key === "prod") {
        html += `<div class="bar bar-prod${startCls}${endCls}${dummyProd ? " dummy-hatch" : ""}">${prodCnt || "&nbsp;"}</div>`;
      } else if (key === "mont") {
        html += `<div class="bar bar-mont${startCls}${endCls}${dummyMont ? " dummy-hatch" : ""}">${montCnt || "&nbsp;"}</div>`;
      }
    }

    html += `</div>`;
    td.innerHTML = html;
    tr.appendChild(td);
  }
}


async function removeOneProjectDummyMontage(projectId, dateISO) {
  // 1 dummy regel verwijderen (als die bestaat)
  const { data, error } = await sb
    .from("project_assignments")
    .select("id")
    .eq("project_id", projectId)
    .eq("work_date", dateISO)
    .eq("work_type", "montage")
    .eq("werknemer_id", DUMMY_EMP_ID)
    .limit(1);

  if (error) {
    console.warn("removeOneProjectDummyMontage select error:", error.message);
    return;
  }

  const id = data?.[0]?.id;
  if (!id) return; // niks om te verwijderen

  const del = await sb.from("project_assignments").delete().eq("id", id);
  if (del.error) console.warn("removeOneProjectDummyMontage delete error:", del.error.message);
}

async function addOneProjectDummyMontage(projectId, dateISO) {
  const ins = await sb.from("project_assignments").insert([{
    project_id: String(projectId),
    work_date: String(dateISO),
    werknemer_id: DUMMY_EMP_ID,      // ✅ geen Number()
    work_type: "montage",
  }]);

  if (ins.error) console.warn("addOneProjectDummyMontage insert error:", ins.error.message);
}


async function dbgProjectDummyMontageCount(projectId, dateISO){
  const { data, error } = await sb
    .from("project_assignments")
    .select("id, werknemer_id, work_type")
    .eq("project_id", String(projectId))
    .eq("work_date", String(dateISO))
    .eq("werknemer_id", DUMMY_EMP_ID)



  if (error) {
    console.error("DBG project_assignments select error:", error.message);
    return null;
  }

  const rows = data || [];
  const byType = rows.reduce((acc, r) => {
    const t = String(r.work_type || "").toLowerCase();
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});

  console.log("DBG project dummy rows:", {
    projectId, dateISO,
    totalDummy: rows.length,
    byType
  });

  return { total: rows.length, byType };
}




function renderOrdersAccordion(byBN){
  if(!byBN || !byBN.size) return `<div class="muted" style="padding:6px 0;">Geen bestellingen</div>`;

  let html = `<div class="orders-acc">`;

  for(const [bn, rows] of byBN){
    const ld = rows.map(x=>x.leverdatum).find(Boolean);
    const ldTxt = ld ? formatDateNL(ld) : "";

    html += `
      <div class="order-card">
        <button class="order-head" type="button">
          <div>${escapeHtml(bn)}</div>
          <div class="order-head-right">
            <div>${escapeHtml(ldTxt)}</div>
            <div class="order-arrow">▾</div>
          </div>
        </button>
        <div class="order-body" hidden>
          ${rows.map(r=>`
            <div class="order-line">
              <div><b>${escapeHtml(r.aantal ?? 1)}</b> — ${escapeHtml(r.omschrijving || "")}</div>
              <div class="ol-meta">${escapeHtml(r.leverancier || "")}${r.leverancier && r.soort ? " • " : ""}${escapeHtml(r.soort || "")}</div>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  html += `</div>`;
  return html;
}

function fmt0(n){
  const v = Number(n || 0);
  return (Math.abs(v) < 0.0001) ? "" : formatHoursCell(v);
}

function miniHoursHtml(req, pl){
  // req/pl zijn getallen
  const f = (n) => escapeHtml(formatHoursCell(Number(n || 0)));

  const limits = {
    // Productie gebruikt productie + cnc uit bronuren
    prod: Number(req.prod || 0) + Number(req.cnc || 0),
    cnc: Number(req.cnc || 0),
    // Montage gebruikt montage + reis uit bronuren
    mont: Number(req.mont || 0) + Number(req.reis || 0),
    reis: Number(req.reis || 0),
  };

  const over = {
    prod: Number(pl.prod || 0) > limits.prod,
    cnc: Number(pl.cnc || 0) > limits.cnc,
    mont: Number(pl.mont || 0) > limits.mont,
    reis: Number(pl.reis || 0) > limits.reis,
  };

  const clsPl = (isOver) => isOver ? "mh-v2 mh-over" : "mh-v2";

  return `
    <div class="mini-hours">
      <div class="mh-row"><span class="mh-l">Prod.</span><span class="mh-v">${f(req.prod)}</span><span class="mh-sep">|</span><span class="${clsPl(over.prod)}">${f(pl.prod)}</span></div>
      <div class="mh-row"><span class="mh-l">CNC</span><span class="mh-v">${f(req.cnc)}</span><span class="mh-sep">|</span><span class="${clsPl(over.cnc)}">${f(pl.cnc)}</span></div>
      <div class="mh-row"><span class="mh-l">Mont.</span><span class="mh-v">${f(req.mont)}</span><span class="mh-sep">|</span><span class="${clsPl(over.mont)}">${f(pl.mont)}</span></div>
      <div class="mh-row"><span class="mh-l">Reis</span><span class="mh-v">${f(req.reis)}</span><span class="mh-sep">|</span><span class="${clsPl(over.reis)}">${f(pl.reis)}</span></div>
    </div>
  `;
}



function applyMiniHoursOverrunColors(root){
  const parse = (v) => {
    const s = String(v ?? "").trim();
    if (!s) return 0;
    const n = Number(s.replace(/\./g, "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };

  (root || document).querySelectorAll(".mini-hours .mh-row").forEach((row) => {
    const leftEl = row.querySelector(".mh-v");
    const rightEl = row.querySelector(".mh-v2");
    if (!leftEl || !rightEl) return;

    const isOver = parse(rightEl.textContent) > parse(leftEl.textContent);
    rightEl.classList.toggle("mh-over", isOver);

    if (isOver) {
      rightEl.style.setProperty("color", "#b42318", "important");
      rightEl.style.setProperty("font-weight", "700", "important");
    } else {
      rightEl.style.removeProperty("color");
      rightEl.style.removeProperty("font-weight");
    }
  });
}

// ======================
// DRAG & DROP (planned days)
// ======================

function wireDragDrop(root){
  if (!root) return;

  // DRAG START / END
  root.querySelectorAll("td.dd-draggable[draggable='true']").forEach(td => {

    td.addEventListener("dragstart", (e) => {
      __wasDragging = true;

      const kind = String(td.dataset.ddKind || "");
      const fromDate = String(td.dataset.workDate || "");

      let fromStart = fromDate;
      let fromEnd   = fromDate;

      // ✅ ALT = hele run pakken
      if (e.altKey) {
        const run = getContiguousRunFromCell(td);
        fromStart = run.startISO;
        fromEnd   = run.endISO;
      }

      const payload = {
        kind,
        sectionId: td.dataset.sectionId || "",
        projectId: td.dataset.projectId || "",
        fromDate,
        fromStart,
        fromEnd,
        isRange: !!e.altKey
      };

      // ✅ belangrijker voor betrouwbare drop
      e.dataTransfer.setData("application/json", JSON.stringify(payload));
      e.dataTransfer.setData("text/plain", "1");
      e.dataTransfer.effectAllowed = "move";

      td.classList.add("is-dragging");
    });

    td.addEventListener("dragend", () => {
      td.classList.remove("is-dragging");
      setTimeout(() => { __wasDragging = false; }, 150);
    });
  });

  // DROPZONES
  root.querySelectorAll("td.dd-dropzone").forEach(cell => {

    cell.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      cell.classList.add("is-drop-target");
    });

    cell.addEventListener("dragleave", () => {
      cell.classList.remove("is-drop-target");
    });

    cell.addEventListener("drop", async (e) => {
      e.preventDefault();
      cell.classList.remove("is-drop-target");

      let payload;
      try {
        payload = JSON.parse(e.dataTransfer.getData("application/json"));
      } catch {
        return;
      }

      const toDate = String(cell.dataset.workDate || "");
      const kind = String(payload.kind || "");
      const fromDate = String(payload.fromDate || "");

      // ✅ alleen droppen op dezelfde soort cel
      const targetKind = String(cell.dataset.ddKind || "");
      if (!targetKind || targetKind !== kind) {
        console.log("DROP ignored: kind mismatch", { kind, targetKind });
        return;
      }

      if (!toDate || !fromDate || toDate === fromDate) return;

      if (kind === "section") {
        const fromSid = String(payload.sectionId || "");
        const toSid   = String(cell.dataset.sectionId || "");
        if (!fromSid || !toSid || fromSid !== toSid) return;

        if (payload.isRange) {
          const startISO = String(payload.fromStart || fromDate);
          const endISO   = String(payload.fromEnd   || fromDate);
          const delta    = daysBetweenISO(startISO, toDate);
          await moveSectionRange(fromSid, startISO, endISO, delta);
        } else {
          await moveSectionDay(fromSid, fromDate, toDate);
        }

        loadAndRender();
        return;
      }

      if (kind === "project-montage") {
        const fromPid = String(payload.projectId || "");
        const toPid   = String(cell.dataset.projectId || "");
        if (!fromPid || !toPid || fromPid !== toPid) return;

        if (payload.isRange) {
          const startISO = String(payload.fromStart || fromDate);
          const endISO   = String(payload.fromEnd   || fromDate);
          const delta    = daysBetweenISO(startISO, toDate);
          await moveProjectMontageRange(fromPid, startISO, endISO, delta);
        } else {
          await moveProjectMontageDay(fromPid, fromDate, toDate);
        }

        loadAndRender();
        return;
      }
    });
  });
}




async function moveSectionDay(sectionId, fromDate, toDate){
  const sid = String(sectionId || "").trim();
  const f = String(fromDate || "").trim();
  const t = String(toDate || "").trim();
  if (!sid || !f || !t || f === t) return;

  // 1) haal bestaande regels op (zodat we ze 1-op-1 kunnen kopiëren)
  const { data: rows, error: selErr } = await sb
    .from("section_assignments")
    .select("id, section_id, werknemer_id, work_type, note")
    .eq("section_id", sid)
    .eq("work_date", f);

  if (selErr) {
    alert("Select fout: " + selErr.message);
    return;
  }

  if (!rows || rows.length === 0) {
    alert("Er is niets verplaatst (0 regels).");
    return;

  }
pushUndo({
  kind: "section",
  section_id: sectionId,
  from_date: fromDate,
  to_date: toDate,
  rows: rows.map(r => ({ werknemer_id: r.werknemer_id, work_type: r.work_type }))
});

  // 2) delete oude dag
  const { error: delErr } = await sb
    .from("section_assignments")
    .delete()
    .eq("section_id", sid)
    .eq("work_date", f);

  if (delErr) {
    alert("Delete fout: " + delErr.message);
    return;
  }

  // 3) insert nieuwe dag
const newRows = rows.map(r => ({
  section_id: r.section_id,
  work_date: t,
  werknemer_id: r.werknemer_id,
  work_type: r.work_type,
  note: r.note || null
}));

  const { error: insErr } = await sb
    .from("section_assignments")
    .insert(newRows);

  if (insErr) {
    alert("Insert fout: " + insErr.message);
    return;
  }

  console.log("moveSectionDay OK:", rows.length, { sid, f, t });
}

async function moveSectionRange(sectionId, fromStartISO, fromEndISO, deltaDays){
  // 1) rows ophalen binnen range
  const { data: rows, error: selErr } = await sb
    .from("section_assignments")
    .select("id, section_id, work_date, werknemer_id, work_type")
    .eq("section_id", sectionId)
    .gte("work_date", fromStartISO)
    .lte("work_date", fromEndISO)
    .limit(200000);

  if (selErr) { alert("Range select fout: " + selErr.message); return; }
  if (!rows || rows.length === 0) { alert("Er is niets verplaatst (0 regels)."); return; }

  // 2) delete originele range
  const { error: delErr } = await sb
    .from("section_assignments")
    .delete()
    .eq("section_id", sectionId)
    .gte("work_date", fromStartISO)
    .lte("work_date", fromEndISO);

  if (delErr) { alert("Range delete fout: " + delErr.message); return; }

  // 3) insert met verschoven datum
  const newRows = rows.map(r => {
    const newISO = toISODate(addDays(parseISODate(r.work_date), deltaDays));
    return {
      section_id: r.section_id,
      work_date: newISO,
      werknemer_id: r.werknemer_id,
      work_type: r.work_type
    };
  });

  const { error: insErr } = await sb.from("section_assignments").insert(newRows);
  if (insErr) { alert("Range insert fout: " + insErr.message); return; }
}



async function moveProjectMontageDay(projectId, fromDate, toDate){
  const pid = String(projectId || "").trim();
  const f = String(fromDate || "").trim();
  const t = String(toDate || "").trim();
  if (!pid || !f || !t || f === t) return;

  const { data: rows, error: selErr } = await sb
    .from("project_assignments")
    .select("id, project_id, werknemer_id, work_type")
    .eq("project_id", pid)
    .eq("work_date", f)
    .eq("work_type", "montage");

  if (selErr) { alert("Select fout: " + selErr.message); return; }
  if (!rows || rows.length === 0) { alert("Er is niets verplaatst (0 regels)."); return; }

  // ✅ UNDO snapshot opslaan (voor we deleten)
pushUndo({
  kind: "project-montage",
  project_id: pid,
  from_date: f,
  to_date: t,
  rows: rows.map(r => ({ werknemer_id: r.werknemer_id, work_type: r.work_type }))
});


  const { error: delErr } = await sb
    .from("project_assignments")
    .delete()
    .eq("project_id", pid)
    .eq("work_date", f)
    .eq("work_type", "montage");

  if (delErr) { alert("Delete fout: " + delErr.message); return; }

  const newRows = rows.map(r => ({
    project_id: r.project_id,
    work_date: t,
    werknemer_id: r.werknemer_id,
    work_type: r.work_type
  }));

  const { error: insErr } = await sb
    .from("project_assignments")
    .insert(newRows);

  if (insErr) { alert("Insert fout: " + insErr.message); return; }

  console.log("moveProjectMontageDay OK:", rows.length, { pid, f, t });
}

async function moveProjectMontageRange(projectId, fromStartISO, fromEndISO, deltaDays){
  const { data: rows, error: selErr } = await sb
    .from("project_assignments")
    .select("id, project_id, work_date, werknemer_id, work_type")
    .eq("project_id", projectId)
    .eq("work_type", "montage")
    .gte("work_date", fromStartISO)
    .lte("work_date", fromEndISO)
    .limit(200000);

  if (selErr) { alert("Range select fout: " + selErr.message); return; }
  if (!rows || rows.length === 0) { alert("Er is niets verplaatst (0 regels)."); return; }

  const { error: delErr } = await sb
    .from("project_assignments")
    .delete()
    .eq("project_id", projectId)
    .eq("work_type", "montage")
    .gte("work_date", fromStartISO)
    .lte("work_date", fromEndISO);

  if (delErr) { alert("Range delete fout: " + delErr.message); return; }

  const newRows = rows.map(r => {
    const newISO = toISODate(addDays(parseISODate(r.work_date), deltaDays));
    return {
      project_id: r.project_id,
      work_date: newISO,
      werknemer_id: r.werknemer_id,
      work_type: r.work_type
    };
  });

  const { error: insErr } = await sb.from("project_assignments").insert(newRows);
  if (insErr) { alert("Range insert fout: " + insErr.message); return; }
}

function daysBetweenISO(fromISO, toISO){
  const a = parseISODate(fromISO);
  const b = parseISODate(toISO);
  if (!a || !b) return 0;
  const ms = (b.getTime() - a.getTime());
  return Math.round(ms / 86400000);
}

// zoekt in dezelfde rij links/rechts cellen met dezelfde ddKey (dus hetzelfde “blok”)
function getContiguousRunFromCell(td){
  const key = String(td.dataset.ddKey || "");
  const tr = td.closest("tr");
  if (!tr || !key) return { startISO: td.dataset.workDate, endISO: td.dataset.workDate };

  const cells = Array.from(tr.querySelectorAll("td.dd-draggable[draggable='true']"));
  // map ISO -> cell
  const byISO = new Map(cells.map(c => [String(c.dataset.workDate||""), c]));
  const curISO = String(td.dataset.workDate || "");

  let startISO = curISO;
  let endISO   = curISO;

  // links uitbreiden
  while(true){
    const prev = toISODate(addDays(parseISODate(startISO), -1));
    const c = byISO.get(prev);
    if (!c) break;
    if (String(c.dataset.ddKey||"") !== key) break;
    startISO = prev;
  }

  // rechts uitbreiden
  while(true){
    const next = toISODate(addDays(parseISODate(endISO), +1));
    const c = byISO.get(next);
    if (!c) break;
    if (String(c.dataset.ddKey||"") !== key) break;
    endISO = next;
  }

  return { startISO, endISO };
}
}