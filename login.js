// login.js
import { makeSupabaseClient } from "./auth.js";
import { el, setStatus } from "./utils.js";

const sb = makeSupabaseClient();

document.addEventListener("DOMContentLoaded", init);

async function init(){
  // Als je al ingelogd bent: door naar menu
  const { data } = await sb.auth.getSession();
  if(data?.session){
    location.href = "index.html";
    return;
  }

  el("btnLogin").addEventListener("click", doLogin);
  el("btnDemo").addEventListener("click", ()=> {
    el("email").value = (el("email").value || "jeroen@lovdinteriors.nl");
    el("password").focus();
  });

  // Enter = login
  ["email","password"].forEach(id=>{
    el(id).addEventListener("keydown", (e)=>{
      if(e.key==="Enter") doLogin();
    });
  });
}

async function doLogin(){
  const email = el("email").value.trim();
  const password = el("password").value;

  setStatus(el("status"), "");

  if(!email || !password){
    setStatus(el("status"), "Vul email en wachtwoord in.", "error");
    return;
  }

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if(error){
    setStatus(el("status"), error.message, "error");
    return;
  }
  location.href = "index.html";
}
