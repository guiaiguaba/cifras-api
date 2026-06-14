# Cifras API

Backend pessoal (Node + Express + Postgres) para gerenciar cifras:
API REST para o app Flutter + dashboard web simples para colar/editar cifras.

## Deploy no Render

1. **Criar o banco**
   - Render Dashboard → New → PostgreSQL
   - Nome sugerido: `cifras-db`
   - Após criado, copie a **Internal Database URL**

2. **Criar o Web Service**
   - Render Dashboard → New → Web Service
   - Conecte este repositório
   - Build command: `npm install`
   - Start command: `npm start`

3. **Variáveis de ambiente** (Web Service → Environment)
   - `DATABASE_URL` = Internal Database URL copiada no passo 1
   - `API_KEY` = uma string aleatória (gere com `openssl rand -hex 16`)

4. Deploy. A URL final será algo como `https://cifras-api.onrender.com`.

## Endpoints

Todas as rotas abaixo (exceto `/dashboard*`) exigem o header `x-api-key`.

- `GET /musicas` — lista todas as músicas
- `GET /musicas/:id` — detalhe de uma música
- `POST /musicas` — cria `{ titulo, cifraOriginal, tomOriginal }`
- `PUT /musicas/:id` — atualiza
- `DELETE /musicas/:id` — remove (e variantes/registros associados)

- `GET /musicas/:musicaId/variantes` — lista variantes de uma música
- `POST /musicas/:musicaId/variantes` — cria `{ label, semitomsTransposicao, cifraTextoCustom }`
- `PUT /variantes/:id` — atualiza
- `DELETE /variantes/:id` — remove

- `GET /registros?musicaId=&tipoCulto=` — lista histórico (filtros opcionais)
- `POST /registros` — cria `{ musicaId, varianteId, data (YYYY-MM-DD), tipoCulto }`
- `DELETE /registros/:id` — remove

## Dashboard

Acesse `https://cifras-api.onrender.com/dashboard` para colar e gerenciar
músicas (título, tom original, texto da cifra com acordes em `[C]`, `[G]`, etc).

**Aviso de segurança**: as rotas `/dashboard-api/*` usadas pelo dashboard
não exigem `x-api-key` (o HTML não pode guardar segredo). Para uso pessoal
isso é aceitável, mas não compartilhe a URL `/dashboard` publicamente.

## Estrutura do banco

Tabelas com prefixo `cifras_` em um Postgres isolado:
- `cifras_musicas`
- `cifras_variantes`
- `cifras_registros`
