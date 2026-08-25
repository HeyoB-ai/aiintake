/**
 * De cliëntkant van een intakegesprek.
 *
 * Eén implementatie voor het ontwikkelharnas (`pnpm dev:live`) en voor de echte
 * cliëntpagina in apps/web. Zou er een tweede komen, dan werkt barge-in daar subtiel anders
 * dan in het harnas waarin hij is afgesteld — en dan bewijst luisteren naar het harnas
 * niets over het product.
 */
export * from './conversation-client';
