/**
 * De agent-veilige databaselaag.
 *
 * Dit pakket bevat uitsluitend wat een langlevend, van buiten bereikbaar proces mag
 * kennen: de anon-client, de agent-client en het RPC-oppervlak. Er zit geen
 * service-role client in, geen JWT-secret en geen envlezer die die twee valideert.
 *
 * Dat is geen stijlkwestie. `apps/agent` hangt aan dit pakket en NIET aan `@intake/db`,
 * zodat de service-role key fysiek buiten bereik van de worker blijft. De test
 * packages/db/src/__tests__/agent-has-no-service-role.test.ts bewaakt die grens.
 */
export * from './client';
export * from './rpc';
