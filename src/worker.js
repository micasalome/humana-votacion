// Worker de la votación "Humana para humanos".
// - /api/votos     GET: conteo para los porcentajes y el Top 3 · POST: guarda un voto
// - /api/exportar  GET ?clave=...: descarga todos los votos en CSV (se abre en Excel)
// - Todo lo demás: la página y las fotos (carpeta public/)

import { LIMPIEZA_1 } from './limpieza1.js';
import { LIMPIEZA_2 } from './limpieza2.js';

const CIERRE = Date.parse('2026-11-11T17:00:00-05:00'); // miércoles 11 nov, 5:00 p. m. (Ecuador)
const CIUDADES = ['quito', 'guayaquil', 'cuenca'];
// Votación en pausa: no se aceptan votos nuevos (los votos guardados y los resultados se mantienen). Cambiar a false para reabrir.
const PAUSADA = false;
let tablaLista = false;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function prepararTabla(db) {
  if (tablaLista) return;
  await db.prepare(
    // Cada voto es una fila nueva: una misma persona puede votar varias veces
    "CREATE TABLE IF NOT EXISTS votos_campana (id INTEGER PRIMARY KEY AUTOINCREMENT, votante TEXT NOT NULL, quito TEXT NOT NULL, guayaquil TEXT NOT NULL, cuenca TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  // Registro de votantes: nombre, apellido y correo (un voto por correo)
  for (const col of ['nombre', 'apellido', 'correo']) {
    try { await db.prepare(`ALTER TABLE votos_campana ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`).run(); } catch (e) { /* ya existe */ }
  }
  await db.prepare("CREATE TABLE IF NOT EXISTS registros (correo TEXT PRIMARY KEY, nombre TEXT NOT NULL, apellido TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')))").run();
  // Filtros anti-robots: conexión cifrada y navegador de cada voto, un voto por dispositivo y fichas de un solo uso
  for (const col of ['conexion', 'navegador']) {
    try { await db.prepare(`ALTER TABLE votos_campana ADD COLUMN ${col} TEXT NOT NULL DEFAULT ''`).run(); } catch (e) { /* ya existe */ }
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS idx_votos_conexion ON votos_campana (conexion, creado)').run();
  await db.prepare("CREATE TABLE IF NOT EXISTS dispositivos (votante TEXT PRIMARY KEY, creado TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.prepare("CREATE TABLE IF NOT EXISTS fichas (ficha TEXT PRIMARY KEY, creado TEXT NOT NULL DEFAULT (datetime('now')))").run();
  await db.prepare('CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT)').run();
  const marca = await db.prepare("SELECT valor FROM ajustes WHERE clave = 'dispositivos_v1'").first();
  if (!marca) {
    // Una sola vez: los dispositivos que ya votaron no pueden volver a votar
    const lote = [db.prepare('INSERT OR IGNORE INTO dispositivos (votante) SELECT DISTINCT votante FROM votos_campana')];
    try { await db.prepare('SELECT 1 FROM votos_publico LIMIT 1').all(); lote.push(db.prepare('INSERT OR IGNORE INTO dispositivos (votante) SELECT DISTINCT votante FROM votos_publico')); } catch (e) {}
    lote.push(db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('dispositivos_v1', datetime('now'))"));
    await db.batch(lote);
  }
  tablaLista = true;
}

// Conteo rápido: se lee la tabla "resumen" (una fila por foto) en vez de recorrer todos los votos.
// Así cada visita lee pocas filas (el plan gratis de Cloudflare permite 5 millones de lecturas al día).
let resumenListo = false;
async function prepararResumen(db) {
  if (resumenListo) return;
  await db.prepare('CREATE TABLE IF NOT EXISTS resumen (ciudad TEXT NOT NULL, foto TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (ciudad, foto))').run();
  await db.prepare('CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT)').run();
  const hecho = await db.prepare("SELECT valor FROM ajustes WHERE clave = 'resumen_v1'").first();
  if (!hecho) {
    // Una sola vez: se arma el resumen con los votos de antes del lanzamiento (votos_publico) y los actuales (votos_campana)
    const armar = (conVieja) => db.batch([
      db.prepare('DELETE FROM resumen'),
      ...CIUDADES.map((k) => db.prepare(
        `INSERT INTO resumen (ciudad, foto, n) SELECT '${k}', foto, SUM(n) FROM (` +
        (conVieja ? `SELECT ${k} AS foto, COUNT(*) AS n FROM votos_publico WHERE ${k} <> '' GROUP BY ${k} UNION ALL ` : '') +
        `SELECT ${k} AS foto, COUNT(*) AS n FROM votos_campana WHERE ${k} <> '' GROUP BY ${k}) GROUP BY foto`
      )),
      db.prepare("INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('resumen_v1', datetime('now'))")
    ]);
    try { await armar(true); } catch (e) { await armar(false); }
  }
  resumenListo = true;
}

// Limpieza única de votos indicados por Humana (votos-humana_BORRAR.xlsx).
// Todo va en un solo lote atómico y protegido por la marca 'limpieza_1': se aplica una sola vez.
let limpiezaLista = false;
async function aplicarLimpieza(db) {
  if (limpiezaLista) return;
  const hecho = await db.prepare("SELECT valor FROM ajustes WHERE clave = 'limpieza_1'").first();
  if (hecho) { limpiezaLista = true; return; }
  const G = "NOT EXISTS (SELECT 1 FROM ajustes WHERE clave = 'limpieza_1')";
  const lote = (conVieja) => {
    const fuente = (conVieja
      ? "SELECT 'p' AS tb, id, votante AS v, datetime(creado, '-5 hours') AS f, quito AS q, guayaquil AS g, cuenca AS c FROM votos_publico UNION ALL "
      : '') +
      "SELECT 'c' AS tb, id, votante AS v, datetime(creado, '-5 hours') AS f, quito AS q, guayaquil AS g, cuenca AS c FROM votos_campana";
    return [
      db.prepare('CREATE TABLE IF NOT EXISTS borrar (f TEXT, v TEXT, q TEXT, g TEXT, c TEXT, n INTEGER)'),
      db.prepare('CREATE TABLE IF NOT EXISTS borrar_ids (tb TEXT, id INTEGER)'),
      db.prepare('DELETE FROM borrar'),
      db.prepare('DELETE FROM borrar_ids'),
      ...LIMPIEZA_1.map((sql) => db.prepare(sql)),
      db.prepare(
        'INSERT INTO borrar_ids (tb, id) SELECT tb, id FROM (' +
        'SELECT t.tb, t.id, b.n, ROW_NUMBER() OVER (PARTITION BY t.v, t.f, t.q, t.g, t.c ORDER BY t.tb DESC, t.id) AS rn ' +
        'FROM (' + fuente + ') t JOIN borrar b ON b.v = t.v AND b.f = t.f AND b.q = t.q AND b.g = t.g AND b.c = t.c' +
        ') WHERE rn <= n AND ' + G
      ),
      ...(conVieja ? [db.prepare("DELETE FROM votos_publico WHERE id IN (SELECT id FROM borrar_ids WHERE tb = 'p')")] : []),
      db.prepare("DELETE FROM votos_campana WHERE id IN (SELECT id FROM borrar_ids WHERE tb = 'c')"),
      db.prepare('DELETE FROM resumen'),
      ...CIUDADES.map((k) => db.prepare(
        `INSERT INTO resumen (ciudad, foto, n) SELECT '${k}', foto, SUM(n) FROM (` +
        (conVieja ? `SELECT ${k} AS foto, COUNT(*) AS n FROM votos_publico WHERE ${k} <> '' GROUP BY ${k} UNION ALL ` : '') +
        `SELECT ${k} AS foto, COUNT(*) AS n FROM votos_campana WHERE ${k} <> '' GROUP BY ${k}) GROUP BY foto`
      )),
      db.prepare(
        "INSERT INTO ajustes (clave, valor) SELECT 'limpieza_1', 'borrados ' || (SELECT COUNT(*) FROM borrar_ids) || ' de ' || (SELECT SUM(n) FROM borrar) || ' · ' || datetime('now', '-5 hours') WHERE " + G
      ),
      db.prepare('DELETE FROM borrar')
    ];
  };
  try { await db.batch(lote(true)); } catch (e) { await db.batch(lote(false)); }
  limpiezaLista = true;
}

// Segunda limpieza (9 nov 2026): votos de robots / registros masivos. Una sola vez, en un lote atómico.
let limpieza2Lista = false;
async function aplicarLimpieza2(db) {
  if (limpieza2Lista) return;
  const hecho = await db.prepare("SELECT valor FROM ajustes WHERE clave = 'limpieza_2'").first();
  if (hecho) { limpieza2Lista = true; return; }
  const G = "NOT EXISTS (SELECT 1 FROM ajustes WHERE clave = 'limpieza_2')";
  const lote = (conVieja) => [
    db.prepare('CREATE TABLE IF NOT EXISTS borrar2 (f TEXT, v TEXT, q TEXT, g TEXT, c TEXT, correo TEXT, n INTEGER)'),
    db.prepare('CREATE TABLE IF NOT EXISTS borrar2_ids (id INTEGER)'),
    db.prepare('DELETE FROM borrar2'),
    db.prepare('DELETE FROM borrar2_ids'),
    ...LIMPIEZA_2.map((sql) => db.prepare(sql)),
    db.prepare(
      'INSERT INTO borrar2_ids (id) SELECT id FROM (' +
      "SELECT t.id, b.n, ROW_NUMBER() OVER (PARTITION BY t.votante, t.f, t.quito, t.guayaquil, t.cuenca, t.correo ORDER BY t.id) AS rn " +
      "FROM (SELECT id, votante, datetime(creado, '-5 hours') AS f, quito, guayaquil, cuenca, lower(correo) AS correo FROM votos_campana) t " +
      'JOIN borrar2 b ON b.v = t.votante AND b.f = t.f AND b.q = t.quito AND b.g = t.guayaquil AND b.c = t.cuenca AND b.correo = t.correo' +
      ') WHERE rn <= n AND ' + G
    ),
    db.prepare('DELETE FROM votos_campana WHERE id IN (SELECT id FROM borrar2_ids)'),
    db.prepare('DELETE FROM resumen'),
    ...CIUDADES.map((k) => db.prepare(
      `INSERT INTO resumen (ciudad, foto, n) SELECT '${k}', foto, SUM(n) FROM (` +
      (conVieja ? `SELECT ${k} AS foto, COUNT(*) AS n FROM votos_publico WHERE ${k} <> '' GROUP BY ${k} UNION ALL ` : '') +
      `SELECT ${k} AS foto, COUNT(*) AS n FROM votos_campana WHERE ${k} <> '' GROUP BY ${k}) GROUP BY foto`
    )),
    db.prepare(
      "INSERT INTO ajustes (clave, valor) SELECT 'limpieza_2', 'borrados ' || (SELECT COUNT(*) FROM borrar2_ids) || ' de ' || (SELECT SUM(n) FROM borrar2) || ' · ' || datetime('now', '-5 hours') WHERE " + G
    ),
    db.prepare('DELETE FROM borrar2')
  ];
  try { await db.batch(lote(true)); } catch (e) { await db.batch(lote(false)); }
  limpieza2Lista = true;
}

async function conteo(db) {
  const c = { quito: {}, guayaquil: {}, cuenca: {} };
  const { results } = await db.prepare('SELECT ciudad, foto, n FROM resumen').all();
  for (const r of results) if (c[r.ciudad]) c[r.ciudad][r.foto] = r.n;
  return c;
}

// ---------- Filtros para aceptar solo votos reales ----------
// Límites por conexión (IP cifrada). Son holgados para oficinas que comparten internet.
const LIMITES = { seg: 8, hora: 40, dia: 200 };
const FICHA_MIN_SEG = 3;            // la página debe estar abierta al menos 3 s antes de votar
const FICHA_MAX_SEG = 12 * 3600;    // una ficha vale 12 horas
const DESDE = Date.parse('2026-10-01T00:00:00Z');

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
let secreto = null;
async function obtenerSecreto(db) {
  if (secreto) return secreto;
  const nuevo = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT OR IGNORE INTO ajustes (clave, valor) VALUES ('firma_secreta', ?)").bind(nuevo).run();
  const r = await db.prepare("SELECT valor FROM ajustes WHERE clave = 'firma_secreta'").first();
  secreto = String(r.valor);
  return secreto;
}
async function hmac(clave, texto) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(texto)));
}
async function crearFicha(db) {
  const base = Date.now().toString(36) + '.' + hex(crypto.getRandomValues(new Uint8Array(8)));
  return base + '.' + (await hmac(await obtenerSecreto(db), 'ficha:' + base)).slice(0, 32);
}
async function fichaValida(db, ficha) {
  const m = /^([a-z0-9]{6,12})\.([0-9a-f]{16})\.([0-9a-f]{32})$/.exec(String(ficha || ''));
  if (!m) return false;
  const firma = (await hmac(await obtenerSecreto(db), 'ficha:' + m[1] + '.' + m[2])).slice(0, 32);
  if (firma !== m[3]) return false;
  const edad = (Date.now() - parseInt(m[1], 36)) / 1000;
  return edad >= FICHA_MIN_SEG && edad <= FICHA_MAX_SEG;
}
function idCoherente(id) {
  const m = /^v-([a-z0-9]{6,10})-([a-z0-9]{4,10})$/.exec(String(id || ''));
  if (!m) return false;
  const t = parseInt(m[1], 36);
  return t >= DESDE && t <= Date.now() + 86400000;
}

async function votar(request, db) {
  if (PAUSADA) return json({ ok: false, motivo: 'pausada' });
  if (Date.now() >= CIERRE) return json({ ok: false, motivo: 'cerrada' });
  // 1) Debe venir desde la propia página, en un navegador
  const url = new URL(request.url);
  const origen = request.headers.get('Origin') || '';
  const sitio = request.headers.get('Sec-Fetch-Site');
  const navegador = (request.headers.get('User-Agent') || '').slice(0, 200);
  if (origen !== url.origin || (sitio && sitio !== 'same-origin') || !/^Mozilla\/5\.0 /.test(navegador)) {
    return json({ ok: false, motivo: 'robot' }, 403);
  }
  let d;
  try { d = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, motivo: 'datos' }, 400); }
  // 2) Datos coherentes: una foto existente por cada ciudad y un identificador de dispositivo bien formado
  const valido = idCoherente(d.votante) &&
    CIUDADES.every((k) => { const m = new RegExp('^' + k + '-(\\d{1,3})$').exec(d[k] || ''); return m && +m[1] < NOMBRES[k].length; });
  if (!valido) return json({ ok: false, motivo: 'datos' }, 400);
  // 3) Ficha firmada que entrega la página al abrirse (de un solo uso)
  if (!(await fichaValida(db, d.ficha))) return json({ ok: false, motivo: 'robot' }, 403);
  // 4) Un voto por dispositivo
  if (await db.prepare('SELECT 1 FROM dispositivos WHERE votante = ?').bind(d.votante).first()) return json({ ok: false, motivo: 'ya_voto' });
  // 5) Límite de velocidad por conexión
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const conexion = ip ? (await hmac(await obtenerSecreto(db), 'ip:' + ip)).slice(0, 16) : '';
  if (conexion) {
    const r = await db.prepare(
      "SELECT SUM(creado > datetime('now', ?)) AS s, SUM(creado > datetime('now', '-1 hour')) AS h, COUNT(*) AS d FROM votos_campana WHERE conexion = ? AND creado > datetime('now', '-1 day')"
    ).bind('-' + LIMITES.seg + ' seconds', conexion).first();
    if ((r && r.s) > 0 || (r && r.h) >= LIMITES.hora || (r && r.d) >= LIMITES.dia) return json({ ok: false, motivo: 'limite' }, 429);
  }
  try {
    await db.batch([
      db.prepare('INSERT INTO fichas (ficha) VALUES (?)').bind(d.ficha),
      db.prepare('INSERT INTO dispositivos (votante) VALUES (?)').bind(d.votante),
      db.prepare('INSERT INTO votos_campana (votante, quito, guayaquil, cuenca, conexion, navegador) VALUES (?, ?, ?, ?, ?, ?)').bind(d.votante, d.quito, d.guayaquil, d.cuenca, conexion, navegador),
      ...CIUDADES.map((k) => db.prepare('INSERT INTO resumen (ciudad, foto, n) VALUES (?, ?, 1) ON CONFLICT (ciudad, foto) DO UPDATE SET n = n + 1').bind(k, d[k]))
    ]);
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e && e.message || e))) return json({ ok: false, motivo: 'ya_voto' });
    throw e;
  }
  return json({ ok: true, counts: await conteo(db) });
}

