'use server';

import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';

const CredentialsSchema = z.object({
  email: z.string().email('Vul een geldig e-mailadres in'),
  password: z.string().min(8, 'Wachtwoord is minimaal 8 tekens'),
  next: z.string().startsWith('/').optional(),
});

export interface LoginState {
  error: string | null;
}

export async function signIn(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = CredentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') || undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Ongeldige invoer' };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    /*
     * De melding blijft vaag voor de gebruiker en wordt precies in het log.
     *
     * Geen onderscheid tussen "onbekend account" en "verkeerd wachtwoord": dat verschil
     * vertelt een aanvaller welke e-mailadressen bestaan. Maar een storing — Supabase plat,
     * een verkeerde publishable key, een geblokkeerd account — ziet er voor de gebruiker
     * dan net zo uit als een typefout, en dat mag niet ook voor ons gelden.
     *
     * Zonder het e-mailadres: dat is een persoonsgegeven en het staat al in auth.
     */
    console.error('auth: inloggen mislukt', {
      code: error.code,
      status: error.status,
      message: error.message,
    });
    return { error: 'Inloggen mislukt. Controleer uw gegevens.' };
  }

  revalidatePath('/', 'layout');
  redirect(parsed.data.next ?? '/dashboard');
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login');
}
