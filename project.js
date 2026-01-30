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

  const a = await sb
    .from(tProj)
    .select(`*, ${joinName}:${tCust}(*)`)
    .eq(DB.projectPkCol, id)
    .maybeSingle();

  if(a.error){
    setStatus(el("status"), a.error.message, "error");
    return;
  }
  project = a.data;

  if(!project){
    setStatus(el("status"), "Project niet gevonden.", "error");
    return;
  }

  // Secties
  const b = await sb
    .from(tSec)
    .select("*")
    .eq(DB.sectionProjectFk, id)
    .order("id", { ascending: true });

  if(b.error){
    setStatus(el("status"), b.error.message, "error");
    return;
  }

  const sections = b.data || [];

  // Render header
  const projectNo = project?.[DB.projectNoCol] ?? "";
  const projectName = project?.[DB.projectNameCol] ?? "";
  const klantName = project?.klant?.[DB.customerNameCol] ?? "";
  el("title").textContent = projectNo ? `${projectNo}` : "Project";
  el("chipHead").textContent = `${projectNo} - ${klantName} - ${projectName}`;
  el("pillStatus").textContent = project.salesstatus ?? "";
  el("pillMeta").textContent = `ID: ${project[DB.projectPkCol]}`;


  // Render blocks
  renderBlock("blkProject", DB.projectBlocks.project, project, project.klant);
  renderBlock("blkCustomer", DB.projectBlocks.customer, project.klant || {}, project.klant || {});
  renderBlock("blkDelivery", DB.projectBlocks.delivery, project, project.klant);
  renderBlock("blkOrder", DB.projectBlocks.order, project, project.klant);

  // Totals: use project totals if present, else compute from sections
  const computed = {
    total_wvb: sumNums(sections, "uren_wvb"),
    total_prod: sumNums(sections, "uren_prod"),
    total_mont: sumNums(sections, "uren_mont"),
    total_reis: sumNums(sections, "uren_reis"),
  };

  const totalsObj = { ...computed, ...project }; // project overrides computed if filled
  renderBlock("blkTotals", DB.projectBlocks.totals, totalsObj, totalsObj);

  // Render sections table
  el("secMeta").textContent = `${sections.length} secties`;

  el("secHead").innerHTML = DB.sectionRowCols.map(c=> `<th>${escapeHtml(c.label)}</th>`).join("") + `<th style="width:70px"></th>`;

  el("secBody").innerHTML = sections.map((s, idx)=>{
    const cols = DB.sectionRowCols.map(c=>{
      const v = valFrom(s, c.col);
      return `<td>${escapeHtml(v ?? "")}</td>`;
    }).join("");

    const detail = DB.sectionDetailCols.map(d=>{
      const raw = valFrom(s, d.col);
      const v = (d.col?.toString().includes("uren_")) ? (raw ?? 0) : (raw ?? "");
      return `
        <div class="fieldgrid" style="grid-template-columns:220px 1fr; margin-top:8px">
          <div class="label">${escapeHtml(d.label)}</div>
          <div class="value" style="white-space:normal">${escapeHtml(v)}</div>
        </div>
      `;
    }).join("");

    return `
      <tr class="accordion-row" data-i="${idx}">
        ${cols}
        <td style="text-align:right"><span class="pill">▾</span></td>
      </tr>
      <tr class="section-details" data-i="${idx}" style="display:none">
        <td colspan="${DB.sectionRowCols.length + 1}">
          <div class="inner">
            <div class="muted" style="font-weight:800; margin-bottom:8px">Sectie details</div>
            ${detail}
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

  setStatus(el("status"), "");
  el("cardMain").style.display = "block";
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
