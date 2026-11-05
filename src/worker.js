// Worker de la votación "Humana para humanos".
// - /api/votos     GET: conteo para los porcentajes y el Top 3 · POST: guarda un voto
// - /api/exportar  GET ?clave=...: descarga todos los votos en CSV (se abre en Excel)
// - /api/revisar   GET ?clave=...: resumen para detectar votos automáticos (robots)
// - /api/config    GET: dice a la página si la verificación anti-robots (Turnstile) está activa
//
// Anti-robots:
// - Cada voto guarda: conexión (IP cifrada, no se guarda la IP real), navegador y país.
// - Límites de votos por periodo de tiempo: ver LIMITES (por dispositivo y por conexión).
// - Si existen los secretos TURNSTILE_SITEKEY y TURNSTILE_SECRET, cada voto debe pasar la
//   verificación de Cloudflare Turnstile (invisible para personas, bloquea robots).
// - Todo lo demás: la página y las fotos (carpeta public/)

const CIERRE = Date.parse('2026-11-11T17:00:00-05:00'); // miércoles 11 nov, 5:00 p. m. (Ecuador)
const CIUDADES = ['quito', 'guayaquil', 'cuenca'];

// Límites de votos por periodo de tiempo (cambiar aquí si hace falta)
const LIMITES = {
  dispositivo: [ // por celular/computador
    { segundos: 600, max: 1 },    // 1 voto cada 10 minutos
    { segundos: 86400, max: 10 }  // máximo 10 votos al día
  ],
  conexion: [ // por red (una oficina comparte la misma red, por eso es más amplio)
    { segundos: 60, max: 20 },    // máximo 20 votos por minuto
    { segundos: 3600, max: 300 }  // máximo 300 votos por hora
  ]
};
let tablaLista = false;

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function prepararTabla(db) {
  if (tablaLista) return;
  await db.prepare(
    // Cada voto es una fila nueva: una misma persona puede votar varias veces
    "CREATE TABLE IF NOT EXISTS votos_campana (id INTEGER PRIMARY KEY AUTOINCREMENT, votante TEXT NOT NULL, quito TEXT NOT NULL, guayaquil TEXT NOT NULL, cuenca TEXT NOT NULL, creado TEXT NOT NULL DEFAULT (datetime('now')))"
  ).run();
  // Columnas nuevas para detectar robots (se agregan sin tocar los votos existentes).
  // Si algo falla aquí, la votación sigue funcionando como antes.
  for (const [col, def] of [['conexion', "TEXT NOT NULL DEFAULT ''"], ['navegador', "TEXT NOT NULL DEFAULT ''"], ['pais', "TEXT NOT NULL DEFAULT ''"], ['verificado', 'INTEGER NOT NULL DEFAULT 0']]) {
    try { await db.prepare(`ALTER TABLE votos_campana ADD COLUMN ${col} ${def}`).run(); } catch (e) { /* ya existe */ }
  }
  try { await db.prepare('CREATE INDEX IF NOT EXISTS idx_campana_conexion ON votos_campana (conexion, creado)').run(); } catch (e) {}
  try { await db.prepare('CREATE INDEX IF NOT EXISTS idx_campana_votante ON votos_campana (votante, creado)').run(); } catch (e) {}
  tablaLista = true;
}

// Código corto que identifica la conexión sin guardar la IP real
async function cifrarIP(ip, sal) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sal + '|' + ip));
  return 'c-' + [...new Uint8Array(buf)].slice(0, 6).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function verificarTurnstile(token, ip, secreto) {
  if (!token) return false;
  const f = new FormData();
  f.append('secret', secreto); f.append('response', token); if (ip) f.append('remoteip', ip);
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: f });
    const d = await r.json();
    return !!d.success;
  } catch (e) { return false; }
}

async function conteo(db) {
  const c = { quito: {}, guayaquil: {}, cuenca: {} };
  for (const k of CIUDADES) {
    const { results } = await db.prepare(`SELECT ${k} AS foto, COUNT(*) AS n FROM votos_campana WHERE ${k} <> '' GROUP BY ${k}`).all();
    for (const r of results) c[k][r.foto] = r.n;
  }
  return c;
}

