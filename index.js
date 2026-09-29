/**
 * [LPD] Bot de Moderação — Anti-flood / Anti-trava / Anti-spam
 * ----------------------------------------------------------------
 * Biblioteca: @whiskeysockets/baileys (open-source, WhatsApp Web multi-device)
 *
 * O QUE ESSE BOT FAZ:
 *  - Detecta flood de mensagens (spam rápido) e remove quem floodar
 *  - Detecta marcação em massa suspeita (@all / mass mention) e remove
 *  - Apaga links de convite de outros grupos postados por não-admins
 *  - Comandos de admin: !ban @pessoa  /  !kick @pessoa
 *
 * O QUE ESSE BOT **NÃO** FAZ:
 *  - Não envia mensagens em massa, não participa de flood/DDoS
 *  - Não explora bugs do WhatsApp — é só moderação reativa e legítima
 *
 * REQUISITOS:
 *  npm install @whiskeysockets/baileys @hapi/boom qrcode-terminal pino
 *
 * COMO RODAR:
 *  node index.js
 *  (escaneie o QR code com o WhatsApp que vai ser o bot/admin do grupo)
 */

const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const QRCode = require('qrcode');

// ==================== SERVIDOR WEB (necessário no Render) ====================
// O Render exige que o serviço escute numa porta HTTP. Essa mesma página
// também serve pra você escanear o QR code sem precisar de terminal.
const app = express();
const PORT = process.env.PORT || 3000;

let qrAtual = null;
let statusConexao = 'iniciando';

