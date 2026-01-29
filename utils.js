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
