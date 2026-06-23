const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('render.com')
    ? { rejectUnauthorized: false }
    : false,
});

async function initSchema() {
  // ── Tabelas existentes (cifras) ──────────────────────────────────────────
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

  // ── Planos dos ministérios ───────────────────────────────────────────────
  // admin_uid: UID Firebase do dono (quem criou o ministério)
  // plano: 'free' | 'pro'
  // validade: NULL = free (sem validade), data = Pro ativo até essa data
  // pagamento_id: ID da transação no Mercado Pago
  // limite_membros: 10 (free) | 30 (pro) — total somado por admin
  // limite_ministerios: 1 (free) | 2 (pro)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS na_planos (
      id SERIAL PRIMARY KEY,
      admin_uid TEXT NOT NULL UNIQUE,
      plano TEXT NOT NULL DEFAULT 'free',
      validade TIMESTAMP,
      pagamento_id TEXT,
      limite_membros INTEGER NOT NULL DEFAULT 10,
      limite_ministerios INTEGER NOT NULL DEFAULT 1,
      permite_gravacao BOOLEAN NOT NULL DEFAULT false,
      permite_ia BOOLEAN NOT NULL DEFAULT false,
      criado_em TIMESTAMP NOT NULL DEFAULT now(),
      atualizado_em TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  // ── Histórico de pagamentos ──────────────────────────────────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS na_pagamentos (
      id SERIAL PRIMARY KEY,
      admin_uid TEXT NOT NULL,
      pagamento_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL,
      valor NUMERIC(10,2) NOT NULL,
      periodo TEXT NOT NULL,
      criado_em TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  console.log('Schema inicializado (cifras + notas_adoracao).');
}

module.exports = { pool, initSchema };
