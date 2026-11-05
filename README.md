# Humana para humanos – Votación de fotos

Página de votación (Quito, Guayaquil y Cuenca) publicada en **Cloudflare Pages**.
Los votos se guardan en una base de datos **Cloudflare D1**. No se necesita iniciar sesión para votar.

## Archivos
- `index.html` – la página.
- `img/` – logo, robot y fotos.
- `functions/api/votos.js` – recibe los votos y entrega el conteo del Top 3.
- `functions/api/exportar.js` – descarga todos los votos en CSV (se abre en Excel).
- `schema.sql` – crea la tabla de votos.

## Configuración en Cloudflare (una sola vez)
1. **Crear la base de datos:** Workers & Pages › D1 › *Create database* › nombre `votos-humana`.
2. **Crear la tabla:** abre la base › pestaña *Console* › pega el contenido de `schema.sql` › *Execute*.
3. **Crear el sitio:** Workers & Pages › *Create* › Pages › *Connect to Git* › elige este repositorio.
   - Framework preset: **None** · Build command: *(vacío)* · Build output directory: **/**
4. **Conectar la base al sitio:** proyecto › Settings › Bindings › *Add* › D1 database
   - Variable name: **DB** · Database: **votos-humana**
5. **Clave para descargar votos:** proyecto › Settings › Variables and Secrets › *Add* › tipo *Secret*
   - Name: **CLAVE_ADMIN** · Value: una clave que solo tú conozcas.
6. Vuelve a desplegar (Deployments › *Retry deployment*) para que tome la base y la clave.

## Descargar los votos en Excel
Abre `https://TU-SITIO.pages.dev/api/exportar?clave=TU_CLAVE` → se descarga `votos-humana.csv`.

## Cierre
La API deja de aceptar votos el **miércoles 11 de noviembre de 2026 a las 5:00 p. m. (Ecuador)**.
