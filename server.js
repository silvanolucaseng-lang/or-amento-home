import express from "express";
import cors from "cors";
import pg from "pg";
import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    if (!origin || ORIGENS_PERMITIDAS.includes(origin)) return cb(null, true);
    return cb(new Error("Origem não permitida"));
  }
}));

// ─────────────────────────────────────────────────────────────
// Credenciais do WhatsApp (variáveis de ambiente do Render)
// ─────────────────────────────────────────────────────────────
const WHATSAPP_TOKEN  = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN    = process.env.VERIFY_TOKEN;
const GRAPH_BASE  = `https://graph.facebook.com/v21.0/${PHONE_NUMBER_ID}`;
const GRAPH_URL   = `${GRAPH_BASE}/messages`;
const GRAPH_MEDIA = `${GRAPH_BASE}/media`;

// ─────────────────────────────────────────────────────────────
// Identidade visual e dados fixos da empresa
// ─────────────────────────────────────────────────────────────
const NAVY  = "#16395C";
const COBRE = "#B0713A";
const CINZA = "#555555";

const EMPRESA = {
  nome: "Home Construtora",
  telefone: "(83) 98874-2184",
  email: "contato.homepb@gmail.com",
  site: "homeempreendimentos.com.br",
  endereco: "Rua Otacílio Nepomuceno, 600 — Catolé, Sala 1001, 10º andar — Campina Grande/PB"
};

// Fases da obra (soma 100%)
const FASES = [
  { nome: "Fundação e serviços iniciais",          pct: 0.08 },
  { nome: "Estrutura",                             pct: 0.18 },
  { nome: "Alvenaria e vedação",                   pct: 0.12 },
  { nome: "Cobertura",                             pct: 0.07 },
  { nome: "Instalações elétricas e hidráulicas",   pct: 0.15 },
  { nome: "Revestimentos e acabamento",            pct: 0.28 },
  { nome: "Esquadrias, louças e metais",           pct: 0.12 }
];

const brl = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const num = (v) => Number(v || 0).toLocaleString("pt-BR", { maximumFractionDigits: 2 });

// ─────────────────────────────────────────────────────────────
// Rota de saúde
// ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", servico: "home-orcamento-api", versao: "2.0.0" });
});

// ─────────────────────────────────────────────────────────────
// POST /leads — recebe o lead do site e grava no Neon
// (normaliza telefone com 55 para o fallback do bot)
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

    let telefone = String(l.tel).replace(/\D/g, "");
    // Se tem 10-11 dígitos e não começa com 55, prefixa 55 (padrão WhatsApp BR)
    if ((telefone.length === 10 || telefone.length === 11) && !telefone.startsWith("55")) {
      telefone = "55" + telefone;
    }

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
// WEBHOOK — verificação
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
  res.sendStatus(200); // o Meta exige resposta rápida

  try {
    const entry  = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg    = change?.messages?.[0];

    if (!msg || msg.type !== "text") return;

    const de    = msg.from;
    const texto = msg.text?.body || "";
    console.log(`Mensagem de ${de}: ${texto}`);

    const match = texto.toUpperCase().match(/HC-[A-Z0-9]{5}/);

    if (!match) {
      await enviarTexto(de,
        "Olá! Para eu localizar seu orçamento, preciso do código que aparece no site (formato HC-XXXXX). " +
        "Se preferir, um de nossos atendentes falará com você em breve.");
      return;
    }

    const codigo = match[0];

    // Busca o lead completo (tudo que o PDF precisa)
    const r = await pool.query(
      `SELECT codigo, nome, cidade, tipo, padrao, ambientes,
              area_real, area_equiv, total, criado_em
         FROM leads WHERE codigo = $1 LIMIT 1`,
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

    // MARCO 2: tenta enviar o PDF; se falhar, cai no texto (Marco 1)
    try {
      const pdfPath = await gerarPDF(lead);
      const mediaId = await uploadMedia(pdfPath);
      const caption =
        `Olá, ${primeiroNome}! Segue em anexo a estimativa do seu orçamento (${codigo}). ` +
        `Este é um valor preliminar — para uma proposta detalhada e precisa, envie o seu projeto ` +
        `(plantas em PDF, DWG ou até fotos/croqui) aqui mesmo por este WhatsApp. ` +
        `Nossa equipe vai analisar e retornar com o orçamento executivo. ` +
        `Qualquer dúvida, estamos à disposição!`;

      await enviarDocumento(de, mediaId, `Orcamento_${codigo}.pdf`, caption);

      // marca como enviado e limpa o arquivo temporário
      await pool.query(`UPDATE leads SET pdf_enviado = true WHERE codigo = $1`, [codigo]);
      fs.unlink(pdfPath, () => {});
      console.log(`PDF enviado para ${de} (${codigo}).`);

    } catch (errPdf) {
      console.error("Falha ao gerar/enviar PDF, caindo no texto:", errPdf);
      const totalFmt = brl(lead.total);
      const areaFmt  = num(lead.area_real);
      await enviarTexto(de,
        `Olá, ${primeiroNome}! Encontrei seu orçamento (${codigo}).\n\n` +
        `Área real: ${areaFmt} m²\n` +
        `Estimativa de investimento: ${totalFmt}\n\n` +
        `Tivemos um problema ao gerar o documento em PDF, mas nossa equipe entrará em contato. ` +
        `Obrigado por escolher a Home Construtora!`);
    }

  } catch (e) {
    console.error("Erro no webhook:", e);
  }
});

