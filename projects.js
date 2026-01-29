// projects.js
import { makeSupabaseClient, requireSession, signOut } from "./auth.js";
import { DB } from "./config.js";
import { el, escapeHtml, setStatus, valFrom } from "./utils.js";

const sb = makeSupabaseClient();

let rows = [];

document.addEventListener("DOMContentLoaded", init);

async function init(){
  const session = await requireSession(sb);
  if(!session) return;

  el("btnLogout").addEventListener("click", ()=>signOut(sb));
  el("btnReload").addEventListener("click", load);
  el("q").addEventListener("input", render);

  await load();
}

async function load(){
  setStatus(el("status"), "Laden...");
  el("tbody").innerHTML = "";

  // We proberen eerst via relationship select (als FK relaties in Supabase staan)
  // Verwachte FK: projecten.(DB.projectCustomerFk) -> klanten.id
  // Als jouw FK anders heet: pas aan in config.js
  const tProj = DB.tables.projects;
  const tCust = DB.tables.customers;

  // 1) Probeer join via select
  const joinName = "klant"; // alias
  const { data, error } = await sb
    .from(tProj)
    .select(`id, ${DB.projectNoCol}, ${DB.projectNameCol}, salesstatus, ${DB.projectCustomerFk}, ${joinName}:${tCust}(id, ${DB.customerNameCol})`)
    .order(DB.projectNoCol, { ascending: false })
    .limit(500);

  if(error){
    console.warn("Join query failed, fallback to 2-step", error.message);
    // 2) Fallback: haal projecten op, dan klanten in tweede query
    const a = await sb
      .from(tProj)
      .select(`id, ${DB.projectNoCol}, ${DB.projectNameCol}, salesstatus, ${DB.projectCustomerFk}`)
      .order(DB.projectNoCol, { ascending: false })
      .limit(500);

    if(a.error){
      setStatus(el("status"), a.error.message, "error");
      return;
    }

    const custIds = [...new Set((a.data||[]).map(r=>r[DB.projectCustomerFk]).filter(Boolean))];
    const custMap = new Map();

    if(custIds.length){
      const b = await sb
        .from(tCust)
        .select(`id, ${DB.customerNameCol}`)
        .in("id", custIds);

      if(b.error){
        setStatus(el("status"), b.error.message, "error");
        return;
      }
      (b.data||[]).forEach(c=> custMap.set(c.id, c));
    }

    rows = (a.data||[]).map(p=> ({
      ...p,
      klant: custMap.get(p[DB.projectCustomerFk]) || null
    }));
  }else{
    rows = data || [];
  }

  setStatus(el("status"), "");
  render();
}

function render(){
  const q = (el("q").value || "").trim().toLowerCase();
  const filtered = !q ? rows : rows.filter(r=>{
    const no = (r[DB.projectNoCol] ?? "").toString().toLowerCase();
    const pr = (r[DB.projectNameCol] ?? "").toString().toLowerCase();
    const kn = (r.klant?.[DB.customerNameCol] ?? "").toString().toLowerCase();
    return no.includes(q) || pr.includes(q) || kn.includes(q);
  });

  el("meta").textContent = `${filtered.length} / ${rows.length}`;

  el("tbody").innerHTML = filtered.map(r=>{
    const id = r.id;
    const projectNo = escapeHtml(r[DB.projectNoCol] ?? "");
    const projectName = escapeHtml(r[DB.projectNameCol] ?? "");
    const klant = escapeHtml(r.klant?.[DB.customerNameCol] ?? "");
    const status = escapeHtml(r.salesstatus ?? "");
    return `
      <tr>
        <td><a class="pill" href="project.html?id=${encodeURIComponent(id)}">${projectNo}</a></td>
        <td>${klant}</td>
        <td>${projectName}</td>
        <td>${status}</td>
      </tr>
    `;
  }).join("");
}
