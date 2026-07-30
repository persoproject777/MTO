#!/usr/bin/env node
/**
 * Pré-calcul des données servies par le CDN GitHub.
 * Exécuté par GitHub Actions, jamais par le navigateur du visiteur.
 *
 * Objectif : chaque serveur d'origine est interrogé UNE fois par cycle au lieu
 * d'une fois par visiteur. Les fichiers produits sont allégés (tableaux
 * positionnels, coordonnées à trois décimales) puis servis depuis le CDN.
 *
 * CE FICHIER EST LA SEULE SOURCE DE VÉRITÉ.
 * Auparavant, la même logique existait en trois exemplaires : ce fichier, une
 * copie à la racine (build-data.js, jamais exécutée et dont le chemin de sortie
 * pointait hors du dépôt), et un document en ligne recopié dans le workflow qui
 * écrasait celui-ci à chaque exécution. Les trois avaient divergé. Le workflow
 * se contente désormais d'appeler ce script.
 *
 *   node scripts/build.js fast   séismes, événements NASA, alertes ONU, vigilances
 *   node scripts/build.js slow   périmètres brûlés Copernicus (lent et instable)
 *
 * Un flux indisponible ne fait jamais échouer le travail et n'efface jamais les
 * données déjà en place.
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data");
fs.mkdirSync(OUT, { recursive: true });

const now = Date.now();
const p3 = v => Math.round(v * 1e3) / 1e3;
const UA = "planete-en-direct (+https://github.com/persoproject777/MTO)";

async function get(url, ms, headers) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms || 45000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: Object.assign({ "User-Agent": UA }, headers || {})
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

/* ---------- Écriture ----------
   Chaque fichier porte un horodatage `t`, ce qui le rendait différent à chaque
   exécution : le dépôt recevait donc un commit toutes les dix minutes même
   quand aucune donnée n'avait bougé. On compare maintenant la charge utile
   SANS l'horodatage ; si elle est identique, le fichier est laissé tel quel.
   Un flux calme ne produit plus aucun commit. */
/* Plusieurs de ces API ne garantissent pas l'ordre de leurs entrées : deux
   réponses identiques peuvent arriver dans un ordre différent. Sans tri, la
   comparaison ci-dessous verrait un changement à chaque cycle et le robot
   commiterait quand même pour rien. On ordonne donc tout de façon stable. */
const byKey = k => (a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : 0; };

const WROTE = [];
const PRESENT = [];
function write(name, obj, label) {
  const file = path.join(OUT, name);
  PRESENT.push(name.replace(".json", ""));
  const fresh = JSON.stringify(obj);
  const payload = JSON.stringify(Object.assign({}, obj, { t: 0 }));
  if (fs.existsSync(file)) {
    try {
      const old = JSON.parse(fs.readFileSync(file, "utf8"));
      if (JSON.stringify(Object.assign({}, old, { t: 0 })) === payload) {
        console.log("  =  " + name.padEnd(14) + " inchangé — " + label);
        return false;
      }
    } catch (e) { /* fichier illisible : on le réécrit */ }
  }
  fs.writeFileSync(file, fresh);
  WROTE.push(name);
  console.log("  +  " + name.padEnd(14) + String(Math.round(fresh.length / 1024)).padStart(5) + " ko   " + label);
  return true;
}

/* ---------- Séismes (USGS) ---------- */
async function quakes() {
  const d = await get("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson", 40000);
  const q = (d.features || []).map(f => {
    const p = f.properties, c = f.geometry.coordinates;
    return [p.mag, p.place || "", p.time, Math.round(c[2]), p3(c[1]), p3(c[0]), p.url || ""];
  }).filter(x => x[0] != null).sort((a, b) => b[2] - a[2]);
  write("quakes.json", { t: now, q }, q.length + " séismes");
}

/* ---------- Événements naturels (NASA EONET) ----------
   La grande majorité des événements « ouverts » ont plus de 90 jours et
   n'apportent rien. On ne garde que les 90 derniers jours, et la trajectoire
   seulement pour les cyclones, qui en ont réellement besoin. */
async function eonet() {
  const d = await get("https://eonet.gsfc.nasa.gov/api/v3/events?status=open", 60000);
  const MAX = 90 * 864e5;
  const events = (d.events || []).map(ev => {
    const g = (ev.geometry || []).filter(x => x.type === "Point" && Array.isArray(x.coordinates));
    if (!g.length) return null;
    if (now - Date.parse(g[g.length - 1].date) > MAX) return null;
    const cat = (ev.categories && ev.categories[0] && ev.categories[0].id) || "";
    const keep = cat === "severeStorms"
      ? (g.length > 20 ? g.slice(-20) : g)
      : [g[0], g[g.length - 1]];
    const seen = new Set(), uniq = [];
    keep.forEach(x => { if (!seen.has(x.date)) { seen.add(x.date); uniq.push(x); } });
    return {
      t: ev.title, c: cat,
      s: (ev.sources && ev.sources[0] && ev.sources[0].url) || "",
      g: uniq.map(x => [p3(x.coordinates[1]), p3(x.coordinates[0]), Math.round(Date.parse(x.date) / 60000)])
    };
  }).filter(Boolean).sort(byKey(e => e.t + "|" + e.c));
  write("eonet.json", { t: now, events }, events.length + " événements (90 j)");
}

/* ---------- Alertes officielles ONU / Commission européenne (GDACS) ----------
   L'API JSON de GDACS est hors service : `geteventlist/MAP` n'a jamais répondu
   en cent secondes lors des essais, et `geteventlist/SEARCH` renvoie 503. Cela
   expliquait le « délai dépassé » constaté aussi bien dans le navigateur des
   visiteurs que dans ce robot — donc l'absence totale d'alertes officielles.

   Le flux RSS officiel, lui, répond en une seconde environ pour un mégaoctet.
   On l'utilise désormais. Il est plus riche que l'API : il porte l'emprise
   (bbox) et le lien vers l'alerte CAP normalisée.

   Analyse par expression régulière et non par vrai analyseur XML : ce flux est
   produit par une machine, sa forme est stable, et le script ne doit dépendre
   d'aucun paquet externe. */
function xmlUnescape(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&").trim();
}
function xmlTag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">"));
  return m ? xmlUnescape(m[1]) : "";
}

