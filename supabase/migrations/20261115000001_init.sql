-- CRM Vendas · estrutura inicial
-- Rodar no Supabase: SQL Editor > New query > colar > Run

create extension if not exists pgcrypto;

-- Estágios do funil (configuráveis)
create table public.stages (
  id smallint primary key,
  name text not null,
  probability smallint not null check (probability between 0 and 100),
  color text not null default '#9aa0a6'
);
insert into public.stages values
 (1,'Lead novo',10,'#9aa0a6'),(2,'Qualificação',20,'#8ab4f8'),(3,'Diagnóstico',35,'#4ecde6'),
 (4,'Proposta enviada',50,'#c58af9'),(5,'Negociação',65,'#f9ab00'),(6,'Ganho',100,'#1e8e3e'),(7,'Perdido',0,'#d93025');

create table public.companies (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  segment text,
  city text,
  created_at timestamptz not null default now()
);

create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  company_id uuid references public.companies on delete set null,
  name text not null,
  email text,
  phone text,
  role text,
  source text,                    -- Meta Ads, Google Ads, Indicação, RD Station…
  rd_uuid text,                   -- id no RD Station Marketing
  lead_score smallint check (lead_score between 0 and 100),
  created_at timestamptz not null default now()
);
create index on public.contacts (owner_id, email);

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null,
  company_id uuid references public.companies on delete set null,
  contact_id uuid references public.contacts on delete set null,
  stage_id smallint not null default 1 references public.stages,
  value numeric(12,2) not null default 0,
  probability smallint check (probability between 0 and 100), -- vazio = usa a do estágio
  score smallint check (score between 0 and 100),             -- termômetro
  source text,
  next_action text,
  next_action_at date,
  last_activity_at timestamptz not null default now(),
  expected_close date,
  lost_reason text,
  won_at timestamptz,
  rd_deal_id text,
  created_at timestamptz not null default now()
);
create index on public.deals (owner_id, stage_id);

-- Temperatura e chance ajustada (mesma regra da página Metas)
create or replace view public.deals_enriched with (security_invoker = true) as
select d.*,
  s.name as stage_name,
  coalesce(d.probability, s.probability) as stage_probability,
  case when d.score >= 80 then 'Quente' when d.score >= 65 then 'Morno'
       when d.score >= 50 then 'Frio' else 'Gelado' end as temperature,
  least(95, round(coalesce(d.probability, s.probability) *
    case when d.score >= 80 then 1.25 when d.score >= 65 then 1 when d.score >= 50 then 0.6 else 0.3 end))::int as adjusted_probability,
  extract(day from now() - d.last_activity_at)::int as days_idle
from public.deals d join public.stages s on s.id = d.stage_id;

create table public.activities (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  deal_id uuid references public.deals on delete cascade,
  contact_id uuid references public.contacts on delete set null,
  type text not null,             -- email, whatsapp, call, meeting, note, move, alert, sync, lead, transcription
  title text not null,
  detail text,
  by_ai boolean not null default false,
  source text,                    -- "Agente IA · Gmail", "n8n · formulário LP"…
  occurred_at timestamptz not null default now()
);
create index on public.activities (owner_id, occurred_at desc);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  deal_id uuid references public.deals on delete cascade,
  kind text not null,             -- meet, whatsapp_audio, call
  duration_min int,
  file_path text,                 -- Storage
  transcript jsonb,               -- [{t:"00:02", who:"Maykom", text:"…"}]
  summary text,
  signals jsonb,                  -- [{type:"buy|pain|obj|risk", text:"…"}]
  worth_score smallint,
  worth_label text,
  next_steps jsonb,               -- cadência sugerida
  occurred_at timestamptz not null default now()
);

create table public.emails (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  gmail_id text,
  thread_id text,
  deal_id uuid references public.deals on delete set null,
  from_name text, from_email text, subject text, snippet text, body text,
  is_strategic boolean not null default false,
  category text,                  -- Respondeu proposta, Pediu reunião, Objeção de preço…
  ai_reasons jsonb, ai_next_action text,
  received_at timestamptz not null default now(),
  unique (owner_id, gmail_id)
);

create table public.templates (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null,
  channel text not null default 'both' check (channel in ('whatsapp','email','both')),
  body text not null,
  wa_template_name text,          -- nome do modelo aprovado na Meta
  uses int not null default 0,
  replies int not null default 0
);

create table public.deadlines (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  deal_id uuid references public.deals on delete cascade,
  type text not null, title text not null, due_at timestamptz not null,
  action_label text, done boolean not null default false
);

create table public.goals (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  period_start date not null, period_end date not null,
  amount numeric(12,2) not null,
  rate_lead_meeting smallint default 30, rate_meeting_proposal smallint default 60,
  rate_proposal_won smallint default 35, avg_ticket numeric(12,2) default 6500
);

-- Integrações: só status e campos públicos. Chaves secretas vão para o Vault.
create table public.integrations (
  owner_id uuid not null default auth.uid() references auth.users on delete cascade,
  provider text not null,
  status text not null default 'off' check (status in ('off','on','test','error')),
  config jsonb not null default '{}',     -- IDs e URLs (nunca segredos)
  secret_ids jsonb not null default '{}', -- referências ao vault.secrets
  last_sync_at timestamptz, last_error text,
  primary key (owner_id, provider)
);

-- Segurança: cada usuário só vê os próprios dados
do $$ declare t text; begin
  foreach t in array array['companies','contacts','deals','activities','conversations','emails','templates','deadlines','goals','integrations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy "dono le" on public.%I for select using (owner_id = auth.uid())', t);
    execute format('create policy "dono cria" on public.%I for insert with check (owner_id = auth.uid())', t);
    execute format('create policy "dono edita" on public.%I for update using (owner_id = auth.uid())', t);
    execute format('create policy "dono apaga" on public.%I for delete using (owner_id = auth.uid())', t);
  end loop;
end $$;
alter table public.stages enable row level security;
create policy "todos leem estagios" on public.stages for select to authenticated using (true);

-- Atualiza "última atividade" do negócio a cada atividade registrada
create or replace function public.touch_deal() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.deal_id is not null then
    update public.deals set last_activity_at = new.occurred_at where id = new.deal_id and last_activity_at < new.occurred_at;
  end if;
  return new;
end $$;
create trigger activities_touch_deal after insert on public.activities for each row execute function public.touch_deal();
