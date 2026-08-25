import { createClient } from '@supabase/supabase-js';
import { ORG_ID } from '../supabase/seed/demo-data.mjs';

/**
 * Maakt een demo-advocaat en koppelt hem aan Van Dijk Arbeidsrecht.
 *
 * ## Waarom dit een apart script is en niet in de seed zit
 *
 * `supabase/seed/demo-data.mjs` schrijft via PostgREST en raakt alleen `public`. Een
 * inlogbaar account leeft in `auth.users`, en dat vraagt de admin-API en dus de secret
 * key. Die twee door elkaar halen zou betekenen dat de gewone seed een sleutel nodig heeft
 * waarmee je RLS volledig omzeilt — voor het vullen van een demotabel is dat te veel.
 *
 * ## Waarom dit niet automatisch bij `db:seed` hoort
 *
 * Een account met een bekend wachtwoord aanmaken is iets anders dan voorbeelddata
 * neerzetten. Dat hoort een aparte handeling te zijn die je bewust doet, en die je op een
 * omgeving die naar buiten staat niet per ongeluk uitvoert.
 *
 * Draaien met: pnpm demo:user
 */

const url = process.env['NEXT_PUBLIC_SUPABASE_URL'];
const secret = process.env['SUPABASE_SECRET_KEY'];
if (!url || !secret) {
  console.error('\n  NEXT_PUBLIC_SUPABASE_URL en SUPABASE_SECRET_KEY moeten in .env staan.\n');
  process.exit(1);
}

const EMAIL = process.env['DEMO_EMAIL'] ?? 'advocaat@vandijk-arbeidsrecht.test';
const WACHTWOORD = process.env['DEMO_PASSWORD'] ?? 'Demo-Intake-2026!aA1';
const NAAM = 'Mr. J. van Dijk';

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Bestaat het account al, dan het wachtwoord terugzetten in plaats van falen.
 *
 * Dit script hoort twee keer draaien te overleven: anders is de enige uitweg bij een
 * vergeten wachtwoord het handmatig opruimen van een auth-gebruiker.
 */
async function zorgVoorGebruiker() {
  const { data: lijst, error: leesFout } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (leesFout) throw new Error(`gebruikers ophalen mislukt: ${leesFout.message}`);

  const bestaand = lijst.users.find((u) => u.email === EMAIL);
  if (bestaand) {
    const { error } = await admin.auth.admin.updateUserById(bestaand.id, {
      password: WACHTWOORD,
      email_confirm: true,
    });
    if (error) throw new Error(`wachtwoord bijwerken mislukt: ${error.message}`);
    return { id: bestaand.id, nieuw: false };
  }

  const { data, error } = await admin.auth.admin.createUser({
    email: EMAIL,
    password: WACHTWOORD,
    email_confirm: true,
    user_metadata: { full_name: NAAM },
  });
  if (error) throw new Error(`account aanmaken mislukt: ${error.message}`);
  return { id: data.user.id, nieuw: true };
}

const { id, nieuw } = await zorgVoorGebruiker();

// De trigger on_auth_user_created vult public.users. De naam staat daar nog niet
// noodzakelijk goed, dus die zetten we hier expliciet.
const { error: naamFout } = await admin
  .from('users')
  .upsert({ id, email: EMAIL, full_name: NAAM }, { onConflict: 'id' });
if (naamFout) throw new Error(`profiel bijwerken mislukt: ${naamFout.message}`);

// Zonder lidmaatschap ziet het dashboard "Nog geen kantoor gekoppeld" — RLS levert dan
// letterlijk niets, en dat lijkt op een lege database terwijl de intakes er wél staan.
const { error: lidFout } = await admin
  .from('organization_users')
  .upsert(
    { organization_id: ORG_ID, user_id: id, role: 'LAWYER' },
    { onConflict: 'organization_id,user_id' },
  );
if (lidFout) throw new Error(`koppeling aan het kantoor mislukt: ${lidFout.message}`);

// Eén intake toewijzen, zodat de kolom "Toegewezen aan" niet overal leeg is.
const { error: toewijsFout } = await admin
  .from('intakes')
  .update({ assigned_to: id })
  .eq('id', '10000000-0000-4000-a000-000000000001');
if (toewijsFout) console.warn(`  (toewijzen mislukt: ${toewijsFout.message})`);

console.log(`\n  ${nieuw ? 'Account aangemaakt' : 'Account bestond al; wachtwoord teruggezet'}`);
console.log(`  gekoppeld aan Van Dijk Arbeidsrecht als LAWYER\n`);
console.log(`    e-mail:     ${EMAIL}`);
console.log(`    wachtwoord: ${WACHTWOORD}\n`);
console.log('  Draai `pnpm dev` en open http://localhost:3000/dashboard\n');
