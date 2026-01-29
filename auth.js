// auth.js
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./config.js";

export function makeSupabaseClient(){
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}

export async function requireSession(sb, redirectTo="login.html"){
  const { data, error } = await sb.auth.getSession();
  if(error) throw error;
  if(!data.session){
    location.href = redirectTo;
    return null;
  }
  return data.session;
}

export async function signOut(sb){
  await sb.auth.signOut();
  location.href = "login.html";
}
