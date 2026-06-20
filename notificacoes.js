// =============================================================================
// notificacoes.js — Sistema de push notifications via FCM
// =============================================================================
//
// Não usa Cloud Functions (decisão do projeto). Em vez disso, faz polling
// periódico no Firestore via Admin SDK, comparando contra o timestamp da
// última verificação para achar eventos novos, e dispara push via FCM.
//
// Requer a variável de ambiente FIREBASE_SERVICE_ACCOUNT_JSON contendo o
// conteúdo JSON completo da service account key (gerada em:
// Firebase Console → Configurações do Projeto → Contas de serviço →
// Gerar nova chave privada). Cole o JSON inteiro como uma única linha.
// =============================================================================

const admin = require('firebase-admin');

let db = null;
let inicializado = false;

// Guarda o timestamp da última verificação de cada tipo de evento, em memória.
// Como o servidor agora roda em plano pago (sem hibernação), isso é seguro —
// se reiniciar (deploy), o pior caso é reenviar notificações de uma janela
// de 5 min, o que é aceitável e não duplicará pois marcamos os itens.
let ultimaVerificacaoEscalas = new Date();
let ultimaVerificacaoAvisos = new Date();
let ultimaVerificacaoMensagens = new Date();
let ultimaVerificacaoLembretes = new Date(0); // força primeira rodada de lembretes a rodar

const INTERVALO_POLLING_MS = 5 * 60 * 1000; // 5 minutos
const HORAS_ANTES_LEMBRETE = 48; // notifica quem não confirmou 48h antes do culto

function inicializarFirebaseAdmin() {
  if (inicializado) return true;

  const credJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!credJson) {
    console.warn(
      '[notificacoes] FIREBASE_SERVICE_ACCOUNT_JSON não configurada. ' +
      'Push notifications desativadas.'
    );
    return false;
  }

  try {
    const credenciais = JSON.parse(credJson);
    admin.initializeApp({
      credential: admin.credential.cert(credenciais),
    });
    db = admin.firestore();
    inicializado = true;
    console.log('[notificacoes] Firebase Admin SDK inicializado.');
    return true;
  } catch (e) {
    console.error('[notificacoes] Falha ao inicializar Firebase Admin:', e.message);
    return false;
  }
}

// -----------------------------------------------------------------------
// Envio de push para um usuário (todos os tokens registrados dele)
// -----------------------------------------------------------------------

async function enviarParaUsuario(uid, { titulo, corpo, dados = {} }) {
  if (!db) return;
  try {
    const tokensSnap = await db.collection('usuarios').doc(uid).collection('tokensFcm').get();
    if (tokensSnap.empty) return;

    const tokens = tokensSnap.docs.map((d) => d.id);
    const mensagem = {
      notification: { title: titulo, body: corpo },
      data: Object.fromEntries(Object.entries(dados).map(([k, v]) => [k, String(v)])),
      tokens,
    };

    const resp = await admin.messaging().sendEachForMulticast(mensagem);

    // Remove tokens inválidos/expirados automaticamente
    resp.responses.forEach((r, i) => {
      if (!r.success && (r.error?.code === 'messaging/registration-token-not-registered')) {
        db.collection('usuarios').doc(uid).collection('tokensFcm').doc(tokens[i]).delete().catch(() => {});
      }
    });

    console.log(`[notificacoes] Enviado para ${uid}: ${resp.successCount}/${tokens.length} sucesso(s)`);
  } catch (e) {
    console.error(`[notificacoes] Erro ao enviar para ${uid}:`, e.message);
  }
}

// -----------------------------------------------------------------------
// 1. Notifica quando alguém é escalado
// -----------------------------------------------------------------------

async function verificarNovasEscalas() {
  if (!db) return;
  const agora = new Date();

  try {
    const ministeriosSnap = await db.collection('ministerios').get();

    for (const ministerioDoc of ministeriosSnap.docs) {
      const escalasSnap = await ministerioDoc.ref
        .collection('escalas')
        .where('criadoEm', '>', admin.firestore.Timestamp.fromDate(ultimaVerificacaoEscalas))
        .get();

      for (const escalaDoc of escalasSnap.docs) {
        const escala = escalaDoc.data();
        const ministerioNome = ministerioDoc.data().nome || 'seu ministério';
        const membros = escala.membrosEscalados || [];

        for (const membro of membros) {
          await enviarParaUsuario(membro.uid, {
            titulo: '🎵 Você foi escalado!',
            corpo: `${escala.titulo} — ${ministerioNome}`,
            dados: { tipo: 'escala_nova', ministerioId: ministerioDoc.id, escalaId: escalaDoc.id },
          });
        }
      }
    }
  } catch (e) {
    console.error('[notificacoes] Erro ao verificar novas escalas:', e.message);
  }

  ultimaVerificacaoEscalas = agora;
}

// -----------------------------------------------------------------------
// 2. Notifica novo aviso publicado
// -----------------------------------------------------------------------

