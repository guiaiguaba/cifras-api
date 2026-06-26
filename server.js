const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const { pool, initSchema } = require('./db');
const cloudinary = require('cloudinary').v2;
const admin      = require('firebase-admin');

// ---------------------------------------------------------------------------
// Firebase Admin SDK
// ---------------------------------------------------------------------------
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

const API_KEY        = process.env.API_KEY;
const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;

if (!API_KEY) {
  console.warn('AVISO: API_KEY não definida. API acessível sem autenticação.');
}

function exigirApiKey(req, res, next) {
  if (!API_KEY) return next();
  const chave = req.header('x-api-key');
  if (chave !== API_KEY) return res.status(401).json({ erro: 'API key inválida ou ausente.' });
  next();
}

// ---------------------------------------------------------------------------
// Helpers de plano
// ---------------------------------------------------------------------------

async function getOuCriarPlano(adminUid) {
  const { rows } = await pool.query('SELECT * FROM na_planos WHERE admin_uid=$1', [adminUid]);
  if (rows.length > 0) return rows[0];
  const { rows: novo } = await pool.query(
    `INSERT INTO na_planos (admin_uid,plano,limite_membros,limite_ministerios,permite_gravacao,permite_ia)
     VALUES ($1,'free',10,1,false,false) RETURNING *`,
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
    plano:             ativo ? row.plano : 'free',
    limiteMembros:     ativo ? row.limite_membros : 10,
    limiteMinisterios: ativo ? row.limite_ministerios : 1,
    permiteGravacao:   ativo ? row.permite_gravacao : false,
    permiteIa:         ativo ? row.permite_ia : false,
    validade:          row.validade,
    ativo,
  };
}

// ---------------------------------------------------------------------------
// Rotas de Plano
// ---------------------------------------------------------------------------

