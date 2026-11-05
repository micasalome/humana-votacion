-- Tabla de votos: una fila por persona (votante = código único del dispositivo)
CREATE TABLE IF NOT EXISTS votos (
  votante   TEXT PRIMARY KEY,
  quito     TEXT NOT NULL,
  guayaquil TEXT NOT NULL,
  cuenca    TEXT NOT NULL,
  creado    TEXT NOT NULL DEFAULT (datetime('now'))
);