// Nombres de los participantes (deben coincidir con public/index.html)
const NOMBRES = {
  quito: ['Auditoría Médica', 'Técnico de Riesgos', 'Gerencia General', 'Inteligencia de Negocios', 'Liquidaciones', 'Cobranzas', 'CX Corporativo', 'Legal y Cumplimiento', 'Contabilidad', 'Compras y Administración', 'Sala de Ventas 4', 'Sala de Ventas 2', 'Calidad, Engagement y CX (Front)', 'Sala de Ventas 8', 'Sala de Ventas 10', 'Lealtad', 'Sala de Ventas 6', 'Sala de Ventas 14', 'Convenios', 'TI', 'Tesorería', 'Gestión de Proyectos', 'Producción', 'Talento Humano'],
  guayaquil: ['Josias Rojas', 'Gustavo Rojas', 'Gabriela Romero', 'Francis Aguirre', 'Freddy Peñafiel', 'Fadua Salinas', 'Evelyn Espinoza', 'Diego Rodriguez', 'Daniela Zambrano', 'Christian Gracia', 'Carolina Naula', 'Claudia Herrera', 'Carol Gavilanez', 'Yahimara Narvaez', 'Mayra Ruiz', 'Veronica Paredes', 'Paulette Freire', 'Mayra Mera', 'Max Wirz', 'Marlon Garcia', 'Maria Jose Cabrera', 'Maria Fernanda Pijal', 'Maria Luisa Cherrez'],
  cuenca: ['Francisco Bravo', 'Katy Quintuña', 'Daniela Barriga', 'Claudia Recalde']
};
const foto = (id) => {
  if (!id) return '';
  const [ciudad, i] = String(id).split('-'); const n = parseInt(i, 10) + 1;
  const num = 'Foto ' + (n < 10 ? '0' : '') + n;
  const nombre = (NOMBRES[ciudad] || [])[n - 1];
  return nombre ? nombre + ' (' + num + ')' : num;
};
const celda = (v) => '"' + String(v).replace(/"/g, '""') + '"';

async function exportar(url, env) {
  const clave = url.searchParams.get('clave') || '';
  // La clave puede estar como secreto CLAVE_ADMIN o guardada en la tabla "ajustes" (clave = 'clave_admin')
  let validas = [];
  if (typeof env.CLAVE_ADMIN === 'string') validas.push(env.CLAVE_ADMIN);
  try { const r = await env.DB.prepare("SELECT valor FROM ajustes WHERE clave = 'clave_admin'").first(); if (r && r.valor) validas.push(String(r.valor)); } catch (e) {}
  if (!clave || validas.indexOf(clave) < 0) return new Response('Clave incorrecta', { status: 401 });
  let antes = [];
  try { ({ results: antes } = await env.DB.prepare("SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca, '' AS nombre, '' AS apellido, '' AS correo, '' AS conexion FROM votos_publico ORDER BY id").all()); } catch (e) { antes = []; }
  const { results: ahora } = await env.DB.prepare(
    "SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca, nombre, apellido, correo, conexion FROM votos_campana ORDER BY id"
  ).all();
  const results = antes.concat(ahora);
  const filas = [['Fecha y hora (Ecuador)', 'Nombre', 'Apellido', 'Correo', 'ID dispositivo', 'Conexión (cifrada)', 'Quito', 'Guayaquil', 'Cuenca']]
    .concat(results.map((r) => [r.creado, r.nombre || '', r.apellido || '', r.correo || '', r.votante, r.conexion || '', foto(r.quito), foto(r.guayaquil), foto(r.cuenca)]));
  const csv = '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="votos-humana.csv"', 'Cache-Control': 'no-store' }
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/votos' || url.pathname === '/api/exportar') {
      try {
        await prepararTabla(env.DB);
        await prepararResumen(env.DB);
        await aplicarLimpieza(env.DB);
        await aplicarLimpieza2(env.DB);
        if (url.pathname === '/api/exportar') return await exportar(url, env);
        if (request.method === 'POST') return await votar(request, env.DB);
        return json({ ok: true, pausada: PAUSADA, ficha: await crearFicha(env.DB), counts: await conteo(env.DB) });
      } catch (e) {
        return json({ ok: false, motivo: 'servidor', detalle: String(e && e.message || e).slice(0, 300) }, 500);
      }
    }
    // La página siempre se pide fresca para que los cambios se vean al instante
    const res = await env.ASSETS.fetch(request);
    const tipo = res.headers.get('Content-Type') || '';
    if (tipo.includes('text/html')) {
      const r = new Response(res.body, res);
      r.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate');
      return r;
    }
    return res;
  }
};
