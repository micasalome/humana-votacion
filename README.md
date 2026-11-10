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
2. **Clave para descargar votos (una sola vez):** Storage & databases › D1 SQL Database › `votos-humana` › Console, pega y ejecuta:
   ```sql
   INSERT OR REPLACE INTO ajustes (clave, valor) VALUES ('clave_admin', 'TU_CLAVE');
   ```

## Descargar los votos en Excel
Abre `https://humana-votacion.pasante-marketing.workers.dev/api/exportar?clave=TU_CLAVE` → se descarga `votos-humana.csv` (se abre en Excel).

## Cierre
Deja de aceptar votos el **miércoles 11 de noviembre de 2026 a las 5:00 p. m. (Ecuador)**.

## Filtros para aceptar solo votos reales (sin registro)
- El voto debe enviarse desde la propia página, en un navegador, con una ficha firmada que la página recibe al abrirse (de un solo uso; mínimo 3 s abierta).
- Debe elegir una foto existente en cada una de las 3 ciudades y tener un identificador de dispositivo válido.
- Un voto por dispositivo (los dispositivos que ya votaron antes no pueden repetir).
- Por conexión a internet: 1 voto cada 8 s, máx. 40 por hora y 200 por día (`LIMITES` en `src/worker.js`).
- El Excel incluye la columna "Conexión (cifrada)" para revisar votos de una misma conexión.
