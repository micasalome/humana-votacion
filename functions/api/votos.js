// API de votos: GET devuelve el conteo para el Top 3, POST guarda un voto.
const CIERRE = Date.parse('2026-11-11T17:00:00-05:00'); // miércoles 11 nov, 5:00 p. m. (Ecuador)
const CIUDADES = ['quito', 'guayaquil', 'cuenca'];

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function conteo(db) {
  const c = { quito: {}, guayaquil: {}, cuenca: {} };
  for (const k of CIUDADES) {
    const { results } = await db.prepare(`SELECT ${k} AS foto, COUNT(*) AS n FROM votos GROUP BY ${k}`).all();
    for (const r of results) c[k][r.foto] = r.n;
  }
  return c;
}

export async function onRequestGet({ env }) {
  return json({ ok: true, counts: await conteo(env.DB) });
}

export async function onRequestPost({ request, env }) {
  if (Date.now() >= CIERRE) return json({ ok: false, motivo: 'cerrada' });
  let d;
  try { d = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, motivo: 'datos' }, 400); }
  const valido = /^v-[a-z0-9-]{4,40}$/.test(d.votante || '') &&
    CIUDADES.every((k) => new RegExp('^' + k + '-\\d{1,3}$').test(d[k] || ''));
  if (!valido) return json({ ok: false, motivo: 'datos' }, 400);

  const r = await env.DB.prepare('INSERT OR IGNORE INTO votos (votante, quito, guayaquil, cuenca) VALUES (?, ?, ?, ?)')
    .bind(d.votante, d.quito, d.guayaquil, d.cuenca).run();
  const nuevo = r.meta && r.meta.changes > 0;
  return json({ ok: nuevo, motivo: nuevo ? undefined : 'ya_voto', counts: await conteo(env.DB) });
}
