/**
 * De barrel.
 *
 * Het contract staat in `contract.ts` en niet hier, want de sjablonen importeren
 * `PromptTemplate` en `wrapUntrusted` — zouden zij dat uit deze barrel halen, dan is er
 * een cyclus (index → conversation → index) en is de laagindeling betekenisloos. De
 * boundary-regel `no-circular` vangt dat af; deze splitsing is het antwoord erop.
 */
export * from './contract';
export * from './conversation';
export * from './extraction';
export * from './registry';
export * from './groet';
export * from './datumanker';
