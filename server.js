const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('./db');
const cloudinary    = require('cloudinary').v2;
const admin         = require('firebase-admin');

// Firebase Admin SDK — inicializa com credenciais do ambiente
// Variável de ambiente: FIREBASE_SERVICE_ACCOUNT (JSON stringificado)
// ou GOOGLE_APPLICATION_CREDENTIALS (path para o arquivo)
if (!admin.apps.length) {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
      ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
      : undefined;
  admin.initializeApp({
    credential: serviceAccount
        ? admin.credential.cert(serviceAccount)
        : admin.credential.applicationDefault(),
  });
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

const API_KEY = process.env.API_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN; // Mercado Pago

function exigirApiKey(req, res, next) {
  if (!API_KEY) return next();
  const chave = req.header('x-api-key');
  if (chave !== API_KEY) {
    return res.status(401).json({ erro: 'API key inválida ou ausente.' });
  }
  next();
}

// ---------------------------------------------------------------------------
// Helpers de plano
// ---------------------------------------------------------------------------

const PLANO_FREE = {
  plano: 'free',
  limite_membros: 10,
  limite_ministerios: 1,
  permite_gravacao: false,
  permite_ia: false,
  validade: null,
};

async function getOuCriarPlano(adminUid) {
  const { rows } = await pool.query(
    'SELECT * FROM na_planos WHERE admin_uid = $1',
    [adminUid]
  );
  if (rows.length > 0) return rows[0];

  // Cria registro free na primeira consulta
  const { rows: novo } = await pool.query(
    `INSERT INTO na_planos
       (admin_uid, plano, limite_membros, limite_ministerios,
        permite_gravacao, permite_ia)
     VALUES ($1, 'free', 10, 1, false, false)
     RETURNING *`,
    [adminUid]
  );
  return novo[0];
}

function planoEstaAtivo(row) {
  if (row.plano === 'free') return true;
  if (!row.validade) return false;
  return new Date(row.validade) > new Date();
}

function formatarPlano(row) {
  const ativo = planoEstaAtivo(row);
  return {
    plano:              ativo ? row.plano : 'free',
    limiteMembros:      ativo ? row.limite_membros : 10,
    limiteMinisterios:  ativo ? row.limite_ministerios : 1,
    permiteGravacao:    ativo ? row.permite_gravacao : false,
    permiteIa:          ativo ? row.permite_ia : false,
    validade:           row.validade,
    ativo,
  };
}

// ---------------------------------------------------------------------------
// Rotas de Plano (consumidas pelo app Flutter)
// ---------------------------------------------------------------------------

// GET /plano/:adminUid — retorna o plano atual do admin
app.get('/plano/:adminUid', exigirApiKey, async (req, res) => {
  try {
    const row = await getOuCriarPlano(req.params.adminUid);
    res.json(formatarPlano(row));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /plano/:adminUid/verificar-limites
// Body: { totalMembros: number, totalMinisterios: number }
// Retorna se a operação é permitida dentro dos limites
app.post('/plano/:adminUid/verificar-limites', exigirApiKey, async (req, res) => {
  try {
    const row    = await getOuCriarPlano(req.params.adminUid);
    const plano  = formatarPlano(row);
    const { totalMembros = 0, totalMinisterios = 0 } = req.body;

    res.json({
      membroPermitido:     totalMembros     < plano.limiteMembros,
      ministerioPermitido: totalMinisterios < plano.limiteMinisterios,
      plano,
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ---------------------------------------------------------------------------
// Webhook Mercado Pago
// ---------------------------------------------------------------------------

app.post('/webhook/mercadopago', async (req, res) => {
  try {
    const { type, data } = req.body;
    if (type !== 'payment') return res.sendStatus(200);

    const pagamentoId = data?.id;
    if (!pagamentoId) return res.sendStatus(200);

    // Consulta o pagamento na API do MP
    const mpResp = await fetch(
      `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );
    const mp = await mpResp.json();

    if (mp.status !== 'approved') return res.sendStatus(200);

    // metadata deve vir do preference criado no app:
    // { admin_uid, periodo } onde periodo = 'mensal' | 'anual'
    const adminUid = mp.metadata?.admin_uid;
    const periodo  = mp.metadata?.periodo || 'mensal';
    const valor    = mp.transaction_amount;

    if (!adminUid) return res.sendStatus(200);

    // Calcula validade
    const validade = new Date();
    if (periodo === 'anual') {
      validade.setFullYear(validade.getFullYear() + 1);
    } else {
      validade.setMonth(validade.getMonth() + 1);
    }

    // Ativa o plano Pro
    await pool.query(
      `INSERT INTO na_planos
         (admin_uid, plano, validade, pagamento_id,
          limite_membros, limite_ministerios, permite_gravacao, permite_ia)
       VALUES ($1, 'pro', $2, $3, 30, 2, true, true)
       ON CONFLICT (admin_uid) DO UPDATE SET
         plano              = 'pro',
         validade           = $2,
         pagamento_id       = $3,
         limite_membros     = 30,
         limite_ministerios = 2,
         permite_gravacao   = true,
         permite_ia         = true,
         atualizado_em      = now()`,
      [adminUid, validade, String(pagamentoId)]
    );

    // Registra pagamento
    await pool.query(
      `INSERT INTO na_pagamentos
         (admin_uid, pagamento_id, status, valor, periodo)
       VALUES ($1, $2, 'approved', $3, $4)
       ON CONFLICT (pagamento_id) DO NOTHING`,
      [adminUid, String(pagamentoId), valor, periodo]
    );

    console.log(`[MP] Plano Pro ativado para ${adminUid} até ${validade.toISOString()}`);
    res.sendStatus(200);
  } catch (e) {
    console.error('[MP] Erro no webhook:', e);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// Dashboard de administração de planos
// ---------------------------------------------------------------------------

app.get('/admin/planos', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM na_planos ORDER BY atualizado_em DESC`
  );
  const { rows: pags } = await pool.query(
    `SELECT * FROM na_pagamentos ORDER BY criado_em DESC LIMIT 50`
  );

  const linhas = rows.map(r => {
    const ativo    = planoEstaAtivo(r);
    const validade = r.validade
      ? new Date(r.validade).toLocaleDateString('pt-BR')
      : '—';
    const badge = ativo && r.plano === 'pro'
      ? '<span style="background:#6c63ff;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px">PRO</span>'
      : '<span style="background:#ccc;color:#333;padding:2px 8px;border-radius:12px;font-size:11px">FREE</span>';

    return `<tr>
      <td style="font-size:11px;color:#666">${r.admin_uid}</td>
      <td>${badge}</td>
      <td>${validade}</td>
      <td>${r.limite_membros}</td>
      <td>${r.limite_ministerios}</td>
      <td>${r.permite_gravacao ? '✅' : '❌'}</td>
      <td>${r.permite_ia ? '✅' : '❌'}</td>
      <td>
        <button onclick="ativarPro('${r.admin_uid}')"
          style="background:#6c63ff;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px">
          Ativar Pro
        </button>
        <button onclick="revogar('${r.admin_uid}')"
          style="background:#ff4444;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:4px">
          Revogar
        </button>
      </td>
    </tr>`;
  }).join('');

  const linhasPag = pags.map(p => `<tr>
    <td style="font-size:11px;color:#666">${p.admin_uid}</td>
    <td>${p.pagamento_id}</td>
    <td>${p.status}</td>
    <td>R$ ${Number(p.valor).toFixed(2)}</td>
    <td>${p.periodo}</td>
    <td>${new Date(p.criado_em).toLocaleDateString('pt-BR')}</td>
  </tr>`).join('');

  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notas de Adoração — Painel de Planos</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #f5f5f5; color: #333; }
  header { background: #6c63ff; color: #fff; padding: 16px 24px; }
  header h1 { font-size: 18px; }
  header p  { font-size: 12px; opacity: .7; margin-top: 2px; }
  .container { max-width: 1100px; margin: 24px auto; padding: 0 16px; }
  .card { background: #fff; border-radius: 12px; padding: 20px; margin-bottom: 24px;
          box-shadow: 0 1px 4px rgba(0,0,0,.08); }
  h2 { font-size: 15px; margin-bottom: 16px; color: #6c63ff; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 10px; background: #f0f0f0;
       border-bottom: 1px solid #e0e0e0; font-size: 11px; color: #666; }
  td { padding: 10px; border-bottom: 1px solid #f0f0f0; vertical-align: middle; }
  tr:hover td { background: #fafafa; }
  .form-row { display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 16px; }
  .form-row input, .form-row select {
    border: 1px solid #ddd; border-radius: 8px; padding: 8px 12px;
    font-size: 13px; flex: 1; min-width: 200px; }
  .form-row button {
    background: #6c63ff; color: #fff; border: none; border-radius: 8px;
    padding: 9px 20px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .form-row button:hover { background: #574fd6; }
  #msg { padding: 10px 14px; border-radius: 8px; font-size: 13px; display: none; margin-bottom: 12px; }
  .ok  { background: #e6f4ea; color: #2e7d32; }
  .err { background: #fdecea; color: #c62828; }
</style>
</head>
<body>
<header>
  <h1>🎵 Notas de Adoração — Painel de Planos</h1>
  <p>Gerencie planos e pagamentos dos administradores de ministério</p>
</header>
<div class="container">

  <div class="card">
    <h2>Ativar / Ajustar Plano Manualmente</h2>
    <div id="msg"></div>
    <div class="form-row">
      <input id="uid" placeholder="UID Firebase do admin" />
      <select id="periodo">
        <option value="mensal">Mensal (30 dias)</option>
        <option value="anual">Anual (365 dias)</option>
        <option value="trial">Trial (7 dias)</option>
      </select>
      <button onclick="ativarProManual()">Ativar Pro</button>
    </div>
  </div>

  <div class="card">
    <h2>Planos Cadastrados</h2>
    <table>
      <thead><tr>
        <th>Admin UID</th><th>Plano</th><th>Válido até</th>
        <th>Máx. Membros</th><th>Máx. Ministérios</th>
        <th>Gravação</th><th>IA</th><th>Ações</th>
      </tr></thead>
      <tbody id="tbPlanos">${linhas}</tbody>
    </table>
  </div>

  <div class="card">
    <h2>Últimos Pagamentos</h2>
    <table>
      <thead><tr>
        <th>Admin UID</th><th>Pagamento ID</th><th>Status</th>
        <th>Valor</th><th>Período</th><th>Data</th>
      </tr></thead>
      <tbody>${linhasPag}</tbody>
    </table>
  </div>

</div>
<script>
const KEY = '${API_KEY || ''}';
const headers = { 'Content-Type': 'application/json', 'x-api-key': KEY };

function mostrarMsg(txt, ok) {
  const el = document.getElementById('msg');
  el.textContent = txt;
  el.className = ok ? 'ok' : 'err';
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 4000);
}

async function ativarProManual() {
  const uid     = document.getElementById('uid').value.trim();
  const periodo = document.getElementById('periodo').value;
  if (!uid) return mostrarMsg('Informe o UID do admin.', false);
  const r = await fetch('/admin/planos/ativar', {
    method: 'POST', headers,
    body: JSON.stringify({ adminUid: uid, periodo })
  });
  const d = await r.json();
  if (r.ok) { mostrarMsg('Plano Pro ativado! Recarregue para ver.', true); }
  else       { mostrarMsg(d.erro || 'Erro desconhecido.', false); }
}

async function ativarPro(uid) {
  const r = await fetch('/admin/planos/ativar', {
    method: 'POST', headers,
    body: JSON.stringify({ adminUid: uid, periodo: 'mensal' })
  });
  const d = await r.json();
  if (r.ok) { mostrarMsg('Renovado!', true); location.reload(); }
  else       { mostrarMsg(d.erro, false); }
}

async function revogar(uid) {
  if (!confirm('Revogar plano Pro de ' + uid + '?')) return;
  const r = await fetch('/admin/planos/revogar', {
    method: 'POST', headers,
    body: JSON.stringify({ adminUid: uid })
  });
  const d = await r.json();
  if (r.ok) { mostrarMsg('Plano revogado.', true); location.reload(); }
  else       { mostrarMsg(d.erro, false); }
}
</script>
</body>
</html>`);
});



// ---------------------------------------------------------------------------
// Notificações de escala — dispara push para membros escalados
// ---------------------------------------------------------------------------

// POST /notificacoes/escala
// Body: { uids, ministerioId, escalaId, titulo, corpo, data }
app.post('/notificacoes/escala', exigirApiKey, async (req, res) => {
  try {
    const { uids, ministerioId, escalaId, titulo, corpo, data: dadosExtra } = req.body;
    if (!uids || !Array.isArray(uids) || uids.length === 0) {
      return res.status(400).json({ erro: 'uids é obrigatório.' });
    }

    const db = admin.firestore();

    // Coleta todos os tokens FCM dos uids escalados
    const tokens = [];
    for (const uid of uids) {
      const snap = await db
          .collection('usuarios').doc(uid)
          .collection('tokensFcm')
          .get();
      snap.docs.forEach(d => tokens.push(d.id));
    }

    if (tokens.length === 0) {
      return res.json({ ok: true, enviados: 0, motivo: 'Nenhum token FCM registrado.' });
    }

    // Remove duplicatas
    const uniqueTokens = [...new Set(tokens)];

    // Envia em lotes de 500 (limite do FCM)
    const BATCH = 500;
    let enviados = 0;
    let falhas   = 0;

    for (let i = 0; i < uniqueTokens.length; i += BATCH) {
      const lote = uniqueTokens.slice(i, i + BATCH);
      const result = await admin.messaging().sendEachForMulticast({
        tokens: lote,
        notification: { title: titulo, body: corpo },
        data: {
          tipo:         dadosExtra?.tipo        ?? 'escala',
          ministerioId: dadosExtra?.ministerioId ?? ministerioId ?? '',
          escalaId:     dadosExtra?.escalaId     ?? escalaId     ?? '',
        },
        android: {
          priority: 'high',
          notification: { sound: 'default', channelId: 'escalas' },
        },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
      });
      enviados += result.successCount;
      falhas   += result.failureCount;

      // Remove tokens inválidos do Firestore
      for (let j = 0; j < result.responses.length; j++) {
        const r = result.responses[j];
        if (!r.success && (
            r.error?.code === 'messaging/registration-token-not-registered' ||
            r.error?.code === 'messaging/invalid-registration-token'
        )) {
          // Remove token inválido — best-effort
          try {
            const tokenInvalido = lote[j];
            for (const uid of uids) {
              await db.collection('usuarios').doc(uid)
                  .collection('tokensFcm').doc(tokenInvalido).delete();
            }
          } catch (_) {}
        }
      }
    }

    console.log(`[FCM Escala] ${enviados} enviados, ${falhas} falhas para ${uids.length} membros`);
    res.json({ ok: true, enviados, falhas, tokens: uniqueTokens.length });
  } catch (e) {
    console.error('[FCM Escala] Erro:', e);
    res.status(500).json({ erro: e.message });
  }
});

// GET /admin/planos/lista — dados completos para o dashboard Flutter
app.get('/admin/planos/lista', exigirApiKey, async (req, res) => {
  try {
    const { rows: planos } = await pool.query(
      'SELECT * FROM na_planos ORDER BY atualizado_em DESC'
    );
    const { rows: pagamentos } = await pool.query(
      'SELECT * FROM na_pagamentos ORDER BY criado_em DESC LIMIT 100'
    );

    // Métricas rápidas
    const totalPro  = planos.filter(p => p.plano === 'pro' && p.validade && new Date(p.validade) > new Date()).length;
    const totalFree = planos.length - totalPro;

    const inicioMes = new Date();
    inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const receitaMes = pagamentos
      .filter(p => p.status === 'approved' && new Date(p.criado_em) >= inicioMes)
      .reduce((s, p) => s + parseFloat(p.valor), 0);

    res.json({
      planos,
      pagamentos,
      metricas: { totalPro, totalFree, receitaMes: receitaMes.toFixed(2) },
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /admin/planos/ativar — ativação manual pelo dashboard
app.post('/admin/planos/ativar', exigirApiKey, async (req, res) => {
  try {
    const { adminUid, periodo = 'mensal' } = req.body;
    if (!adminUid) return res.status(400).json({ erro: 'adminUid obrigatório.' });

    const validade = new Date();
    if (periodo === 'anual')  validade.setFullYear(validade.getFullYear() + 1);
    else if (periodo === 'trial') validade.setDate(validade.getDate() + 7);
    else validade.setMonth(validade.getMonth() + 1);

    await pool.query(
      `INSERT INTO na_planos
         (admin_uid, plano, validade, limite_membros,
          limite_ministerios, permite_gravacao, permite_ia)
       VALUES ($1, 'pro', $2, 30, 2, true, true)
       ON CONFLICT (admin_uid) DO UPDATE SET
         plano              = 'pro',
         validade           = $2,
         limite_membros     = 30,
         limite_ministerios = 2,
         permite_gravacao   = true,
         permite_ia         = true,
         atualizado_em      = now()`,
      [adminUid, validade]
    );
    res.json({ ok: true, validade });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// POST /admin/planos/revogar — revoga Pro, volta para Free
app.post('/admin/planos/revogar', exigirApiKey, async (req, res) => {
  try {
    const { adminUid } = req.body;
    if (!adminUid) return res.status(400).json({ erro: 'adminUid obrigatório.' });

    await pool.query(
      `UPDATE na_planos SET
         plano              = 'free',
         validade           = NULL,
         limite_membros     = 10,
         limite_ministerios = 1,
         permite_gravacao   = false,
         permite_ia         = false,
         atualizado_em      = now()
       WHERE admin_uid = $1`,
      [adminUid]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ---------------------------------------------------------------------------
// Gravações — deleção no Cloudinary
// ---------------------------------------------------------------------------

app.delete('/gravacao', exigirApiKey, async (req, res) => {
  const { publicId } = req.query;
  if (!publicId) return res.status(400).json({ erro: 'publicId é obrigatório.' });
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: 'raw',
    });
    res.json({ ok: true, cloudinary: result.result });
  } catch (err) {
    console.error('Erro ao deletar no Cloudinary:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Rotas de Músicas (existentes)
// ---------------------------------------------------------------------------

app.get('/musicas', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, cifra_original, tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});

app.get('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, cifra_original, tom_original FROM cifras_musicas WHERE id = $1',
    [req.params.id]
  );
  if (rows.length === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});

app.post('/musicas', exigirApiKey, async (req, res) => {
  const { titulo, cifraOriginal, tomOriginal } = req.body;
  if (!titulo || !cifraOriginal || !tomOriginal)
    return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_musicas (id, titulo, cifra_original, tom_original) VALUES ($1, $2, $3, $4)',
    [id, titulo, cifraOriginal, tomOriginal]
  );
  res.status(201).json({ id, titulo, cifraOriginal, tomOriginal });
});

app.put('/musicas/:id', exigirApiKey, async (req, res) => {
  const { titulo, cifraOriginal, tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_musicas SET titulo=$1, cifra_original=$2, tom_original=$3, atualizado_em=now() WHERE id=$4`,
    [titulo, cifraOriginal, tomOriginal, req.params.id]
  );
  if (rowCount === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

app.delete('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_musicas WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

// Variantes
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
    `INSERT INTO cifras_variantes (id, musica_id, label, semitons_transposicao, cifra_texto_custom) VALUES ($1,$2,$3,$4,$5)`,
    [id, req.params.musicaId, label, semitomsTransposicao ?? 0, cifraTextoCustom ?? null]
  );
  res.status(201).json({ id, musicaId: req.params.musicaId, label });
});

app.put('/variantes/:id', exigirApiKey, async (req, res) => {
  const { label, semitomsTransposicao, cifraTextoCustom } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_variantes SET label=$1, semitons_transposicao=$2, cifra_texto_custom=$3 WHERE id=$4`,
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

// Registros
app.get('/registros', exigirApiKey, async (req, res) => {
  const { tipoCulto, musicaId } = req.query;
  const condicoes = [], valores = [];
  if (musicaId)  { valores.push(musicaId);  condicoes.push(`musica_id = $${valores.length}`); }
  if (tipoCulto) { valores.push(tipoCulto); condicoes.push(`tipo_culto = $${valores.length}`); }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id, musica_id, variante_id, data, tipo_culto FROM cifras_registros ${where} ORDER BY data DESC`,
    valores
  );
  res.json(rows.map(formatarRegistro));
});

app.post('/registros', exigirApiKey, async (req, res) => {
  const { musicaId, varianteId, data, tipoCulto } = req.body;
  if (!musicaId || !data || !tipoCulto)
    return res.status(400).json({ erro: 'musicaId, data e tipoCulto são obrigatórios.' });
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_registros (id, musica_id, variante_id, data, tipo_culto) VALUES ($1,$2,$3,$4,$5)',
    [id, musicaId, varianteId ?? null, data, tipoCulto]
  );
  res.status(201).json({ id, musicaId, varianteId: varianteId ?? null, data, tipoCulto });
});

app.delete('/registros/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_registros WHERE id = $1', [req.params.id]);
  if (rowCount === 0) return res.status(404).json({ erro: 'Registro não encontrado.' });
  res.json({ ok: true });
});

// Dashboard existente
app.use('/dashboard', express.static(path.join(__dirname, 'public')));

app.get('/dashboard-api/musicas', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, titulo, cifra_original, tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatarMusica(row) {
  return { id: row.id, titulo: row.titulo, cifraOriginal: row.cifra_original, tomOriginal: row.tom_original };
}
function formatarVariante(row) {
  return { id: row.id, musicaId: row.musica_id, label: row.label,
    semitomsTransposicao: row.semitons_transposicao, cifraTextoCustom: row.cifra_texto_custom };
}
function formatarRegistro(row) {
  return { id: row.id, musicaId: row.musica_id, varianteId: row.variante_id,
    data: row.data, tipoCulto: row.tipo_culto };
}

// ---------------------------------------------------------------------------
// Inicialização
// ---------------------------------------------------------------------------

const PORT = process.env.PORT || 3000;

initSchema().then(() => {
  app.listen(PORT, () => console.log(`Notas de Adoração API rodando na porta ${PORT}`));
}).catch(err => {
  console.error('Erro ao inicializar schema:', err);
  process.exit(1);
});