async function votar(request, env) {
  const db = env.DB;
  if (Date.now() >= CIERRE) return json({ ok: false, motivo: 'cerrada' });
  let d;
  try { d = JSON.parse(await request.text()); } catch (e) { return json({ ok: false, motivo: 'datos' }, 400); }
  const valido = /^v-[a-z0-9-]{4,40}$/.test(d.votante || '') &&
    CIUDADES.every((k) => new RegExp('^' + k + '-\\d{1,3}$').test(d[k] || '')); // obligatorio: una foto por cada ciudad
  if (!valido) return json({ ok: false, motivo: 'datos' }, 400);

  const ip = request.headers.get('CF-Connecting-IP') || '';
  const conexion = await cifrarIP(ip, env.CLAVE_ADMIN || 'humana-para-humanos');
  const navegador = (request.headers.get('User-Agent') || '').slice(0, 250);
  const pais = (request.cf && request.cf.country) || '';

  // Verificación anti-robots (solo si está configurada)
  let verificado = 0;
  if (env.TURNSTILE_SECRET) {
    if (!(await verificarTurnstile(d.token, ip, env.TURNSTILE_SECRET))) return json({ ok: false, motivo: 'robot' }, 403);
    verificado = 1;
  }

  // Límites de votos por periodo de tiempo
  const espera = async (campo, valor, reglas) => {
    let max = 0;
    for (const r of reglas) {
      const f = await db.prepare(`SELECT COUNT(*) AS n, CAST(strftime('%s', MIN(creado)) AS INTEGER) AS primero FROM (SELECT creado FROM votos_campana WHERE ${campo} = ? AND creado >= datetime('now', ?) ORDER BY creado DESC LIMIT ?)`)
        .bind(valor, '-' + r.segundos + ' seconds', r.max).first();
      if (f && f.n >= r.max) max = Math.max(max, f.primero + r.segundos - Math.floor(Date.now() / 1000));
    }
    return max;
  };
  let seg = 0;
  try { seg = Math.max(await espera('votante', d.votante, LIMITES.dispositivo), await espera('conexion', conexion, LIMITES.conexion)); } catch (e) { seg = 0; }
  if (seg > 0) return json({ ok: false, motivo: 'rapido', espera: Math.max(1, seg) }, 429);

  try {
    await db.prepare('INSERT INTO votos_campana (votante, quito, guayaquil, cuenca, conexion, navegador, pais, verificado) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(d.votante, d.quito, d.guayaquil, d.cuenca, conexion, navegador, pais, verificado).run();
  } catch (e) {
    await db.prepare('INSERT INTO votos_campana (votante, quito, guayaquil, cuenca) VALUES (?, ?, ?, ?)')
      .bind(d.votante, d.quito, d.guayaquil, d.cuenca).run();
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
  if (!env.CLAVE_ADMIN || clave !== env.CLAVE_ADMIN) return new Response('Clave incorrecta', { status: 401 });
  const { results } = await env.DB.prepare(
    "SELECT datetime(creado, '-5 hours') AS creado, votante, quito, guayaquil, cuenca, conexion, navegador, pais, verificado FROM votos_campana ORDER BY id"
  ).all();
  const filas = [['Fecha y hora (Ecuador)', 'ID dispositivo', 'Quito', 'Guayaquil', 'Cuenca', 'Conexión', 'País', 'Verificado anti-robot', 'Navegador']]
    .concat(results.map((r) => [r.creado, r.votante, foto(r.quito), foto(r.guayaquil), foto(r.cuenca), r.conexion || '', r.pais || '', r.verificado ? 'Sí' : 'No', r.navegador || '']));
  const csv = '﻿' + filas.map((f) => f.map(celda).join(';')).join('\r\n');
  return new Response(csv, {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="votos-humana.csv"', 'Cache-Control': 'no-store' }
  });
}

// Resumen para detectar votos automáticos
async function revisar(url, env) {
  const clave = url.searchParams.get('clave') || '';
  if (!env.CLAVE_ADMIN || clave !== env.CLAVE_ADMIN) return new Response('Clave incorrecta', { status: 401 });
  const db = env.DB;
  const q = async (sql) => (await db.prepare(sql).all()).results;
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM votos_campana').first()).n;
  const conexiones = await q("SELECT conexion, COUNT(*) AS votos, COUNT(DISTINCT votante) AS dispositivos, MIN(datetime(creado,'-5 hours')) AS primero, MAX(datetime(creado,'-5 hours')) AS ultimo FROM votos_campana WHERE conexion <> '' GROUP BY conexion ORDER BY votos DESC LIMIT 15");
  const dispositivos = await q("SELECT votante, COUNT(*) AS votos, MIN(datetime(creado,'-5 hours')) AS primero, MAX(datetime(creado,'-5 hours')) AS ultimo FROM votos_campana GROUP BY votante ORDER BY votos DESC LIMIT 15");
  const minutos = await q("SELECT substr(datetime(creado,'-5 hours'),1,16) AS minuto, COUNT(*) AS votos FROM votos_campana GROUP BY minuto ORDER BY votos DESC LIMIT 15");
  const combos = await q("SELECT quito, guayaquil, cuenca, COUNT(*) AS votos FROM votos_campana GROUP BY quito, guayaquil, cuenca ORDER BY votos DESC LIMIT 10");
  const raros = await q("SELECT navegador, COUNT(*) AS votos FROM votos_campana WHERE navegador <> '' AND navegador NOT LIKE 'Mozilla/%' GROUP BY navegador ORDER BY votos DESC LIMIT 10");
  const paises = await q("SELECT CASE WHEN pais = '' THEN '(sin dato)' ELSE pais END AS pais, COUNT(*) AS votos FROM votos_campana GROUP BY pais ORDER BY votos DESC");
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const tabla = (titulo, nota, filas, cols) => '<h2>' + titulo + '</h2><p>' + nota + '</p>' + (filas.length
    ? '<table><tr>' + cols.map((c) => '<th>' + c[1] + '</th>').join('') + '</tr>' + filas.map((f) => '<tr>' + cols.map((c) => '<td>' + esc(c[2] ? c[2](f[c[0]]) : f[c[0]]) + '</td>').join('') + '</tr>').join('') + '</table>'
    : '<p><em>Sin datos todavía.</em></p>');
  const html = '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Revisión de votos</title><style>body{font-family:system-ui,sans-serif;max-width:1000px;margin:24px auto;padding:0 16px;color:#0A3566}table{border-collapse:collapse;width:100%;font-size:14px;margin-bottom:8px}th,td{border:1px solid #cfe0f2;padding:6px 8px;text-align:left}th{background:#eaf3fc}h2{margin-top:28px}p{color:#2D4F78}</style></head><body>'
    + '<h1>Revisión de votos · Humana para humanos</h1><p><strong>Total de votos: ' + total + '</strong>. Las conexiones y dispositivos con muchísimos más votos que el resto, los minutos con ráfagas y los navegadores que no son normales son señales de votos automáticos. Los votos anteriores a esta revisión no tienen datos de conexión, navegador ni país.</p>'
    + tabla('Conexiones con más votos', 'Una oficina comparte una conexión: es normal ver varios dispositivos en una. Sospechoso: muchos votos en poco tiempo o muchísimos dispositivos.', conexiones, [['conexion', 'Conexión'], ['votos', 'Votos'], ['dispositivos', 'Dispositivos'], ['primero', 'Primer voto'], ['ultimo', 'Último voto']])
    + tabla('Dispositivos con más votos', 'Sospechoso: un dispositivo con muchos más votos que el resto.', dispositivos, [['votante', 'Dispositivo'], ['votos', 'Votos'], ['primero', 'Primer voto'], ['ultimo', 'Último voto']])
    + tabla('Minutos con más votos', 'Sospechoso: picos muy por encima de lo normal.', minutos, [['minuto', 'Minuto (Ecuador)'], ['votos', 'Votos']])
    + tabla('Combinaciones más repetidas', 'Sospechoso: la misma combinación exacta repetida muchísimas veces.', combos, [['quito', 'Quito', foto], ['guayaquil', 'Guayaquil', foto], ['cuenca', 'Cuenca', foto], ['votos', 'Votos']])
    + tabla('Programas que no son navegadores', 'Un voto desde algo que no es Chrome, Safari, Edge, Firefox, etc. casi seguro es automático.', raros, [['navegador', 'Programa'], ['votos', 'Votos']])
    + tabla('Votos por país', 'Sospechoso: muchos votos desde fuera de Ecuador.', paises, [['pais', 'País'], ['votos', 'Votos']])
    + '</body></html>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/config') {
      return json({ turnstile: env.TURNSTILE_SECRET && env.TURNSTILE_SITEKEY ? env.TURNSTILE_SITEKEY : null });
    }
    if (url.pathname === '/api/votos' || url.pathname === '/api/exportar' || url.pathname === '/api/revisar') {
      try {
        await prepararTabla(env.DB);
        if (url.pathname === '/api/exportar') return await exportar(url, env);
        if (url.pathname === '/api/revisar') return await revisar(url, env);
        if (request.method === 'POST') return await votar(request, env);
        return json({ ok: true, counts: await conteo(env.DB) });
      } catch (e) {
        return json({ ok: false, motivo: 'servidor' }, 500);
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
