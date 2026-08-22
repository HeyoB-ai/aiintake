-- Geweigerde feiten zichtbaar maken in llm_calls.
--
-- De hallucinatiecheck (`rejectUngroundedFacts`) weigert elk feit waarvan het citaat niet
-- in het transcript terug te vinden is. Tot nu toe verdween dat oordeel in het niets: de
-- engine gaf het terug, de worker gooide het weg. Een controle die stilzwijgend weggooit
-- is niet te onderscheiden van een controle die niets doet — precies het bezwaar dat
-- eerder tegen de boundary-regel gold.
--
-- Twee kolommen, met verschillende houdbaarheid. Het aantal is een metriek en mag blijven
-- staan. De details bevatten een citaat uit het intakegesprek, en dat is inhoud van de
-- cliënt: die hoort onder dezelfde retentie te vallen als de rest van het transcript.
-- Vandaar jsonb met alleen sleutel en reden, en niet de volledige waarde.

alter table public.llm_calls
  add column if not exists rejected_fact_count int not null default 0
    check (rejected_fact_count >= 0),
  add column if not exists rejected_facts jsonb not null default '[]'::jsonb;

comment on column public.llm_calls.rejected_fact_count is
  'Aantal feiten dat de citaatverankering heeft geweigerd. Structureel hoog = het model verzint bronnen.';
comment on column public.llm_calls.rejected_facts is
  'Sleutel en reden per geweigerd feit. Geen waarden: die horen bij het transcript en bij diens retentie.';

-- Een index op het aantal is niet nodig; wel op "er is iets geweigerd", want dat is de
-- vraag die je stelt en het is een kleine minderheid van de rijen.
create index if not exists llm_calls_rejected_idx
  on public.llm_calls (organization_id, created_at desc)
  where rejected_fact_count > 0;

-- De oude signatuur vervalt. Eerst intrekken en droppen, anders blijft er een variant
-- staan die het nieuwe veld niet vult en die per ongeluk gekozen kan worden.
revoke all on function public.agent_log_llm_call(text, uuid, text, text, int, int, int, boolean, int, text, int) from public;
drop function if exists public.agent_log_llm_call(text, uuid, text, text, int, int, int, boolean, int, text, int);

create or replace function public.agent_log_llm_call(
  p_session_token       text,
  p_intake_id           uuid,
  p_purpose             text,
  p_model               text,
  p_input_tokens        int,
  p_output_tokens       int,
  p_latency_ms          int,
  p_schema_valid        boolean default null,
  p_repair_attempts     int default 0,
  p_prompt_template_key text default null,
  p_prompt_version      int default null,
  p_rejected_facts      jsonb default '[]'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_template_id uuid;
  v_id uuid;
  v_rejected jsonb;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  if p_prompt_template_key is not null then
    select t.id into v_template_id
    from public.prompt_templates t where t.key = p_prompt_template_key;
  end if;

  -- Een niet-array accepteren zou een lijst van één stilzwijgend als nul tellen.
  v_rejected := case
    when p_rejected_facts is null then '[]'::jsonb
    when jsonb_typeof(p_rejected_facts) = 'array' then p_rejected_facts
    else '[]'::jsonb
  end;

  insert into public.llm_calls (
    organization_id, intake_id, session_id, purpose, model,
    prompt_template_id, prompt_version,
    input_tokens, output_tokens, latency_ms, schema_valid, repair_attempts,
    rejected_fact_count, rejected_facts
  )
  values (
    v_org, p_intake_id, v_session, p_purpose, p_model,
    v_template_id, p_prompt_version,
    p_input_tokens, p_output_tokens, p_latency_ms, p_schema_valid, coalesce(p_repair_attempts, 0),
    jsonb_array_length(v_rejected), v_rejected
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.agent_log_llm_call(text, uuid, text, text, int, int, int, boolean, int, text, int, jsonb) from public;
grant execute on function public.agent_log_llm_call(text, uuid, text, text, int, int, int, boolean, int, text, int, jsonb) to anon, authenticated;

-- Hoe vaak weigert de verankering iets, per organisatie en per dag?
--
-- `security_invoker`: de view moet de RLS van de kijker gebruiken en niet die van de
-- maker, anders lekt hij tussen kantoren. Zelfde reden als bij truncation_rate.
create or replace view public.fact_rejection_rate
with (security_invoker = true) as
select
  organization_id,
  date_trunc('day', created_at) as dag,
  count(*)                       as calls,
  sum(rejected_fact_count)       as geweigerd,
  round(
    sum(rejected_fact_count)::numeric / greatest(count(*), 1),
    3
  )                              as per_call
from public.llm_calls
where purpose = 'extraction'
group by 1, 2;

revoke all on public.fact_rejection_rate from anon;
