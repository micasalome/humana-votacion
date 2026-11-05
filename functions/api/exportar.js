// Descarga todos los votos en un archivo CSV que se abre en Excel.
// Uso: https://TU-SITIO.pages.dev/api/exportar?clave=TU_CLAVE  (la clave se configura en Cloudflare como CLAVE_ADMIN)
const foto = (id) => { const n = parseInt(String(id).split('-')[1], 10) + 1; return 'Foto ' + (n < 10 ? '0' : '') + n; };
const celda = (v) => '"' + String(v).replace(/"/g, '""') + '"';

export async function onRequestGet({ request, env }) {
  const clave = new URL(request.url).searchParams.get('clave') || '';
  if (!env.CLAVE_ADMIN || clave !== env.CLAVE_ADMIN) return new Response('Clave incorrecta', { status: 401 });
  const { results } = await env.DB.prepare("SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca FROM votos ORDER BY creado").all();
  const filas = [['Fecha y hora (Ecuador)', 'ID votante', 'Quito', 'Guayaquil', 'Cuenca']]
    .concat(results.map((r) => [r.creado, r.votante, foto(r.quito), foto(r.guayaquil), foto(r.cuenca)]));
  const csv = '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="votos-humana.csv"', 'Cache-Control': 'no-store' }
  });
}