app.get('/plano/:adminUid', exigirApiKey, async (req, res) => {
  try {
    const row = await getOuCriarPlano(req.params.adminUid);
    res.json(formatarPlano(row));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/plano/:adminUid/verificar-limites', exigirApiKey, async (req, res) => {
  try {
    const row   = await getOuCriarPlano(req.params.adminUid);
    const plano = formatarPlano(row);
    const { totalMembros = 0, totalMinisterios = 0 } = req.body;
    res.json({
      membroPermitido:     totalMembros     < plano.limiteMembros,
      ministerioPermitido: totalMinisterios < plano.limiteMinisterios,
      plano,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
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

    const mpResp = await fetch(
      `https://api.mercadopago.com/v1/payments/${pagamentoId}`,
      { headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` } }
    );
    const mp = await mpResp.json();
    if (mp.status !== 'approved') return res.sendStatus(200);

    const adminUid = mp.metadata?.admin_uid;
    const periodo  = mp.metadata?.periodo || 'mensal';
    const valor    = mp.transaction_amount;
    if (!adminUid) return res.sendStatus(200);

    const validade = new Date();
    if (periodo === 'anual') validade.setFullYear(validade.getFullYear() + 1);
    else validade.setMonth(validade.getMonth() + 1);

    await pool.query(
      `INSERT INTO na_planos (admin_uid,plano,validade,pagamento_id,limite_membros,limite_ministerios,permite_gravacao,permite_ia)
       VALUES ($1,'pro',$2,$3,30,2,true,true)
       ON CONFLICT (admin_uid) DO UPDATE SET
         plano='pro',validade=$2,pagamento_id=$3,
         limite_membros=30,limite_ministerios=2,
         permite_gravacao=true,permite_ia=true,atualizado_em=now()`,
      [adminUid, validade, String(pagamentoId)]
    );
    await pool.query(
      `INSERT INTO na_pagamentos (admin_uid,pagamento_id,status,valor,periodo)
       VALUES ($1,$2,'approved',$3,$4) ON CONFLICT (pagamento_id) DO NOTHING`,
      [adminUid, String(pagamentoId), valor, periodo]
    );
    console.log(`[MP] Pro ativado para ${adminUid} até ${validade.toISOString()}`);
    res.sendStatus(200);
  } catch (e) {
    console.error('[MP] Erro:', e);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------------------
// Dashboard HTML de planos
// ---------------------------------------------------------------------------

app.get('/admin/planos', async (req, res) => {
  const { rows }      = await pool.query(`SELECT * FROM na_planos ORDER BY atualizado_em DESC`);
  const { rows: pags } = await pool.query(`SELECT * FROM na_pagamentos ORDER BY criado_em DESC LIMIT 50`);

  const linhas = rows.map(r => {
    const ativo    = planoEstaAtivo(r);
    const validade = r.validade ? new Date(r.validade).toLocaleDateString('pt-BR') : '—';
    const badge    = ativo && r.plano === 'pro'
      ? '<span style="background:#6c63ff;color:#fff;padding:2px 8px;border-radius:12px;font-size:11px">PRO</span>'
      : '<span style="background:#ccc;color:#333;padding:2px 8px;border-radius:12px;font-size:11px">FREE</span>';
    return `<tr>
      <td style="font-size:11px;color:#666">${r.admin_uid}</td>
      <td>${badge}</td><td>${validade}</td>
      <td>${r.limite_membros}</td><td>${r.limite_ministerios}</td>
      <td>${r.permite_gravacao?'✅':'❌'}</td><td>${r.permite_ia?'✅':'❌'}</td>
      <td>
        <button onclick="ativarPro('${r.admin_uid}')" style="background:#6c63ff;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px">Ativar Pro</button>
        <button onclick="revogar('${r.admin_uid}')" style="background:#ff4444;color:#fff;border:none;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px;margin-left:4px">Revogar</button>
      </td></tr>`;
  }).join('');

  const linhasPag = pags.map(p => `<tr>
    <td style="font-size:11px;color:#666">${p.admin_uid}</td>
    <td>${p.pagamento_id}</td><td>${p.status}</td>
    <td>R$ ${Number(p.valor).toFixed(2)}</td><td>${p.periodo}</td>
    <td>${new Date(p.criado_em).toLocaleDateString('pt-BR')}</td></tr>`).join('');

  res.send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Notas de Adoração — Painel</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#f5f5f5;color:#333}
header{background:#6c63ff;color:#fff;padding:16px 24px}header h1{font-size:18px}header p{font-size:12px;opacity:.7;margin-top:2px}
.container{max-width:1100px;margin:24px auto;padding:0 16px}.card{background:#fff;border-radius:12px;padding:20px;margin-bottom:24px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
h2{font-size:15px;margin-bottom:16px;color:#6c63ff}table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 10px;background:#f0f0f0;border-bottom:1px solid #e0e0e0;font-size:11px;color:#666}
td{padding:10px;border-bottom:1px solid #f0f0f0;vertical-align:middle}tr:hover td{background:#fafafa}
.form-row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end;margin-bottom:16px}
.form-row input,.form-row select{border:1px solid #ddd;border-radius:8px;padding:8px 12px;font-size:13px;flex:1;min-width:200px}
.form-row button{background:#6c63ff;color:#fff;border:none;border-radius:8px;padding:9px 20px;cursor:pointer;font-size:13px;font-weight:600}
#msg{padding:10px 14px;border-radius:8px;font-size:13px;display:none;margin-bottom:12px}
.ok{background:#e6f4ea;color:#2e7d32}.err{background:#fdecea;color:#c62828}</style></head>
<body><header><h1>🎵 Notas de Adoração — Painel de Planos</h1><p>Gerencie planos e pagamentos</p></header>
<div class="container">
<div class="card"><h2>Ativar / Ajustar Plano Manualmente</h2><div id="msg"></div>
<div class="form-row">
<input id="uid" placeholder="UID Firebase do admin"/>
<select id="periodo"><option value="mensal">Mensal (30 dias)</option><option value="anual">Anual (365 dias)</option><option value="trial">Trial (7 dias)</option></select>
<button onclick="ativarProManual()">Ativar Pro</button></div></div>
<div class="card"><h2>Planos Cadastrados</h2><table><thead><tr>
<th>Admin UID</th><th>Plano</th><th>Válido até</th><th>Máx. Membros</th><th>Máx. Ministérios</th><th>Gravação</th><th>IA</th><th>Ações</th>
</tr></thead><tbody>${linhas}</tbody></table></div>
<div class="card"><h2>Últimos Pagamentos</h2><table><thead><tr>
<th>Admin UID</th><th>Pagamento ID</th><th>Status</th><th>Valor</th><th>Período</th><th>Data</th>
</tr></thead><tbody>${linhasPag}</tbody></table></div></div>
<script>
const KEY='${API_KEY||''}';const headers={'Content-Type':'application/json','x-api-key':KEY};
function mostrarMsg(txt,ok){const el=document.getElementById('msg');el.textContent=txt;el.className=ok?'ok':'err';el.style.display='block';setTimeout(()=>el.style.display='none',4000);}
async function ativarProManual(){const uid=document.getElementById('uid').value.trim();const periodo=document.getElementById('periodo').value;if(!uid)return mostrarMsg('Informe o UID.',false);const r=await fetch('/admin/planos/ativar',{method:'POST',headers,body:JSON.stringify({adminUid:uid,periodo})});const d=await r.json();r.ok?mostrarMsg('Plano Pro ativado! Recarregue.',true):mostrarMsg(d.erro||'Erro.',false);}
async function ativarPro(uid){const r=await fetch('/admin/planos/ativar',{method:'POST',headers,body:JSON.stringify({adminUid:uid,periodo:'mensal'})});const d=await r.json();r.ok?(mostrarMsg('Renovado!',true),location.reload()):mostrarMsg(d.erro,false);}
async function revogar(uid){if(!confirm('Revogar plano Pro de '+uid+'?'))return;const r=await fetch('/admin/planos/revogar',{method:'POST',headers,body:JSON.stringify({adminUid:uid})});const d=await r.json();r.ok?(mostrarMsg('Revogado.',true),location.reload()):mostrarMsg(d.erro,false);}
</script></body></html>`);
});

// ---------------------------------------------------------------------------
// Notificações de escala (FCM)
// ---------------------------------------------------------------------------

app.post('/notificacoes/escala', exigirApiKey, async (req, res) => {
  try {
    const { uids, ministerioId, escalaId, titulo, corpo, data: dadosExtra } = req.body;
    if (!uids || !Array.isArray(uids) || uids.length === 0)
      return res.status(400).json({ erro: 'uids é obrigatório.' });

    const db     = admin.firestore();
    const tokens = [];
    for (const uid of uids) {
      const snap = await db.collection('usuarios').doc(uid).collection('tokensFcm').get();
      snap.docs.forEach(d => tokens.push(d.id));
    }
    if (tokens.length === 0)
      return res.json({ ok: true, enviados: 0, motivo: 'Nenhum token FCM registrado.' });

    const uniqueTokens = [...new Set(tokens)];
    let enviados = 0, falhas = 0;

    for (let i = 0; i < uniqueTokens.length; i += 500) {
      const lote   = uniqueTokens.slice(i, i + 500);
      const result = await admin.messaging().sendEachForMulticast({
        tokens: lote,
        notification: { title: titulo, body: corpo },
        data: {
          tipo:         dadosExtra?.tipo        ?? 'escala',
          ministerioId: dadosExtra?.ministerioId ?? ministerioId ?? '',
          escalaId:     dadosExtra?.escalaId     ?? escalaId     ?? '',
        },
        android: { priority: 'high', notification: { sound: 'default', channelId: 'escalas' } },
        apns:    { payload: { aps: { sound: 'default', badge: 1 } } },
      });
      enviados += result.successCount;
      falhas   += result.failureCount;
      for (let j = 0; j < result.responses.length; j++) {
        const r = result.responses[j];
        if (!r.success && (
          r.error?.code === 'messaging/registration-token-not-registered' ||
          r.error?.code === 'messaging/invalid-registration-token'
        )) {
          try {
            const t = lote[j];
            for (const uid of uids)
              await db.collection('usuarios').doc(uid).collection('tokensFcm').doc(t).delete();
          } catch (_) {}
        }
      }
    }
    console.log(`[FCM] ${enviados} enviados, ${falhas} falhas`);
    res.json({ ok: true, enviados, falhas, tokens: uniqueTokens.length });
  } catch (e) {
    console.error('[FCM] Erro:', e);
    res.status(500).json({ erro: e.message });
  }
});

// ---------------------------------------------------------------------------
// Admin planos/lista (dashboard Flutter)
// ---------------------------------------------------------------------------

app.get('/admin/planos/lista', exigirApiKey, async (req, res) => {
  try {
    const { rows: planos     } = await pool.query('SELECT * FROM na_planos ORDER BY atualizado_em DESC');
    const { rows: pagamentos } = await pool.query('SELECT * FROM na_pagamentos ORDER BY criado_em DESC LIMIT 100');
    const totalPro   = planos.filter(p => p.plano==='pro' && p.validade && new Date(p.validade)>new Date()).length;
    const totalFree  = planos.length - totalPro;
    const inicioMes  = new Date(); inicioMes.setDate(1); inicioMes.setHours(0,0,0,0);
    const receitaMes = pagamentos
      .filter(p => p.status==='approved' && new Date(p.criado_em)>=inicioMes)
      .reduce((s,p) => s+parseFloat(p.valor), 0);
    res.json({ planos, pagamentos, metricas:{ totalPro, totalFree, receitaMes: receitaMes.toFixed(2) } });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/admin/planos/ativar', exigirApiKey, async (req, res) => {
  try {
    const { adminUid, periodo='mensal' } = req.body;
    if (!adminUid) return res.status(400).json({ erro: 'adminUid obrigatório.' });
    const validade = new Date();
    if (periodo==='anual')      validade.setFullYear(validade.getFullYear()+1);
    else if (periodo==='trial') validade.setDate(validade.getDate()+7);
    else                        validade.setMonth(validade.getMonth()+1);
    await pool.query(
      `INSERT INTO na_planos (admin_uid,plano,validade,limite_membros,limite_ministerios,permite_gravacao,permite_ia)
       VALUES ($1,'pro',$2,30,2,true,true)
       ON CONFLICT (admin_uid) DO UPDATE SET
         plano='pro',validade=$2,limite_membros=30,limite_ministerios=2,
         permite_gravacao=true,permite_ia=true,atualizado_em=now()`,
      [adminUid, validade]
    );
    res.json({ ok: true, validade });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/admin/planos/revogar', exigirApiKey, async (req, res) => {
  try {
    const { adminUid } = req.body;
    if (!adminUid) return res.status(400).json({ erro: 'adminUid obrigatório.' });
    await pool.query(
      `UPDATE na_planos SET plano='free',validade=NULL,
         limite_membros=10,limite_ministerios=1,
         permite_gravacao=false,permite_ia=false,atualizado_em=now()
       WHERE admin_uid=$1`,
      [adminUid]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ---------------------------------------------------------------------------
// Gravações — deleção no Cloudinary
// ---------------------------------------------------------------------------

app.delete('/gravacao', exigirApiKey, async (req, res) => {
  const { publicId } = req.query;
  if (!publicId) return res.status(400).json({ erro: 'publicId é obrigatório.' });
  try {
    const result = await cloudinary.uploader.destroy(publicId, { resource_type: 'raw' });
    res.json({ ok: true, cloudinary: result.result });
  } catch (err) {
    console.error('Erro Cloudinary:', err);
    res.status(500).json({ erro: err.message });
  }
});

// ---------------------------------------------------------------------------
// Músicas
// ---------------------------------------------------------------------------

app.get('/musicas', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,titulo,artista,imagem_url,cifra_original,tom_original FROM cifras_musicas ORDER BY titulo'
  );
  res.json(rows.map(formatarMusica));
});
app.get('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,titulo,artista,imagem_url,cifra_original,tom_original FROM cifras_musicas WHERE id=$1',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});
app.post('/musicas', exigirApiKey, async (req, res) => {
  const { titulo, artista, imagemUrl, cifraOriginal, tomOriginal } = req.body;
  if (!titulo || !cifraOriginal || !tomOriginal)
    return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_musicas (id,titulo,artista,imagem_url,cifra_original,tom_original) VALUES ($1,$2,$3,$4,$5,$6)',
    [id,titulo,artista??null,imagemUrl??null,cifraOriginal,tomOriginal]
  );
  res.status(201).json({ id,titulo,artista:artista??null,imagemUrl:imagemUrl??null,cifraOriginal,tomOriginal });
});
app.put('/musicas/:id', exigirApiKey, async (req, res) => {
  const { titulo, artista, imagemUrl, cifraOriginal, tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    `UPDATE cifras_musicas SET titulo=$1,artista=$2,imagem_url=$3,cifra_original=$4,tom_original=$5,atualizado_em=now() WHERE id=$6`,
    [titulo,artista??null,imagemUrl??null,cifraOriginal,tomOriginal,req.params.id]
  );
  if (!rowCount) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});
app.delete('/musicas/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_musicas WHERE id=$1',[req.params.id]);
  if (!rowCount) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});
app.get('/musicas/:musicaId/variantes', exigirApiKey, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id,musica_id,label,semitons_transposicao,cifra_texto_custom FROM cifras_variantes WHERE musica_id=$1',
    [req.params.musicaId]
  );
  res.json(rows.map(formatarVariante));
});
app.post('/musicas/:musicaId/variantes', exigirApiKey, async (req, res) => {
  const { label, semitomsTransposicao, cifraTextoCustom } = req.body;
  if (!label) return res.status(400).json({ erro: 'label é obrigatório.' });
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_variantes (id,musica_id,label,semitons_transposicao,cifra_texto_custom) VALUES ($1,$2,$3,$4,$5)',
    [id,req.params.musicaId,label,semitomsTransposicao??0,cifraTextoCustom??null]
  );
  res.status(201).json({ id, musicaId:req.params.musicaId, label, semitomsTransposicao:semitomsTransposicao??0, cifraTextoCustom:cifraTextoCustom??null });
});
app.put('/variantes/:id', exigirApiKey, async (req, res) => {
  const { label, semitomsTransposicao, cifraTextoCustom } = req.body;
  const { rowCount } = await pool.query(
    'UPDATE cifras_variantes SET label=$1,semitons_transposicao=$2,cifra_texto_custom=$3 WHERE id=$4',
    [label,semitomsTransposicao??0,cifraTextoCustom??null,req.params.id]
  );
  if (!rowCount) return res.status(404).json({ erro: 'Variante não encontrada.' });
  res.json({ ok: true });
});
app.delete('/variantes/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_variantes WHERE id=$1',[req.params.id]);
  if (!rowCount) return res.status(404).json({ erro: 'Variante não encontrada.' });
  res.json({ ok: true });
});
app.get('/registros', exigirApiKey, async (req, res) => {
  const { tipoCulto, musicaId } = req.query;
  const condicoes=[], valores=[];
  if (musicaId)  { valores.push(musicaId);  condicoes.push(`musica_id=$${valores.length}`); }
  if (tipoCulto) { valores.push(tipoCulto); condicoes.push(`tipo_culto=$${valores.length}`); }
  const where = condicoes.length ? `WHERE ${condicoes.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT id,musica_id,variante_id,data,tipo_culto FROM cifras_registros ${where} ORDER BY data DESC`,
    valores
  );
  res.json(rows.map(formatarRegistro));
});
app.post('/registros', exigirApiKey, async (req, res) => {
  const { musicaId, varianteId, data, tipoCulto } = req.body;
  if (!musicaId||!data||!tipoCulto) return res.status(400).json({ erro: 'musicaId, data e tipoCulto são obrigatórios.' });
  const id = crypto.randomUUID();
  await pool.query(
    'INSERT INTO cifras_registros (id,musica_id,variante_id,data,tipo_culto) VALUES ($1,$2,$3,$4,$5)',
    [id,musicaId,varianteId??null,data,tipoCulto]
  );
  res.status(201).json({ id,musicaId,varianteId:varianteId??null,data,tipoCulto });
});
app.delete('/registros/:id', exigirApiKey, async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_registros WHERE id=$1',[req.params.id]);
  if (!rowCount) return res.status(404).json({ erro: 'Registro não encontrado.' });
  res.json({ ok: true });
});

