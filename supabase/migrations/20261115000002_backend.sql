-- CRM Vendas · tabelas usadas só pelas funções de servidor (Vercel)
-- Rodar no SQL Editor depois do 20261115000001_init.sql

-- Tokens de acesso das contas conectadas (Google etc.). Sem política: o navegador não lê.
create table if not exists public.integration_tokens (
  owner_id uuid not null references auth.users on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  scope text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (owner_id, provider)
);
alter table public.integration_tokens enable row level security;

-- Eventos recebidos pelos webhooks (WhatsApp, RD Station CRM, Resend, n8n)
create table if not exists public.webhook_events (
  id bigint generated always as identity primary key,
  provider text not null,
  payload jsonb not null,
  headers jsonb,
  processed boolean not null default false,
  received_at timestamptz not null default now()
);
create index if not exists webhook_events_pending on public.webhook_events (provider, received_at) where not processed;
alter table public.webhook_events enable row level security;
