-- Referencia: el Worker crea esta tabla solo. Cada voto es una fila (se puede votar varias veces).
CREATE TABLE IF NOT EXISTS votos_campana (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  votante   TEXT NOT NULL,
  quito     TEXT NOT NULL,
  guayaquil TEXT NOT NULL,
  cuenca    TEXT NOT NULL,
  creado    TEXT NOT NULL DEFAULT (datetime('now'))
);
