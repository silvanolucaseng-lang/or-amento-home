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

// Rota de saúde: pra você testar no navegador se a API está viva
app.get("/", (req, res) => {
  res.json({ status: "ok", servico: "home-orcamento-api" });
});

// Rota principal: recebe o lead do site e grava no Neon
app.post("/leads", async (req, res) => {
  try {
    const l = req.body || {};

    // validação mínima
    if (!l.codigo || !l.nome || !l.tel || !l.email) {
      return res.status(400).json({ ok: false, erro: "Campos obrigatórios faltando" });
    }
    if (l.consentimento !== true) {
      return res.status(400).json({ ok: false, erro: "Consentimento LGPD obrigatório" });
    }

    const telefone = String(l.tel).replace(/\D/g, ""); // só dígitos

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