// Dashboard estático
app.use('/dashboard', express.static(path.join(__dirname, 'public')));
app.get('/dashboard-api/musicas', async (req, res) => {
  const { rows } = await pool.query('SELECT id,titulo,artista,imagem_url,cifra_original,tom_original FROM cifras_musicas ORDER BY titulo');
  res.json(rows.map(formatarMusica));
});
app.get('/dashboard-api/musicas/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT id,titulo,artista,imagem_url,cifra_original,tom_original FROM cifras_musicas WHERE id=$1',[req.params.id]);
  if (!rows.length) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json(formatarMusica(rows[0]));
});
app.post('/dashboard-api/musicas', async (req, res) => {
  const { titulo,artista,imagemUrl,cifraOriginal,tomOriginal } = req.body;
  if (!titulo||!cifraOriginal||!tomOriginal) return res.status(400).json({ erro: 'titulo, cifraOriginal e tomOriginal são obrigatórios.' });
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO cifras_musicas (id,titulo,artista,imagem_url,cifra_original,tom_original) VALUES ($1,$2,$3,$4,$5,$6)',[id,titulo,artista??null,imagemUrl??null,cifraOriginal,tomOriginal]);
  res.status(201).json({ id,titulo,artista:artista??null,imagemUrl:imagemUrl??null,cifraOriginal,tomOriginal });
});
app.put('/dashboard-api/musicas/:id', async (req, res) => {
  const { titulo,artista,imagemUrl,cifraOriginal,tomOriginal } = req.body;
  const { rowCount } = await pool.query(
    'UPDATE cifras_musicas SET titulo=$1,artista=$2,imagem_url=$3,cifra_original=$4,tom_original=$5,atualizado_em=now() WHERE id=$6',
    [titulo,artista??null,imagemUrl??null,cifraOriginal,tomOriginal,req.params.id]
  );
  if (!rowCount) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});
