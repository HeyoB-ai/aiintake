-- =============================================================================
-- 0700  Afgekapte uitspraken zichtbaar maken
-- =============================================================================
-- De STT kan besluiten dat de cliënt is uitgesproken terwijl die nog midden in een zin
-- zit. De rest komt daarna alsnog binnen, maar de beurt is dan al verwerkt.
--
-- Dat is stil dataverlies: er is geen foutmelding en geen lege waarde, alleen een zin
-- die grammaticaal klopt en inhoudelijk incompleet is. De fact extraction ziet een
-- uitspraak zonder de bepaling die hem betekenis gaf, de samenvatting neemt dat over
-- als vastgesteld feit mét bronverwijzing, en de advocaat leest iets dat klopt met de
-- brondata en niet met wat de cliënt zei. Zie docs/RISICOS.md risico 2.
--
-- De agent detecteert het inmiddels en herstelt de volledige uitspraak. Zonder deze
-- kolom blijft "hoe vaak knippen we verkeerd" echter een indruk in plaats van een
-- getal — en dat getal wil je hebben vóórdat er echte gesprekken op staan, niet erna.
-- =============================================================================

alter table public.messages
  add column if not exists client_utterance_was_cut boolean not null default false;

comment on column public.messages.client_utterance_was_cut is
  'De STT kapte de uitspraak van de cliënt te vroeg af; de volledige tekst is achteraf hersteld. Zie docs/RISICOS.md risico 2.';

alter table public.messages
  add column if not exists continuation_gap_ms int check (continuation_gap_ms >= 0);

comment on column public.messages.continuation_gap_ms is
  'Gat tussen de afgekapte beurt en het vervolg. Klein gat = agressieve endpointing; basis voor het afstellen van de drempel.';

-- Partieel: het gaat om de uitzonderingen, niet om de regel. Zo blijft de index klein
-- ook als er honderdduizenden berichten staan.
create index if not exists messages_truncated_idx
  on public.messages (organization_id, created_at desc)
  where client_utterance_was_cut;

-- -----------------------------------------------------------------------------
-- De agent kan het nu meegeven
-- -----------------------------------------------------------------------------
-- Nieuwe parameters achteraan en met een default, zodat bestaande aanroepen blijven
-- werken; PostgREST matcht op naam, niet op positie.
create or replace function public.agent_append_message(
  p_session_token         text,
  p_intake_id             uuid,
  p_turn_index            int,
  p_role                  text,
  p_content               text,
  p_intended_content      text default null,
  p_interrupted_at_char   int default null,
  p_spoken_ms             int default null,
  p_planned_question_keys text[] default '{}',
  p_llm_call_id           uuid default null,
  p_client_utterance_was_cut boolean default false,
  p_continuation_gap_ms   int default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org uuid;
  v_session uuid;
  v_id uuid;
begin
  select s.organization_id, s.session_id into v_org, v_session
  from app.assert_agent_scope(p_session_token, p_intake_id) s;

  insert into public.messages (
    organization_id, intake_id, session_id, turn_index, role,
    content, intended_content, interrupted_at_char, spoken_ms,
    planned_question_keys, llm_call_id,
    client_utterance_was_cut, continuation_gap_ms
  )
  values (
    v_org, p_intake_id, v_session, p_turn_index, p_role,
    p_content, p_intended_content, p_interrupted_at_char, p_spoken_ms,
    coalesce(p_planned_question_keys, '{}'), p_llm_call_id,
    coalesce(p_client_utterance_was_cut, false), p_continuation_gap_ms
  )
  returning id into v_id;

  update public.intakes
     set turn_count = greatest(turn_count, p_turn_index + 1)
   where id = p_intake_id;

  return v_id;
end;
$$;

-- De oude signatuur bestaat naast de nieuwe zolang hij niet expliciet wordt verwijderd.
-- Twee overloads betekent dat PostgREST kan gaan gokken, dus weg ermee.
drop function if exists public.agent_append_message(
  text, uuid, int, text, text, text, int, int, text[], uuid
);

revoke all on function public.agent_append_message(
  text, uuid, int, text, text, text, int, int, text[], uuid, boolean, int
) from public;
grant execute on function public.agent_append_message(
  text, uuid, int, text, text, text, int, int, text[], uuid, boolean, int
) to anon, authenticated;

-- -----------------------------------------------------------------------------
-- Zicht op de frequentie
-- -----------------------------------------------------------------------------
-- Eén getal per kantoor per dag: hoeveel cliëntbeurten zijn er afgekapt? Zonder dit
-- moet iedereen die het wil weten zelf een query schrijven, en dan vraagt niemand het.
create or replace view public.truncation_rate as
  select
    m.organization_id,
    date_trunc('day', m.created_at) as dag,
    count(*) filter (where m.role = 'client') as client_beurten,
    count(*) filter (where m.client_utterance_was_cut) as afgekapt,
    round(
      100.0 * count(*) filter (where m.client_utterance_was_cut)
        / nullif(count(*) filter (where m.role = 'client'), 0),
      1
    ) as percentage,
    min(m.continuation_gap_ms) filter (where m.client_utterance_was_cut) as kleinste_gap_ms
  from public.messages m
  group by m.organization_id, date_trunc('day', m.created_at);

-- De view erft de RLS van public.messages: een kantoor ziet alleen zijn eigen cijfers.
alter view public.truncation_rate set (security_invoker = true);

comment on view public.truncation_rate is
  'Afkapfrequentie per kantoor per dag. security_invoker, dus de RLS van messages geldt.';

-- Supabase geeft nieuwe objecten in `public` standaard rechten aan anon. De view is
-- door security_invoker al beschermd door de RLS van messages, maar een aggregaat over
-- gesprekken hoort niet in het publieke oppervlak te staan — ook niet leeg.
revoke all on public.truncation_rate from anon;
grant select on public.truncation_rate to authenticated;
