// Worker de la votación "Humana para humanos".
// - /api/votos     GET: conteo para los porcentajes y el Top 3 · POST: guarda un voto
// - /api/exportar  GET ?clave=...: descarga todos los votos en CSV (se abre en Excel)
// - Todo lo demás: la página y las fotos (carpeta public/)

const CIERRE = Date.parse('2026-11-11T17:00:00-05:00'); // miércoles 11 nov, 5:00 p. m. (Ecuador)
const CIUDADES = ['quito', 'guayaquil', 'cuenca'];
let tablaLista = false;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function prepararTabla(db) {
  if (tablaLista) return;
  await db.prepare(
    // Cada voto es una fila nueva: una misma persona puede votar varias veces
    "CREATE TABLE IF NOT EXISTS votos_todos (id INTEGER PRIMARY KEY AUTOINCREMENT, votante TEXT NOT NULL, quito TEXT NOT NULL, guayaquil TEXT NOT NULL, cuenca TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  tablaLista = true;
}

async function conteo(db) {
  const c = { quito: {}, guayaquil: {}, cuenca: {} };
  for (const k of CIUDADES) {
    const { results } = await db.prepare(`SELECT ${k} AS foto, COUNT(*) AS n FROM votos_todos GROUP BY ${k}`).all();
    for (const r of results) c[k][r.foto] = r.n;
  }
  return c;
}

async function votar(request, db) {
  if (Date.now() >= CIERRE) return json({ ok: false, motivo: 'cerrada' });
  let d;
  try { d = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, motivo: 'datos' }, 400); }
  const valido = /^v-[a-z0-9-]{4,40}$/.test(d.votante || '') &&
    CIUDADES.every((k) => new RegExp('^' + k + '-\\d{1,3}$').test(d[k] || ''));
  if (!valido) return json({ ok: false, motivo: 'datos' }, 400);
  await db.prepare('INSERT INTO votos_todos (votante, quito, guayaquil, cuenca) VALUES (?, ?, ?, ?)')
    .bind(d.votante, d.quito, d.guayaquil, d.cuenca).run();
  return json({ ok: true, counts: await conteo(db) });
}

// Nombres de los participantes (deben coincidir con public/index.html)
const NOMBRES = {
  guayaquil: ['Josias Rojas', 'Gustavo Rojas', 'Gabriela Romero', 'Francis Aguirre', 'Freddy Peñafiel', 'Fadua Salinas', 'Evelyn Espinoza', 'Diego Rodriguez', 'Daniela Zambrano', 'Christian Gracia', 'Carolina Naula', 'Claudia Herrera', 'Carol Gavilanez', 'Yahimara Narvaez', 'Mayra Ruiz', 'Veronica Paredes', 'Paulette Freire', 'Mayra Mera', 'Max Wirz', 'Marlon Garcia', 'Maria Jose Cabrera', 'Maria Fernanda Pijal', 'Maria Luisa Cherrez']
};
const foto = (id) => {
  const [ciudad, i] = String(id).split('-'); const n = parseInt(i, 10) + 1;
  const num = 'Foto ' + (n < 10 ? '0' : '') + n;
  const nombre = (NOMBRES[ciudad] || [])[n - 1];
  return nombre ? nombre + ' (' + num + ')' : num;
};
const celda = (v) => '"' + String(v).replace(/"/g, '""') + '"';

async function exportar(url, env) {
  const clave = url.searchParams.get('clave') || '';
  if (!env.CLAVE_ADMIN || clave !== env.CLAVE_ADMIN) return new Response('Clave incorrecta', { status: 401 });
  const { results } = await env.DB.prepare(
    "SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca FROM votos_todos ORDER BY id"
  ).all();
  const filas = [['Fecha y hora (Ecuador)', 'ID dispositivo', 'Quito', 'Guayaquil', 'Cuenca']]
    .concat(results.map((r) => [r.creado, r.votante, foto(r.quito), foto(r.guayaquil), foto(r.cuenca)]));
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
        if (url.pathname === '/api/exportar') return await exportar(url, env);
        if (request.method === 'POST') return await votar(request, env.DB);
        return json({ ok: true, counts: await conteo(env.DB) });
      } catch (e) {
        return json({ ok: false, motivo: 'servidor' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