app.delete('/dashboard-api/musicas/:id', async (req, res) => {
  const { rowCount } = await pool.query('DELETE FROM cifras_musicas WHERE id=$1',[req.params.id]);
  if (!rowCount) return res.status(404).json({ erro: 'Música não encontrada.' });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatarMusica(row) {
  return { id:row.id, titulo:row.titulo, artista:row.artista, imagemUrl:row.imagem_url, cifraOriginal:row.cifra_original, tomOriginal:row.tom_original };
}
function formatarVariante(row) {
  return { id:row.id, musicaId:row.musica_id, label:row.label, semitomsTransposicao:row.semitons_transposicao, cifraTextoCustom:row.cifra_texto_custom };
}
function formatarRegistro(row) {
  return { id:row.id, musicaId:row.musica_id, varianteId:row.variante_id, data:row.data, tipoCulto:row.tipo_culto };
}

// ---------------------------------------------------------------------------
// Hinos — Harpa Cristã e Cantor Cristão
// ---------------------------------------------------------------------------

app.get('/hinos', exigirApiKey, async (req, res) => {
  const { hinario='harpa', q='', pagina='1', por_pagina='30' } = req.query;
  const offset=(parseInt(pagina)-1)*parseInt(por_pagina), limit=parseInt(por_pagina);
  try {
    let rows, total;
    if (q.trim()) {
      const busca=`%${q.trim()}%`;
      const r1=await pool.query(`SELECT id,numero,titulo,hinario,cifra,tom FROM cifras_hinos WHERE hinario=$1 AND (titulo ILIKE $2 OR letra ILIKE $2) ORDER BY numero LIMIT $3 OFFSET $4`,[hinario,busca,limit,offset]);
      const r2=await pool.query(`SELECT COUNT(*) FROM cifras_hinos WHERE hinario=$1 AND (titulo ILIKE $2 OR letra ILIKE $2)`,[hinario,busca]);
      rows=r1.rows; total=parseInt(r2.rows[0].count);
    } else {
      const r1=await pool.query(`SELECT id,numero,titulo,hinario,cifra,tom FROM cifras_hinos WHERE hinario=$1 ORDER BY numero LIMIT $2 OFFSET $3`,[hinario,limit,offset]);
      const r2=await pool.query(`SELECT COUNT(*) FROM cifras_hinos WHERE hinario=$1`,[hinario]);
      rows=r1.rows; total=parseInt(r2.rows[0].count);
    }
    res.json({ total, pagina:parseInt(pagina), hinos:rows });
  } catch(e) { console.error('[hinos]',e.message); res.status(500).json({ erro:'Erro ao listar hinos' }); }
});
app.get('/hinos/stats', exigirApiKey, async (req, res) => {
  try {
    const { rows }=await pool.query(`SELECT hinario,COUNT(*) as total,COUNT(cifra) as com_cifra FROM cifras_hinos GROUP BY hinario ORDER BY hinario`);
    res.json(rows);
  } catch(e) { res.status(500).json({ erro:'Erro ao buscar estatísticas' }); }
});
app.get('/hinos/:hinario/:numero', exigirApiKey, async (req, res) => {
  try {
    const { rows }=await pool.query(`SELECT * FROM cifras_hinos WHERE hinario=$1 AND numero=$2`,[req.params.hinario,parseInt(req.params.numero)]);
    if (!rows.length) return res.status(404).json({ erro:'Hino não encontrado.' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ erro:'Erro ao buscar hino' }); }
});
app.put('/hinos/:hinario/:numero/cifra', exigirApiKey, async (req, res) => {
  const { cifra, tom }=req.body;
  try {
    const { rowCount }=await pool.query(`UPDATE cifras_hinos SET cifra=$1,tom=$2,atualizado_em=now() WHERE hinario=$3 AND numero=$4`,[cifra??null,tom??null,req.params.hinario,parseInt(req.params.numero)]);
    if (!rowCount) return res.status(404).json({ erro:'Hino não encontrado.' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ erro:'Erro ao salvar cifra do hino' }); }
});
app.get('/dashboard-api/hinos', async (req, res) => {
  const { hinario='harpa',q='',pagina='1',por_pagina='30' }=req.query;
  const offset=(parseInt(pagina)-1)*parseInt(por_pagina), limit=parseInt(por_pagina);
  try {
    let rows, total;
    if (q.trim()) {
      const busca=`%${q.trim()}%`;
      const r1=await pool.query(`SELECT id,numero,titulo,hinario,cifra,tom FROM cifras_hinos WHERE hinario=$1 AND (titulo ILIKE $2 OR CAST(numero AS TEXT) LIKE $2) ORDER BY numero LIMIT $3 OFFSET $4`,[hinario,busca,limit,offset]);
      const r2=await pool.query(`SELECT COUNT(*) FROM cifras_hinos WHERE hinario=$1 AND (titulo ILIKE $2 OR CAST(numero AS TEXT) LIKE $2)`,[hinario,busca]);
      rows=r1.rows; total=parseInt(r2.rows[0].count);
    } else {
      const r1=await pool.query(`SELECT id,numero,titulo,hinario,cifra,tom FROM cifras_hinos WHERE hinario=$1 ORDER BY numero LIMIT $2 OFFSET $3`,[hinario,limit,offset]);
      const r2=await pool.query(`SELECT COUNT(*) FROM cifras_hinos WHERE hinario=$1`,[hinario]);
      rows=r1.rows; total=parseInt(r2.rows[0].count);
    }
    res.json({ total, pagina:parseInt(pagina), hinos:rows });
  } catch(e) { res.status(500).json({ erro:'Erro ao listar hinos' }); }
});
app.get('/dashboard-api/hinos/:hinario/:numero', async (req, res) => {
  try {
    const { rows }=await pool.query('SELECT * FROM cifras_hinos WHERE hinario=$1 AND numero=$2',[req.params.hinario,parseInt(req.params.numero)]);
    if (!rows.length) return res.status(404).json({ erro:'Hino não encontrado.' });
    res.json(rows[0]);
  } catch(e) { res.status(500).json({ erro:'Erro ao buscar hino' }); }
});
app.put('/dashboard-api/hinos/:hinario/:numero/cifra', async (req, res) => {
  const { cifra, tom }=req.body;
  try {
    const { rowCount }=await pool.query(`UPDATE cifras_hinos SET cifra=$1,tom=$2,atualizado_em=now() WHERE hinario=$3 AND numero=$4`,[cifra??null,tom??null,req.params.hinario,parseInt(req.params.numero)]);
    if (!rowCount) return res.status(404).json({ erro:'Hino não encontrado.' });
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ erro:'Erro ao salvar cifra' }); }
});

