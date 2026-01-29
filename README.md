# LOVD – Planning (start clean)
Deze mini-webapp is een **schone basis** voor je nieuwe (capaciteit) planning in Supabase.

## Wat zit erin
- **login.html** – inloggen (email + password)
- **index.html** – menu (nu alleen: Projecten)
- **projects.html** – lijst + zoeken (projectnummer / klant / projectnaam)
- **project.html** – projectdetail met indeling zoals je mockup + secties als uitklapbare rijen

## Install
1. Zet je Supabase URL + anon key in `config.js`
2. Zorg dat je tabellen bestaan:
   - `klanten` (groen)
   - `projecten` (blauw)
   - `secties` (paars)
3. Zet RLS policies zodat ingelogde users mogen **lezen** (zie onderaan).
4. Open `login.html` (of host de map via GitHub Pages / Netlify / lokale webserver)

> Tip: lokaal via VS Code “Live Server” of `python -m http.server`.

## Belangrijk: kolomnamen / relaties
Omdat ik je exacte kolomnamen niet 100% weet, staat alles **configureerbaar** in `config.js`:
- welke kolom in `projecten` wijst naar klant (`projectCustomerFk`)
- welke kolom in `secties` wijst naar project (`sectionProjectFk`)
- welke velden we tonen in de UI per blok

Pas dat aan naar je echte schema en je bent klaar.

## RLS (voorbeeld – alleen lezen voor ingelogde users)
Voer in Supabase SQL editor uit (pas aan als je strikter wilt):

```sql
alter table public.klanten enable row level security;
alter table public.projecten enable row level security;
alter table public.secties enable row level security;

create policy "read klanten (auth)"
on public.klanten for select
to authenticated
using (true);

create policy "read projecten (auth)"
on public.projecten for select
to authenticated
using (true);

create policy "read secties (auth)"
on public.secties for select
to authenticated
using (true);
```

## Volgende stap
Als dit werkt bouwen we door naar:
- klanten, team, voertuigen
- capaciteit (uren vs beschikbaarheid) + weekplanning view
- rollen (admin/hoofd/gebruiker) en RLS per team
