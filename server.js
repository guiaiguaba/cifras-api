const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('./db');
const notificacoes = require('./notificacoes');

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
// Dashboard — Hinos (Harpa Cristã / Cantor Cristão)
// ---------------------------------------------------------------------

app.get('/dashboard-api/hinos', async (req, res) => {
  const { hinario = 'harpa', q = '', pagina = '1', por_pagina = '30' } = req.query;
  const offset = (parseInt(pagina) - 1) * parseInt(por_pagina);
  const limit = parseInt(por_pagina);
  try {
    let rows, total;
    if (q.trim()) {
      const busca = `%${q.trim()}%`;
      const r1 = await pool.query(
        `SELECT id, numero, titulo, hinario, cifra, tom FROM cifras_hinos
         WHERE hinario=$1 AND (titulo ILIKE $2 OR CAST(numero AS TEXT) LIKE $2)
         ORDER BY numero LIMIT $3 OFFSET $4`,
        [hinario, busca, limit, offset]
      );
      const r2 = await pool.query(
        `SELECT COUNT(*) FROM cifras_hinos WHERE hinario=$1 AND (titulo ILIKE $2 OR CAST(numero AS TEXT) LIKE $2)`,
        [hinario, busca]
      );
      rows = r1.rows; total = parseInt(r2.rows[0].count);
    } else {
      const r1 = await pool.query(
        `SELECT id, numero, titulo, hinario, cifra, tom FROM cifras_hinos
         WHERE hinario=$1 ORDER BY numero LIMIT $2 OFFSET $3`,
        [hinario, limit, offset]
      );
      const r2 = await pool.query(
        `SELECT COUNT(*) FROM cifras_hinos WHERE hinario=$1`, [hinario]
      );
      rows = r1.rows; total = parseInt(r2.rows[0].count);
    }
    res.json({ total, pagina: parseInt(pagina), hinos: rows });
  } catch (e) {
    console.error('[dashboard/hinos]', e.message);
    res.status(500).json({ erro: 'Erro ao listar hinos' });
  }
});

app.get('/dashboard-api/hinos/:hinario/:numero', async (req, res) => {
  const { hinario, numero } = req.params;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM cifras_hinos WHERE hinario=$1 AND numero=$2',
      [hinario, parseInt(numero)]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Hino não encontrado.' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao buscar hino' });
  }
});

app.put('/dashboard-api/hinos/:hinario/:numero/cifra', async (req, res) => {
  const { hinario, numero } = req.params;
  const { cifra, tom } = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE cifras_hinos SET cifra=$1, tom=$2, atualizado_em=now()
       WHERE hinario=$3 AND numero=$4`,
      [cifra ?? null, tom ?? null, hinario, parseInt(numero)]
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Hino não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao salvar cifra' });
  }
});



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
// Hinos — Harpa Cristã e Cantor Cristão
// Os dados ficam no Postgres (tabela cifras_hinos).
// Execute seed_hinos.js uma vez para popular o banco.
// ---------------------------------------------------------------------

// GET /hinos?hinario=harpa&q=texto&pagina=1&por_pagina=20
app.get('/hinos', exigirApiKey, async (req, res) => {
  const {
    hinario = 'harpa',
    q = '',
    pagina = '1',
    por_pagina = '30',
  } = req.query;

  const offset = (parseInt(pagina) - 1) * parseInt(por_pagina);
  const limit = parseInt(por_pagina);

  try {
    let rows, total;
    if (q.trim()) {
      const busca = `%${q.trim()}%`;
      const res1 = await pool.query(
        `SELECT id, numero, titulo, hinario, cifra, tom
         FROM cifras_hinos
         WHERE hinario = $1 AND (titulo ILIKE $2 OR letra ILIKE $2)
         ORDER BY numero
         LIMIT $3 OFFSET $4`,
        [hinario, busca, limit, offset],
      );
      const res2 = await pool.query(
        `SELECT COUNT(*) FROM cifras_hinos
         WHERE hinario = $1 AND (titulo ILIKE $2 OR letra ILIKE $2)`,
        [hinario, busca],
      );
      rows = res1.rows;
      total = parseInt(res2.rows[0].count);
    } else {
      const res1 = await pool.query(
        `SELECT id, numero, titulo, hinario, cifra, tom
         FROM cifras_hinos WHERE hinario = $1
         ORDER BY numero LIMIT $2 OFFSET $3`,
        [hinario, limit, offset],
      );
      const res2 = await pool.query(
        `SELECT COUNT(*) FROM cifras_hinos WHERE hinario = $1`,
        [hinario],
      );
      rows = res1.rows;
      total = parseInt(res2.rows[0].count);
    }

    res.json({ total, pagina: parseInt(pagina), hinos: rows });
  } catch (e) {
    console.error('[hinos] listar:', e.message);
    res.status(500).json({ erro: 'Erro ao listar hinos' });
  }
});

// GET /hinos/:hinario/:numero — hino completo com letra
app.get('/hinos/:hinario/:numero', exigirApiKey, async (req, res) => {
  const { hinario, numero } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM cifras_hinos WHERE hinario = $1 AND numero = $2`,
      [hinario, parseInt(numero)],
    );
    if (rows.length === 0) return res.status(404).json({ erro: 'Hino não encontrado.' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao buscar hino' });
  }
});

