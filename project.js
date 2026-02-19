// project.js
import { makeSupabaseClient, requireSession, signOut } from "./auth.js";
import { DB } from "./config.js";
import { el, escapeHtml, fmtDate, setStatus, valFrom, sumNums } from "./utils.js";

const sb = makeSupabaseClient();

document.addEventListener("DOMContentLoaded", init);

async function init(){
  const session = await requireSession(sb);
  if(!session) return;

  el("btnLogout").addEventListener("click", ()=>signOut(sb));

  const id = new URL(location.href).searchParams.get("id");
  if(!id){
    setStatus(el("status"), "Geen project-id meegegeven.", "error");
    return;
  }

  await loadProject(id);
}

async function loadProject(id){
  setStatus(el("status"), "Project laden...");
  el("cardMain").style.display = "none";

  const tProj = DB.tables.projects;
  const tCust = DB.tables.customers;
  const tSec  = DB.tables.sections;

  // Project + klant (join als FK bekend is)
  const joinName = "klant";
  let project = null;

  // Probeer project + klant via relationship select; als dat faalt: 2-step fallback
  let a = await sb
    .from(tProj)
    .select(`*, ${joinName}:${tCust}(*)`)
    .eq(DB.projectPkCol, id)
    .maybeSingle();

  if(a.error){
    console.warn("Project join failed, fallback to 2-step", a.error.message);
    a = await sb
      .from(tProj)
      .select("*")
      .eq(DB.projectPkCol, id)
      .maybeSingle();
    if(a.error){
      setStatus(el("status"), a.error.message, "error");
      return;
    }
    project = a.data;
    const custId = project?.[DB.projectCustomerFk];
    if(custId){
      const k = await sb
        .from(tCust)
        .select("*")
        .eq(DB.customerPkCol, custId)
        .maybeSingle();
      if(!k.error) project.klant = k.data;
    }
  } else {
    project = a.data;
  }

  if(!project){
    setStatus(el("status"), "Project niet gevonden.", "error");
    return;
  }

  // Secties
  const b = await sb
    .from(tSec)
    .select("*")
    .eq(DB.sectionProjectFk, id)
    .order(DB.sectionPkCol, { ascending: true });

  if(b.error){
    setStatus(el("status"), b.error.message, "error");
    return;
  }

  const sections = b.data || [];
  const includePlanningCol = pickIncludePlanningCol(sections);

    

  // Orders (bestellingen) voor alle secties van dit project
  const sectionIds = sections
    .map(s => s?.[DB.sectionPkCol])
    .filter(Boolean);

  let orders = [];
  if (sectionIds.length) {
    const oRes = await sb
      .from("section_orders")
      .select("id, section_id, bestel_nummer, leverdatum, omschrijving, aantal, leverancier, soort, created_at")
      .in("section_id", sectionIds)
      .order("bestel_nummer", { ascending: true })
      .order("leverdatum", { ascending: true })
      .order("created_at", { ascending: true });

    if (oRes.error) {
      console.warn("section_orders laden faalde:", oRes.error.message);
      orders = [];
    } else {
      orders = oRes.data || [];
    }
  }

  // Map: section_id -> orders[]
  const ordersBySection = new Map();
  for (const r of orders) {
    const sid = String(r.section_id || "");
    if (!sid) continue;
    if (!ordersBySection.has(sid)) ordersBySection.set(sid, []);
    ordersBySection.get(sid).push(r);
  }


  // Render header
  const projectNo = project?.[DB.projectNoCol] ?? "";
  const projectName = project?.[DB.projectNameCol] ?? "";
  const klantName = project?.klant?.[DB.customerNameCol] ?? "";
  el("title").textContent = projectNo ? `${projectNo}` : "Project";
  el("chipHead").textContent = `${projectNo} - ${klantName} - ${projectName}`;
  el("pillStatus").textContent = project.salesstatus ?? "";
  el("pillMeta").textContent = `ID: ${project?.[DB.projectPkCol] ?? ""}`;

  // Render blocks
  renderBlock("blkProject", DB.projectBlocks.project, project, project.klant);
  renderBlock("blkCustomer", DB.projectBlocks.customer, project.klant || {}, project.klant || {});
  renderBlock("blkDelivery", DB.projectBlocks.delivery, project, project.klant);
  renderBlock("blkOrder", DB.projectBlocks.order, project, project.klant);

  // Totals: use project totals if present, else compute from sections
  // Kolomnamen van uren kunnen per omgeving verschillen; we volgen config.js
  const computed = {
    total_wvb: sumNums(sections, "uren_wvb"),
    total_prod: sumNums(sections, "uren_prod"),
    total_mont: sumNums(sections, "uren_montage") || sumNums(sections, "uren_mont"),
    total_reis: sumNums(sections, "uren_reis"),
  };

  const totalsObj = { ...computed, ...project }; // project overrides computed if filled
  renderBlock("blkTotals", DB.projectBlocks.totals, totalsObj, totalsObj);

  // Render sections table
  el("secMeta").textContent = `${sections.length} secties`;

  el("secHead").innerHTML = DB.sectionRowCols.map(c=> `<th>${escapeHtml(c.label)}</th>`).join("")
    + `<th style="width:170px">In planning</th>`
    + `<th style="width:70px"></th>`;

  el("secBody").innerHTML = sections.map((s, idx)=>{
    const cols = DB.sectionRowCols.map(c=>{
      const v = Array.isArray(c.col)
        ? c.col.map(k => valFrom(s, k)).find(x => x !== null && x !== undefined && x !== "")
        : valFrom(s, c.col);

      return `<td>${escapeHtml(v ?? "")}</td>`;
    }).join("");

// ===== detail opsplitsen: tekst/beschrijving boven, uren links =====
const detailText = DB.sectionDetailCols
  .filter(d => !String(Array.isArray(d.col) ? d.col[0] : d.col).includes("uren_"))
  .map(d => {
    const raw = Array.isArray(d.col)
      ? d.col.map(c => valFrom(s, c)).find(v => v !== null && v !== undefined && v !== "")
      : valFrom(s, d.col);

    const v = raw ?? "";
    return `
      <div class="fieldgrid" style="grid-template-columns:220px 1fr; margin-top:8px">
        <div class="label">${escapeHtml(d.label)}</div>
        <div class="value" style="white-space:normal">${escapeHtml(v)}</div>
      </div>
    `;
  }).join("");

const detailHours = DB.sectionDetailCols
  .filter(d => String(Array.isArray(d.col) ? d.col[0] : d.col).includes("uren_"))
  .map(d => {
    const raw = Array.isArray(d.col)
      ? d.col.map(c => valFrom(s, c)).find(v => v !== null && v !== undefined && v !== "")
      : valFrom(s, d.col);

    const v = (raw ?? 0);
    return `
      <div class="fieldgrid" style="grid-template-columns:190px 1fr; margin-top:8px">
        <div class="label">${escapeHtml(d.label)}</div>
        <div class="value">${escapeHtml(v)}</div>
      </div>
    `;
  }).join("");


// ===== Orders HTML voor deze sectie (accordion per bestel_nummer) =====
const sid = String(s?.[DB.sectionPkCol] ?? "");
const includeInPlanning = getIncludePlanningValue(s, includePlanningCol);
const ords = ordersBySection.get(sid) || [];

const ordersHtml = `
  <div class="muted" style="font-weight:800; margin:14px 0 8px">Bestellingen</div>
  ${renderOrdersAccordionHtml(ords)}
`;


    return `
      <tr class="accordion-row" data-i="${idx}">
        ${cols}
        <td>
          <label class="row" style="gap:8px; justify-content:flex-start" title="Sectie opnemen in planning">
            <input type="checkbox" class="js-include-planning" data-sid="${escapeHtml(sid)}" ${includeInPlanning ? "checked" : ""}>
            <span class="muted" style="font-size:12px">Opnemen</span>
          </label>
        </td>
        <td style="text-align:right"><span class="pill">▾</span></td>
      </tr>
      <tr class="section-details" data-i="${idx}" style="display:none">
        <td colspan="${DB.sectionRowCols.length + 2}">
          <div class="inner">
            <div class="inner">
              <div class="muted" style="font-weight:800; margin-bottom:8px">Sectie details</div>

              <!-- 1) Tekst/beschrijving boven (volledige breedte) -->
              ${detailText}

              <!-- 2) Uren links + Bestellingen rechts -->
              <div class="sec-split" style="display:grid; grid-template-columns: 260px 1fr; gap:16px; margin-top:14px;">
                <div class="sec-left">
                  ${detailHours}
                </div>

                <div class="sec-right">
                  ${ordersHtml}
                </div>
              </div>
            </div>

        </td>
      </tr>
    `;
  }).join("");

  // Accordion behavior
  [...el("secBody").querySelectorAll(".accordion-row")].forEach(tr=>{
    tr.addEventListener("click", ()=>{
      const i = tr.getAttribute("data-i");
      const detailRow = el("secBody").querySelector(`.section-details[data-i="${i}"]`);
      const open = detailRow.style.display !== "none";
      detailRow.style.display = open ? "none" : "table-row";
      tr.querySelector(".pill").textContent = open ? "▾" : "▴";
    });
  });

  [...el("secBody").querySelectorAll(".js-include-planning")].forEach(cb => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", async (e) => {
      e.stopPropagation();
      const sectionId = cb.getAttribute("data-sid");
      const checked = cb.checked;

      cb.disabled = true;
      const ok = await saveIncludeInPlanning(sectionId, checked, includePlanningCol);
      cb.disabled = false;

      if (!ok) {
        cb.checked = !checked;
      }
    });
  });

