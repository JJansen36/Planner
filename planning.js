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

  // ===== Open/close state bewaren =====
  let openState = {
    projects: new Set(),
    sections: new Set(),
    orders: new Set(), // key: `${sid}||${bn}`
  };

  function captureOpenState(){
    const st = { projects: new Set(), sections: new Set(), orders: new Set() };

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

  applyZebraVisible();
}



  const HOURS_PER_PERSON_DAY = 7.75;

  // ---- Settings (uitbreidbaar) ----
  const SETTINGS_KEY = "lovd_planner_settings_v1";
  // ===== Dummy medewerker (virtuele inhuur) =====
  const DUMMY_EMP_ID = 999999;
  const DUMMY_EMP_NAME = "Concept";

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
  // output: { "YYYY-MM-DD": { pro:Set, mo:Set, dummyPro:number, dummyMo:number }, ... }
  const out = Object.create(null);

  for (const it of (planningItems || [])) {
    const d = String(it.work_date || "").trim();
    const wid = String(it.werknemer_id ?? "").trim();
    const kind = String(it.work_type || it.kind || it.type || "").toLowerCase().trim();


    if (!d || !wid) continue;

    const bucket =
      kind === "pro" || kind === "productie" ? "pro" :
      kind === "mo"  || kind === "montage"  ? "mo"  :
      null;

    if (!bucket) continue;

    if (!out[d]) out[d] = { pro: new Set(), mo: new Set(), dummyPro: 0, dummyMo: 0 };

    const isDummy = String(wid) === String(DUMMY_EMP_ID);

    if (isDummy) {
      if (bucket === "pro") out[d].dummyPro += 1;
      if (bucket === "mo")  out[d].dummyMo  += 1;
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
  const s = String(v);

  // al een pure date: "YYYY-MM-DD"
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // timestamp: "YYYY-MM-DDTHH:mm:ss..."
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0,10); // fallback

  // lokale dag teruggeven (NL), niet de UTC dag uit de string
  return toISODate(d);
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
          <div class="assign-grid">
            <div class="assign-col">
              <div class="assign-col-title">Productie</div>
              <div id="amListProd" class="assign-list"></div>
            </div>

            <div class="assign-col">
              <div class="assign-col-title">Montage</div>
              <div id="amListMont" class="assign-list"></div>
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
      .from("projecten")
      .select("*")
      .in("salesstatus", [4,5,6,7,8])
      .gte("completiondate", todayISO)
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

    // 2b) section_orders voor alle secties in dit project (✅ nieuw)
    const sectionIds = (secties || [])
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
      werknemersCap,
      assigns: safeAssigns,
      orders // ✅ nieuw
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


    // -------- RENDER --------
    function renderPlanner({ start, days, projecten, secties, work, cap, werknemers, werknemersCap, assigns, orders }){


    const dates = [];
    for(let i=0;i<days;i++) dates.push(addDays(start, i));

      console.log("DATES preview:", dates.slice(0,14).map(d => toISODate(d)).join(", "));

    resetZebra(); // ✅ hier

    // indexes
    const projIdKey = pickKey(projecten[0], ["project_id","id"]);
    const projNrKey = pickKey(projecten[0], ["offerno","projectnr","project_nr","nummer","nr"]);
    const projNameKey = pickKey(projecten[0], ["projectname","naam","name","omschrijving","titel","title"]);
    const klantKey = pickKey(projecten[0], ["deliveryname", "klantnaam","klant_name","klant","customer","relatie"]);


    const completionKey = pickKey(projecten[0], ["completiondate","completion_date","opleverdatum","end_date"]);
    const deliveryKey = pickKey(projecten[0], ["deliverydate","delivery_date","leverdatum"]);


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



    for (const r of (orders || [])) {
      const rawSid = r.section_id;
      if (!rawSid) continue;

      // belangrijk: zelfde "canonical" sid gebruiken als rest van planner
      const sid = sectLookup.get(String(rawSid)) || String(rawSid);

      if (!ordersBySection.has(sid)) ordersBySection.set(sid, new Map());
      const by = ordersBySection.get(sid);

      const bn = String(r.bestel_nummer || "").trim() || "Onbekend";
      if (!by.has(bn)) by.set(bn, []);
      by.get(bn).push(r);
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
      const sid = String(a.section_id || "").trim();
      const d   = String(a.work_date || "").trim();
      const emp = String(a.werknemer_id ?? "").trim();
      const wt  = String(a.work_type || "").toLowerCase().trim();

      if (!sid || !d || !emp || !wt) continue;

      if (!assignMap.has(sid)) assignMap.set(sid, new Map());
      const dmA = assignMap.get(sid);
      if (!dmA.has(d)) dmA.set(d, { productie: new Set(), montage: new Set() });

      if (wt === "productie") dmA.get(d).productie.add(emp);
      if (wt === "montage") dmA.get(d).montage.add(emp);
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


    // planned prod/mont per day (unieke medewerkers per dag * 7,75 * planFactor)
    const plannedProdByDay = {};
    const plannedMontByDay = {};

    const plannedSetsByDay = buildPlannedSetsByDay(assigns || []);
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

      // let op: plannedSetsByDay gebruikt keys "pro" en "mo"
      empAssignByDay[iso] = {
        prod: new Set(Array.from(sets.pro || []).map(x => String(x).trim())),
        mont: new Set(Array.from(sets.mo || []).map(x => String(x).trim())),
      };
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
      const kl = String(p?.deliveryname || p?.[klantKey] || "").trim();
      const complRaw = p?.[completionKey] ?? "";
      const complTxt = formatDateNL(complRaw);
      const complISO = asISODate(complRaw);
      const deliveryRaw = p?.[deliveryKey] ?? "";
      const deliveryISO = asISODate(deliveryRaw);

      console.log("RAW completion:", complRaw, "=> ISO:", complISO);



      console.log("completionKey:", completionKey, "value:", p?.[completionKey]);


      const projRow = document.createElement("tr");
      projRow.className = "project-row";
      markZebra(projRow);
      const left = document.createElement("td");
      left.className = "rowhdr sticky-left project-cell";
      left.innerHTML = `
        <button class="expander" data-proj="${escapeAttr(pid)}" aria-label="toggle">▶</button>
        <span class="projtext" data-proj="${escapeAttr(pid)}">
          <div class="projline1">${escapeHtml(nr)} - ${escapeHtml(kl)}</div>
          <div class="projline2">${escapeHtml(nm)}</div>
        </span>
      `;

      projRow.appendChild(left);

      

    

      
  // tel ingeplande mensen per dag op over alle secties van dit project
  const projAssignByDay = {};
  const secs = sectiesByProject.get(pid) || [];

for (const dd of dates) {
  const iso = toISODate(dd);
  let prod = 0, mont = 0;
  let dummyProd = false, dummyMont = false; // ✅ FIX

  for (const s of secs) {
    const sid = s?.[sectIdKey]
      ? String(s[sectIdKey])
      : (s?.section_id ? String(s.section_id) : null);
    if (!sid) continue;

    const entry = assignMap.get(String(sid))?.get(iso);
    if (entry) {
      prod += entry.productie.size;
      mont += entry.montage.size;

      if (entry.productie.has(String(DUMMY_EMP_ID)) || entry.productie.has(Number(DUMMY_EMP_ID))) dummyProd = true;
      if (entry.montage.has(String(DUMMY_EMP_ID)) || entry.montage.has(Number(DUMMY_EMP_ID))) dummyMont = true;
    }
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


  // section rows (hidden by default)
      const secList = (sectiesByProject.get(pid) || []).slice()
        .sort((a,b)=>String(a?.[sectNameKey]||"").localeCompare(String(b?.[sectNameKey]||"")));

      for (const s of secList) {
        const secRow = document.createElement("tr");
        secRow.className = "section-row hidden";
        markZebra(secRow);
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
      appendOrderDayCells(orderRow, dates, oh.leverISO);
      tbody.appendChild(orderRow);

      // 2) Orderregel-rijen (1 rij per orderregel) — standaard verborgen
      // 2) Orderregel-rijen (1 rij per orderregel) — standaard verborgen
    const items = (oh.items || []);
    items.forEach((it, idx) => {
      const isLast = idx === items.length - 1;

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

      const leverLineISO = it.leverdatum ? asISODate(it.leverdatum) : oh.leverISO;
      appendOrderDayCells(lineRow, dates, leverLineISO);

      tbody.appendChild(lineRow);
    });

    }
      }}

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
  `;
  trTotal.appendChild(tdTotalLeft);

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

      const empIdStr = String(empId ?? "").trim();

      for (const d of dates) {
        const dayISO = toISODate(d);
        const h = capByEmp.get(empIdStr)?.get(dayISO) || 0;

        const td = document.createElement("td");
        td.className = `cell cap-cell ${isWeekend(d) ? "wknd" : ""}`;

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


    // =========================
    // EXPANDERS BINDEN (na render)
    // =========================

    // Section expander (▶) opent: section-details + order-rijen
    gridEl.querySelectorAll(".expander-sec").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();

        const sid = String(btn.dataset.sect || "");
        const parentTr = btn.closest("tr");
        const pid = String(parentTr?.dataset?.parent || "");
        if (!sid || !pid) return;

        const open = btn.textContent !== "▼";
        btn.textContent = open ? "▼" : "▶";

        // 1) sectie-details row (Bestellingen blok etc.)
        gridEl.querySelectorAll(
          `tr.section-details-row[data-sect="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"]`
        ).forEach(r => r.classList.toggle("hidden", !open));

        // 2) bestelling header-rijen (order-row) tonen/verbergen bij sectie open/dicht
        gridEl.querySelectorAll(
          `tr.order-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"]`
        ).forEach(r => r.classList.toggle("hidden", !open));

        // 3) als sectie dicht gaat: verberg ook ALLE order-regel-rijen + zet order-pijltjes terug
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

    // Order expander (▶) opent alleen de details van die bestelling
    gridEl.querySelectorAll(".expander-order").forEach(btn => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();

        const sid = String(btn.dataset.sect || "");
        const bn  = String(btn.dataset.orderbn || "");
        const parentTr = btn.closest("tr");
        const pid = String(parentTr?.dataset?.parent || "");
        if (!sid || !bn || !pid) return;

        const open = btn.textContent !== "▼";
        btn.textContent = open ? "▼" : "▶";

        const row = gridEl.querySelector(
          `tr.order-details-row[data-order-parent="${cssEsc(sid)}"][data-order-bn="${cssEsc(bn)}"][data-parent="${cssEsc(pid)}"]`
        );
        if (row) row.classList.toggle("hidden", !open);

        applyZebraVisible();
      });
    });


    applyZebraVisible();

    // click on section cell -> assignments modal
    gridEl.onclick = async (ev) => {

     // ✅ klik op bestelling pijltje => toon/verberg orderregel-rijen
    const obtn = ev.target.closest(".expander-order");
    if (obtn) {
      ev.stopPropagation();

      const sid = String(obtn.dataset.sect || "");
      const bn  = String(obtn.dataset.orderbn || "");

      // pid pakken we veilig van de rij zelf (betrouwbaarder dan dataset op de button)
      const tr = obtn.closest("tr");
      const pid = String(tr?.dataset?.parent || "");

      const open = obtn.textContent !== "▼";
      obtn.textContent = open ? "▼" : "▶";

      gridEl.querySelectorAll(
        `tr.order-line-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"][data-order-bn="${cssEsc(bn)}"]`
      ).forEach(r => r.classList.toggle("hidden", !open));

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
      const listProd = modal.wrap.querySelector("#amListProd");
      const listMont = modal.wrap.querySelector("#amListMont");
      const saveBtn = modal.wrap.querySelector("#amSave");
      if (subEl) subEl.textContent = `${dateISO} • ${sid}`;


      const renderBothLists = () => {
        listProd.innerHTML = "";
        listMont.innerHTML = "";

        const busySet = busyByDay.get(dateISO) || new Set();

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

  // ===== ORDER EXPANDERS: toon/verberg orderregels (order-line-row) =====
  gridEl.querySelectorAll(".expander-order").forEach(btn => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();

      const sid = String(btn.dataset.sect || "");
      const pid = String(btn.dataset.parent || "");
      const bn  = String(btn.dataset.orderbn || "");

      const open = btn.textContent !== "▼";
      btn.textContent = open ? "▼" : "▶";

      // toon/verberg ALLE orderregel-rijen die bij deze bestelling horen
      gridEl.querySelectorAll(
        `tr.order-line-row[data-order-parent="${cssEsc(sid)}"][data-parent="${cssEsc(pid)}"][data-order-bn="${cssEsc(bn)}"]`
      ).forEach(r => r.classList.toggle("hidden", !open));

      applyZebraVisible();
     

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
      applyZebraVisible();
   

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

    // mount
    gridEl.innerHTML = "";
    gridEl.appendChild(table);

    // ... hier komen al je listeners ...

    applyZebraVisible();

    // ✅ NA alles: state terugzetten
    restoreOpenState();

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
    function labelRow(label, dates, byDay, kind = "") {
      const tr = document.createElement("tr");
      tr.className = `sum-row ${kind ? "planned-row " + kind : ""}`.trim();

      tr.appendChild(leftRowHdrCell(label, "sticky-left sum-label"));

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
      ? `<div class="marker delivery">lever</div>`
      : `<div class="marker delivery placeholder">lever</div>`;
    html += isMarker
      ? `<div class="marker deadline">oplever</div>`
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

      // ✅ bij "both": 2 losse bars onder elkaar
      if (key === "both") {
        html += `<div class="bar bar-prod${startCls}${endCls}${dummyProd ? " dummy-hatch" : ""}">${isStart ? "pro" : "&nbsp;"}</div>`;
        html += `<div class="bar bar-mont${startCls}${endCls}${dummyMont ? " dummy-hatch" : ""}">${isStart ? "mon" : "&nbsp;"}</div>`;
      } else {
        const txt = isStart ? (label || (key === "prod" ? "pro" : "mon")) : "&nbsp;";
        const dummyCls =
          (key === "prod" && dummyProd) ? " dummy-hatch" :
          (key === "mont" && dummyMont) ? " dummy-hatch" : "";

        // let op: class bar-prod / bar-mont toevoegen zodat kleur 100% klopt
        const typeCls = (key === "prod") ? " bar-prod" : (key === "mont") ? " bar-mont" : "";
        html += `<div class="bar${typeCls}${startCls}${endCls}${dummyCls}">${txt}</div>`;
      }
    }

    html += `</div>`;
    td.innerHTML = html;
    tr.appendChild(td);
  }
}





    // like appendDayCells, but makes section-day cells clickable for assignments
    function appendSectionDayCells(tr, dates, labels, sectionId, assignCountByDay, assignMap, werknemers) {
      const empIdKey = "id";
      const empNameKey = pickKey(werknemers?.[0], ["naam","name","fullname","display_name"]);
      const empNameById = new Map((werknemers || []).map(w => [
        String(w?.[empIdKey] ?? "").trim(),
        String(w?.[empNameKey] || w?.[empIdKey] || "")
      ]));

      // keys bepalen zodat we start/einde kunnen zien
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

      for (let i = 0; i < dates.length; i++) {
        const d = dates[i];
        const iso = toISODate(d);

        const prod = Number(assignCountByDay?.[iso]?.prod || 0);
        const mont = Number(assignCountByDay?.[iso]?.mont || 0);
        const label = labels[i] || "";

        const key = keys[i];
        const prevKey = (i > 0) ? keys[i - 1] : "";
        const nextKey = (i < keys.length - 1) ? keys[i + 1] : "";

        const td = document.createElement("td");
        td.dataset.sectionId = String(sectionId || "");
        td.dataset.workDate = iso;

        // tooltip met namen
        const entry = assignMap?.get(String(sectionId))?.get(iso);
        const dummyProd = entry?.productie?.has(String(DUMMY_EMP_ID)) || entry?.productie?.has(Number(DUMMY_EMP_ID));
        const dummyMont = entry?.montage?.has(String(DUMMY_EMP_ID)) || entry?.montage?.has(Number(DUMMY_EMP_ID));

        if (entry) {
          const prodNames = Array.from(entry.productie || []).map(id => empNameById.get(String(id)) || String(id));
          const montNames = Array.from(entry.montage || []).map(id => empNameById.get(String(id)) || String(id));
          let tip = "";
          if (prodNames.length) tip += `Productie:\n- ${prodNames.join("\n- ")}`;
          if (montNames.length) tip += (tip ? "\n\n" : "") + `Montage:\n- ${montNames.join("\n- ")}`;
          if (tip) td.dataset.tip = tip;
        }

        // cel-kleur
        let cls = `cell plan-cell section-click ${isWeekend(d) ? "wknd" : ""}`.trim();
        if (key === "both") cls += " bar-both";
        else if (key === "prod") cls += " bar-prod";
        else if (key === "mont") cls += " bar-mont";
        else if (key.startsWith("lbl:")) cls += ` ${barClass(label)}`;
        td.className = cls;

        let html = `<div class="plan-stack">`;

        // markers samen op 1 regel (placeholders blijven voor vaste hoogte)
        html += `<div class="marker-row">`;
        html += `<div class="marker delivery placeholder">lever</div>`;
        html += `<div class="marker deadline placeholder">oplever</div>`;
        html += `</div>`;


        if (key) {
          const isStart = key !== prevKey;
          const isEnd = key !== nextKey;

          const startCls = isStart ? " bar-start" : "";
          const endCls = isEnd ? " bar-end" : "";

          // dummy flags (die had je al)
          // dummyProd / dummyMont bestaan hierboven al

          // ✅ bij "both": 2 losse bars stacken
          if (key === "both") {
            html += `<div class="bar bar-prod${startCls}${endCls}${dummyProd ? " dummy-hatch" : ""}">${isStart ? "pro" : "&nbsp;"}</div>`;
            html += `<div class="bar bar-mont${startCls}${endCls}${dummyMont ? " dummy-hatch" : ""}">${isStart ? "mon" : "&nbsp;"}</div>`;
          } else {
            const txt = isStart ? (label || (key === "prod" ? "pro" : "mon")) : "&nbsp;";
            const dummyCls =
              (key === "prod" && dummyProd) ? " dummy-hatch" :
              (key === "mont" && dummyMont) ? " dummy-hatch" : "";

            const typeCls = (key === "prod") ? " bar-prod" : (key === "mont") ? " bar-mont" : "";
            html += `<div class="bar${typeCls}${startCls}${endCls}${dummyCls}">${txt}</div>`;
          }
        }

        html += `</div>`;
        td.innerHTML = html;
        tr.appendChild(td);
      }
    }

function appendOrderDayCells(tr, dates, leverISO){
  for (const d of dates) {
    const iso = toISODate(d);

    const td = document.createElement("td");
    td.className = `cell plan-cell ${isWeekend(d) ? "wknd" : ""}`.trim();

    if (leverISO && iso === leverISO) {
      td.classList.add("bar-order");
      td.innerHTML = `<div class="bar bar-order">lever</div>`;
    } else {
      td.innerHTML = "";
    }

    tr.appendChild(td);
  }
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
