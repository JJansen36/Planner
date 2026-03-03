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

  const sections = sortSections(b.data || []);

    

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

  el("secHead").innerHTML =
    DB.sectionRowCols.map(c=> `<th>${escapeHtml(c.label)}</th>`).join("")
    + `<th style="width:170px">In planning</th>`
    + `<th style="width:70px"></th>`;
    
  el("secBody").innerHTML = sections.map((s, idx)=>{
    const cols = DB.sectionRowCols.map(c=>{
      const v = Array.isArray(c.col)
        ? c.col.map(k => valFrom(s, k)).find(x => x !== null && x !== undefined && x !== "")
        : valFrom(s, c.col);


      return `<td>${escapeHtml(v ?? "")}</td>`;
    }).join("");

    setupSectionFilesDelegation();
el("secBody").querySelectorAll(".sec-files").forEach(b => renderSectionFiles(b));

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
const ords = ordersBySection.get(sid) || [];

const ordersHtml = `
  <div class="muted" style="font-weight:800; margin:14px 0 8px">Bestellingen</div>
  ${renderOrdersAccordionHtml(ords)}
`;

const projectId = String(project?.[DB.projectPkCol] ?? id); // id is de URL param

const filesHtml = `
  <div class="muted" style="font-weight:800; margin:14px 0 8px">Bestanden</div>

  <div class="sec-files" data-section-id="${escapeHtml(sid)}" data-project-id="${escapeHtml(projectId)}">
    <div class="sec-files-top" style="display:flex; align-items:center; justify-content:space-between; gap:10px;">
      <div class="sec-files-title" style="font-weight:700; color:var(--muted); font-size:12px; text-transform:uppercase;">
        Uploads
      </div>

      <label class="btn small js-sec-upload" style="cursor:pointer;">
        + Upload
        <input class="secFileInput" type="file" multiple hidden />
      </label>
    </div>

    <div class="sec-files-list" style="margin-top:8px;"></div>
  </div>
`;

const includeInPlanning = getIncludePlanningValue(s);
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
                  ${filesHtml}
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

  // Checkbox: opnemen in planning
  [...el("secBody").querySelectorAll(".js-include-planning")].forEach(cb => {
    cb.addEventListener("click", (e) => e.stopPropagation()); // voorkomt sectie open/dicht
    cb.addEventListener("change", async (e) => {
      e.stopPropagation();
      const sectionId = cb.getAttribute("data-sid");
      const checked = cb.checked;

      cb.disabled = true;
      const ok = await saveIncludeInPlanning(sectionId, checked);
      cb.disabled = false;

      if (!ok) cb.checked = !checked; // revert bij fout
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
    if (!body) return;

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





  setStatus(el("status"), "");
  el("cardMain").style.display = "block";
}

function getIncludePlanningValue(section){
  const raw = section?.in_planning;
  if (raw === null || raw === undefined) return true; // default: aan
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  if (typeof raw === "string") {
    const v = raw.trim().toLowerCase();
    return !["0","false","nee","no","off"].includes(v);
  }
  return Boolean(raw);
}

async function saveIncludeInPlanning(sectionId, includeInPlanning){
  if (!sectionId) return false;
  const tSec = DB.tables.sections;

  const res = await sb
    .from(tSec)
    .update({ in_planning: includeInPlanning })
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
      <div class="order-card" data-order-card>
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


function sortSections(rows){
  return [...(rows || [])].sort((a,b)=>{
    const ka = sectionSortKey(a);
    const kb = sectionSortKey(b);

    // 1) normale secties eerst, M-secties onderaan
    if (ka.group !== kb.group) return ka.group - kb.group;

    // 2) binnen groep: numeriek op nummer (01,02,10...)
    if (ka.num !== kb.num) return ka.num - kb.num;

    // 3) fallback: string compare
    return ka.raw.localeCompare(kb.raw, "nl", { numeric:true });
  });
}

function sectionSortKey(section){
  // probeer de meest waarschijnlijke kolommen waar jouw "01." / "M05." in staat
  const candidates = [
    "paragraaf",
    "paragraph",
    "sectionno",
    "sectienr",
    "sectie",
    "code",
    "section_code",
    DB.sectionNoCol,            // als je dit in config hebt
  ].filter(Boolean);

  let raw = "";
  for (const k of candidates){
    const v = section?.[k];
    if (v !== null && v !== undefined && String(v).trim() !== ""){
      raw = String(v).trim();
      break;
    }
  }

  // als we niets vonden: pak eventueel de eerste kolom uit DB.sectionRowCols
  if (!raw && DB?.sectionRowCols?.length){
    const firstCol = DB.sectionRowCols[0]?.col;
    const v = Array.isArray(firstCol)
      ? firstCol.map(k => section?.[k]).find(x => x !== null && x !== undefined && String(x).trim() !== "")
      : section?.[firstCol];
    raw = String(v ?? "").trim();
  }

  const s = raw.toUpperCase().replace(/\s+/g,""); // "M05." -> "M05."
  const isM = s.startsWith("M");

  // haal cijfers uit "01." / "M05." / "13" etc
  const digits = (isM ? s.slice(1) : s).match(/\d+/);
  const num = digits ? parseInt(digits[0], 10) : Number.MAX_SAFE_INTEGER;

  return {
    raw: s,
    group: isM ? 1 : 0,   // 0 = normaal, 1 = M onderaan
    num,
  };
}


// =========================
// SECTION FILES (delegated)
// =========================
const FILES_BUCKET = "project-files";
const FILES_TABLE  = "section_files";

function formatBytes(n){
  if(n === null || n === undefined) return "";
  const u = ["B","KB","MB","GB","TB"];
  let i=0, v=Number(n)||0;
  while(v>=1024 && i<u.length-1){ v/=1024; i++; }
  return `${v.toFixed(v>=10 || i===0 ? 0 : 1)} ${u[i]}`;
}
function safeName(name){
  return String(name||"bestand").replace(/[^\w.\- ]+/g,"_").trim();
}

async function listSectionFiles(projectId, sectionId){
  const { data, error } = await sb
    .from(FILES_TABLE)
    .select("*")
    .eq("project_id", projectId)
    .eq("section_id", sectionId)
    .order("created_at", { ascending:false });
  if(error) throw error;
  return data || [];
}

async function renderSectionFiles(blockEl){
  const projectId = blockEl.dataset.projectId;
  const sectionId = blockEl.dataset.sectionId;
  const listEl = blockEl.querySelector(".sec-files-list");
  if(!listEl) return;

  listEl.innerHTML = `<div class="muted">Laden…</div>`;

  let files = [];
  try { files = await listSectionFiles(projectId, sectionId); }
  catch(err){
    console.error("[FILES] list error", err);
    listEl.innerHTML = `<div class="muted">Kon bestanden niet laden.</div>`;
    return;
  }

  if(!files.length){
    listEl.innerHTML = `<div class="muted">Nog geen bestanden.</div>`;
    return;
  }

  listEl.innerHTML = files.map(f => `
    <div class="file-row" data-file-id="${f.id}">
      <div class="file-meta">
        <div class="file-name" title="${escapeHtml(f.file_name||"")}">${escapeHtml(f.file_name||"")}</div>
        <div class="file-sub">${escapeHtml(formatBytes(f.size_bytes))}${f.content_type ? " • " + escapeHtml(f.content_type) : ""}</div>
      </div>
      <div class="file-actions">
        <button class="btn small" type="button" data-act="open">Open</button>
        <button class="btn small" type="button" data-act="download">Download</button>
        <button class="btn small danger" type="button" data-act="delete">Verwijder</button>
      </div>
    </div>
  `).join("");
}

async function uploadFilesToSection(projectId, sectionId, fileList){
  const files = Array.from(fileList || []);
  if(!files.length) return;

  const userRes = await sb.auth.getUser();
  const userId = userRes?.data?.user?.id || null;

  for(const file of files){
    const original = safeName(file.name);
    const ts = new Date().toISOString().replace(/[:.]/g,"-");
    const path = `projects/${projectId}/sections/${sectionId}/${ts}_${original}`;

    console.log("[UPLOAD] start", { original, path });

    const { data: up, error: upErr } = await sb.storage
      .from(FILES_BUCKET)
      .upload(path, file, { contentType: file.type || "application/octet-stream", upsert:false });

    if(upErr){
      console.error("[UPLOAD] storage error", upErr);
      alert(`Upload mislukt: ${upErr.message || upErr}`);
      continue;
    }

    const { error: insErr } = await sb
      .from(FILES_TABLE)
      .insert({
        project_id: projectId,
        section_id: sectionId,
        file_path: up.path,
        file_name: original,
        content_type: file.type || null,
        size_bytes: file.size || null,
        uploaded_by: userId
      });

    if(insErr){
      console.error("[UPLOAD] db error", insErr);
      alert(`Opslaan in database mislukt: ${insErr.message || insErr}`);
      await sb.storage.from(FILES_BUCKET).remove([up.path]);
      continue;
    }

    console.log("[UPLOAD] done", original);
  }
}

let _filesDelegationWired = false;
function setupSectionFilesDelegation(){
  if(_filesDelegationWired) return;
  _filesDelegationWired = true;

  const body = el("secBody");
  if(!body) return;

  body.addEventListener("change", async (e) => {
    const input = e.target.closest(".secFileInput");
    if(!input) return;

    const block = input.closest(".sec-files");
    if(!block) return;

    const projectId = block.dataset.projectId;
    const sectionId = block.dataset.sectionId;

    console.log("[UPLOAD] change fired", input.files?.length, input.files?.[0]?.name, { projectId, sectionId });

    try{
      await uploadFilesToSection(projectId, sectionId, input.files);
      input.value = "";
      await renderSectionFiles(block);
    }catch(err){
      console.error("[UPLOAD] fatal", err);
      alert("Upload ging mis (zie console).");
    }
  });

  body.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if(!btn) return;

    const act = btn.dataset.act;
    const block = btn.closest(".sec-files");
    const row = btn.closest(".file-row");
    if(!block || !row) return;

    e.stopPropagation();

    const fileId = row.dataset.fileId;
    const projectId = block.dataset.projectId;
    const sectionId = block.dataset.sectionId;

    const files = await listSectionFiles(projectId, sectionId);
    const file = files.find(x => String(x.id) === String(fileId));
    if(!file) return;

    if(act === "open" || act === "download"){
      const { data, error } = await sb.storage.from(FILES_BUCKET).createSignedUrl(file.file_path, 120);
      if(error){ console.error(error); alert("Kon geen link maken."); return; }
      const url = data?.signedUrl;
      if(!url) return;

      if(act === "open"){
        window.open(url, "_blank", "noopener,noreferrer");
      }else{
        const a = document.createElement("a");
        a.href = url;
        a.download = file.file_name || "download";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    }

    if(act === "delete"){
      if(!confirm(`Bestand verwijderen?\n\n${file.file_name}`)) return;

      const { error: stErr } = await sb.storage.from(FILES_BUCKET).remove([file.file_path]);
      if(stErr){ console.error(stErr); alert("Kon storage bestand niet verwijderen."); return; }

      const { error: dbErr } = await sb.from(FILES_TABLE).delete().eq("id", file.id);
      if(dbErr){ console.error(dbErr); alert("Kon database record niet verwijderen."); return; }

      await renderSectionFiles(block);
    }
  });
}