// ─────────────────────────────────────────────────────────────
// Gera o PDF da estimativa e devolve o caminho do arquivo
// ─────────────────────────────────────────────────────────────
function gerarPDF(lead) {
  return new Promise((resolve, reject) => {
    try {
      const codigo = lead.codigo;
      const filePath = path.join("/tmp", `Orcamento_${codigo}.pdf`);
      const doc = new PDFDocument({ size: "A4", margin: 48 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const larguraUtil = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const x0 = doc.page.margins.left;

      // ── CABEÇALHO: logo + título ──
      const logoPath = path.join(__dirname, "logonavy.png");
      let headerY = doc.page.margins.top;
      if (fs.existsSync(logoPath)) {
        try { doc.image(logoPath, x0, headerY, { height: 34 }); } catch (_) {}
      } else {
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(16)
           .text("HOME CONSTRUTORA", x0, headerY + 6);
      }
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(13)
         .text("ESTIMATIVA DE INVESTIMENTO", x0, headerY, { width: larguraUtil, align: "right" });
      const dataStr = new Date(lead.criado_em || Date.now()).toLocaleDateString("pt-BR");
      doc.fillColor(CINZA).font("Helvetica").fontSize(9)
         .text(`Código ${codigo}  •  ${dataStr}`, x0, headerY + 18, { width: larguraUtil, align: "right" });

      doc.moveTo(x0, headerY + 46).lineTo(x0 + larguraUtil, headerY + 46)
         .lineWidth(2).strokeColor(COBRE).stroke();

      doc.y = headerY + 62;

      // ── DADOS DO CLIENTE / IMÓVEL ──
      const boxTop = doc.y;
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10).text("DADOS DO CLIENTE", x0, boxTop);
      doc.fillColor("#222").font("Helvetica").fontSize(10);
      doc.text(lead.nome || "-", x0, doc.y + 2);
      if (lead.cidade) doc.text(lead.cidade, x0, doc.y + 1);

      const colDir = x0 + larguraUtil / 2;
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(10).text("IMÓVEL", colDir, boxTop);
      doc.fillColor("#222").font("Helvetica").fontSize(10);
      doc.text(`Tipo: ${lead.tipo || "-"}`, colDir, boxTop + 14);
      doc.text(`Padrão: ${lead.padrao || "-"}`, colDir, doc.y + 1);

      doc.moveDown(1.2);

      // ── AMBIENTES ──
      let ambientes = [];
      try {
        ambientes = typeof lead.ambientes === "string" ? JSON.parse(lead.ambientes) : (lead.ambientes || []);
      } catch (_) { ambientes = []; }

      if (Array.isArray(ambientes) && ambientes.length) {
        doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Ambientes", x0);
        doc.moveDown(0.3);
        doc.font("Helvetica").fontSize(10).fillColor("#333");
        ambientes.forEach(a => {
          const nome = a.nome || a.label || "Ambiente";
          const qtd  = a.qtd || a.quantidade || 1;
          const area = a.area != null ? a.area : (a.m2 != null ? a.m2 : null);
          const linha = area != null
            ? `${qtd}× ${nome} — ${num(area)} m²`
            : `${qtd}× ${nome}`;
          doc.text(linha, x0 + 8);
        });
        doc.moveDown(0.6);
      }

      // ── ÁREAS ──
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Áreas", x0);
      doc.moveDown(0.3);
      doc.font("Helvetica").fontSize(10).fillColor("#333");
      doc.text(`Área real construída:  ${num(lead.area_real)} m²`, x0 + 8);
      doc.text(`Área equivalente de custo:  ${num(lead.area_equiv)} m²`, x0 + 8);
      doc.moveDown(0.8);

      // ── DISTRIBUIÇÃO POR FASES DA OBRA (tabela) ──
      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(11).text("Distribuição por fases da obra", x0);
      doc.moveDown(0.4);

      const total = Number(lead.total || 0);
      const tblX = x0;
      const colPctW = 60;
      const colValW = 130;
      const colNomeW = larguraUtil - colPctW - colValW;
      let ty = doc.y;

      // Cabeçalho da tabela
      doc.rect(tblX, ty, larguraUtil, 20).fill(NAVY);
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(9);
      doc.text("FASE", tblX + 8, ty + 6, { width: colNomeW - 8 });
      doc.text("%", tblX + colNomeW, ty + 6, { width: colPctW, align: "center" });
      doc.text("VALOR", tblX + colNomeW + colPctW, ty + 6, { width: colValW - 8, align: "right" });
      ty += 20;

      doc.font("Helvetica").fontSize(9.5);
      FASES.forEach((f, i) => {
        const valor = total * f.pct;
        if (i % 2 === 0) doc.rect(tblX, ty, larguraUtil, 18).fill("#F2F5F8");
        doc.fillColor("#222");
        doc.text(f.nome, tblX + 8, ty + 5, { width: colNomeW - 8 });
        doc.text(`${(f.pct * 100).toFixed(0)}%`, tblX + colNomeW, ty + 5, { width: colPctW, align: "center" });
        doc.text(brl(valor), tblX + colNomeW + colPctW, ty + 5, { width: colValW - 8, align: "right" });
        ty += 18;
      });
      doc.y = ty + 6;

      // ── VALOR TOTAL (destaque) ──
      const totalBoxY = doc.y;
      doc.rect(tblX, totalBoxY, larguraUtil, 34).fill(NAVY);
      doc.fillColor("#fff").font("Helvetica-Bold").fontSize(11)
         .text("ESTIMATIVA TOTAL DE INVESTIMENTO", tblX + 12, totalBoxY + 11);
      doc.fillColor(COBRE).font("Helvetica-Bold").fontSize(15)
         .text(brl(total), tblX, totalBoxY + 9, { width: larguraUtil - 12, align: "right" });
      doc.y = totalBoxY + 46;

      // ── RODAPÉ: disclaimer + dados da empresa (fixo no fim da página) ──
      const footerY = doc.page.height - doc.page.margins.bottom - 78;
      doc.moveTo(x0, footerY).lineTo(x0 + larguraUtil, footerY)
         .lineWidth(0.5).strokeColor("#CCC").stroke();

      doc.fillColor(CINZA).font("Helvetica-Oblique").fontSize(8)
         .text(
           "Estimativa preliminar gerada automaticamente. Válida por 15 dias e sujeita a projeto executivo. " +
           "Os valores podem variar conforme detalhamento do projeto, condições do terreno e especificações de acabamento.",
           x0, footerY + 8, { width: larguraUtil, align: "center" }
         );

      doc.fillColor(NAVY).font("Helvetica-Bold").fontSize(9)
         .text(EMPRESA.nome, x0, footerY + 32, { width: larguraUtil, align: "center" });
      doc.fillColor(CINZA).font("Helvetica").fontSize(8);
      doc.text(`Tel: ${EMPRESA.telefone}  •  E-mail: ${EMPRESA.email}  •  ${EMPRESA.site}`,
               x0, footerY + 44, { width: larguraUtil, align: "center" });
      doc.text(EMPRESA.endereco, x0, footerY + 55, { width: larguraUtil, align: "center" });

      doc.end();
      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ─────────────────────────────────────────────────────────────
// Faz upload do PDF no Meta e retorna o media id
// ─────────────────────────────────────────────────────────────
async function uploadMedia(filePath) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  const buffer = fs.readFileSync(filePath);
  const blob = new Blob([buffer], { type: "application/pdf" });
  form.append("file", blob, path.basename(filePath));

  const resp = await fetch(GRAPH_MEDIA, {
    method: "POST",
    headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}` },
    body: form
  });
  const data = await resp.json();
  if (!resp.ok || !data.id) {
    throw new Error("Falha no upload do PDF: " + JSON.stringify(data));
  }
  return data.id;
}

// ─────────────────────────────────────────────────────────────
// Envia um documento (PDF) pelo WhatsApp
// ─────────────────────────────────────────────────────────────
async function enviarDocumento(para, mediaId, filename, caption) {
  const resp = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: para,
      type: "document",
      document: { id: mediaId, filename, caption }
    })
  });
  if (!resp.ok) {
    const erro = await resp.text();
    throw new Error("Falha ao enviar documento: " + resp.status + " " + erro);
  }
}

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
