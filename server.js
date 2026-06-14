const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('./db');

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.API_KEY;

if (!API_KEY) {
  console.warn(
    'AVISO: variável de ambiente API_KEY não definida. ' +
    'A API ficará acessível sem autenticação até você configurá-la.'
  );
}

/**
 * Middleware de autenticação simples por API key.
 * Aceita a chave via header "x-api-key".
 * O dashboard (servido como HTML) não passa por aqui.
 */
function exigirApiKey(req, res, next) {
  if (!API_KEY) return next(); // sem API_KEY configurada, libera (modo dev)
  const chave = req.header('x-api-key');
  if (chave !== API_KEY) {
    return res.status(401).json({ erro: 'API key inválida ou ausente.' });
  }
  next();
}

// ---------------------------------------------------------------------
// Rotas de Músicas
// ---------------------------------------------------------------------

app.get('/musicas', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, artista, cifra_original, tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});

app.get('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, artista, cifra_original, tom_original FROM cifras_musicas WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});

app.post('/musicas', exigirApiKey, async (req, res) => {
  const { titulo, artista, cifraOriginal, tomOriginal } = req.body;
  if (!titulo || !cifraOriginal || !tomOriginal) {
    return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  }
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_musicas (id, titulo, artista, cifra_original, tom_original) VALUES ($1, $2, $3, $4, $5)',
    [id, titulo, artista ?? null, cifraOriginal, tomOriginal]
  );
  res.status(201).json({ id, titulo, artista: artista ?? null, cifraOriginal, tomOriginal });
});

app.put('/musicas/:id', exigirApiKey, async (req, res) => {
  const { titulo, artista, cifraOriginal, tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_musicas
     SET titulo = $1, artista = $2, cifra_original = $3, tom_original = $4, atualizado_em = now()
     WHERE id = $5`,
    [titulo, artista ?? null, cifraOriginal, tomOriginal, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

app.delete('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_musicas WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Rotas de Variantes
// ---------------------------------------------------------------------

app.get('/musicas/:musicaId/variantes', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, musica_id, label, semitons_transposicao, cifra_texto_custom FROM cifras_variantes WHERE musica_id = $1',
    [req.params.musicaId]
  );
  res.json(rows.map(formatarVariante));
});

app.post('/musicas/:musicaId/variantes', exigirApiKey, async (req, res) => {
  const { label, semitomsTransposicao, cifraTextoCustom } = req.body;
  if (!label) return res.status(400).json({ erro: 'label é obrigatório.' });
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO cifras_variantes (id, musica_id, label, semitons_transposicao, cifra_texto_custom)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, req.params.musicaId, label, semitomsTransposicao ?? 0, cifraTextoCustom ?? null]
  );
  res.status(201).json({ id, musicaId: req.params.musicaId, label, semitomsTransposicao: semitomsTransposicao ?? 0, cifraTextoCustom: cifraTextoCustom ?? null });
});

app.put('/variantes/:id', exigirApiKey, async (req, res) => {
  const { label, semitomsTransposicao, cifraTextoCustom } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_variantes
     SET label = $1, semitons_transposicao = $2, cifra_texto_custom = $3
     WHERE id = $4`,
    [label, semitomsTransposicao ?? 0, cifraTextoCustom ?? null, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ erro: 'Variante não encontrada.' });
  res.json({ ok: true });
});

app.delete('/variantes/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_variantes WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ erro: 'Variante não encontrada.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Rotas de Registros (histórico)
// ---------------------------------------------------------------------

app.get('/registros', exigirApiKey, async (req, res) => {
  const { tipoCulto, musicaId } = req.query;
  const condicoes = [];
  const valores = [];

  if (musicaId) {
    valores.push(musicaId);
    condicoes.push(`musica_id = $${valores.length}`);
  }
  if (tipoCulto) {
    valores.push(tipoCulto);
    condicoes.push(`tipo_culto = $${valores.length}`);
  }

  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, musica_id, variante_id, data, tipo_culto FROM cifras_registros ${where} ORDER BY data DESC`,
    valores
  );
  res.json(rows.map(formatarRegistro));
});

app.post('/registros', exigirApiKey, async (req, res) => {
  const { musicaId, varianteId, data, tipoCulto } = req.body;
  if (!musicaId || !data || !tipoCulto) {
    return res.status(400).json({ erro: 'musicaId, data e tipoCulto são obrigatórios.' });
  }
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_registros (id, musica_id, variante_id, data, tipo_culto) VALUES ($1, $2, $3, $4, $5)',
    [id, musicaId, varianteId ?? null, data, tipoCulto]
  );
  res.status(201).json({ id, musicaId, varianteId: varianteId ?? null, data, tipoCulto });
});

app.delete('/registros/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_registros WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Dashboard (HTML simples, sem API key — protegido apenas por URL obscura
// se você quiser; para uso pessoal isso é aceitável)
// ---------------------------------------------------------------------

app.use('/dashboard', express.static(path.join(__dirname, 'public')));

// Endpoint usado pelo dashboard para ler/gravar sem precisar da API key
// (já que o dashboard roda no navegador e expor a key no HTML não é seguro).
// Protegido apenas por estar sob /dashboard-api - para uso pessoal é suficiente,
// mas não exponha a URL publicamente.
app.get('/dashboard-api/musicas', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, artista, cifra_original, tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});

app.get('/dashboard-api/musicas/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, artista, cifra_original, tom_original FROM cifras_musicas WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});

app.post('/dashboard-api/musicas', async (req, res) => {
  const { titulo, artista, cifraOriginal, tomOriginal } = req.body;
  if (!titulo || !cifraOriginal || !tomOriginal) {
    return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  }
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_musicas (id, titulo, artista, cifra_original, tom_original) VALUES ($1, $2, $3, $4, $5)',
    [id, titulo, artista ?? null, cifraOriginal, tomOriginal]
  );
  res.status(201).json({ id, titulo, artista: artista ?? null, cifraOriginal, tomOriginal });
});

app.put('/dashboard-api/musicas/:id', async (req, res) => {
  const { titulo, artista, cifraOriginal, tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_musicas
     SET titulo = $1, artista = $2, cifra_original = $3, tom_original = $4, atualizado_em = now()
     WHERE id = $5`,
    [titulo, artista ?? null, cifraOriginal, tomOriginal, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

app.delete('/dashboard-api/musicas/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_musicas WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Helpers de formatação (snake_case do banco -> camelCase da API)
// ---------------------------------------------------------------------

function formatarMusica(row) {
  return {
    id: row.id,
    titulo: row.titulo,
    artista: row.artista,
    cifraOriginal: row.cifra_original,
    tomOriginal: row.tom_original,
  };
}

function formatarVariante(row) {
  return {
    id: row.id,
    musicaId: row.musica_id,
    label: row.label,
    semitomsTransposicao: row.semitons_transposicao,
    cifraTextoCustom: row.cifra_texto_custom,
  };
}

function formatarRegistro(row) {
  return {
    id: row.id,
    musicaId: row.musica_id,
    varianteId: row.variante_id,
    data: row.data,
    tipoCulto: row.tipo_culto,
  };
}

// ---------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Cifras API rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Erro ao inicializar schema do banco:', err);
    process.exit(1);
  });
