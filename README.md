# Home Orçamento API

API que recebe os leads do site da Home Construtora e grava no banco Neon (Postgres).

## Variáveis de ambiente (configurar no Render)

- `DATABASE_URL` — connection string do projeto Neon `home-orcamento`.
- `ALLOWED_ORIGINS` — endereço(s) do site autorizado(s) a chamar a API,
  separados por vírgula. Ex: `https://home-construtora.netlify.app`

## Rotas

- `GET /` — verificação de saúde (retorna `{ status: "ok" }`).
- `POST /leads` — recebe o objeto do orçamento e grava um lead.

## Rodar localmente (opcional)

```bash
npm install
DATABASE_URL="..." ALLOWED_ORIGINS="http://localhost" npm start
```