// Orders accordion behavior (per bestelnummer)
[...el("secBody").querySelectorAll("[data-order-toggle]")].forEach(btn=>{
  btn.addEventListener("click", (e)=>{
    e.stopPropagation();

    // werkt zowel met als zonder .order-card wrapper
    const card = btn.closest(".order-card") || btn.parentElement;
    const body = card ? card.querySelector(".order-body") : null;
    const arrow = card ? card.querySelector(".order-arrow") : btn.querySelector(".order-arrow");

    if (!body) return; // niets te togglen

    const isOpen = !body.hasAttribute("hidden");
    if (isOpen) {
      body.setAttribute("hidden", "");
      btn.setAttribute("aria-expanded", "false");
      if (arrow) arrow.textContent = "▾";
    } else {
      body.removeAttribute("hidden");
      btn.setAttribute("aria-expanded", "true");
      if (arrow) arrow.textContent = "▴";
    }
  });
});



// Bestellingen accordion (binnen sectie-details) - delegated
el("secBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-order-toggle]");
  if (!btn) return;

  e.stopPropagation(); // voorkomt togglen van sectie zelf
  const card = btn.closest("[data-order-card]");
  if (!card) return;

  const body = card.querySelector(".order-body");
  const arrow = card.querySelector(".order-arrow");
  const open = body && body.style.display !== "none";

  if (body) body.style.display = open ? "none" : "block";
  if (arrow) arrow.textContent = open ? "▾" : "▴";
});


  setStatus(el("status"), "");
  el("cardMain").style.display = "block";
}