// PUT /hinos/:hinario/:numero/cifra — salva/atualiza cifra de um hino
app.put('/hinos/:hinario/:numero/cifra', exigirApiKey, async (req, res) => {
  const { hinario, numero } = req.params;
  const { cifra, tom } = req.body;
  try {
    const { rowCount } = await pool.query(
      `UPDATE cifras_hinos
       SET cifra = $1, tom = $2, atualizado_em = now()
       WHERE hinario = $3 AND numero = $4`,
      [cifra ?? null, tom ?? null, hinario, parseInt(numero)],
    );
    if (rowCount === 0) return res.status(404).json({ erro: 'Hino não encontrado.' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao salvar cifra do hino' });
  }
});

// GET /hinos/stats — quantos hinos por hinario
app.get('/hinos/stats', exigirApiKey, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT hinario, COUNT(*) as total,
              COUNT(cifra) as com_cifra
       FROM cifras_hinos GROUP BY hinario ORDER BY hinario`,
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ erro: 'Erro ao buscar estatísticas' });
  }
});

// ---------------------------------------------------------------------
// Busca de cifra — API interna do CifraClub (uso pessoal)
// Usa os mesmos endpoints JSON que o site usa internamente.
// Requer: npm install cheerio
// ---------------------------------------------------------------------

const cheerio = require('cheerio');

const HEADERS_CC = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer': 'https://www.cifraclub.com.br/',
  'Origin': 'https://www.cifraclub.com.br',
};

// GET /cifra/buscar?q=nome+da+musica
// Usa o endpoint Solr do CifraClub — retorna JSON com docs de músicas (tipo=2)
app.get('/cifra/buscar', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ erro: 'q é obrigatório.' });
  try {
    const url = `https://solr.sscdn.co/cc/c7/?q=${encodeURIComponent(q)}&limit=30&callback=suggest_callback`;
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Referer': 'https://www.cifraclub.com.br/',
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    // Resposta é JSONP: suggest_callback({...}) — remove o wrapper
    const texto = await resp.text();
    const jsonStr = texto.replace(/^suggest_callback\s*\(/, '').replace(/\);\s*$/, '').trim();
    const data = JSON.parse(jsonStr);

    // Filtra só músicas (tipo=2) — tipo=1 são artistas, tipo=5 são playlists, tipo=6 são álbuns
    const docs = (data.response?.docs || []).filter(d => d.tipo === '2' && d.url && d.dns);

    const resultados = docs.map(d => ({
      name: d.txt || '',
      artist: d.art || '',
      artistSlug: d.dns || '',
      slug: d.url || '',
      img: d.imgm || '',
      url: `https://www.cifraclub.com.br/${d.dns}/${d.url}/`,
    }));

    res.json(resultados);
  } catch (e) {
    console.error('[cifra] buscar:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar cifra: ' + e.message });
  }
});