async function verificarNovosAvisos() {
  if (!db) return;
  const agora = new Date();

  try {
    const ministeriosSnap = await db.collection('ministerios').get();

    for (const ministerioDoc of ministeriosSnap.docs) {
      const avisosSnap = await ministerioDoc.ref
        .collection('avisos')
        .where('criadoEm', '>', admin.firestore.Timestamp.fromDate(ultimaVerificacaoAvisos))
        .get();

      if (avisosSnap.empty) continue;

      const membrosSnap = await ministerioDoc.ref.collection('membros').get();
      const ministerioNome = ministerioDoc.data().nome || 'seu ministério';

      for (const avisoDoc of avisosSnap.docs) {
        const aviso = avisoDoc.data();

        for (const membroDoc of membrosSnap.docs) {
          // Não notifica o próprio autor do aviso
          if (membroDoc.id === aviso.autorUid) continue;

          await enviarParaUsuario(membroDoc.id, {
            titulo: `📢 ${ministerioNome}`,
            corpo: aviso.titulo,
            dados: { tipo: 'aviso_novo', ministerioId: ministerioDoc.id, avisoId: avisoDoc.id },
          });
        }
      }
    }
  } catch (e) {
    console.error('[notificacoes] Erro ao verificar novos avisos:', e.message);
  }

  ultimaVerificacaoAvisos = agora;
}

// -----------------------------------------------------------------------
// 2b. Notifica nova mensagem no chat do ministério
// -----------------------------------------------------------------------

async function verificarNovasMensagens() {
  if (!db) return;
  const agora = new Date();

  try {
    const ministeriosSnap = await db.collection('ministerios').get();

    for (const ministerioDoc of ministeriosSnap.docs) {
      const mensagensSnap = await ministerioDoc.ref
        .collection('mensagens')
        .where('criadoEm', '>', admin.firestore.Timestamp.fromDate(ultimaVerificacaoMensagens))
        .get();

      if (mensagensSnap.empty) continue;

      const membrosSnap = await ministerioDoc.ref.collection('membros').get();
      const ministerioNome = ministerioDoc.data().nome || 'seu ministério';

      for (const msgDoc of mensagensSnap.docs) {
        const msg = msgDoc.data();
        const corpo = (msg.texto || '').length > 80 ? `${msg.texto.slice(0, 80)}...` : (msg.texto || '');

        for (const membroDoc of membrosSnap.docs) {
          // Não notifica o próprio autor da mensagem
          if (membroDoc.id === msg.uid) continue;

          await enviarParaUsuario(membroDoc.id, {
            titulo: `💬 ${msg.nome || 'Mensagem'} — ${ministerioNome}`,
            corpo,
            dados: { tipo: 'mensagem_nova', ministerioId: ministerioDoc.id, mensagemId: msgDoc.id },
          });
        }
      }
    }
  } catch (e) {
    console.error('[notificacoes] Erro ao verificar novas mensagens:', e.message);
  }

  ultimaVerificacaoMensagens = agora;
}

// -----------------------------------------------------------------------
// 3. Lembrete de confirmação pendente perto do culto
// -----------------------------------------------------------------------
// Roda a cada ciclo, mas só notifica cada escala UMA vez (marca um campo
// no próprio documento da escala para não duplicar).

async function verificarConfirmacoesPendentes() {
  if (!db) return;

  try {
    const agora = new Date();
    const janelaInicio = new Date(agora.getTime() + (HORAS_ANTES_LEMBRETE - 0.5) * 60 * 60 * 1000);
    const janelaFim = new Date(agora.getTime() + (HORAS_ANTES_LEMBRETE + 0.5) * 60 * 60 * 1000);

    const ministeriosSnap = await db.collection('ministerios').get();

    for (const ministerioDoc of ministeriosSnap.docs) {
      const escalasSnap = await ministerioDoc.ref
        .collection('escalas')
        .where('data', '>=', admin.firestore.Timestamp.fromDate(janelaInicio))
        .where('data', '<=', admin.firestore.Timestamp.fromDate(janelaFim))
        .get();

      const ministerioNome = ministerioDoc.data().nome || 'seu ministério';

      for (const escalaDoc of escalasSnap.docs) {
        const escala = escalaDoc.data();

        // Já notificado? marca um campo interno para não repetir.
        if (escala._lembreteEnviado) continue;

        const pendentes = (escala.membrosEscalados || []).filter((m) => m.confirmado === null || m.confirmado === undefined);
        if (pendentes.length === 0) {
          // Nada pendente, mas marca como "verificado" para não checar de novo
          await escalaDoc.ref.update({ _lembreteEnviado: true }).catch(() => {});
          continue;
        }

        for (const membro of pendentes) {
          await enviarParaUsuario(membro.uid, {
            titulo: '⏰ Confirme sua presença',
            corpo: `${escala.titulo} — ${ministerioNome}, em breve`,
            dados: { tipo: 'lembrete_confirmacao', ministerioId: ministerioDoc.id, escalaId: escalaDoc.id },
          });
        }

        await escalaDoc.ref.update({ _lembreteEnviado: true }).catch(() => {});
      }
    }
  } catch (e) {
    console.error('[notificacoes] Erro ao verificar confirmações pendentes:', e.message);
  }
}

// -----------------------------------------------------------------------
// Loop de polling
// -----------------------------------------------------------------------

let intervalId = null;

function iniciarPolling() {
  if (!inicializarFirebaseAdmin()) return;
  if (intervalId) return; // já rodando

  console.log(`[notificacoes] Polling iniciado — intervalo de ${INTERVALO_POLLING_MS / 60000} min.`);

  const ciclo = async () => {
    await verificarNovasEscalas();
    await verificarNovosAvisos();
    await verificarNovasMensagens();
    await verificarConfirmacoesPendentes();
  };

  // Roda uma vez ao iniciar, depois no intervalo configurado
  ciclo();
  intervalId = setInterval(ciclo, INTERVALO_POLLING_MS);
}

function pararPolling() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

module.exports = { iniciarPolling, pararPolling, enviarParaUsuario, inicializarFirebaseAdmin };
