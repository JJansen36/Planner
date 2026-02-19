// config.js
// 1) Vul je Supabase gegevens in
export const SUPABASE_URL = "https://zdtkxbacdchsyfxuknxk.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpkdGt4YmFjZGNoc3lmeHVrbnhrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njg1ODUxNTcsImV4cCI6MjA4NDE2MTE1N30.bIOBrjUq4jKFaUxH79OznuGS3BvBxrdsPZaLSJHlizw";

// 2) Pas dit aan naar je schema als kolomnamen anders zijn
export const DB = {
  tables: {
    customers: "klanten",
    projects: "projecten",
    sections: "secties",
    employees: "werknemers",
    capacityEntries: "capacity_entries",
    sectionWork: "section_work",
    projectPlans: "project_plan",
    projectOrders: "project_orders",
  },

  // Primary keys (pas aan naar jouw schema)
  projectPkCol: "project_id",
  customerPkCol: "customer_id",
  sectionPkCol: "section_id",

  // Medewerkers (tabel bestaat bij jou als 'werknemers')
  // Zet employeePkCol naar je echte PK kolomnaam (bv werknemer_id / employee_id)
  employeePkCol: "werknemer_id",
  // Naam kolom (als je die hebt). Als leeg, proberen we automatisch een paar bekende velden.
  employeeNameCol: "naam",

  // FK kolom in projecten -> klanten.customer_id
  projectCustomerFk: "customer_id",

  // FK kolom in secties -> projecten.project_id
  sectionProjectFk: "project_id",

  // Boolean veld op sectie om te bepalen of deze in planning zichtbaar is
  // Eerste bestaande kolom in deze lijst wordt gebruikt.
  sectionIncludeInPlanningCols: ["in_planning", "include_in_planning", "show_in_planning", "planning_visible"],

  // Project "header" titel: <OFFFERNO> - <name_kl> - <projectname>
  // Dit zijn kolommen in projecten en klanten:
  projectNoCol: "offerno",
  projectNameCol: "projectname",
  customerNameCol: "name_kl",

  // Velden voor de project-detail indeling (labels links, kolomnamen rechts)
  // Je kunt hier vrij velden toevoegen/verwijderen; UI rendert automatisch.
  projectBlocks: {
    // Linksboven (blauw) – project
    project: [
      { label: "Project nummer", col: "offerno" },
      { label: "Project naam", col: "projectname" },
    ],

    // Links midden (groen) – klant
    customer: [
      { label: "Klant", col: "name_kl" },
      { label: "Contact persoon", col: "fullname_kl" },
      { label: "Adres", col: "locaddress_kl" },
      { label: "Postcode + plaats", col: ["loczipcode_kl", "loccity_kl"], joiner: "  " },
      { label: "Telefoon", col: "phone_kl" },
      { label: "Mobiel contactpersoon", col: "mobilephone_kl" },
      { label: "Email contactpersoon", col: "email_kl" },
    ],

    // Links onder (blauw) – aflevergegevens (meestal in projecten; pas aan als dit in klanten zit)
    delivery: [
      { label: "Naam locatie", col: "deliveryname" },
      { label: "Contactpersoon", col: "deliveryfullname" },
      { label: "Adres", col: "deliveryadress" },
      { label: "Postcode + plaats", col: ["deliveryzipcode", "deliverycity"], joiner: "  " },
      { label: "Telefoon", col: "deliveryphone" },
      { label: "Email", col: "deliveryemail" },
    ],

    // Rechts (blauw) – orderstatus / datums / medewerkers
    order: [
      { label: "Order status", col: "salesstatus" },
      { label: "Invoerdatum", col: "entrydate", type: "date" },
      { label: "Offerte datum", col: "offerdate", type: "date" },
      { label: "Orderdatum", col: "orderdate", type: "date" },
      { label: "Productie datum", col: "proddate", type: "date" },
      { label: "Leverdatum", col: "deliverydate", type: "date" },
      { label: "Opleverdatum", col: "completiondate", type: "date" },
      { label: "Verkoper", col: "salesemployee" },
      { label: "Calculator", col: "offeremployee" },
    ],

    // Totalen (als je ze in projecten hebt, toon je ze hier; anders laten we ze berekenen uit secties)
    totals: [
      { label: "Totaal werkvoorbereiding uren", col: "total_wvb" },
      { label: "Totaal productie uren", col: "total_prod" },
      { label: "Totaal montage uren", col: "total_mont" },
      { label: "Totaal reis uren", col: "total_reis" },
    ],
  },

  // Secties overzicht (onderaan)
  // Welke kolommen tonen we in de tabel-rij?
sectionRowCols: [
  { label:"Paragraaf",   col:["paragraaf","paragraph","para"] },
  { label:"Omschrijving",col:["omschrijving","description","sectienaam","salestextrtf"] },
  { label:"Aantal",      col:["aantal","qty","quantity"] },
  { label:"Bijlage",     col:["bijlage","attachment","file"] },
],


  // Welke detailvelden tonen we als je een sectie openklapt?
  sectionDetailCols: [
    { label: "Tekst", col: "salestextrtf" },
    { label: "Werkvoorbereiding uren", col: "uren_wvb" },
    { label: "Productie uren", col: "uren_prod" },
    { label: "Montage uren", col: ["uren_montage", "uren_mont"] },
    { label: "Reis uren", col: "uren_reis" },
  ],

  // Planning regels
  planning: {
    // Werkdagen voor "1 werkdag" berekeningen (buffers)
    workdays: [1,2,3,4,5],
    // Buffers: montage eindigt 1 werkdag vóór opleverdatum, productie eindigt 1 werkdag vóór montage start
    bufferDaysMontageBeforeDue: 1,
    bufferDaysProdBeforeMontage: 1,
    // In de capaciteit-optelling tellen we alleen deze types mee als "gepland"
    plannedTypes: ["prod","mont"],
    // WVB later aparte capaciteit-lijn
    includeWvbInCapacity: false,
    // Reisuren bij montage optellen (voor berekening "gepland")
    addTravelToMontage: true,
  },
};
