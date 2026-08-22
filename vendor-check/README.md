# vendor-check — werkt het voorbeeld van de leverancier zelf?

Twee minimale voorbeelden, zo dicht mogelijk bij de documentatie van de leverancier.
Bewust **buiten** de pnpm-workspace en zonder één import uit `@intake/*`: geen
`AvatarProvider`, geen turn-loop, geen eigen roombeheer, geen eigen tokens.

De vraag die dit beantwoordt is enkelvoudig:

- werkt hún voorbeeld wél en ons pad niet → dan ligt het aan onze integratie;
- werkt hún voorbeeld ook niet → dan ligt het aan hun kant of aan het account.

## Installeren

```
cd vendor-check
npm install
```

`npm` en niet `pnpm`, zodat deze map geen workspace-koppeling krijgt en er dus ook
per ongeluk niets uit onze packages ingeladen kan worden.

## Draaien

```
npm run bey     # Beyond Presence via hun LiveKit-plugin
npm run anam    # Anam via hun browser-SDK, met een latencymeting
```

Beide lezen `../.env`.