async function gdacs() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  let xml;
  try {
    const r = await fetch("https://www.gdacs.org/xml/rss.xml",
      { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    xml = await r.text();
  } finally { clearTimeout(t); }

  const items = xml.split("<item>").slice(1).map(s => s.split("</item>")[0]);
  const f = items.map(it => {
    const lat = parseFloat(xmlTag(it, "geo:lat"));
    const lon = parseFloat(xmlTag(it, "geo:long"));
    if (!isFinite(lat) || !isFinite(lon)) return null;
    /* bbox GDACS : « lonMin lonMax latMin latMax ». On la republie dans l'ordre
       attendu côté carte (ouest, sud, est, nord) pour délimiter l'emprise. */
    const bb = xmlTag(it, "gdacs:bbox").split(/\s+/).map(Number);
    const box = bb.length === 4 && bb.every(isFinite)
      ? [p3(bb[0]), p3(bb[2]), p3(bb[1]), p3(bb[3])] : null;
    return {
      t: xmlTag(it, "gdacs:eventtype"),
      a: xmlTag(it, "gdacs:alertlevel"),
      co: xmlTag(it, "gdacs:country"),
      /* Attention au piège : `gdacs:title` vaut « Event in rss format » et
         `gdacs:description` « Joint Research Center of the European Commission ».
         Ce sont des remplissages. L'information réelle est dans les balises RSS
         standard `title` (type, magnitude, lieu, heure) et `description`
         (phrase descriptive complète). */
      n: xmlTag(it, "title"),
      s: xmlTag(it, "description"),
      d: xmlTag(it, "gdacs:fromdate"),
      u: xmlTag(it, "link"),
      cap: xmlTag(it, "gdacs:cap") || "",
      id: xmlTag(it, "gdacs:eventid"),
      cur: xmlTag(it, "gdacs:iscurrent") === "true",
      sc: parseFloat(xmlTag(it, "gdacs:alertscore")) || 0,
      bb: box,
      c: [p3(lat), p3(lon)]
    };
  }).filter(Boolean)
    /* Les plus graves d'abord : la carte n'aura jamais à trier elle-même pour
       décider quoi dessiner en dernier, donc au-dessus. */
    .sort(byKey(x => ({ Red: 0, Orange: 1, Green: 2 }[x.a] ?? 3) + "|" + x.t + "|" + x.id));

  const rouge = f.filter(x => x.a === "Red").length;
  const orange = f.filter(x => x.a === "Orange").length;
  write("gdacs.json", { t: now, f },
    f.length + " alertes (" + rouge + " rouges, " + orange + " orange, " + (f.length - rouge - orange) + " vertes)");
}

/* ---------- FRONTIÈRES ET NOMS DE PAYS, EN FRANÇAIS ----------
   Les couches de référence toutes prêtes (Esri, CARTO) écrivent les pays EN
   ANGLAIS : « UNITED KINGDOM », « SPAIN », « GERMANY ». Sur une carte française
   c'est incohérent, et cela faisait doublon avec nos propres étiquettes de
   villes, elles en français. Vérifié tuile par tuile : aucune des deux couches
   Esri n'est un tracé pur — celle qui porte le moins d'étiquettes est la plus
   LOURDE au centre de la France (12,6 ko contre 4,1), signe qu'elle transporte
   routes et toponymes.

   On trace donc les frontières nous-mêmes, et on écrit les noms en français.
   Le nom vient d'`Intl.DisplayNames`, qui existe aussi côté Node : la table
   officielle, à jour, sans rien à maintenir. Mesuré : 177 pays, 171 avec un
   ISO_A2 valide, et les six manquants (dont la France) sont rattrapés par
   ISO_A2_EH. Zéro pays sans nom français.

   Le point d'étiquette est le centre de la plus GRANDE enveloppe, pas la
   moyenne de toutes : sinon « France » s'écrirait au milieu de l'Atlantique,
   entre la métropole et les Antilles. */
/* ---------- CRÉNEAUX D'IMAGES SATELLITE RÉELLEMENT PUBLIÉS ----------
   Piège coûteux, découvert en production : les images géostationnaires ne sont
   PAS publiées toutes les dix minutes de façon régulière. Relevé sur GOES-East :
     15:20, 15:30, [trou], 15:50, 16:00, [trou], 16:30, 16:40
   En calculant les créneaux moi-même par pas de dix minutes, je demandais des
   images qui n'existent pas — 86 tuiles en échec d'un coup dans le journal d'un
   visiteur, et une animation qui saute.

   Le service publie pourtant la liste exacte dans ses capacités, sous forme
   d'intervalles « début/fin/pas ». Le robot les lit et republie les derniers
   créneaux VALIDES. Le navigateur ne devine plus rien.

   On ne développe que les DERNIERS intervalles : la liste complète compte des
   milliers d'entrées remontant à plusieurs semaines, et seule l'heure écoulée
   nous intéresse. */
const GIBS_CAP = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml";
/* Le MEME produit pour les trois : deux rendus differents ne se raccordent pas,
   et la couture entre couleur naturelle et infrarouge etait visible en travers
   de la carte. L'infrarouge bande 13 existe pour les trois satellites. */
const GIBS_SATS = ["GOES-West_ABI_Band13_Clean_Infrared",
                   "GOES-East_ABI_Band13_Clean_Infrared",
                   "Himawari_AHI_Band13_Clean_Infrared"];
async function nuages() {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 60000);
  let xml;
  try {
    const r = await fetch(GIBS_CAP, { signal: ctl.signal, headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    xml = await r.text();
  } finally { clearTimeout(t); }

  const out = {};
  for (const nom of GIBS_SATS) {
    const i = xml.indexOf("<ows:Identifier>" + nom + "</ows:Identifier>");
    if (i < 0) continue;
    const deb = xml.lastIndexOf("<Layer>", i), fin = xml.indexOf("</Layer>", i);
    const bloc = xml.slice(deb, fin);
    const vals = [...bloc.matchAll(/<Value>([^<]+)<\/Value>/g)].map(m => m[1]);
    /* On remonte depuis la FIN jusqu'à tenir huit créneaux : c'est l'heure et
       quart la plus récente, tout ce dont l'animation a besoin. */
    const creneaux = [];
    for (let k = vals.length - 1; k >= 0 && creneaux.length < 8; k--) {
      const [a0, b0, pas] = vals[k].split("/");
      if (!b0 || !pas) { if (a0) creneaux.unshift(a0); continue; }
      const min = +(pas.match(/PT(\d+)M/) || [])[1];
      if (!min) { creneaux.unshift(b0); continue; }
      const d0 = Date.parse(a0), d1 = Date.parse(b0);
      if (!isFinite(d0) || !isFinite(d1)) continue;
      const loc = [];
      for (let x = d1; x >= d0 && loc.length < 8; x -= min * 60000)
        loc.unshift(new Date(x).toISOString().replace(".000", ""));
      creneaux.unshift(...loc);
    }
    const garde = creneaux.slice(-8);
    if (garde.length) out[nom] = garde;
  }
  const n = Object.values(out).reduce((a, b) => a + b.length, 0);
  const dernier = Object.values(out).map(v => v[v.length - 1]).sort().pop();
  write("nuages.json", { t: now, sats: out },
    n + " créneaux d'image sur " + Object.keys(out).length + " satellites"
    + (dernier ? " (dernier " + dernier.slice(11, 16) + " UTC)" : ""));
}

/* ---------- FRONTIÈRES TERRESTRES ET NOMS DE PAYS ----------
   ON NE TRACE PLUS LE CONTOUR DES PAYS, seulement les frontières TERRESTRES.
   Le contour d'un pays contient sa CÔTE, et une côte simplifiée posée sur de
   l'imagerie satellite précise déborde forcément : le trait passait dans la mer,
   coupait les golfes, mordait sur les îles. Or la côte, l'image la montre déjà —
   la redessiner n'apportait rien et gâchait tout.
   Natural Earth publie un jeu dédié aux seules limites entre pays. Mesuré :
     frontières terrestres 110m   0,32 Mo    3 k sommets
     frontières terrestres  50m   0,72 Mo   20 k sommets   <- retenu
     frontières terrestres  10m   2,18 Mo   77 k sommets
     contours de pays       50m   2,91 Mo   99 k sommets
   Le 50m est cinq fois plus fin que ce qu'on affichait, et PLUS LÉGER que les
   contours qu'il remplace. Aucun trait en mer, aucune côte redessinée.

   Les noms, eux, viennent d'un fichier séparé réduit à l'essentiel : un point et
   un nom par pays, sans la moindre géométrie — quelques kilo-octets au lieu de
   cent soixante-dix. */
const NE_BORNES = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
                + "master/geojson/ne_50m_admin_0_boundary_lines_land.geojson";
const NE110 = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/"
            + "master/geojson/ne_110m_admin_0_countries.geojson";

async function bornes() {
  const d = await get(NE_BORNES, 60000);
  /* Tolérance de 0,008° ≈ 900 m : invisible au niveau régional, où ces traits
     sont lus, et cela retire l'essentiel des sommets alignés. */
  const TOL = 0.008;
  const lignes = [];
  for (const x of (d.features || [])) {
    const g = x.geometry; if (!g) continue;
    const brins = g.type === "LineString" ? [g.coordinates] : g.coordinates;
    for (const b of brins) {
      if (!Array.isArray(b) || b.length < 2) continue;
      const r = dp(b, TOL).map(c => [p3(c[0]), p3(c[1])]);
      if (r.length >= 2) lignes.push(r);
    }
  }
  lignes.sort(byKey(l => String(Math.round(l[0][0] * 10)).padStart(6, "0") + "|"
                       + String(Math.round(l[0][1] * 10)).padStart(6, "0")));
  const som = lignes.reduce((n, l) => n + l.length, 0);
  write("bornes.json", { t: now, l: lignes },
    lignes.length + " frontières terrestres, " + som + " sommets");
}

function aireAnneau(a) {
  let s = 0;
  for (let i = 0; i < a.length - 1; i++) s += a[i][0] * a[i + 1][1] - a[i + 1][0] * a[i][1];
  return Math.abs(s / 2);
}
function pointEtiquette(g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
  let best = null, ba = -1;
  for (const p of polys) {
    const a = aireAnneau(p[0]);
    if (a > ba) { ba = a; best = p[0]; }
  }
  if (!best) return null;
  let x = 0, y = 0;
  for (const c of best) { x += c[0]; y += c[1]; }
  return [p3(y / best.length), p3(x / best.length)];
}
async function pays() {
  const d = await get(NE110, 60000);
  let fr = null;
  try { fr = new Intl.DisplayNames(["fr"], { type: "region" }); } catch (e) {}
  const f = (d.features || []).map(x => {
    const p = x.properties || {};
    const cc = (p.ISO_A2_EH && p.ISO_A2_EH !== "-99") ? p.ISO_A2_EH
             : (p.ISO_A2 && p.ISO_A2 !== "-99") ? p.ISO_A2 : "";
    let nom = "";
    if (cc && fr) { try { const v = fr.of(cc); if (v && v !== cc) nom = v; } catch (e) {} }
    if (!nom) nom = p.ADMIN || p.NAME || cc || "";
    const pt = pointEtiquette(x.geometry);
    if (!pt) return null;
    /* AUCUNE géométrie republiée : ce fichier ne sert qu'à placer les noms. */
    return { cc, n: nom, r: Math.round(Math.log10(Math.max(1, +p.POP_EST || 1))), c: pt };
  }).filter(Boolean).sort(byKey(x => x.cc + "|" + x.n));
  write("pays.json", { t: now, f }, f.length + " pays, noms français");
}

/* ---------- CONTOURS RÉELS DES ALERTES GDACS ----------
   RECTIFICATION IMPORTANTE. Le flux RSS ne porte aucune géométrie utile : son
   champ `gdacs:bbox` vaut toujours « centre ±4° », soit un carré fixe de 888 km
   qui n'apprend rien (c'est pourquoi il n'est plus dessiné). Et le lien CAP
   renvoie une page d'administration.
   J'en avais conclu que GDACS ne publiait AUCUN contour. C'ÉTAIT FAUX : il
   existe un point d'accès distinct, `getgeometry`, qui rend de vrais polygones.
   Mesuré : inondation en Chine, 2 polygones et 5 235 sommets, 53 ko ; inondation
   aux États-Unis, 2 polygones, 5 ko ; sécheresse européenne, 1 multipolygone.
   C'est la seule source sans clé donnant une emprise de SÉCHERESSE.

   On ne le demande que pour les alertes GRAVES et EN COURS : sur 341 alertes du
   flux, une douzaine seulement, donc une douzaine de requêtes par cycle. Et on
   simplifie : 5 235 sommets sur un écran de téléphone, c'est du poids pur. */
const GEOM_TYPES = ["FL", "DR", "TC", "WF"];
async function gdacsGeom() {
  let f = [];
  try { f = JSON.parse(fs.readFileSync(path.join(OUT, "gdacs.json"), "utf8")).f || []; }
  catch (e) { console.log("  …  contours GDACS : gdacs.json absent, on passe"); return; }

  const cibles = f.filter(x => (x.a === "Red" || x.a === "Orange") && x.cur
                            && GEOM_TYPES.includes(x.t) && x.id).slice(0, 14);
  if (!cibles.length) { write("gdacsgeo.json", { t: now, f: [] }, "aucune alerte grave à contourer"); return; }

  const out = [];
  for (const x of cibles) {
    const u = "https://www.gdacs.org/gdacsapi/api/polygons/getgeometry"
            + "?eventtype=" + x.t + "&eventid=" + x.id + "&episodeid=1";
    try {
      const d = await get(u, 30000);
      for (const g of (d.features || [])) {
        const ty = g.geometry && g.geometry.type;
        /* Le point est déjà porté par l'alerte elle-même : on ne garde que ce
           qui apporte une EMPRISE, c'est tout l'intérêt de cet appel. */
        if (ty !== "Polygon" && ty !== "MultiPolygon") continue;
        const pr = g.properties || {};
        out.push({
          id: x.id, t: x.t, a: x.a, co: x.co,
          /* `Class` distingue chez GDACS l'emprise observée de l'emprise
             prévue : on le republie tel quel plutôt que d'inventer un libellé. */
          cl: String(pr.Class || pr.class || ""),
          nm: String(pr.polygonlabel || pr.eventname || ""),
          g: { type: ty, coordinates: simpGeo(g.geometry.coordinates) }
        });
      }
    } catch (e) { /* une alerte sans contour n'est pas une panne */ }
  }
  const som = JSON.stringify(out).length;
  write("gdacsgeo.json", { t: now, f: out },
    out.length + " contours d'alerte (" + Math.round(som / 1024) + " ko)");
}

/* ---------- TORNADES ET ORAGES VIOLENTS (NWS, États-Unis) ----------
   Le seul flux ouvert au monde qui donne le POLYGONE d'une tornade en cours.
   Vérifié : les « Warning » portent un polygone en ligne ; les « Watch » n'en
   ont pas (elles renvoient à des zones administratives qu'il faudrait résoudre
   depuis une archive de 26 Mo au format shapefile — hors de portée d'un robot
   sans dépendances, donc écartées pour l'instant, et c'est dit).

   DEUX PIÈGES MESURÉS, à ne pas réintroduire :
   · l'en-tête User-Agent est OBLIGATOIRE — sans lui, la réponse est 403 ;
   · il faut TOUJOURS filtrer par `event`. La collection complète pesait
     1 145 ko le jour du test, et ce volume double selon la météo. */
const NWS_ORAGE = ["Tornado Warning", "Severe Thunderstorm Warning",
                   "Flash Flood Warning", "Extreme Wind Warning", "Dust Storm Warning"];
async function storms() {
  const u = "https://api.weather.gov/alerts/active?event="
          + NWS_ORAGE.map(encodeURIComponent).join(",");
  const d = await get(u, 45000, { Accept: "application/geo+json" });
  const f = (d.features || []).filter(x => x.geometry).map(x => {
    const p = x.properties || {};
    /* Le code VTEC dit si l'alerte est NEUVE, PROLONGÉE, ou déjà ANNULÉE ou
       EXPIRÉE. Une alerte annulée qui traîne dans le flux ne doit jamais se
       lire comme une tornade en cours — c'est la règle du projet. */
    const vtec = String((p.parameters && p.parameters.VTEC && p.parameters.VTEC[0]) || "");
    const act = (vtec.match(/\/[A-Z]\.([A-Z]{3})\./) || [])[1] || "";
    /* Le déplacement du noyau orageux, quand il est publié : direction, vitesse
       et position d'origine. C'est une mesure du radar, pas une extrapolation. */
    const mot = String((p.parameters && p.parameters.eventMotionDescription
                       && p.parameters.eventMotionDescription[0]) || "");
    const mm = mot.match(/(\d{1,3})DEG\.\.\.(\d{1,3})KT\.\.\.(-?[\d.]+),(-?[\d.]+)/);
    return {
      ev: p.event || "", sev: p.severity || "", cert: p.certainty || "",
      urg: p.urgency || "", zone: p.areaDesc || "",
      d0: p.effective || p.sent || "", d1: p.expires || p.ends || "",
      /* ACTIVE tant que l'action VTEC n'est ni annulée ni expirée. */
      on: !(act === "CAN" || act === "EXP"),
      act,
      tor: String((p.parameters && p.parameters.tornadoDetection
                  && p.parameters.tornadoDetection[0]) || ""),
      grele: String((p.parameters && p.parameters.maxHailSize
                    && p.parameters.maxHailSize[0]) || ""),
      vent: String((p.parameters && p.parameters.maxWindGust
                   && p.parameters.maxWindGust[0]) || ""),
      dep: mm ? { brg: +mm[1], kt: +mm[2], c: [p3(+mm[3]), p3(+mm[4])] } : null,
      txt: String(p.headline || "").slice(0, 180),
      g: { type: x.geometry.type, coordinates: simpGeo(x.geometry.coordinates) }
    };
  }).sort(byKey(x => x.ev + "|" + x.zone + "|" + x.d0));

  const tor = f.filter(x => x.ev === "Tornado Warning").length;
  write("storms.json", { t: now, f },
    f.length + " orages violents (" + tor + " tornades)");
}

/* ---------- CENDRES VOLCANIQUES (SIGMET internationaux) ----------
   Mesuré : 138 SIGMET, dont 11 pour des cendres, TOUS avec des coordonnées.
   C'est la seule source ouverte donnant un polygone de nuage de cendres à
   l'échelle du monde — les VAAC eux-mêmes publient en texte ou en CSV maison. */
async function sigmet() {
  const d = await get("https://aviationweather.gov/api/data/isigmet?format=json", 30000);
  const f = (Array.isArray(d) ? d : []).filter(x => Array.isArray(x.coords) && x.coords.length >= 3)
    .map(x => ({
      h: String(x.hazard || ""),          /* VA = cendres, TS = orage, TURB, ICE… */
      q: String(x.qualifier || ""),
      fir: String(x.firName || x.firId || ""),
      d0: x.validTimeFrom || null, d1: x.validTimeTo || null,
      /* Tranche de niveaux de vol : c'est ce qui compte pour l'aviation. */
      b: x.base == null ? null : +x.base, tp: x.top == null ? null : +x.top,
      txt: String(x.rawSigmet || "").replace(/\s+/g, " ").slice(0, 240),
      g: { type: "Polygon", coordinates: [x.coords.map(c => [p3(c.lon), p3(c.lat)])] }
    }))
    .sort(byKey(x => x.h + "|" + x.fir + "|" + String(x.d0)));
  const va = f.filter(x => /VA|ASH/i.test(x.h)).length;
  write("sigmet.json", { t: now, f },
    f.length + " SIGMET (" + va + " cendres volcaniques)");
}

/* ---------- VIGILANCES EUROPÉENNES (MeteoAlarm) ----------
   La seule source ouverte qui couvre la FRANCE. L'API temps réel de
   Météo-France exige une clé, et son archive ouverte accuse trois semaines de
   retard (vérifié : dernier dossier au 9 juillet) — elle ne convient donc pas.

   MeteoAlarm publie du CAP sans aucune géométrie : uniquement des codes NUTS3,
   c'est-à-dire les départements en France. C'est le robot qui va chercher les
   contours chez Eurostat (1 143 ko pour 1 345 unités) et n'en republie QUE les
   zones réellement en vigilance — le visiteur ne reçoit jamais le fichier
   complet. */
/* LA FRANCE ET ELLE SEULE, et c'est une contrainte de la donnee, pas un choix.
   J'ai tire les flux des dix pays et releve leur systeme de codes de zone :
     france          NUTS3        <- resolvable
     spain, italy, portugal, austria, netherlands   EMMA_ID
     germany         EMMA_ID, WARNCELLID
     belgium         EMMA_ID, NUTS2   (trop grossier : une region entiere)
     switzerland, united-kingdom      AUCUN code
   EMMA_ID est un identifiant interne a MeteoAlarm, dont je n'ai trouve aucun
   fichier de contours publie. Dessiner ces pays exigerait d'inventer leurs
   limites : exclu. La couche s'appelle donc « Vigilance France » et ne pretend
   pas couvrir l'Europe. */
const MA_PAYS = ["france"];
/* On traduit d'après le LIBELLÉ publié dans le flux, pas d'après le numéro.
   Première version de ce tableau : j'avais deviné les numéros, et je me suis
   trompé — 13 est « pluie-inondation », pas « vent de terre », et 12 est
   « inondation », pas « vagues ». Le libellé, lui, est dans la donnée. */
const MA_TYPE = {
  "wind":"Vent", "snow-ice":"Neige et verglas", "thunderstorm":"Orages",
  "fog":"Brouillard", "high-temperature":"Chaleur extrême",
  "low-temperature":"Grand froid", "coastalevent":"Submersion côtière",
  "coastal-event":"Submersion côtière", "forest-fire":"Feu de forêt",
  "forestfire":"Feu de forêt", "avalanches":"Avalanches", "avalanche":"Avalanches",
  "rain":"Pluie", "flooding":"Inondation", "flood":"Inondation",
  "rain-flood":"Pluie-inondation", "rainflood":"Pluie-inondation"
};
const MA_NIV = { 1:"vert", 2:"jaune", 3:"orange", 4:"rouge" };
let NUTS = null;
async function chargeNuts() {
  if (NUTS) return NUTS;
  /* MILLESIME 2013, et surtout pas un plus recent. Verifie code par code :
     les identifiants du flux (FR814, FR421, FR422, FR434) existent dans la
     nomenclature 2013 et NULLE PART ailleurs — 5 sur 5 en 2013, 1 sur 5 en
     2016, 2021 et 2024. Charger le millesime courant donnait zero jointure,
     donc une couche vide, sans le moindre message d'erreur. */
  const d = await get("https://gisco-services.ec.europa.eu/distribution/v2/nuts/geojson/"
                    + "NUTS_RG_60M_2013_4326_LEVL_3.geojson", 60000);
  NUTS = new Map();
  for (const f of (d.features || [])) {
    const id = f.properties && f.properties.NUTS_ID;
    if (id && f.geometry) NUTS.set(id, f.geometry);
  }
  return NUTS;
}
async function meteoalarm() {
  const nuts = await chargeNuts();
  const zones = new Map();   /* code NUTS3 → la vigilance la plus grave */
  let lus = 0;
  for (const pays of MA_PAYS) {
    let d;
    try { d = await get("https://feeds.meteoalarm.org/api/v1/warnings/feeds-" + pays, 30000); }
    catch (e) { continue; }
    lus++;
    for (const w of (d.warnings || [])) {
      const al = w.alert; if (!al || !Array.isArray(al.info)) continue;
      for (const inf of al.info) {
        const par = {};
        for (const p of (inf.parameter || [])) par[p.valueName] = p.value;
        /* PIÈGE : ces champs sont des CHAÎNES, « 2; yellow; Moderate » et
           « 13; rain-flood », pas des nombres. Les additionner donnait NaN,
           donc un niveau de 0, donc zéro vigilance retenue sur les 82 du flux
           français — la couche était vide sans que rien ne le signale. */
        const nivS = String(par.awareness_level || "");
        const niv  = +((nivS.match(/^\s*(\d)/) || [])[1] || 0);
        const typS = String(par.awareness_type || "");
        const typL = (typS.split(";")[1] || "").trim().toLowerCase();
        if (niv < 2) continue;             /* le vert n'est pas une vigilance */
        /* Une vigilance PÉRIMÉE ne doit jamais se lire comme une vigilance en
           cours : le flux en conserve plusieurs jours. Règle du projet. */
        const fin = inf.expires ? Date.parse(inf.expires) : NaN;
        if (isFinite(fin) && fin < now) continue;
        for (const ar of (inf.area || [])) {
          for (const gc of (ar.geocode || [])) {
            if (gc.valueName !== "NUTS3" || !nuts.has(gc.value)) continue;
            const anc = zones.get(gc.value);
            if (anc && anc.niv >= niv) continue;   /* on garde le plus grave */
            zones.set(gc.value, {
              niv, typL,
              nm: String(ar.areaDesc || ""),
              pays,
              d0: inf.onset || inf.effective || null,
              d1: inf.expires || null,
              txt: String(inf.description || inf.headline || "").replace(/\s+/g, " ").slice(0, 220)
            });
          }
        }
      }
    }
  }
  const f = [...zones.entries()].map(([id, v]) => ({
    id, niv: v.niv, nivn: MA_NIV[v.niv] || "",
    /* Si le libellé n'est pas dans le tableau, on republie l'original tel quel
       plutôt que d'inventer une traduction. */
    typn: MA_TYPE[v.typL] || v.typL || "",
    nm: v.nm, pays: v.pays, d0: v.d0, d1: v.d1, txt: v.txt,
    g: { type: nuts.get(id).type, coordinates: simpGeo(nuts.get(id).coordinates) }
  })).sort(byKey(x => (9 - x.niv) + "|" + x.id));
  const rouge = f.filter(x => x.niv === 4).length, orange = f.filter(x => x.niv === 3).length;
  write("meteoalarm.json", { t: now, f },
    f.length + " departements en vigilance (" + rouge + " rouges, " + orange + " orange)");
}

/* ---------- Vigilances des météorologues d'État (NWS, États-Unis) ---------- */
async function nws() {
  const d = await get("https://api.weather.gov/alerts/active?status=actual&severity=Extreme,Severe",
    45000, { Accept: "application/geo+json" });
  /* On tronque D'ABORD dans l'ordre de la source — elle place les vigilances les
     plus pertinentes en tête, et trier avant de couper retiendrait 120 alertes
     arbitraires. Le tri ne sert qu'à stabiliser la comparaison, il vient donc
     après la troncature. */
  const f = (d.features || []).filter(x => x.geometry).slice(0, 120)
    .sort(byKey(x => String((x.properties && x.properties.id) || x.id || "")));
  write("nws.json", { t: now, type: "FeatureCollection", features: f }, f.length + " vigilances");
}

/* ---------- Foyers satellite : vue mondiale ----------
   Mesure qui a motivé cette tâche : la requête que le navigateur envoyait pour
   la vue mondiale mettait 12,4 secondes. C'était de loin le poste le plus lent
   de tout le chargement. La raison est simple : filtrer par une enveloppe
   géographique qui couvre la planète entière coûte cher au serveur ArcGIS.

   Il y a 59 820 détections VIIRS sur 24 h dans le monde. On n'en a pas besoin
   de 59 820 pour une vue mondiale — on n'y dessine même plus les foyers
   individuels, seulement les sinistres agrégés. On garde donc les plus
   puissants, qui sont précisément ceux qui forment les sinistres visibles.

   Le navigateur continue d'interroger la source en direct dès qu'on approche :
   l'enveloppe est alors petite, la réponse rapide, et la précision totale. */
async function hotspots() {
  const VIIRS = "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/Satellite_VIIRS_Thermal_Hotspots_and_Fire_Activity/FeatureServer/0/query";
  const MODIS = "https://services9.arcgis.com/RHVPKKiFTONKtxq3/arcgis/rest/services/MODIS_Thermal_v1/FeatureServer/1/query";
  const CF = { low: 0, nominal: 1, high: 2 };

  /* FILTRE DE FRAÎCHEUR, indispensable. La couche contient plus de 24 h
     d'historique : trier par puissance sans borner la date remontait des
     détections vieilles de plus de quatre jours, qui auraient formé des
     sinistres fantômes sur la vue mondiale. Avec la borne, les âges vont de
     2 à 13 h pour VIIRS et de 2 à 24 h pour MODIS — c'est bien « ce qui brûle
     en ce moment ». */
  const v = await get(VIIRS + "?where=acq_date%3E%3DCURRENT_TIMESTAMP-1"
    + "&outFields=latitude,longitude,frp,confidence,acq_time,bright_ti4,scan,track"
    + "&returnGeometry=false&outSR=4326&f=json&orderByFields=frp%20DESC&resultRecordCount=3000", 90000);
  /* [lat, lon, frp, confiance, horodatage, température, scan, track, capteur]
     Format positionnel : trois fois plus léger que le JSON verbeux d'ArcGIS. */
  const out = (v.features || []).map(f => {
    const a = f.attributes || {};
    if (a.latitude == null || a.longitude == null) return null;
    return [p3(a.latitude), p3(a.longitude), Math.round((a.frp || 0) * 10) / 10,
      CF[String(a.confidence).toLowerCase()] ?? 1, a.acq_time || 0,
      Math.round(a.bright_ti4 || 0), a.scan || 0.375, a.track || 0.375, 0];
  }).filter(Boolean);

  /* MODIS complète VIIRS : résolution plus grossière mais passages à d'autres
     heures, souvent plus récents. Les deux réunis couvrent cinq satellites. */
  try {
    const m = await get(MODIS + "?where=ACQ_DATE%3E%3DCURRENT_TIMESTAMP-1"
      + "&outFields=SCAN,TRACK,SATELLITE,CONFIDENCE,FRP,ACQ_DATE,BRIGHTNESS"
      + "&outSR=4326&f=geojson&orderByFields=FRP%20DESC&resultRecordCount=1200&geometryPrecision=4", 90000);
    const vus = new Set(out.map(h => Math.round(h[0] / 0.0045) + "_" + Math.round(h[1] / 0.0045)));
    (m.features || []).forEach(f => {
      const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
      if (!c) return;
      const k = Math.round(c[1] / 0.0045) + "_" + Math.round(c[0] / 0.0045);
      if (vus.has(k)) return;                       /* déjà vu par VIIRS, plus fin */
      const cn = typeof p.CONFIDENCE === "number" ? (p.CONFIDENCE >= 80 ? 2 : p.CONFIDENCE >= 30 ? 1 : 0)
        : (CF[String(p.CONFIDENCE).toLowerCase()] ?? 1);
      out.push([p3(c[1]), p3(c[0]), Math.round((p.FRP || 0) * 10) / 10, cn,
        p.ACQ_DATE || 0, Math.round(p.BRIGHTNESS || 0), p.SCAN || 1, p.TRACK || 1, 1]);
    });
  } catch (e) { console.log("     MODIS indisponible : " + e.message); }

  if (out.length < 100) { console.log("  !  foyers : trop peu de points (" + out.length + "), fichier conservé"); return false; }
  out.sort(byKey(h => String(Math.round(1e6 - h[2] * 10)).padStart(9, "0") + "|" + h[0] + "|" + h[1]));
  write("hot.json", { t: now, h: out }, out.length + " foyers (les plus puissants du monde)");
  return true;
}

/* ---------- Qualité de l'air mondiale ----------
   Même raisonnement que pour le vent : la grille de particules fines était
   demandée par chaque visiteur, et elle échouait en 400 ou 429 dès que le
   plafond horaire d'Open-Meteo était atteint. Grille de 12°, soit 435 points. */
async function air() {
  const STEP = 12, pts = [];
  for (let la = -60; la <= 72; la += STEP)
    for (let lo = -180; lo < 180; lo += STEP) pts.push([la, lo]);
  const cells = [];
  for (let i = 0; i < pts.length; i += 100) {
    const chunk = pts.slice(i, i + 100);
    try {
      const d = await get("https://air-quality-api.open-meteo.com/v1/air-quality"
        + "?latitude=" + chunk.map(p => p[0]).join(",")
        + "&longitude=" + chunk.map(p => p[1]).join(",")
        + "&current=european_aqi,pm2_5", 45000);
      (Array.isArray(d) ? d : [d]).forEach((o, j) => {
        if (!o || !o.current || !chunk[j]) return;
        const aqi = o.current.european_aqi, pm = o.current.pm2_5;
        if (aqi == null) return;
        cells.push([chunk[j][0], chunk[j][1], Math.round(aqi), Math.round((pm || 0) * 10) / 10]);
      });
    } catch (e) { console.log("     bloc air " + (i / 100 + 1) + " : " + e.message); }
    if (i + 100 < pts.length) await new Promise(r => setTimeout(r, 900));
  }
  if (cells.length < 100) { console.log("  !  air : trop peu de points (" + cells.length + "), fichier conservé"); return false; }
  cells.sort(byKey(c => String(c[0]).padStart(5, "0") + "|" + String(c[1]).padStart(5, "0")));
  write("air.json", { t: now, step: STEP, cells }, cells.length + " points de qualité de l'air");
  return true;
}

/* ---------- Champ de vent mondial ----------
   POURQUOI CETTE TÂCHE EXISTE
   Open-Meteo plafonne à 5 000 mesures par heure et PAR ADRESSE IP. Chaque
   visiteur interrogeait le service pour lui-même, et le plafond était atteint en
   quelques secondes d'ouverture : plus de vent, plus de températures, un écran
   vide et un message d'erreur. C'est le même raisonnement que pour GDACS ou les
   séismes — une requête par cycle depuis l'infrastructure, pas une par visiteur.

   Grille de 10°, de -80° à 80° de latitude : 612 points, soit sept requêtes.
   Résolution volontairement grossière : elle sert de fond de carte du vent à
   l'échelle mondiale et continentale. Le navigateur continue d'affiner autour de
   ce que l'utilisateur regarde quand le service le lui permet, mais il a
   désormais toujours un champ complet à afficher, même à quota épuisé.

   Rafraîchi au maximum une fois par heure : à cette résolution, un champ de vent
   ne change pas de façon perceptible en quinze minutes, et cela garde la
   consommation à environ 600 mesures par heure au lieu de 2 400. */
/* ---------- VENT ----------
   RÉSOLUTION : le pas est passé de 10° à 5°.
   À 10°, deux points de grille sont distants d'environ 1 100 km. Or un typhon
   mesure 300 à 800 km de diamètre : il tenait ENTIÈREMENT ENTRE DEUX POINTS.
   L'interpolation ne pouvait donc rien en faire d'autre qu'un écoulement lisse
   et presque uniforme — exactement ce qu'on voyait passer tout droit au large
   de Hong Kong pendant qu'un cyclone y tournait. Ce n'était pas un défaut de
   tracé : la donnée ne contenait tout simplement pas la rotation.
   5° ramène l'écart à 550 km. C'est mieux partout, mais cela ne suffit toujours
   pas pour un cyclone — d'où la grille fine dédiée, plus bas. */
async function wind() {
  const STEP = 5, pts = [];
  for (let la = -80; la <= 80; la += STEP)
    for (let lo = -180; lo < 180; lo += STEP) pts.push([la, lo]);

  const cells = [];
  for (let i = 0; i < pts.length; i += 100) {
    const chunk = pts.slice(i, i + 100);
    const u = "https://api.open-meteo.com/v1/forecast"
      + "?latitude=" + chunk.map(p => p[0]).join(",")
      + "&longitude=" + chunk.map(p => p[1]).join(",")
      + "&current=wind_speed_10m,wind_direction_10m";
    try {
      const d = await get(u, 45000);
      const arr = Array.isArray(d) ? d : [d];
      arr.forEach((o, j) => {
        if (!o || !o.current || !chunk[j]) return;
        const sp = o.current.wind_speed_10m, di = o.current.wind_direction_10m;
        if (sp == null || di == null) return;
        /* On stocke les composantes, pas la direction : le navigateur interpole
           linéairement entre quatre cellules, ce qui est faux sur un angle
           (350° et 10° donneraient 180°) mais exact sur des composantes. */
        const r = (di + 180) * Math.PI / 180;
        cells.push([chunk[j][0], chunk[j][1],
          Math.round(sp * Math.sin(r) * 100) / 100,
          Math.round(sp * Math.cos(r) * 100) / 100]);
      });
    } catch (e) {
      console.log("     bloc " + (i / 100 + 1) + " : " + e.message);
    }
    if (i + 100 < pts.length) await new Promise(r => setTimeout(r, 900));
  }
  if (cells.length < 200) { console.log("  !  vent : trop peu de points (" + cells.length + "), fichier conservé"); return false; }
  cells.sort(byKey(c => String(c[0]).padStart(5, "0") + "|" + String(c[1]).padStart(5, "0")));
  write("wind.json", { t: now, step: STEP, cells }, cells.length + " points de vent (grille " + STEP + "°)");
  return true;
}

/* ---------- Périmètres brûlés (Copernicus EFFIS) ----------
   Source la plus lente et la plus instable de toutes. Un contour de zone brûlée
   n'évolue pas d'une minute à l'autre : une fois par jour suffit.
   Les contours bruts comptent jusqu'à 126 000 sommets ; on les réduit à
   48 points par anneau sans supprimer aucune zone. Mémoire divisée par trois
   côté navigateur, précision visuellement identique à l'échelle de la carte. */
function simp(ring, k) {
  if (ring.length <= k) return ring;
  const step = ring.length / k, out = [];
  for (let i = 0; i < k; i++) out.push(ring[Math.floor(i * step)]);
  out.push(ring[ring.length - 1]);
  return out;
}

/* ---------- SIMPLIFICATION QUI RESPECTE LA FORME (Douglas-Peucker) ----------
   `simp` ci-dessus garde « un point sur N » sans regarder la géométrie. Sur un
   périmètre de zone brûlée, dont on ne juge que l'ordre de grandeur, cela passe.
   Sur une FRONTIÈRE, c'est désastreux : les angles sont coupés au hasard, et le
   trait se met à traverser la mer ou à mordre sur le pays voisin — c'est
   exactement ce qui donnait l'impression que tout débordait.
   Douglas-Peucker, lui, conserve les sommets qui portent la forme et supprime
   ceux qui sont alignés : à nombre de points égal, le tracé reste juste. */
function dp(pts, tol) {
  if (pts.length < 3) return pts;
  const sq = t => t * t;
  /* Distance d'un point au segment, au carré — pas de racine, inutile ici. */
  const d2 = (p, a, b) => {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx || dy) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; }
      else if (t > 0) { x += dx * t; y += dy * t; }
    }
    return sq(p[0] - x) + sq(p[1] - y);
  };
  const t2 = sq(tol), garde = new Array(pts.length).fill(false);
  garde[0] = garde[pts.length - 1] = true;
  /* Pile explicite plutôt que récursion : certaines frontières comptent des
     milliers de sommets et la pile d'appels y passerait. */
  const pile = [[0, pts.length - 1]];
  while (pile.length) {
    const [i, j] = pile.pop();
    let max = 0, k = -1;
    for (let m = i + 1; m < j; m++) {
      const d = d2(pts[m], pts[i], pts[j]);
      if (d > max) { max = d; k = m; }
    }
    if (max > t2 && k > 0) { garde[k] = true; pile.push([i, k], [k, j]); }
  }
  return pts.filter((_, i) => garde[i]);
}
const simpGeo = c => Array.isArray(c[0]) && Array.isArray(c[0][0]) ? c.map(simpGeo) : simp(c, 48);

