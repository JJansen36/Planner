import { makeSupabaseClient, requireSession } from "./auth.js";
import { DB } from "./config.js";
import { el, setStatus } from "./utils.js";

const sb = makeSupabaseClient();
let currentOffset = 0; // Om door de weken te bladeren

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const session = await requireSession(sb);
  if (!session) return;

  el("btnPrev").onclick = () => { currentOffset--; loadPlanning(); };
  el("btnNext").onclick = () => { currentOffset++; loadPlanning(); };

  await loadPlanning();
}

async function loadPlanning() {
  setStatus(el("status"), "Planning berekenen...");
  
  // 1. Haal projecten op met hun secties
  const { data: projects, error } = await sb
    .from(DB.tables.projects)
    .select(`*, ${DB.tables.sections}(*)`);

  if (error) {
    setStatus(el("status"), error.message, "error");
    return;
  }

  renderGantt(projects);
  setStatus(el("status"), "");
}

function renderGantt(projects) {
  const container = el("planningGrid");
  container.innerHTML = ""; // Reset

  // De PDF toont rijen per project met balken voor de fases
  projects.forEach(proj => {
    const row = document.createElement("div");
    row.className = "project-timeline-row";
    
    // Bereken datums op basis van de config-buffers
    // Productie eindigt (bufferDaysProdBeforeMontage) dagen voor Montage
    
    row.innerHTML = `
      <div class="project-info">
        <strong>${proj[DB.projectNoCol]}</strong><br>
        <small>${proj[DB.projectNameCol]}</small>
      </div>
      <div class="timeline-lane">
        <div class="bar bar-wvb" title="WVB uren: ${proj.total_wvb || 0}"></div>
        <div class="bar bar-prod" title="Prod uren: ${proj.total_prod || 0}"></div>
      </div>
    `;
    container.appendChild(row);
  });
}