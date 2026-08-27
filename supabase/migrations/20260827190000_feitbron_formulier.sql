-- Een feit dat de client zelf heeft ingevuld, is geen uitspraak uit het gesprek.
--
-- ## Waarom
--
-- De client vult op het toestemmingsscherm zijn naam in. Die gaat naar `intakes.client_name`
-- en wordt gebruikt in de begroeting -- maar hij belandt niet in `case_facts`. De planner ziet
-- `client_full_name` dus als openstaand en vraagt ernaar, terwijl de assistent de client net
-- bij naam heeft begroet. Gemeten in een echt gesprek van 27 augustus 2026:
--
--     assistent  "Volle naam van u -- hoe heet u precies?"
--     client     "Dat weet je toch?"
--
-- Dat is een terechte vraag van de client.
--
-- ## Waarom een eigen bron en niet `client_statement`
--
-- De herkomst hoort te kloppen. `client_statement` betekent: dit is in het gesprek gezegd, en
-- er is een citaat dat het staaft -- de citaatverankering rekent daarop, en `case_facts` eist
-- een `source_ref` voor alles wat niet `unknown` is. Een formulierveld heeft geen citaat en
-- hoort er ook geen te krijgen.
--
-- Voor een advocaat is het verschil inhoudelijk: een naam die iemand heeft ingetypt is anders
-- geverifieerd dan een naam die uit spraakherkenning komt.

alter table public.case_facts
  drop constraint if exists case_facts_source_check;

alter table public.case_facts
  add constraint case_facts_source_check
  check (source in ('client_statement', 'document', 'lawyer_input', 'client_form'));