async function effis() {
  const zones = [["eu", "-11,35,32,60"], ["med", "-8,29,42,46"]];
  const out = { t: now, type: "FeatureCollection", features: [] };
  let ok = 0;
  for (const [name, bbox] of zones) {
    try {
      const u = "https://maps.wild-fire.eu/effis?service=WFS&version=1.0.0&request=GetFeature"
        + "&typeName=ms:modis.ba.poly.season&outputFormat=geojson&maxFeatures=600"
        + "&srsName=EPSG:4326&bbox=" + bbox;
      const d = await get(u, 120000);
      (d.features || []).forEach(f => {
        const p = f.properties || {};
        f.properties = {
          COMMUNE: p.COMMUNE, PROVINCE: p.PROVINCE, COUNTRY: p.COUNTRY,
          AREA_HA: p.AREA_HA, FIREDATE: p.FIREDATE, LASTUPDATE: p.LASTUPDATE
        };
        const round = c => Array.isArray(c[0]) ? c.map(round) : [p3(c[0]), p3(c[1])];
        if (f.geometry && f.geometry.coordinates)
          f.geometry.coordinates = simpGeo(round(f.geometry.coordinates));
        out.features.push(f);
      });
      ok++;
      console.log("     zone " + name + " : " + (d.features || []).length + " périmètres");
    } catch (e) {
      console.log("     zone " + name + " : échec (" + e.message + ") — on garde l'existant");
    }
  }
  if (ok && out.features.length) {
    out.features.sort(byKey(f => {
      const p = f.properties || {}, c = f.geometry && f.geometry.coordinates;
      let first = "";
      let cur = c;
      while (Array.isArray(cur) && Array.isArray(cur[0])) cur = cur[0];
      if (Array.isArray(cur)) first = cur.join(",");
      return (p.COUNTRY || "") + "|" + (p.PROVINCE || "") + "|" + (p.COMMUNE || "") + "|" + (p.FIREDATE || "") + "|" + first;
    }));
    write("effis.json", out, out.features.length + " périmètres");
    return true;
  }
  console.log("  !  effis.json inchangé (aucune zone n'a répondu)");
  if (fs.existsSync(path.join(OUT, "effis.json"))) PRESENT.push("effis");
  return false;
}

