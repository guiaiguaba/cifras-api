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
    'SELECT id, titulo, artista, imagem_url, cifra_original, tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});

app.get('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, artista, imagem_url, cifra_original, tom_original FROM cifras_musicas WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});

app.post('/musicas', exigirApiKey, async (req, res) => {
  const { titulo, artista, imagemUrl, cifraOriginal, tomOriginal } = req.body;
  if (!titulo || !cifraOriginal || !tomOriginal) {
    return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  }
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_musicas (id, titulo, artista, imagem_url, cifra_original, tom_original) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, titulo, artista ?? null, imagemUrl ?? null, cifraOriginal, tomOriginal]
  );
  res.status(201).json({ id, titulo, artista: artista ?? null, imagemUrl: imagemUrl ?? null, cifraOriginal, tomOriginal });
});

app.put('/musicas/:id', exigirApiKey, async (req, res) => {
  const { titulo, artista, imagemUrl, cifraOriginal, tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_musicas
     SET titulo = $1, artista = $2, imagem_url = $3, cifra_original = $4, tom_original = $5, atualizado_em = now()
     WHERE id = $6`,
    [titulo, artista ?? null, imagemUrl ?? null, cifraOriginal, tomOriginal, req.params.id]
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
    'SELECT id, titulo, artista, imagem_url, cifra_original, tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});

app.get('/dashboard-api/musicas/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, artista, imagem_url, cifra_original, tom_original FROM cifras_musicas WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});

app.post('/dashboard-api/musicas', async (req, res) => {
  const { titulo, artista, imagemUrl, cifraOriginal, tomOriginal } = req.body;
  if (!titulo || !cifraOriginal || !tomOriginal) {
    return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  }
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_musicas (id, titulo, artista, imagem_url, cifra_original, tom_original) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, titulo, artista ?? null, imagemUrl ?? null, cifraOriginal, tomOriginal]
  );
  res.status(201).json({ id, titulo, artista: artista ?? null, imagemUrl: imagemUrl ?? null, cifraOriginal, tomOriginal });
});

app.put('/dashboard-api/musicas/:id', async (req, res) => {
  const { titulo, artista, imagemUrl, cifraOriginal, tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_musicas
     SET titulo = $1, artista = $2, imagem_url = $3, cifra_original = $4, tom_original = $5, atualizado_em = now()
     WHERE id = $6`,
    [titulo, artista ?? null, imagemUrl ?? null, cifraOriginal, tomOriginal, req.params.id]
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
    imagemUrl: row.imagem_url,
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
// Proxy da Bíblia (ABíbliaDigital)
// A key da ABíbliaDigital fica segura no servidor, não exposta no app.
// Configure a variável de ambiente BIBLIA_TOKEN no Render com o token
// obtido em abibliadigital.com.br após o cadastro.
// ---------------------------------------------------------------------

const BIBLIA_BASE = 'https://www.abibliadigital.com.br/api';
const BIBLIA_TOKEN = process.env.BIBLIA_TOKEN;

function bibliaHeaders() {
  return {
    'Authorization': `Bearer ${BIBLIA_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

// Cache em memória para reduzir chamadas à API externa (limite do plano free).
const bibliaCache = new Map();
const BIBLIA_TTL = 24 * 60 * 60 * 1000; // 24h para capítulos/livros
const BIBLIA_DIA_TTL = 60 * 60 * 1000;  // 1h para versículo do dia

async function bibliaFetch(url, ttl = BIBLIA_TTL) {
  const hit = bibliaCache.get(url);
  if (hit && Date.now() - hit.ts < ttl) return hit.data;

  const resp = await fetch(url, { headers: bibliaHeaders() });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`ABíbliaDigital ${resp.status}: ${err}`);
  }
  const data = await resp.json();
  bibliaCache.set(url, { data, ts: Date.now() });
  return data;
}

// GET /biblia/livros — lista todos os livros
app.get('/biblia/livros', exigirApiKey, async (req, res) => {
  try {
    const data = await bibliaFetch(`${BIBLIA_BASE}/books`);
    res.json(data);
  } catch (e) {
    console.error('[biblia] livros:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar livros', detalhe: e.message });
  }
});

// GET /biblia/capitulo?versao=nvi&livro=jo&capitulo=3
app.get('/biblia/capitulo', exigirApiKey, async (req, res) => {
  const { versao = 'nvi', livro, capitulo } = req.query;
  if (!livro || !capitulo) {
    return res.status(400).json({ erro: 'livro e capitulo são obrigatórios.' });
  }
  try {
    const data = await bibliaFetch(
      `${BIBLIA_BASE}/verses/${versao}/${livro}/${capitulo}`
    );
    res.json(data);
  } catch (e) {
    console.error('[biblia] capitulo:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar capítulo', detalhe: e.message });
  }
});

// GET /biblia/versiculo?versao=nvi&livro=jo&capitulo=3&versiculo=16
app.get('/biblia/versiculo', exigirApiKey, async (req, res) => {
  const { versao = 'nvi', livro, capitulo, versiculo } = req.query;
  if (!livro || !capitulo || !versiculo) {
    return res.status(400).json({ erro: 'livro, capitulo e versiculo são obrigatórios.' });
  }
  try {
    const data = await bibliaFetch(
      `${BIBLIA_BASE}/verses/${versao}/${livro}/${capitulo}/${versiculo}`
    );
    res.json(data);
  } catch (e) {
    console.error('[biblia] versiculo:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar versículo', detalhe: e.message });
  }
});

// GET /biblia/versiculo-dia?versao=nvi
// ABíbliaDigital não tem endpoint de "versículo do dia" oficial —
// usamos um versículo determinístico baseado no dia do ano (0-365)
// mapeado para uma lista curada de referências significativas.
const VERSICULOS_DIA = [
  { livro: 'jo', cap: 3, ver: 16 }, { livro: 'sl', cap: 23, ver: 1 },
  { livro: 'fp', cap: 4, ver: 13 }, { livro: 'rm', cap: 8, ver: 28 },
  { livro: 'is', cap: 40, ver: 31 }, { livro: 'pv', cap: 3, ver: 5 },
  { livro: 'mt', cap: 6, ver: 33 }, { livro: 'jr', cap: 29, ver: 11 },
  { livro: 'sl', cap: 46, ver: 1 }, { livro: 'fp', cap: 4, ver: 7 },
  { livro: 'rm', cap: 12, ver: 2 }, { livro: 'ef', cap: 2, ver: 8 },
  { livro: 'hb', cap: 11, ver: 1 }, { livro: 'sl', cap: 91, ver: 1 },
  { livro: 'mt', cap: 11, ver: 28 }, { livro: '1co', cap: 13, ver: 4 },
  { livro: 'pv', cap: 18, ver: 10 }, { livro: 'sl', cap: 37, ver: 4 },
  { livro: 'rm', cap: 5, ver: 8 }, { livro: 'jo', cap: 14, ver: 6 },
  { livro: 'ef', cap: 6, ver: 10 }, { livro: 'mt', cap: 5, ver: 3 },
  { livro: 'sl', cap: 119, ver: 105 }, { livro: '2tm', cap: 1, ver: 7 },
  { livro: 'gl', cap: 5, ver: 22 }, { livro: 'sl', cap: 27, ver: 1 },
  { livro: 'rm', cap: 1, ver: 16 }, { livro: 'tg', cap: 1, ver: 5 },
  { livro: 'fp', cap: 4, ver: 4 }, { livro: 'jo', cap: 15, ver: 5 },
  { livro: 'pv', cap: 16, ver: 3 }, { livro: 'sl', cap: 1, ver: 1 },
];

app.get('/biblia/versiculo-dia', exigirApiKey, async (req, res) => {
  const { versao = 'nvi' } = req.query;
  const agora = new Date();
  const inicio = new Date(agora.getFullYear(), 0, 0);
  const diaDoAno = Math.floor((agora - inicio) / 86400000);
  const ref = VERSICULOS_DIA[diaDoAno % VERSICULOS_DIA.length];

  try {
    const data = await bibliaFetch(
      `${BIBLIA_BASE}/verses/${versao}/${ref.livro}/${ref.cap}/${ref.ver}`,
      BIBLIA_DIA_TTL
    );
    res.json(data);
  } catch (e) {
    console.error('[biblia] versiculo-dia:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar versículo do dia', detalhe: e.message });
  }
});

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