app.get('/', async (req, res) => {
  if (statusConexao === 'conectado') {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b0f19;color:#00ffcc">
        <h1>✅ [LPD] Bot conectado e ativo</h1>
        <p>O bot já está rodando no grupo.</p>
      </body></html>
    `);
  }
  if (!qrAtual) {
    return res.send(`
      <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b0f19;color:#00ffcc">
        <h1>⏳ Gerando QR code...</h1>
        <p>Atualize a página em alguns segundos.</p>
        <meta http-equiv="refresh" content="5">
      </body></html>
    `);
  }
  const qrImg = await QRCode.toDataURL(qrAtual);
  res.send(`
    <html><body style="font-family:sans-serif;text-align:center;padding:40px;background:#0b0f19;color:#00ffcc">
      <h1>💎 [LPD] Conectar Bot ao WhatsApp</h1>
      <p>Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho, e escaneie:</p>
      <img src="${qrImg}" style="border:8px solid #00ffcc;border-radius:12px;margin-top:20px" />
      <p style="margin-top:20px;color:#8892b0">Essa página atualiza sozinha a cada 5s até você escanear.</p>
      <meta http-equiv="refresh" content="5">
    </body></html>
  `);
});

app.listen(PORT, () => console.log(`[LPD] Servidor web ativo na porta ${PORT}`));
// ===============================================================================

// ==================== CONFIGURAÇÃO ====================
const CONFIG = {
  // Anti-flood: limite de mensagens por usuário numa janela de tempo
  FLOOD_MAX_MSGS: 8,        // mensagens
  FLOOD_WINDOW_MS: 5000,    // dentro de 5 segundos

  // Anti mass-mention: número de pessoas marcadas numa única mensagem
  MASS_MENTION_LIMIT: 15,

  // Ação ao detectar violação: 'remove' | 'apenas_avisar'
  ACAO_FLOOD: 'remove',
  ACAO_MASS_MENTION: 'remove',

  // Prefixo dos comandos de admin
  PREFIXO: '!',
};
// ========================================================

// Guarda o histórico de mensagens recentes por usuário, por grupo
// Estrutura: { [groupId]: { [userId]: [timestamps] } }
const historicoMensagens = {};

function registrarMensagem(groupId, userId) {
  const agora = Date.now();
  historicoMensagens[groupId] = historicoMensagens[groupId] || {};
  const hist = historicoMensagens[groupId][userId] || [];

  // Mantém só mensagens dentro da janela de tempo
  const recentes = hist.filter((t) => agora - t < CONFIG.FLOOD_WINDOW_MS);
  recentes.push(agora);

  historicoMensagens[groupId][userId] = recentes;
  return recentes.length;
}

async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      qrAtual = qr;
      statusConexao = 'aguardando_qr';
    }

    if (connection === 'close') {
      const deveReconectar =
        new Boom(lastDisconnect?.error)?.output?.statusCode !==
        DisconnectReason.loggedOut;
      statusConexao = 'desconectado';
      console.log('[LPD] Conexão encerrada. Reconectar?', deveReconectar);
      if (deveReconectar) iniciarBot();
    } else if (connection === 'open') {
      statusConexao = 'conectado';
      qrAtual = null;
      console.log('[LPD] Bot conectado e ativo na base.');
    }
  });

  // ================= EVENTO PRINCIPAL =================
  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      const groupId = msg.key.remoteJid;
      const isGroup = groupId?.endsWith('@g.us');
      if (!isGroup) continue;

      const autor = msg.key.participant || msg.participant;
      if (!autor) continue;

      try {
        await processarMensagem(sock, groupId, autor, msg);
      } catch (erro) {
        console.error('[LPD] Erro ao processar mensagem:', erro);
      }
    }
  });

  return sock;
}

async function processarMensagem(sock, groupId, autor, msg) {
  const metadata = await sock.groupMetadata(groupId);
  const isAutorAdmin = metadata.participants.some(
    (p) => p.id === autor && (p.admin === 'admin' || p.admin === 'superadmin')
  );
  const botId = sock.user.id;
  const isBotAdmin = metadata.participants.some(
    (p) => p.id === botId && (p.admin === 'admin' || p.admin === 'superadmin')
  );

  const textoMsg =
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    '';

  // ---------- COMANDOS DE ADMIN ----------
  if (textoMsg.startsWith(CONFIG.PREFIXO) && isAutorAdmin) {
    await tratarComando(sock, groupId, autor, msg, textoMsg, isBotAdmin);
    return;
  }

  // Admins não sofrem moderação automática
  if (isAutorAdmin) return;

  // Bot precisa ser admin pra conseguir remover alguém
  if (!isBotAdmin) return;

  // ---------- ANTI-FLOOD ----------
  const qtdRecente = registrarMensagem(groupId, autor);
  if (qtdRecente >= CONFIG.FLOOD_MAX_MSGS) {
    await moderarUsuario(
      sock,
      groupId,
      autor,
      `⚠️ Flood detectado. Base protegida — ${CONFIG.ACAO_FLOOD === 'remove' ? 'removendo' : 'avisando'} usuário.`
    );
    return;
  }

  // ---------- ANTI MASS-MENTION ----------
  const mentions =
    msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
  if (mentions.length >= CONFIG.MASS_MENTION_LIMIT) {
    await moderarUsuario(
      sock,
      groupId,
      autor,
      `⚠️ Marcação em massa detectada (${mentions.length} pessoas). Removendo tentativa de travamento.`
    );
    return;
  }

  // ---------- ANTI LINK DE CONVITE SUSPEITO ----------
  if (/chat\.whatsapp\.com\/[A-Za-z0-9]+/.test(textoMsg)) {
    try {
      await sock.sendMessage(groupId, { delete: msg.key });
    } catch (_) {}
    await sock.sendMessage(groupId, {
      text: `🚫 Link de convite removido — apenas admins podem compartilhar links no @${autor.split('@')[0]}.`,
      mentions: [autor],
    });
  }
}

async function moderarUsuario(sock, groupId, autor, motivo) {
  await sock.sendMessage(groupId, {
    text: `${motivo}\n👤 @${autor.split('@')[0]}`,
    mentions: [autor],
  });

  if (CONFIG.ACAO_FLOOD === 'remove' || CONFIG.ACAO_MASS_MENTION === 'remove') {
    try {
      await sock.groupParticipantsUpdate(groupId, [autor], 'remove');
      console.log(`[LPD] Removido por moderação automática: ${autor}`);
    } catch (erro) {
      console.error('[LPD] Falha ao remover (bot precisa ser admin):', erro);
    }
  }
}

async function tratarComando(sock, groupId, autor, msg, textoMsg, isBotAdmin) {
  const mentions =
    msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];

  const comando = textoMsg.trim().split(' ')[0].toLowerCase();

  if (comando === '!ban' || comando === '!kick') {
    if (!isBotAdmin) {
      await sock.sendMessage(groupId, {
        text: '⚠️ Preciso ser admin do grupo pra executar esse comando.',
      });
      return;
    }
    if (mentions.length === 0) {
      await sock.sendMessage(groupId, {
        text: `Uso: ${comando} @pessoa`,
      });
      return;
    }
    try {
      await sock.groupParticipantsUpdate(groupId, mentions, 'remove');
      await sock.sendMessage(groupId, {
        text: `✅ Removido(s) por decisão da diretoria [LPD]: ${mentions
          .map((m) => `@${m.split('@')[0]}`)
          .join(', ')}`,
        mentions,
      });
    } catch (erro) {
      await sock.sendMessage(groupId, {
        text: '❌ Não consegui remover. Confere se ainda sou admin.',
      });
    }
    return;
  }

  if (comando === '!status') {
    await sock.sendMessage(groupId, {
      text: `🛡️ [LPD] Bot de moderação ativo.\nAnti-flood: ${CONFIG.FLOOD_MAX_MSGS} msgs / ${CONFIG.FLOOD_WINDOW_MS}ms\nAnti mass-mention: ${CONFIG.MASS_MENTION_LIMIT}+ marcações`,
    });
  }
}

iniciarBot();
