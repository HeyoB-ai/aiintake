/**
 * Publieke ingang van dit package.
 *
 * De interfaces staan in contract.ts en niet hier, zodat implementaties ze kunnen
 * importeren zonder cyclus met de barrel. Een `index -> fake -> index`-lus is niet
 * alleen een lintmelding: hij maakt de laadvolgorde afhankelijk van wie er eerst
 * binnenkomt.
 */
export * from './contract';
export * from './aanloopstilte';
export * from './cartesia';
export * from './elevenlabs';
export * from './spreektempo';
export * from './fake';
export * from './sentence-flush';
/*
 * Doorgegeven vanuit @intake/audio.
 *
 * De rekenregels zijn verhuisd zodat de browser-cliënt ze kan gebruiken zonder dit pakket
 * — en daarmee `ws` en de Cartesia-adapter — mee te bundelen. Deze regel blijft staan zodat
 * bestaande aanroepers niets hoeven te wijzigen.
 */
export * from '@intake/audio';