function pickIncludePlanningCol(rows){
  const candidates = DB.sectionIncludeInPlanningCols || ["in_planning"];
  const first = rows?.[0] ? Object.keys(rows[0]) : [];
  const found = candidates.find(col => first.includes(col));
  return found || candidates[0] || "in_planning";
}

function getIncludePlanningValue(section, col){
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

async function saveIncludeInPlanning(sectionId, includeInPlanning, includePlanningCol){
  if (!sectionId) return false;
  const tSec  = DB.tables.sections;
  const payload = { [includePlanningCol]: includeInPlanning };

  const res = await sb
    .from(tSec)
    .update(payload)
    .eq(DB.sectionPkCol, sectionId);

  if (res.error) {
    console.warn("Sectie planning-toggle opslaan mislukt:", res.error.message);
    setStatus(el("status"), `Opslaan mislukt: ${res.error.message}`, "error");
    return false;
  }

  setStatus(el("status"), "Sectie bijgewerkt.");
  return true;
}

function renderBlock(targetId, fields, primaryObj, fallbackObj){
  const node = el(targetId);
  node.innerHTML = fields.map(f=>{
    const cols = f.col;
    let raw;
    if(Array.isArray(cols)){
      raw = cols.map(c=> (primaryObj?.[c] ?? fallbackObj?.[c])).filter(Boolean).join(f.joiner || " ");
    }else{
      raw = (primaryObj?.[cols] ?? fallbackObj?.[cols]);
    }

    if(f.type==="date") raw = fmtDate(raw);

    return `
      <div class="label">${escapeHtml(f.label)}</div>
      <div class="value" title="${escapeHtml(raw ?? "")}">${escapeHtml(raw ?? "")}</div>
    `;
  }).join("");
}

function groupOrdersByBestelnummer(rows){
  const by = new Map();
  for (const r of (rows || [])) {
    const key = String(r.bestel_nummer || "").trim() || "Onbekend";
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return by;
}

function renderOrdersAccordionHtml(rows){
  if (!rows || !rows.length) {
    return `<div class="muted" style="padding:8px 0;">Geen bestellingen</div>`;
  }

  const grouped = groupOrdersByBestelnummer(rows);

  // per bestelnummer 1 header + uitklapbare regels
  let html = `<div class="orders-acc">`;

  for (const [bn, items] of grouped) {
    // leverdatum op header: neem eerste niet-lege leverdatum
    const ld = items.map(x => x.leverdatum).find(Boolean);
    const ldTxt = ld ? fmtDate(ld) : "";

    const safeBn = escapeHtml(bn);
    const safeLd = escapeHtml(ldTxt);

    html += `
        <button class="order-head" type="button" data-order-toggle="1" aria-expanded="false">
          <div class="order-head-left">
            <span class="pill pill-soft">${safeBn}</span>
          </div>

          <div class="order-head-right">
            <span class="pill pill-soft">${safeLd || "-"}</span>
            <span class="order-arrow">▾</span>
          </div>
        </button>


        <div class="order-body" hidden>

          ${items.map(it=>{
            const oms = escapeHtml(it.omschrijving || "");
            const aant = escapeHtml(it.aantal ?? "");
            const lev = escapeHtml(it.leverancier || "");
            const soort = escapeHtml(it.soort || "");
            return `
              <div class="order-line">
                <div class="ol-aantal">${aant}</div>
                <div class="ol-oms">${oms}</div>
                <div class="ol-meta">${lev}${lev && soort ? " • " : ""}${soort}</div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  html += `</div>`;
  return html;
}
