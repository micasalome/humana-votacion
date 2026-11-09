// Worker de la votación "Humana para humanos".
// - /api/votos     GET: conteo para los porcentajes y el Top 3 · POST: guarda un voto
// - /api/exportar  GET ?clave=...: descarga todos los votos en CSV (se abre en Excel)
// - Todo lo demás: la página y las fotos (carpeta public/)

import { LIMPIEZA_1 } from './limpieza1.js';

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

async function conteo(db) {
  const c = { quito: {}, guayaquil: {}, cuenca: {} };
  const { results } = await db.prepare('SELECT ciudad, foto, n FROM resumen').all();
  for (const r of results) if (c[r.ciudad]) c[r.ciudad][r.foto] = r.n;
  return c;
}

async function votar(request, db) {
  if (PAUSADA) return json({ ok: false, motivo: 'pausada' });
  if (Date.now() >= CIERRE) return json({ ok: false, motivo: 'cerrada' });
  let d;
  try { d = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, motivo: 'datos' }, 400); }
  const valido = /^v-[a-z0-9-]{4,40}$/.test(d.votante || '') &&
    CIUDADES.every((k) => new RegExp('^' + k + '-\\d{1,3}$').test(d[k] || '')); // obligatorio: una foto por cada ciudad
  if (!valido) return json({ ok: false, motivo: 'datos' }, 400);
  const limpio = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const nombre = limpio(d.nombre), apellido = limpio(d.apellido), correo = limpio(d.correo).toLowerCase();
  if (nombre.length < 2 || nombre.length > 60 || apellido.length < 2 || apellido.length > 60 ||
      correo.length > 120 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(correo)) {
    return json({ ok: false, motivo: 'registro' }, 400);
  }
  const ya = await db.prepare('SELECT 1 FROM registros WHERE correo = ?').bind(correo).first();
  if (ya) return json({ ok: false, motivo: 'ya_voto' });
  try {
    await db.batch([
      db.prepare('INSERT INTO registros (correo, nombre, apellido) VALUES (?, ?, ?)').bind(correo, nombre, apellido),
      db.prepare('INSERT INTO votos_campana (votante, quito, guayaquil, cuenca, nombre, apellido, correo) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(d.votante, d.quito, d.guayaquil, d.cuenca, nombre, apellido, correo),
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
  try { ({ results: antes } = await env.DB.prepare("SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca, '' AS nombre, '' AS apellido, '' AS correo FROM votos_publico ORDER BY id").all()); } catch (e) { antes = []; }
  const { results: ahora } = await env.DB.prepare(
    "SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca, nombre, apellido, correo FROM votos_campana ORDER BY id"
  ).all();
  const results = antes.concat(ahora);
  const filas = [['Fecha y hora (Ecuador)', 'Nombre', 'Apellido', 'Correo', 'ID dispositivo', 'Quito', 'Guayaquil', 'Cuenca']]
    .concat(results.map((r) => [r.creado, r.nombre || '', r.apellido || '', r.correo || '', r.votante, foto(r.quito), foto(r.guayaquil), foto(r.cuenca)]));
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
        if (url.pathname === '/api/exportar') return await exportar(url, env);
        if (request.method === 'POST') return await votar(request, env.DB);
        return json({ ok: true, pausada: PAUSADA, counts: await conteo(env.DB) });
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
