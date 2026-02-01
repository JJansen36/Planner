// utils.js
export function el(id){ return document.getElementById(id); }
export function q(sel, root=document){ return root.querySelector(sel); }
export function qa(sel, root=document){ return [...root.querySelectorAll(sel)]; }

export function escapeHtml(s){
  return (s ?? "").toString()
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");
}

export function getParam(name){
  const u = new URL(location.href);
  return u.searchParams.get(name);
}

// Compat aliases (used in newer pages)
export const getQueryParam = getParam;

export function setQueryParam(name, value){
  const u = new URL(location.href);
  if(value===null || value===undefined || value==="") u.searchParams.delete(name);
  else u.searchParams.set(name, value);
  history.replaceState(null, "", u.toString());
}

export function parseISODate(s){
  // expects YYYY-MM-DD
  if(!s) return null;
  const [y,m,d] = s.split("-").map(Number);
  if(!y || !m || !d) return null;
  return new Date(y, m-1, d);
}

export function toISODate(d){
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const dd = String(d.getDate()).padStart(2,"0");
  return `${yyyy}-${mm}-${dd}`;
}

export function addDays(d, n){
  const x = new Date(d);
  x.setDate(x.getDate()+n);
  return x;
}

export function startOfISOWeek(d){
  const x = new Date(d);
  const day = (x.getDay()+6)%7; // Monday=0
  x.setHours(0,0,0,0);
  x.setDate(x.getDate() - day);
  return x;
}

export function setStatus(node, msg, kind="notice"){
  node.innerHTML = msg ? `<div class="${kind}">${escapeHtml(msg)}</div>` : "";
}

export function fmtDate(v){
  if(!v) return "";
  // Accept ISO string or Date-like
  const d = new Date(v);
  if(Number.isNaN(d.getTime())) return (v ?? "").toString();
  const dd = String(d.getDate()).padStart(2,"0");
  const mm = String(d.getMonth()+1).padStart(2,"0");
  const yy = d.getFullYear();
  return `${dd}-${mm}-${yy}`;
}

export function valFrom(obj, colDef){
  // colDef can be string OR array
  if(Array.isArray(colDef)){
    return colDef.map(c => obj?.[c]).filter(Boolean).join(" ");
  }
  return obj?.[colDef];
}

export function sumNums(rows, col){
  return rows.reduce((acc,r)=> acc + (Number(r?.[col])||0), 0);
}
