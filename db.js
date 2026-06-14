const { Pool } = require('pg');

// Render fornece DATABASE_URL automaticamente quando você adiciona
// um banco Postgres ao seu Web Service (ou você cola a Internal Database URL
// manualmente nas env vars).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

/**
 * Cria as tabelas se não existirem. Prefixo "cifras_" para deixar claro
 * que pertencem a este domínio, mesmo em banco isolado.
 */
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS cifras_musicas (
      id TEXT PRIMARY KEY,
      titulo TEXT NOT NULL,
      cifra_original TEXT NOT NULL,
      tom_original TEXT NOT NULL,
      criado_em TIMESTAMP NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cifras_variantes (
      id TEXT PRIMARY KEY,
      musica_id TEXT NOT NULL REFERENCES cifras_musicas(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      semitons_transposicao INTEGER NOT NULL DEFAULT 0,
      cifra_texto_custom TEXT
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS cifras_registros (
      id TEXT PRIMARY KEY,
      musica_id TEXT NOT NULL REFERENCES cifras_musicas(id) ON DELETE CASCADE,
      variante_id TEXT REFERENCES cifras_variantes(id) ON DELETE SET NULL,
      data DATE NOT NULL,
      tipo_culto TEXT NOT NULL
    );
  `);
}

module.exports = { pool, initSchema };
