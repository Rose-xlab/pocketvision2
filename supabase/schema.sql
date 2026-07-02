-- PocketVision — Supabase schema (Phase 4).
-- Run this once in the Supabase dashboard: SQL Editor → New query → paste → Run.
--
-- Security model: RLS is ENABLED on every table and NO policies are created.
-- That means the anon/authenticated keys can read/write NOTHING; only the
-- service-role key (used by the VPS scanner, never shipped to a browser)
-- bypasses RLS. Add read policies later when the dashboard phase starts.

-- Every alert the scanner sent.
create table if not exists public.alerts (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  symbol        text        not null,
  label         text,
  payout        numeric,
  streak        int         not null,
  colour        text        not null check (colour in ('green', 'red')),
  timeframe_sec int         not null,
  period_start  timestamptz not null            -- start of the streak's last candle
);

-- What the NEXT candle did after each alert (win/loss evidence).
create table if not exists public.outcomes (
  id                 bigint generated always as identity primary key,
  at                 timestamptz not null default now(),
  symbol             text        not null,
  label              text,
  payout             numeric,
  streak             int         not null,
  colour             text        not null check (colour in ('green', 'red')),
  timeframe_sec      int         not null,
  alert_period_start timestamptz not null,
  outcome            text        not null check (outcome in ('reversal', 'continuation', 'doji', 'void')),
  next_open          numeric,
  next_high          numeric,
  next_low           numeric,
  next_close         numeric
);

-- Scanner liveness pings (is the VPS bot alive right now?).
create table if not exists public.heartbeats (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  conns_live  int,
  conns_total int,
  pairs       int,
  alerts      int,
  summary     text
);

create index if not exists alerts_at_idx      on public.alerts (at desc);
create index if not exists alerts_symbol_idx  on public.alerts (symbol, at desc);
create index if not exists outcomes_at_idx    on public.outcomes (at desc);
create index if not exists outcomes_sym_idx   on public.outcomes (symbol, at desc);
create index if not exists heartbeats_at_idx  on public.heartbeats (at desc);

alter table public.alerts     enable row level security;
alter table public.outcomes   enable row level security;
alter table public.heartbeats enable row level security;
