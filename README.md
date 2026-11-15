# CRM Vendas

CRM de vendas no estilo Pipedrive com visual Google. Site estático + funções de servidor na Vercel + banco no Supabase.

## Estrutura
- `index.html` login (Supabase Auth) · `app.html` CRM · `supa.js` conexão com o banco
- `api/status.js` mostra quais chaves estão preenchidas (sem revelar valores)
- `api/hooks/[provider].js` webhooks: `/api/hooks/wa`, `/rdcrm`, `/resend`, `/n8n`, `/hook`
- `api/oauth/google.js` login do Conector Google (`/oauth/google`)
- `supabase/migrations/` estrutura do banco · `supabase/seed.sql` dados de exemplo

## Chaves
Todas ficam em **Vercel > crm-vendas-pam > Settings > Environment Variables** (lista em `.env.example`).
As que estão como `PREENCHER` ainda não foram configuradas. Depois de trocar qualquer valor: **Deployments > Redeploy**.

## Banco (rodar no SQL Editor, nesta ordem)
1. `supabase/migrations/20261115000001_init.sql`
2. `supabase/migrations/20261115000002_backend.sql`
3. `supabase/seed.sql` (depois de criar o usuário em Authentication)
