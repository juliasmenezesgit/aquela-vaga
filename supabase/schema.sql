-- ============================================================
-- Aquela Vaga — Schema inicial
-- Execute no SQL Editor do Supabase (Database > SQL Editor)
-- ============================================================

-- Tabela de leads (emails capturados no formulário)
create table public.leads (
  id         uuid        default gen_random_uuid() primary key,
  name       text,
  email      text        not null,
  source     text        default 'form',
  created_at timestamptz default now()
);

-- Tabela de análises geradas pela IA
create table public.analyses (
  id                  uuid        default gen_random_uuid() primary key,
  email               text,
  empresa             text,
  cargo               text,
  fit_score           int,
  ats_score           int,
  curriculo_reescrito text,
  gaps                jsonb,
  linkedin_headline   text,
  sobre_empresa       text,
  created_at          timestamptz default now()
);

-- ============================================================
-- Row Level Security
-- Habilita RLS em ambas as tabelas.
-- Sem políticas públicas = acesso negado para anon/authenticated.
-- O service_role key (usado nas Netlify Functions) bypassa o RLS
-- automaticamente — sem precisar de políticas extras.
-- ============================================================

alter table public.leads    enable row level security;
alter table public.analyses enable row level security;
