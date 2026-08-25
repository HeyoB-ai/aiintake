/**
 * Signaalbewerking, zonder I/O en zonder leverancier.
 *
 * Stond eerst in `@intake/provider-tts`. Verplaatst toen de browser-cliënt hetzelfde
 * resamplen nodig had: dat pakket sleept een WebSocket-client en de Cartesia-adapter mee,
 * en die horen niet in een bundel die naar een telefoon gaat. Twee kopieën van dezelfde
 * rekenregels zou erger zijn — dan kunnen server en cliënt het oneens worden over wat er
 * met de audio gebeurt.
 */
export * from './resample';
export * from './tikken';
