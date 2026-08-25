# Testen op een echt toestel

Het cliëntscherm is mobile-first, en iOS Safari is de enige plek waar je een aantal dingen
écht kunt beoordelen: hoe de microfoonvraag eruitziet, of de zelfweergave draait bij een
rotatie, of het scherm niet in slaap valt tijdens een gesprek. Een emulator doet dat niet na.

Om vanaf een telefoon te kunnen testen is HTTPS nodig. Dat is geen voorkeur maar een
browserregel: `getUserMedia` bestaat alleen in een beveiligde context, en `localhost` is de
enige uitzondering — op de telefoon is `localhost` de telefoon zelf, niet je laptop. Op
`http://192.168.x.x` krijg je dus nooit een microfoon, in geen enkele browser.

## Eenmalig: certificaat maken en op de telefoon vertrouwen

```
pnpm cert:lan
```

Dit maakt een eigen CA en een certificaat voor `localhost`, `127.0.0.1` en het LAN-adres van
deze machine, in `.certs/` (staat in `.gitignore` — er zit een privésleutel in). Het IP-adres
moet in het certificaat staan als SAN; een certificaat dat alleen `localhost` dekt is voor de
telefoon waardeloos.

Dan, in een tweede terminal:

```
pnpm cert:serve
```

Dat serveert alleen `rootCA.pem` op poort 3001, over platte HTTP. Expres: de telefoon moet dit
certificaat ophalen om HTTPS te kúnnen vertrouwen, dus het over diezelfde HTTPS aanbieden is
een kip die op zijn eigen ei wacht. Er gaat niets geheims overheen — een CA-certificaat is de
publieke helft; de sleutel wordt nooit geserveerd.

Op de iPhone:

1. Open `http://<lan-ip>:3001` in Safari.
2. Safari vraagt of je een configuratieprofiel wilt toestaan → **Sta toe**.
3. Instellingen → Algemeen → **VPN en apparaatbeheer** → het gedownloade profiel →
   **Installeer** (je pincode).
4. Instellingen → Algemeen → **Info** → **Certificaatvertrouwensinstellingen** → zet de
   schakelaar bij *Legal Intake AI Lokaal Testen* aan.

Stap 4 is de stap die overgeslagen wordt. Zonder die schakelaar staat het certificaat wel
geïnstalleerd maar vertrouwt iOS het niet, en dan blijft Safari klagen over een onveilige
verbinding terwijl alles er geïnstalleerd uitziet.

Daarna mag `pnpm cert:serve` weg (Ctrl+C). Het hoeft niet te blijven draaien.

## Elke keer: beide servers met TLS

De pagina staat op HTTPS, dus de WebSocket moet op WSS. Een `https`-pagina mag geen `ws://`
openen — dat is gemengde inhoud, en de browser blokkeert het **zonder melding**: geen fout,
geen event, alleen een gespreksscherm dat eeuwig laadt. Beide servers krijgen daarom hetzelfde
certificaat, zodat er op de telefoon maar één ding te vertrouwen is.

Je hoeft hiervoor niets in `.env` te wijzigen. `pnpm dev:https` leest het LAN-adres uit en
zet `NEXT_PUBLIC_AGENT_WS_URL` zelf op `wss://<lan-ip>:5174` voor die ene sessie. Dat is
bewust: zou het adres in `.env` staan, dan zou de gewone `pnpm dev` op de desktop naar een
poort wijzen waar niets draait — en het adres verandert na een herstart toch.

Twee terminals:

```
pnpm dev:https        # de webapp op https://<lan-ip>:3000
pnpm dev:live:https   # de worker op wss://<lan-ip>:5174
```

En op de telefoon: `https://<lan-ip>:3000/intake/vandijk-arbeidsrecht`

## Als het misgaat

**"De microfoon kon niet worden geopend"** — die melding is vervangen. Bij een onveilige
context noemt het toestemmingsscherm nu het protocol en het adres waar de pagina op staat, en
zegt dat het via HTTPS moet. De drie andere oorzaken (geweigerd, geen microfoon aanwezig, in
gebruik door een ander programma) hebben elk hun eigen tekst gekregen.

**Gespreksscherm blijft laden** — waarschijnlijk `ws://` terwijl de pagina op `https` staat.
Het cliëntscherm controleert dit nu en weigert met de reden erbij in plaats van te blijven
hangen; zie je die melding, dan klopt `NEXT_PUBLIC_AGENT_WS_URL` niet of draait de worker
zonder `--tls`.

**Safari vertrouwt het certificaat niet** — bijna altijd stap 4 hierboven. Controleer ook of
het LAN-adres nog klopt: DHCP kan het na een herstart veranderd hebben, en dan staat het oude
adres in het certificaat. Opnieuw `pnpm cert:lan` draaien en het profiel op de telefoon
vervangen.

**Windows Firewall** — bij de eerste start vraagt Windows of Node op het netwerk mag. Zeg ja
voor privénetwerken; anders komt de telefoon er niet bij en lijkt het alsof de server niet
draait.

## Wat dit niet is

Een zelfondertekende CA op je eigen machine is prima voor dit doel. Hem elders installeren of
de sleutel delen is iets anders: wie `rootCA-key.pem` heeft, kan voor die telefoon elk domein
vervalsen. De CA is een jaar geldig; laat hem niet op een toestel staan dat je uit handen
geeft.