// GET /cifra/obter?artista=gabriela-rocha&musica=bondade-de-deus&name=Bondade+de+Deus&artist=Gabriela+Rocha
// name e artist são opcionais — se passados, usamos diretamente sem tentar extrair do HTML
app.get('/cifra/obter', async (req, res) => {
  const { artista, musica, name, artist } = req.query;
  if (!artista || !musica) return res.status(400).json({ erro: 'artista e musica são obrigatórios.' });

  try {
    const pageUrl = `https://www.cifraclub.com.br/${encodeURIComponent(artista)}/${encodeURIComponent(musica)}/`;
    const pageResp = await fetch(pageUrl, {
      headers: { ...HEADERS_CC, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      signal: AbortSignal.timeout(20000),
    });
    if (!pageResp.ok) throw new Error(`CifraClub retornou ${pageResp.status}`);

    const html = await pageResp.text();
    const $ = cheerio.load(html);

    // Título e artista — usa os parâmetros passados pela busca (mais confiável)
    let titulo = (name || '').trim();
    let nomeArtista = (artist || '').trim();

    // Se não foram passados, extrai do mesmo bloco song/page usado para
    // o tom e o vídeo (fonte real desta página — não existe __NEXT_DATA__).
    if (!titulo || !nomeArtista) {
      const matchNome = html.match(/name:\s*'((?:[^'\\]|\\.)*)'/);
      const matchArtista = html.match(/artist:\s*'((?:[^'\\]|\\.)*)'/);
      // Usa JSON.parse para decodificar escapes (\u002C, \u00E9 etc) de
      // forma segura, em vez de regex manual.
      const decodificar = (s) => { try { return JSON.parse(`"${s}"`); } catch (_) { return s; } };
      if (!titulo && matchNome) titulo = decodificar(matchNome[1]);
      if (!nomeArtista && matchArtista) nomeArtista = decodificar(matchArtista[1]);
    }

    // Último fallback para título
    if (!titulo) {
      titulo = musica.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
    if (!nomeArtista) {
      nomeArtista = artista.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }

    // Tom e cifra — a página não usa Next.js (não existe script
    // __NEXT_DATA__); os dados reais vêm do bloco inline window._ccq.push(
    // ['song/page', ..., { key: 'G', chords: [...], ... }]) que o
    // CifraClub injeta para inicializar a página. Extraímos o campo "key"
    // de lá como fonte primária do tom.
    let tom = '';
    let cifra = '';

    const matchKey = html.match(/key:\s*'([A-G][b#]?m?)'/) || html.match(/key:\s*"([A-G][b#]?m?)"/);
    if (matchKey) tom = matchKey[1];

    // Busca "chord" em qualquer script da página
    if (!cifra) {
      $('script').each((_, el) => {
        if (cifra) return;
        const txt = $(el).html() || '';
        const m = txt.match(/"chord"\s*:\s*"((?:[^"\\]|\\.)*)"/);
        if (m) {
          cifra = m[1]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\')
            .replace(/\\"/g, '"');
        }
        if (!tom) {
          const mt = txt.match(/"(?:key|tom)"\s*:\s*"([A-Gb#m]{1,4})"/);
          if (mt) tom = mt[1];
        }
      });
    }

    // Scraping HTML como último recurso para a cifra
    if (!cifra) {
      const elemCifra = $('pre.cifra, #cifra_cnt pre, .cifra_cnt pre, pre').first();
      if (elemCifra.length) {
        elemCifra.find('b').each((_, el) => { $(el).replaceWith(`[${$(el).text()}]`); });
        cifra = elemCifra.text().trim();
      }
    }

    if (!tom) {
      tom = $('.cifra_tom b, .cifra_tom, .tom-atual').first().text().trim();
    }

    // Fallback final: extrai o tom do primeiro acorde encontrado na própria cifra
    // Cifras têm acordes entre colchetes [C], [Am], [G7] etc — o primeiro costuma ser o tom da música
    if (!tom && cifra) {
      const primeiroAcorde = cifra.match(/\[([A-G][b#]?m?(?:7|maj7|sus2|sus4|9|11|13|dim|aug|add\d)?(?:\/[A-G][b#]?)?)\]/);
      if (primeiroAcorde) tom = primeiroAcorde[1];
    }

    tom = (tom || 'C').replace(/[^A-Gb#m0-9]/g, '');
    // Normaliza: mantém só a parte tonal básica (ex: "Am7" vira "Am", "C/E" vira "C")
    const matchTomSimples = tom.match(/^([A-G][b#]?m?)/);
    tom = matchTomSimples ? matchTomSimples[1] : 'C';

    console.log(`[cifra] obter — tom extraído: "${tom}" para ${titulo}`);

    // Remove tablatura (linhas E|---)
    if (cifra) {
      const linhas = cifra.split('\n');
      const semTab = linhas.filter(l => !l.match(/^[EADGBe]\|[-\d\/\\hpb~.]+/)).join('\n');
      if (semTab.trim().length > cifra.length * 0.3) cifra = semTab;
    }

    // Extrai YouTube ID da página — a fonte real é o script inline que o
    // CifraClub injeta para inicializar a página da música:
    //
    //   window._ccq.push(['song/page', pageScript, {
    //     cifraId: ..., songId: ..., name: '...', artist: '...',
    //     youtubeId: 'ldK43s9UyQI', key: 'G', chords: [...]
    //   }]);
    //
    // Não é JSON válido (objeto JS literal, chaves sem aspas), então
    // extraímos só o campo que precisamos via regex em vez de fazer parse
    // do objeto inteiro. Essa é a MESMA estrutura que entrega `name`,
    // `artist` e `key` — ou seja, é garantidamente desta música específica,
    // não uma busca solta pela página.
    let youtubeId = '';
    let fonteYoutubeId = 'nenhuma';

    const matchSongPage = html.match(/_ccq\.push\(\['song\/page',[\s\S]{0,1500}/);
    if (matchSongPage) {
      const blocoSongPage = matchSongPage[0];
      const matchYt = blocoSongPage.match(/youtubeId:\s*'([a-zA-Z0-9_-]{11})'/)
        || blocoSongPage.match(/youtubeId:\s*"([a-zA-Z0-9_-]{11})"/);
      if (matchYt) { youtubeId = matchYt[1]; fonteYoutubeId = 'song/page'; }
    }

    // Fallback: caso a estrutura do bloco song/page mude, tenta achar o
    // campo em qualquer lugar do HTML, mas só aceita se vier acompanhado
    // de outros campos da MESMA música por perto (songId/cifraId), para
    // não pegar vídeo de "músicas relacionadas" ou anúncios.
    if (!youtubeId) {
      const matchGenerico = html.match(/(?:cifraId|songId)[\s\S]{0,500}?youtubeId:\s*['"]([a-zA-Z0-9_-]{11})['"]/);
      if (matchGenerico) { youtubeId = matchGenerico[1]; fonteYoutubeId = 'fallback:proximo-a-songId'; }
    }

    console.log(`[cifra] youtubeId="${youtubeId || '(vazio)'}" fonte="${fonteYoutubeId}" para "${titulo}"`);

    if (!cifra.trim()) {
      return res.status(404).json({ erro: 'Cifra não encontrada.', url: pageUrl });
    }

    // Monta link da letra (letras.mus.br usa o mesmo padrão de slugs do CifraClub)
    const linkLetra = `https://m.letras.mus.br/${artista}/${musica}/`;

    // Busca link de áudio no Deezer via busca pública
    let linkAudio = '';
    try {
      const queryDeezer = `${nomeArtista} ${titulo}`;
      const deezerResp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(queryDeezer)}&limit=1`, {
        signal: AbortSignal.timeout(8000),
      });
      if (deezerResp.ok) {
        const deezerData = await deezerResp.json();
        if (deezerData.data && deezerData.data.length > 0) {
          linkAudio = deezerData.data[0].link || '';
        }
      }
    } catch (_) {
      // Deezer indisponível — segue sem áudio
    }

    res.json({
      titulo,
      artista: nomeArtista,
      tom,
      cifra: cifra.trim(),
      url: pageUrl,
      linkCifra: pageUrl,
      linkLetra,
      linkAudio,
      youtubeId: youtubeId || null,
    });
  } catch (e) {
    console.error('[cifra] obter:', e.message);
    res.status(502).json({ erro: 'Erro ao obter cifra: ' + e.message });
  }
});


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

// GET /biblia/busca?versao=nvi&q=amor
app.get('/biblia/busca', exigirApiKey, async (req, res) => {
  const { versao = 'nvi', q } = req.query;
  if (!q) return res.status(400).json({ erro: 'q é obrigatório.' });
  try {
    const data = await bibliaFetch(
      `${BIBLIA_BASE}/verses/search/${versao}/${encodeURIComponent(q)}`,
      BIBLIA_TTL
    );
    res.json(data);
  } catch (e) {
    console.error('[biblia] busca:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar', detalhe: e.message });
  }
});
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
      notificacoes.iniciarPolling();
    });
  })
  .catch((err) => {
    console.error('Erro ao inicializar schema do banco:', err);
    process.exit(1);
  });