/* ---------- Orchestration ---------- */
(async () => {
  const only = process.argv[2] || "fast";
  console.log("Pré-calcul (" + only + ") — " + new Date(now).toISOString());

  /* État précédent : sert à savoir quels fichiers existent déjà et quand la
     source lente a été tentée pour la dernière fois. */
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(path.join(OUT, "meta.json"), "utf8")); } catch (e) {}

  const tasks = only === "slow"
    ? [["effis", effis]]
    /* `gdacsGeom` vient APRÈS `gdacs` : il relit gdacs.json pour savoir quelles
       alertes méritent qu'on aille chercher leur contour. L'ordre compte. */
    /* `pays` est un fond STATIQUE : les frontieres ne bougent pas toutes les
       quinze minutes. Il n'est reconstruit que s'il manque — le comparateur
       d'ecriture s'en charge, la tache ne coute donc rien les autres fois. */
    : [["bornes", bornes], ["pays", pays], ["nuages", nuages], ["quakes", quakes], ["eonet", eonet], ["gdacs", gdacs], ["gdacsgeo", gdacsGeom],
       ["nws", nws], ["storms", storms], ["sigmet", sigmet], ["meteoalarm", meteoalarm],
       ["hotspots", hotspots]];

  let failed = 0;
  for (const [name, fn] of tasks) {
    try { await fn(); }
    catch (e) { failed++; console.log("  x  " + name.padEnd(14) + " échec : " + e.message); }
  }

  /* Rattrapage de la source lente.
     Le déclencheur quotidien dédié n'a jamais été honoré par GitHub : data/effis.json
     n'a donc jamais existé, et la couche « Périmètres » interrogeait en direct le
     serveur le plus lent du lot chez chaque visiteur. Le cycle rapide rattrape
     désormais lui-même : si le fichier manque ou dépasse vingt heures, il le
     reconstruit. Une tentative infructueuse n'est pas relancée avant trois heures,
     pour ne pas matraquer un serveur en panne à chaque cycle. */
  /* Champ de vent : au maximum une fois par heure (voir la tâche pour le
     détail). On le rattache au cycle rapide plutôt qu'à un déclencheur dédié —
     le déclencheur quotidien d'EFFIS n'a jamais été honoré par GitHub, la leçon
     est retenue. */
  let windAt = prev.windAt || 0;
  if (only === "fast") {
    const wf = path.join(OUT, "wind.json");
    let wAge = Infinity;
    if (fs.existsSync(wf)) {
      try { wAge = now - (JSON.parse(fs.readFileSync(wf, "utf8")).t || 0); } catch (e) {}
    }
    if (wAge > 50 * 60e3 && now - windAt > 45 * 60e3) {
      console.log("  …  vent " + (wAge === Infinity ? "absent" : "vieux de " + Math.round(wAge / 60e3) + " min") + " — reconstruction");
      windAt = now;
      try { await wind(); } catch (e) { console.log("  x  vent échec : " + e.message); }
      /* La qualité de l'air suit le même rythme horaire que le vent : les deux
         viennent d'Open-Meteo, autant grouper leur consommation. */
      try { await air(); } catch (e) { console.log("  x  air échec : " + e.message); }
    } else {
      if (fs.existsSync(wf)) PRESENT.push("wind");
      if (fs.existsSync(path.join(OUT, "air.json"))) PRESENT.push("air");
    }
  }

  let effisTried = prev.effisTried || 0;
  if (only === "fast") {
    const f = path.join(OUT, "effis.json");
    let age = Infinity;
    if (fs.existsSync(f)) {
      try { age = now - (JSON.parse(fs.readFileSync(f, "utf8")).t || 0); } catch (e) {}
    }
    const stale = age > 20 * 3600e3;
    /* Délai de reprise ramené de 3 h à 1 h. Les passages du robot étant eux-mêmes
       irréguliers — le planificateur de GitHub en écarte beaucoup — un délai de
       trois heures se cumulait avec ces absences, et le fichier n'a jamais fini
       par être produit. Une heure laisse largement le serveur EFFIS souffler
       sans que le rattrapage devienne inatteignable. */
    const cooled = now - effisTried > 3600e3;
    if (stale && cooled) {
      console.log("  …  effis.json " + (age === Infinity ? "absent" : "vieux de " + Math.round(age / 3600e3) + " h") + " — rattrapage");
      effisTried = now;
      try { await effis(); } catch (e) { console.log("  x  effis échec : " + e.message); }
    } else if (fs.existsSync(f)) {
      PRESENT.push("effis");
    }
  }

  /* Liste exacte des fichiers réellement disponibles : la carte ne demandera
     jamais un fichier absent, donc plus aucune erreur 404 dans son journal. */
  const files = [];
  fs.readdirSync(OUT).forEach(f => {
    if (f.endsWith(".json") && f !== "meta.json") files.push(f.replace(".json", ""));
  });
  PRESENT.forEach(n => { if (files.indexOf(n) < 0) files.push(n); });
  files.sort();

  /* meta.json n'est réécrit que s'il change vraiment. Comme il portait
     `built: Date.now()`, il différait à chaque exécution et garantissait à lui
     seul un commit par cycle, même quand aucune donnée n'avait bougé. */
  const listChanged = JSON.stringify(prev.files || []) !== JSON.stringify(files);
  const triedChanged = (prev.effisTried || 0) !== effisTried || (prev.windAt || 0) !== windAt;
  if (WROTE.length || listChanged || triedChanged) {
    fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
      built: now, builtISO: new Date(now).toISOString(), kind: only, files, effisTried, windAt
    }));
    console.log("  +  meta.json      " + files.length + " fichiers : " + files.join(", "));
  } else {
    console.log("  =  meta.json      inchangé");
  }

  console.log(WROTE.length
    ? "Terminé — " + WROTE.length + " fichier(s) mis à jour" + (failed ? ", " + failed + " échec(s)" : "") + "."
    : "Terminé — aucune donnée n'a changé" + (failed ? " (" + failed + " échec(s))" : "") + ", aucun commit à faire.");
  process.exit(0);
})();
