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
  },

    // Primary key kolommen (BELANGRIJK!)
  projectPkCol: "project_id",  // <-- jouw projecten PK
  customerPkCol: "klant_id",   // <-- alleen aanpassen als klanten géén "id" heeft
  sectionPkCol: "id",          // <-- alleen aanpassen als secties géén "id" heeft


  // FK kolom in projecten -> klanten.id (pas aan als je bv customer_id gebruikt)
  projectCustomerFk: "klant_id",

  // FK kolom in secties -> projecten.id (pas aan als je bv project_id gebruikt)
  sectionProjectFk: "project_id",

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
    { label: "Paragraaf", col: "paragraph" },
    { label: "Omschrijving", col: "description" },
    { label: "Aantal", col: "quantity" },
    { label: "Bijlage", col: "bijlage" },
  ],

  // Welke detailvelden tonen we als je een sectie openklapt?
  sectionDetailCols: [
    { label: "Tekst", col: "text" },
    { label: "Werkvoorbereiding uren", col: "uren_wvb" },
    { label: "Productie uren", col: "uren_prod" },
    { label: "Montage uren", col: "uren_mont" },
    { label: "Reis uren", col: "uren_reis" },
  ],
};
