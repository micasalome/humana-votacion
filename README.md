# Humana para humanos – Votación de fotos

Página de votación (Quito, Guayaquil y Cuenca) publicada como **Cloudflare Worker**.
Los votos se guardan en una base de datos **Cloudflare D1**. No se necesita iniciar sesión para votar.

## Archivos
- `public/index.html` – la página.
- `public/img/` – logo, robot y fotos.
- `src/worker.js` – guarda los votos, entrega los porcentajes y descarga el Excel.
- `wrangler.jsonc` – configuración del Worker y de la base de datos `votos-humana` (se crea sola).
- `schema.sql` – referencia de la tabla (el Worker la crea solo).

## Configuración en Cloudflare
1. Workers & Pages › tu proyecto `humana-votacion` › Deployments › el despliegue se hace solo al subir cambios a GitHub.
2. **Clave para descargar votos:** Settings › Variables and Secrets › Add › tipo *Secret* › Name `CLAVE_ADMIN` › Value: una clave que solo tú conozcas › Deploy.

## Anti-robots
- Cada voto guarda la conexión (IP cifrada), el navegador y el país.
- Límites (`LIMITES` en `src/worker.js`): por dispositivo 1 voto cada 10 minutos y máx. 10 al día; por conexión máx. 20 por minuto y 300 por hora.
- **Revisión:** abre `https://TU-ENLACE/api/revisar?clave=TU_CLAVE` para ver conexiones, dispositivos, minutos y combinaciones con más votos.
- **Verificación Cloudflare Turnstile (opcional, recomendada):**
  1. Cloudflare › Turnstile › Add widget › nombre `humana-votacion` › Hostname: `humana-votacion.pasante-marketing.workers.dev` › Widget mode: *Invisible* › Create.
  2. Copia la *Site Key* y la *Secret Key*.
  3. Workers & Pages › `humana-votacion` › Settings › Variables and Secrets › Add dos *Secret*: `TURNSTILE_SITEKEY` (Site Key) y `TURNSTILE_SECRET` (Secret Key) › Deploy.
  Para desactivarla, borra esos dos secretos.

## Descargar los votos en Excel
Abre `https://TU-ENLACE/api/exportar?clave=TU_CLAVE` → se descarga `votos-humana.csv`.

## Cierre
Deja de aceptar votos el **miércoles 11 de noviembre de 2026 a las 5:00 p. m. (Ecuador)**.
