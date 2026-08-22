import { redirect } from 'next/navigation';

export default function HomePage() {
  // Er is geen publieke homepage: kantoormedewerkers gaan naar het dashboard,
  // cliënten komen binnen via /intake/[organizationSlug].
  redirect('/dashboard');
}
