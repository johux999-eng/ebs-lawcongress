// Synchronisiert data.json mit den aktuellen Inhalten von www.ebs-lawcongress.com.
//
// Die Website ist mit Trickle gebaut; Programm, Speaker und Partner stehen als
// JavaScript-Literale in Inline-<script>-Tags. Dieses Skript führt keinen Code der
// Website aus: Es parst die Skripte mit acorn zu einem Syntaxbaum und liest daraus
// ausschließlich reine Literale (Objekte, Arrays, Strings, Zahlen) aus.
//
// Aufruf: node scripts/sync-data.mjs [--dry-run]
// Exit-Code 0 = OK (geändert oder unverändert), 1 = Fehler (data.json bleibt unangetastet).

import { parse } from 'acorn';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE = 'https://www.ebs-lawcongress.com/';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data.json');
const DRY = process.argv.includes('--dry-run');

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'user-agent': 'ebs-lawcongress-app-sync/1.0', 'cache-control': 'no-cache' },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

function inlineScripts(html) {
  const out = [];
  const re = /<script([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    if (/\bsrc=/.test(attrs) || /type="application\/ld\+json"/.test(attrs)) continue;
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

// --- Sichere Literal-Auswertung ------------------------------------------------

class Unsupported extends Error {}

function keyName(prop) {
  if (prop.computed) throw new Unsupported('computed key');
  if (prop.key.type === 'Identifier') return prop.key.name;
  if (prop.key.type === 'Literal') return String(prop.key.value);
  throw new Unsupported(prop.key.type);
}

function literal(node) {
  switch (node.type) {
    case 'Literal':
      if (node.regex) throw new Unsupported('regex');
      return node.value;
    case 'TemplateLiteral':
      if (node.expressions.length) throw new Unsupported('template expression');
      return node.quasis.map(q => q.value.cooked).join('');
    case 'ArrayExpression':
      return node.elements.map(el => {
        if (!el || el.type === 'SpreadElement') throw new Unsupported('array hole/spread');
        return literal(el);
      });
    case 'ObjectExpression': {
      const obj = {};
      for (const p of node.properties) {
        if (p.type !== 'Property' || p.kind !== 'init' || p.method) throw new Unsupported('object member');
        obj[keyName(p)] = literal(p.value);
      }
      return obj;
    }
    case 'UnaryExpression':
      if (node.operator === '-' && node.argument.type === 'Literal' && typeof node.argument.value === 'number') {
        return -node.argument.value;
      }
      if (node.operator === '!' && node.argument.type === 'Literal') return !node.argument.value;
      throw new Unsupported('unary ' + node.operator);
    case 'Identifier':
      if (node.name === 'undefined') return undefined;
      throw new Unsupported('identifier ' + node.name);
    default:
      throw new Unsupported(node.type);
  }
}

// Navigiert innerhalb eines ObjectExpression-Knotens zu einem Unterpfad, ohne den Rest auszuwerten.
function astPath(node, keys) {
  let cur = node;
  for (const k of keys) {
    if (!cur || cur.type !== 'ObjectExpression') return null;
    const p = cur.properties.find(pr => pr.type === 'Property' && !pr.computed && (() => {
      try { return keyName(pr) === k; } catch { return false; }
    })());
    if (!p) return null;
    cur = p.value;
  }
  return cur;
}

function memberPath(node) {
  const parts = [];
  while (node && node.type === 'MemberExpression' && !node.computed) {
    parts.unshift(node.property.name);
    node = node.object;
  }
  if (node && node.type === 'Identifier') parts.unshift(node.name);
  else return null;
  return parts.join('.');
}

// Sammelt Top-Level-Deklarationen (const/let/var X = ...) und Zuweisungen (a.b.c = ...).
function collect(scripts) {
  const decls = new Map();
  const assigns = new Map();
  for (const src of scripts) {
    let ast;
    try {
      ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
    } catch {
      continue;
    }
    for (const stmt of ast.body) {
      if (stmt.type === 'VariableDeclaration') {
        for (const d of stmt.declarations) {
          if (d.id.type === 'Identifier' && d.init && !decls.has(d.id.name)) decls.set(d.id.name, d.init);
        }
      } else if (stmt.type === 'ExpressionStatement') {
        const exprs = stmt.expression.type === 'SequenceExpression' ? stmt.expression.expressions : [stmt.expression];
        for (const e of exprs) {
          if (e.type === 'AssignmentExpression' && e.operator === '=') {
            const p = memberPath(e.left);
            if (p) assigns.set(p, e.right);
          }
        }
      }
    }
  }
  return { decls, assigns };
}

function need(value, label) {
  if (value === undefined || value === null) throw new Error(`Nicht gefunden: ${label}`);
  return value;
}

function get(map, name) {
  const node = map.get(name);
  if (!node) return undefined;
  try {
    return literal(node);
  } catch (e) {
    if (e instanceof Unsupported) throw new Error(`${name}: kein reines Literal (${e.message})`);
    throw e;
  }
}

// --- Aufbereitung -------------------------------------------------------------

const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const str = v => (typeof v === 'string' ? v.trim() : '');

function mapEvent(e) {
  const ev = {
    id: str(e.id),
    time: str(e.time),
    title: str(e.title),
    location: str(e.location),
    speaker: str(e.speaker),
    type: str(e.type) || 'other',
    description: str(e.description),
  };
  if (Array.isArray(e.subEvents) && e.subEvents.length) {
    ev.subEvents = e.subEvents.map(s => ({ time: str(s.time), title: str(s.title) }));
  }
  return ev;
}

function buildSchedule(de, enTitles = {}, enDescriptions = {}) {
  const scheduleDe = de.map(day => ({ day: str(day.day), events: day.events.map(mapEvent) }));
  // Gleiche Logik wie auf der Website: englische Titel/Beschreibungen über Lookup-Tabellen.
  const scheduleEn = scheduleDe.map(day => ({
    day: day.day.replace('Tag', 'Day'),
    events: day.events.map(e => {
      const out = {
        ...e,
        title: enTitles[e.title] || e.title,
        description: enDescriptions[e.id] !== undefined ? str(enDescriptions[e.id]) : e.description,
      };
      if (e.subEvents) out.subEvents = e.subEvents.map(s => ({ ...s, title: enTitles[s.title] || s.title }));
      return out;
    }),
  }));
  return { de: scheduleDe, en: scheduleEn };
}

function buildSpeakers(list) {
  const seen = new Set();
  return list.map(s => {
    let id = slug(str(s.name));
    while (seen.has(id)) id += '-x';
    seen.add(id);
    return {
      id,
      n: str(s.name),
      r: str(s.role),
      re: str(s.role_en) || str(s.role),
      c: str(s.organization),
      ce: str(s.organization_en) || str(s.organization),
      li: str(s.linkedin),
      img: str(s.image),
      bio: str(s.bio),
      bioe: str(s.bio_en) || str(s.bio),
    };
  });
}

function buildSponsors(list) {
  return list.map(s => ({ n: str(s.name), u: str(s.url), l: str(s.logo) })).filter(s => s.n);
}

function translationPart(transNode, lang, keys) {
  const node = transNode && astPath(transNode, [lang, ...keys]);
  if (!node) return undefined;
  try { return literal(node); } catch { return undefined; }
}

async function main() {
  const html = await fetchText(BASE);
  const { decls, assigns } = collect(inlineScripts(html));

  // Programm (aktueller Kongress)
  const scheduleDe = need(get(decls, 'schedule2026_DE'), 'schedule2026_DE');
  const schedule = buildSchedule(
    scheduleDe,
    get(decls, 'schedule2026_EN_TITLES') || {},
    get(decls, 'schedule2026_EN_DESCRIPTIONS') || {},
  );

  // Speaker
  const speakersNode = assigns.get('window.CongressData.speakers2026');
  const speakersRaw = need(speakersNode && literal(speakersNode), 'CongressData.speakers2026');
  const speakers = buildSpeakers(speakersRaw);

  // Partner
  const sponsors = buildSponsors(need(get(decls, 'currentSponsorsData'), 'currentSponsorsData'));

  // Eckdaten aus den Übersetzungen
  const trans = decls.get('translations');
  const heroDe = translationPart(trans, 'de', ['hero']) || {};
  const heroEn = translationPart(trans, 'en', ['hero']) || {};
  const roomsDe = translationPart(trans, 'de', ['roomPlan', 'rooms']) || {};
  const roomsEn = translationPart(trans, 'en', ['roomPlan', 'rooms']) || {};
  const roomNames = r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, str(v && v.name)]));

  const titleTag = (html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '';
  const edition = Number((titleTag.match(/(\d+)\.\s*EBS Law Congress/i) || [])[1]) || null;

  // Ticketshop-Link (eingebettet auf tickets.html)
  let ticketUrl = new URL('tickets.html', BASE).href;
  try {
    const t = await fetchText(new URL('tickets.html', BASE).href);
    const m = t.match(/https:\/\/vivenu\.com\/event\/[A-Za-z0-9_-]+/);
    if (m) ticketUrl = m[0];
  } catch (e) {
    console.warn('tickets.html nicht lesbar, nutze Fallback-Link:', e.message);
  }

  // Bilder (Logo, Hero-Foto, Raumplan) aus den Komponenten der Website
  const imgBy = (re, fallback) => { const m = html.match(re); return m ? m[1] : fallback; };
  const IMG = 'https://app.trickle.so/storage/[^"]+';
  const images = {
    logo: imgBy(new RegExp(`src:"(${IMG})",alt:"Law Congress Logo"`),
      'https://app.trickle.so/storage/public/images/usr_1a6da71af0000001/e5c2fd38-03c9-40e8-a275-becc52e0e3c8.png'),
    hero: imgBy(new RegExp(`src:"(${IMG})",alt:"Law Congress Background"`), ''),
    roomPlan: imgBy(new RegExp(`src:"(${IMG})",alt:t\\("roomPlan\\.mainTitle"\\)`), ''),
  };

  // Konkrete Kongresstage (ISO) aus dem Datumstext, z. B. "26. und 27. November 2026"
  const MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
  let days = [];
  const dm = str(heroDe.date).toLowerCase().match(/^(\d{1,2})\.(?:\s*(?:und|&|–|-)\s*(\d{1,2})\.)?\s*([a-zäöü]+)\s+(\d{4})/);
  if (dm && MONTHS.includes(dm[3])) {
    const mo = String(MONTHS.indexOf(dm[3]) + 1).padStart(2, '0');
    days = [dm[1], dm[2]].filter(Boolean).map(d => `${dm[4]}-${mo}-${d.padStart(2, '0')}`);
  }

  const content = {
    source: BASE,
    images,
    event: {
      edition,
      name: edition ? `${edition}. EBS Law Congress` : 'EBS Law Congress',
      motto: { de: str(heroDe.title), en: str(heroEn.title) || str(heroDe.title) },
      date: { de: str(heroDe.date), en: str(heroEn.date) || str(heroDe.date) },
      days,
      location: { de: str(heroDe.location), en: str(heroEn.location) || str(heroDe.location) },
      ticketUrl,
      website: BASE,
      instagram: 'https://www.instagram.com/ebs.lawcongress/',
    },
    rooms: { de: roomNames(roomsDe), en: roomNames(roomsEn) },
    schedule,
    speakers,
    sponsors,
  };

  // Plausibilitätsprüfung: lieber abbrechen als eine leere App ausliefern.
  const nEvents = schedule.de.reduce((n, d) => n + d.events.length, 0);
  if (schedule.de.length < 1 || nEvents < 3) throw new Error(`Programm unplausibel (${nEvents} Events)`);
  if (speakers.length < 1) throw new Error('Keine Speaker gefunden');
  if (sponsors.length < 1) throw new Error('Keine Partner gefunden');
  for (const d of schedule.de) for (const e of d.events) if (!e.id || !e.title) throw new Error('Event ohne id/title');

  let previous = null;
  try { previous = JSON.parse(await readFile(OUT, 'utf8')); } catch {}
  const strip = d => { if (!d) return null; const { updatedAt, ...rest } = d; return JSON.stringify(rest); };

  const summary = `${schedule.de.length} Tage, ${nEvents} Events, ${speakers.length} Speaker, ${sponsors.length} Partner`;
  if (previous && strip(previous) === JSON.stringify(content)) {
    console.log(`Unverändert (${summary}).`);
    return;
  }
  const data = { updatedAt: new Date().toISOString(), ...content };
  if (DRY) {
    console.log(`Änderungen gefunden (${summary}) – Dry-Run, nichts geschrieben.`);
    return;
  }
  await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
  console.log(`data.json aktualisiert (${summary}).`);
}

main().catch(err => {
  console.error('Sync fehlgeschlagen:', err.message);
  process.exit(1);
});
