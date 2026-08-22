/**
 * Publieke ingang van dit package.
 *
 * De interfaces staan in contract.ts en niet hier, zodat implementaties ze kunnen
 * importeren zonder cyclus met de barrel. Een `index -> fake -> index`-lus is niet
 * alleen een lintmelding: hij maakt de laadvolgorde afhankelijk van wie er eerst
 * binnenkomt.
 */
export * from './contract';
export * from './cartesia';
export * from './fake';
export * from './sentence-flush';
