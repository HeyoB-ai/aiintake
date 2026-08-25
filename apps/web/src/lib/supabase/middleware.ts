import { createServerClient, type CookieMethodsServer } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

/** Routes die zonder sessie bereikbaar zijn. De publieke intake staat hier bewust bij. */
const PUBLIC_PREFIXES = [
  '/login',
  '/auth',
  '/intake',
  '/privacy',
  '/ai-disclosure',
  '/_next',
  '/favicon',
];

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  /*
   * Het type staat er expliciet bij, en dat is geen stijlkeuze.
   *
   * Zonder annotatie krijgt `cookiesToSet` zijn type via contextuele inferentie door de
   * signatuur van `createServerClient` heen. Dat werkt zolang die signatuur op elke machine
   * hetzelfde oplost. Doet hij dat niet — een andere resolutie, een ander overload-pad — dan
   * valt de parameter stil terug op impliciet `any`, en de fout verschijnt op de plek waar de
   * inferentie eindigde in plaats van waar hij misging. Precies de melding waarop de
   * Netlify-build vastliep.
   *
   * Met een expliciet type hangt de controle nergens meer van af: klopt het niet, dan faalt
   * het hier, met deze regel erbij.
   */
  const cookies: CookieMethodsServer = {
    getAll: () => request.cookies.getAll(),
    setAll(cookiesToSet) {
      for (const { name, value } of cookiesToSet) {
        request.cookies.set(name, value);
      }
      response = NextResponse.next({ request });
      for (const { name, value, options } of cookiesToSet) {
        response.cookies.set(name, value, options);
      }
    },
  };

  const supabase = createServerClient(
    process.env['NEXT_PUBLIC_SUPABASE_URL']!,
    process.env['NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY']!,
    { cookies },
  );

  // Verifieert het token bij de auth-server in plaats van de cookie te geloven.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const path = request.nextUrl.pathname;
  const isPublic = PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));

  if (!user && !isPublic) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', path);
    return NextResponse.redirect(url);
  }

  return response;
}
