import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

/*
 * Opruimen tussen tests.
 *
 * Testing Library ruimt zichzelf op zodra vitest met `globals: true` draait. Dat doen we
 * hier niet — globale `describe`/`it` maskeren waar iets vandaan komt — dus moet het met
 * de hand. Zonder dit stapelen de renders zich op en meldt elke tweede query "found
 * multiple elements", wat eruitziet als een fout in de component.
 */
afterEach(cleanup);

/*
 * jsdom kent geen scrollIntoView.
 *
 * Het transcript scrollt naar de laatste beurt. In jsdom bestaat die methode niet en gooit
 * het effect, waardoor elke transcripttest faalt op iets dat met het transcript niets te
 * maken heeft.
 */
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {
    /* niets te scrollen in een virtuele DOM */
  };
}