// ---------------------------------------------------------------------------
// CifraClub — busca e obtenção de cifras
// ---------------------------------------------------------------------------

const cheerio = require('cheerio');

const HEADERS_CC = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'pt-BR,pt;q=0.9',
  'Referer': 'https://www.cifraclub.com.br/',
  'Origin': 'https://www.cifraclub.com.br',
};

// GET /cifra/buscar?q=nome+da+musica
app.get('/cifra/buscar', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ erro: 'q é obrigatório.' });
  try {
    const url = `https://solr.sscdn.co/cc/c7/?q=${encodeURIComponent(q)}&limit=30&callback=suggest_callback`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': HEADERS_CC['User-Agent'], 'Accept': '*/*', 'Referer': 'https://www.cifraclub.com.br/' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const texto   = await resp.text();
    const jsonStr = texto.replace(/^suggest_callback\s*\(/, '').replace(/\);\s*$/, '').trim();
    const data    = JSON.parse(jsonStr);
    const docs    = (data.response?.docs || []).filter(d => d.tipo === '2' && d.url && d.dns);
    res.json(docs.map(d => ({
      name: d.txt || '', artist: d.art || '',
      artistSlug: d.dns || '', slug: d.url || '',
      img: d.imgm || '', url: `https://www.cifraclub.com.br/${d.dns}/${d.url}/`,
    })));
  } catch (e) {
    console.error('[cifra] buscar:', e.message);
    res.status(502).json({ erro: 'Erro ao buscar cifra: ' + e.message });
  }
});

// GET /cifra/obter?artista=slug&musica=slug&name=Nome&artist=Artista
// name e artist passados pela busca são usados diretamente (mais confiável)
app.get('/cifra/obter', async (req, res) => {
  const { artista, musica, name, artist } = req.query;
  if (!artista || !musica) return res.status(400).json({ erro: 'artista e musica são obrigatórios.' });

  try {
    const pageUrl  = `https://www.cifraclub.com.br/${encodeURIComponent(artista)}/${encodeURIComponent(musica)}/`;
    const pageResp = await fetch(pageUrl, {
      headers: { ...HEADERS_CC, 'Accept': 'text/html,application/xhtml+xml,*/*' },
      signal: AbortSignal.timeout(20000),
    });
    if (!pageResp.ok) throw new Error(`CifraClub retornou ${pageResp.status}`);

    const html = await pageResp.text();
    const $    = cheerio.load(html);

    // -----------------------------------------------------------------
    // Título e artista — usa os parâmetros da busca quando disponíveis
    // (muito mais confiável do que tentar extrair do HTML)
    // -----------------------------------------------------------------
    let titulo      = (name   || '').trim();
    let nomeArtista = (artist || '').trim();

    // Fallback: extrai do bloco song/page injetado pelo CifraClub
    // window._ccq.push(['song/page', script, { name: '...', artist: '...', key: '...', youtubeId: '...', ... }])
    if (!titulo || !nomeArtista) {
      const matchNome    = html.match(/name:\s*'((?:[^'\\]|\\.)*)'/);
      const matchArtista = html.match(/artist:\s*'((?:[^'\\]|\\.)*)'/);
      const decodificar  = (s) => { try { return JSON.parse(`"${s}"`); } catch (_) { return s; } };
      if (!titulo      && matchNome)    titulo      = decodificar(matchNome[1]);
      if (!nomeArtista && matchArtista) nomeArtista = decodificar(matchArtista[1]);
    }

    // Último fallback — humaniza o slug
    if (!titulo)      titulo      = musica.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());
    if (!nomeArtista) nomeArtista = artista.replace(/-/g,' ').replace(/\b\w/g, c => c.toUpperCase());

    // -----------------------------------------------------------------
    // Tom — extrai do bloco song/page (campo key)
    // -----------------------------------------------------------------
    let tom   = '';
    let cifra = '';

    const matchKey = html.match(/key:\s*'([A-G][b#]?m?)'/) || html.match(/key:\s*"([A-G][b#]?m?)"/);
    if (matchKey) tom = matchKey[1];

    // -----------------------------------------------------------------
    // Cifra — campo "chord" em scripts da página
    // -----------------------------------------------------------------
    $('script').each((_, el) => {
      if (cifra) return;
      const txt = $(el).html() || '';
      const m   = txt.match(/"chord"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (m) {
        cifra = m[1]
          .replace(/\\n/g,'\n').replace(/\\t/g,'\t')
          .replace(/\\\\/g,'\\').replace(/\\"/g,'"');
      }
      if (!tom) {
        const mt = txt.match(/"(?:key|tom)"\s*:\s*"([A-Gb#m]{1,4})"/);
        if (mt) tom = mt[1];
      }
    });

    // Scraping HTML como último recurso para cifra
    if (!cifra) {
      const elemCifra = $('pre.cifra, #cifra_cnt pre, .cifra_cnt pre, pre').first();
      if (elemCifra.length) {
        elemCifra.find('b').each((_, el) => { $(el).replaceWith(`[${$(el).text()}]`); });
        cifra = elemCifra.text().trim();
      }
    }
    if (!tom) tom = $('.cifra_tom b, .cifra_tom, .tom-atual').first().text().trim();

    // Fallback: primeiro acorde da cifra como tom
    if (!tom && cifra) {
      const m = cifra.match(/\[([A-G][b#]?m?(?:7|maj7|sus2|sus4|9|11|13|dim|aug|add\d)?(?:\/[A-G][b#]?)?)\]/);
      if (m) tom = m[1];
    }

    tom = (tom || 'C').replace(/[^A-Gb#m0-9]/g, '');
    const matchTomSimples = tom.match(/^([A-G][b#]?m?)/);
    tom = matchTomSimples ? matchTomSimples[1] : 'C';

    // -----------------------------------------------------------------
    // YouTube ID — extrai do bloco song/page (fonte mais confiável)
    // -----------------------------------------------------------------
    let youtubeId     = '';
    let fonteYoutubeId = 'nenhuma';

    const matchSongPage = html.match(/_ccq\.push\(\['song\/page',[\s\S]{0,1500}/);
    if (matchSongPage) {
      const bloco    = matchSongPage[0];
      const matchYt  = bloco.match(/youtubeId:\s*'([a-zA-Z0-9_-]{11})'/)
                    || bloco.match(/youtubeId:\s*"([a-zA-Z0-9_-]{11})"/);
      if (matchYt) { youtubeId = matchYt[1]; fonteYoutubeId = 'song/page'; }
    }

    // Fallback: campo youtubeId próximo a cifraId/songId (evita pegar vídeo de músicas relacionadas)
    if (!youtubeId) {
      const m = html.match(/(?:cifraId|songId)[\s\S]{0,500}?youtubeId:\s*['"]([a-zA-Z0-9_-]{11})['"]/);
      if (m) { youtubeId = m[1]; fonteYoutubeId = 'fallback:proximo-a-songId'; }
    }

    console.log(`[cifra] "${titulo}" | tom="${tom}" | yt="${youtubeId||'(vazio)'}" (${fonteYoutubeId})`);

    // Remove tablatura (linhas E|---)
    if (cifra) {
      const linhas = cifra.split('\n');
      const semTab = linhas.filter(l => !l.match(/^[EADGBe]\|[-\d\/\\hpb~.]+/)).join('\n');
      if (semTab.trim().length > cifra.length * 0.3) cifra = semTab;
    }

    if (!cifra.trim()) return res.status(404).json({ erro: 'Cifra não encontrada.', url: pageUrl });

    // Links extras
    const linkLetra = `https://m.letras.mus.br/${artista}/${musica}/`;
    let linkAudio   = '';
    try {
      const dResp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(`${nomeArtista} ${titulo}`)}&limit=1`,{ signal:AbortSignal.timeout(8000) });
      if (dResp.ok) {
        const dData = await dResp.json();
        if (dData.data?.length > 0) linkAudio = dData.data[0].link || '';
      }
    } catch (_) {}

    res.json({
      titulo,
      artista:   nomeArtista,
      tom,
      cifra:     cifra.trim(),
      url:       pageUrl,
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

// ---------------------------------------------------------------------------
// Bíblia Digital
// ---------------------------------------------------------------------------

const BIBLIA_BASE   = 'https://www.abibliadigital.com.br/api';
const BIBLIA_TOKEN  = process.env.BIBLIA_TOKEN;
const bibliaCache   = new Map();
const BIBLIA_TTL     = 24*60*60*1000;
const BIBLIA_DIA_TTL = 60*60*1000;

function bibliaHeaders() {
  return { 'Authorization': `Bearer ${BIBLIA_TOKEN}`, 'Content-Type': 'application/json' };
}
async function bibliaFetch(url, ttl=BIBLIA_TTL) {
  const hit = bibliaCache.get(url);
  if (hit && Date.now()-hit.ts < ttl) return hit.data;
  const resp = await fetch(url, { headers: bibliaHeaders() });
  if (!resp.ok) { const err=await resp.text(); throw new Error(`ABíbliaDigital ${resp.status}: ${err}`); }
  const data = await resp.json();
  bibliaCache.set(url, { data, ts: Date.now() });
  return data;
}

app.get('/biblia/livros', exigirApiKey, async (req, res) => {
  try { res.json(await bibliaFetch(`${BIBLIA_BASE}/books`)); }
  catch(e) { res.status(502).json({ erro:'Erro ao buscar livros', detalhe:e.message }); }
});
app.get('/biblia/capitulo', exigirApiKey, async (req, res) => {
  const { versao='nvi', livro, capitulo }=req.query;
  if (!livro||!capitulo) return res.status(400).json({ erro:'livro e capitulo são obrigatórios.' });
  try { res.json(await bibliaFetch(`${BIBLIA_BASE}/verses/${versao}/${livro}/${capitulo}`)); }
  catch(e) { res.status(502).json({ erro:'Erro ao buscar capítulo', detalhe:e.message }); }
});
app.get('/biblia/versiculo', exigirApiKey, async (req, res) => {
  const { versao='nvi', livro, capitulo, versiculo }=req.query;
  if (!livro||!capitulo||!versiculo) return res.status(400).json({ erro:'livro, capitulo e versiculo são obrigatórios.' });
  try { res.json(await bibliaFetch(`${BIBLIA_BASE}/verses/${versao}/${livro}/${capitulo}/${versiculo}`)); }
  catch(e) { res.status(502).json({ erro:'Erro ao buscar versículo', detalhe:e.message }); }
});
app.get('/biblia/busca', exigirApiKey, async (req, res) => {
  const { versao='nvi', q }=req.query;
  if (!q) return res.status(400).json({ erro:'q é obrigatório.' });
  try { res.json(await bibliaFetch(`${BIBLIA_BASE}/verses/search/${versao}/${encodeURIComponent(q)}`)); }
  catch(e) { res.status(502).json({ erro:'Erro ao buscar', detalhe:e.message }); }
});

const VERSICULOS_DIA = [
  {livro:'jo',cap:3,ver:16},{livro:'sl',cap:23,ver:1},{livro:'fp',cap:4,ver:13},
  {livro:'rm',cap:8,ver:28},{livro:'is',cap:40,ver:31},{livro:'pv',cap:3,ver:5},
  {livro:'mt',cap:6,ver:33},{livro:'jr',cap:29,ver:11},{livro:'sl',cap:46,ver:1},
  {livro:'fp',cap:4,ver:7},{livro:'rm',cap:12,ver:2},{livro:'ef',cap:2,ver:8},
  {livro:'hb',cap:11,ver:1},{livro:'sl',cap:91,ver:1},{livro:'mt',cap:11,ver:28},
  {livro:'1co',cap:13,ver:4},{livro:'pv',cap:18,ver:10},{livro:'sl',cap:37,ver:4},
  {livro:'rm',cap:5,ver:8},{livro:'jo',cap:14,ver:6},{livro:'ef',cap:6,ver:10},
  {livro:'mt',cap:5,ver:3},{livro:'sl',cap:119,ver:105},{livro:'2tm',cap:1,ver:7},
  {livro:'gl',cap:5,ver:22},{livro:'sl',cap:27,ver:1},{livro:'rm',cap:1,ver:16},
  {livro:'tg',cap:1,ver:5},{livro:'fp',cap:4,ver:4},{livro:'jo',cap:15,ver:5},
  {livro:'pv',cap:16,ver:3},{livro:'sl',cap:1,ver:1},
];

app.get('/biblia/versiculo-dia', exigirApiKey, async (req, res) => {
  const { versao='nvi' }=req.query;
  const agora=new Date(), inicio=new Date(agora.getFullYear(),0,0);
  const diaDoAno=Math.floor((agora-inicio)/86400000);
  const ref=VERSICULOS_DIA[diaDoAno % VERSICULOS_DIA.length];
  try { res.json(await bibliaFetch(`${BIBLIA_BASE}/verses/${versao}/${ref.livro}/${ref.cap}/${ref.ver}`,BIBLIA_DIA_TTL)); }
  catch(e) { res.status(502).json({ erro:'Erro ao buscar versículo do dia', detalhe:e.message }); }
});

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