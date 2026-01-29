// menu.js
import { makeSupabaseClient, requireSession, signOut } from "./auth.js";
import { el, setStatus } from "./utils.js";

const sb = makeSupabaseClient();

document.addEventListener("DOMContentLoaded", init);

async function init(){
  try{
    const session = await requireSession(sb);
    if(!session) return;

    el("who").textContent = session.user.email;
    el("btnLogout").addEventListener("click", ()=>signOut(sb));
  }catch(err){
    console.error(err);
    setStatus(el("status"), (err?.message || "Onbekende fout"), "error");
  }
}
