import express from "express";
import cors from "cors";
import pg from "pg";

const { Pool } = pg;

// Conexão com o Neon — a senha NÃO fica aqui, vem da variável de ambiente
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(express.json());

// CORS: só o site oficial pode chamar esta API
const ORIGENS_PERMITIDAS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: function (origin, cb) {
    // sem origin (ex: teste via curl) ou origin na lista => libera
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) return cb(null, true);
    return cb(new Error("Origem não permitida"));
  }
}));

// ─────────────────────────────────────────────────────────────
// Credenciais do WhatsApp (vêm das variáveis de ambiente do Render)
// ─────────────────────────────────────────────────────────────
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;    // token do Meta (secreto)
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;   // ex: 1235499732976084
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;      // senha que VOCÊ inventa
const GRAPH_URL = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}/messages`;

// ─────────────────────────────────────────────────────────────
// Rota de saúde
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", servico: "home-orcamento-api" });
});

// ─────────────────────────────────────────────────────────────
// Rota principal: recebe o lead do site e grava no Neon
// ─────────────────────────────────────────────────────────────
app.post("/leads", async (req, res) => {
  try {
    const l = req.body || {};

    if (!l.codigo || !l.nome || !l.tel || !l.email) {
      return res.status(400).json({ ok: false, erro: "Campos obrigatórios faltando" });
    }
    if (l.consentimento !== true) {
      return res.status(400).json({ ok: false, erro: "Consentimento LGPD obrigatório" });
    }

    const telefone = String(l.tel).replace(/\D/g, "");

    await pool.query(
      `INSERT INTO leads
        (codigo, nome, telefone, email, cidade, financiamento, prazo,
         tem_terreno, lote_m2, observacoes, tem_projeto, tipo, padrao,
         ambientes, area_real, area_equiv, total, consentimento)
       VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       ON CONFLICT (codigo) DO NOTHING`,
      [
        l.codigo, l.nome, telefone, l.email, l.cidade || null,
        l.financ || null, l.prazo || null, l.temTerreno || null,
        l.lote || 0, l.obs || null, l.temProjeto || null,
        l.tipo || null, l.padrao || null,
        JSON.stringify(l.usados || []),
        l.areaReal || 0, l.areaEq || 0, l.total || 0,
        true
      ]
    );

    return res.json({ ok: true, codigo: l.codigo });
  } catch (e) {
    console.error("Erro ao gravar lead:", e);
    return res.status(500).json({ ok: false, erro: "Erro interno" });
  }
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK — verificação (o Meta "bate na porta" pra confirmar que é sua)
// ─────────────────────────────────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }
  console.warn("Falha na verificação do webhook.");
  return res.sendStatus(403);
});

// ─────────────────────────────────────────────────────────────
// WEBHOOK — recebe mensagens dos clientes
// ─────────────────────────────────────────────────────────────
app.post("/webhook", async (req, res) => {
  // Responde 200 imediatamente (o Meta exige resposta rápida)
  res.sendStatus(200);

  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg    = change?.messages?.[0];

    // Se não for uma mensagem de texto de cliente, ignora
    if (!msg || msg.type !== "text") return;

    const de    = msg.from;              // número do cliente (ex: 5583...)
    const texto = msg.text?.body || "";

    console.log(`Mensagem de ${de}: ${texto}`);

    // Procura um código no formato HC-XXXXX (5 caracteres)
    const match = texto.toUpperCase().match(/HC-[A-Z0-9]{5}/);

    if (!match) {
      await enviarTexto(de,
        "Olá! Para eu localizar seu orçamento, preciso do código que aparece no site (formato HC-XXXXX). " +
        "Se preferir, um de nossos atendentes falará com você em breve.");
      return;
    }

    const codigo = match[0];

    // Busca o lead no banco
    const r = await pool.query(
      `SELECT nome, area_real, area_equiv, total FROM leads WHERE codigo = $1 LIMIT 1`,
      [codigo]
    );

    if (r.rowCount === 0) {
      await enviarTexto(de,
        `Não encontrei o orçamento com o código ${codigo}. ` +
        `Confira se digitou certinho, ou refaça sua estimativa no site.`);
      return;
    }

    const lead = r.rows[0];
    const primeiroNome = (lead.nome || "").split(" ")[0] || "";
    const totalFmt = Number(lead.total).toLocaleString("pt-BR", {
      style: "currency", currency: "BRL"
    });
    const areaFmt = Number(lead.area_real).toLocaleString("pt-BR");

    // MARCO 1: responde em TEXTO (o PDF vem no Marco 2)
    await enviarTexto(de,
      `Olá, ${primeiroNome}! Encontrei seu orçamento (${codigo}).\n\n` +
      `Área real: ${areaFmt} m²\n` +
      `Estimativa de investimento: ${totalFmt}\n\n` +
      `Em breve enviaremos o documento completo com a divisão por fases da obra. ` +
      `Obrigado por escolher a Home Construtora!`);

  } catch (e) {
    console.error("Erro no webhook:", e);
  }
});

// ─────────────────────────────────────────────────────────────
// Envia uma mensagem de texto pelo WhatsApp
// ─────────────────────────────────────────────────────────────
async function enviarTexto(para, corpo) {
  try {
    const resp = await fetch(GRAPH_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: para,
        type: "text",
        text: { body: corpo }
      })
    });
    if (!resp.ok) {
      const erro = await resp.text();
      console.error("Falha ao enviar WhatsApp:", resp.status, erro);
    }
  } catch (e) {
    console.error("Erro ao enviar WhatsApp:", e);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
