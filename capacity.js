import { makeSupabaseClient, requireSession } from "./auth.js";

const sb = makeSupabaseClient();
const $ = (q) => document.querySelector(q);

const tbody = $("#tbl tbody");
const statusEl = $("#status");

$("#btnLogout").addEventListener("click", async () => {
  await sb.auth.signOut();
  location.href = "./login.html";
});

$("#btnRefresh").addEventListener("click", load);

document.addEventListener("DOMContentLoaded", init);

async function init() {
  await requireSession(sb);
  await load();
}

async function load() {
  statusEl.textContent = "Laden…";
  tbody.innerHTML = "";

  // Pas tabelnaam/kolommen aan als jouw schema anders heet
  const { data, error } = await sb
    .from("capacity_entries")
    .select("work_date, werknemer_id, hours, type, note")
    .order("work_date", { ascending: true })
    .limit(500);

  if (error) {
    console.error(error);
    statusEl.textContent = "Fout bij laden: " + error.message;
    return;
  }

  statusEl.textContent = data?.length ? `${data.length} regels` : "Geen data gevonden.";

  for (const r of data || []) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.work_date ?? "")}</td>
      <td>${escapeHtml(r.werknemer_id ?? "")}</td>
      <td>${escapeHtml(String(r.hours ?? ""))}</td>
      <td>${escapeHtml(r.type ?? "")}</td>
      <td>${escapeHtml(r.note ?? "")}</td>
    `;
    tbody.appendChild(tr);
  }
}

function escapeHtml(s){
  return String(s)
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}
