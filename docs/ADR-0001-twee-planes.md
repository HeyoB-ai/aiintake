# ADR-0001 — Control plane en realtime plane zijn twee processen

**Status:** aanvaard · **Datum:** 22 augustus 2026 · **Fase:** 0

## Context

De oorspronkelijke opzet plaatste alles in Next.js server routes. Zodra realtime video
een harde eis is, houdt dat geen stand: een WebRTC-mediastroom met barge-in vraagt om
een langlevend proces met een open audio/videoverbinding. Serverless routes hebben
geen persistente sockets, kennen cold starts en executielimieten.

## Besluit

Twee planes, met een gedeelde kern.

|      | Control plane                                                         | Realtime plane                              |
| ---- | --------------------------------------------------------------------- | ------------------------------------------- |
| Wat  | auth, tenants, dashboard, dossiers, documenten, samenvattingen, audit | STT → engine → LLM → TTS → avatar, barge-in |
| Waar | `apps/web` (Next.js, Vercel/Netlify, EU)                              | `apps/agent` (Node in een container, EU)    |
| Vorm | stateless HTTP / server actions                                       | langlevend proces, WebRTC                   |

`packages/intake-engine` is transport-agnostisch en wordt door beide gebruikt. Input is
toestand, output is een beslissing; hij kent geen HTTP, geen WebRTC en geen
avatarvendor.

## Gevolgen

- Dezelfde intake-intelligentie draait in de videomodus én in de chat-fallback.
- De engine is unit-testbaar zonder één netwerkcall — zie `conditions.test.ts`.
- Twee deploytargets in plaats van één. De worker heeft eigen hosting, eigen env en
  eigen observability nodig.
- De grens is een build-fout, geen afspraak: `.dependency-cruiser.cjs` faalt de CI als
  de engine iets anders importeert dan `domain` of `prompts`. Die regel is
  gecontroleerd door hem opzettelijk te breken; hij gaat af.

## Overwogen alternatieven

**Alles in Next.js met een aparte WebSocket-route.** Werkt niet op serverless hosting en
zou de latencybegroting onmiddellijk opblazen.

**De engine in de worker en de chat-fallback apart bouwen.** Twee implementaties van
dezelfde intake-logica die onvermijdelijk uit elkaar lopen — precies het probleem dat
de abstractie moet voorkomen.
