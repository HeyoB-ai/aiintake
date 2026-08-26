# Supportmelding Beyond Presence — klaar om te versturen

**Aan:** support@bey.dev (technisch deel) — zet sales in cc, deel C loopt via hen
**Onderwerp:** LiveKit sessions stuck at `to_start`, avatar joins but never publishes — plus session lifecycle and DPA questions

Hieronder de mailtekst in het Engels. Drie delen: A is de blokkerende bug, B is het
levenscyclusprobleem dat ook in productie terugkomt, C zijn de DPA-vragen uit
`01-architectuur-en-providerkeuze.md` §5 die nog niet gesteld waren.

Vervang `[naam]` en `[bedrijf]` voor verzenden. Voeg de uitvoer van `pnpm diag:bey` toe als
bijlage — niet de API-key.

---

Hi,

We are building a realtime video intake product for Dutch law firms and are evaluating
Beyond Presence as the avatar layer, in audio-to-video mode over LiveKit. We do our own
STT and TTS; we only need the face rendered from audio we supply.

We are blocked, and before writing we verified our side against your own LiveKit plugin
(`@livekit/agents-plugin-bey@1.7.0`) rather than guessing. Details below.

## A. Sessions stay at `to_start`; the avatar joins the room but never publishes a track

**What we do**

1. Create a LiveKit room and connect our agent worker to it as `intake-agent`.
2. Mint a LiveKit token for `bey-avatar-agent` with `kind: "agent"` and the participant
   attribute `lk.publish_on_behalf: "intake-agent"`.
3. `POST https://api.bey.dev/v1/session` with `avatar_id`, `livekit_url`, `livekit_token`.
4. Send audio to the avatar participant over a LiveKit DataStream
   (`voice.DataStreamAudioOutput`).

This mirrors your plugin exactly.

**What happens**

- `POST /v1/session` returns **201**.
- Participant `bey-avatar-agent` connects to our room after ~1.1 s. LiveKit reports it as
  `kind: 4` (AGENT) with `lk.publish_on_behalf: intake-agent`, so the token is accepted
  and the attributes arrive.
- At ~3.1 s the participant **disconnects and immediately reconnects** (~0.2 s later).
  This looks like a crash-restart on your side.
- After that it stays connected but **never publishes any track — no video, no audio.**
- The session status stays `{"type": "to_start"}` indefinitely. We have never seen a
  session leave that state.

**We also ran your own plugin, unmodified.** Outside our codebase, in a scratch project
with no code of ours: room created with `RoomServiceClient`, token minted with
`AccessToken` (both from `livekit-server-sdk`), avatar started with `bey.AvatarSession`
from `@livekit/agents-plugin-bey` against a real `voice.AgentSession`. Same result — the
participant joins, drops at ~3.1 s, rejoins, never publishes. Your own plugin logs
`Participant bey-avatar-agent disconnected while waiting for track publication`.

So this is not our integration.

**What we ruled out on our side** (reproducible; see attached log)

- **Token.** Accepted by LiveKit, correct kind and attributes, as above.
- **Avatar ID.** Identical behaviour with our own avatar
  (`2bc759ab-a7e5-4b91-941d-9e42450d6546`, "Fjolla") and with the stock avatar your plugin
  defaults to (`694c83e2-8895-4a98-bd16-56332ca3f449`, "Nelly - Office").
- **A deadlock where we wait for video while you wait for audio.** We tested sending audio
  first, without waiting for a remote track: two seconds of PCM were delivered over the
  DataStream without error, and the avatar still published nothing in the following
  fifteen seconds.
- **Endpoint and payload.** `/v1/session` (singular), `avatar_id` / `livekit_url` /
  `livekit_token`, exactly as in your plugin.

**Our LiveKit project:** `wss://pro-interview-hb0qna7g.livekit.cloud`

**Session IDs, all stuck at `to_start`:**

```
84c5cc76-965d-452d-97ba-da547b70248e   (avatar 2bc759ab…)
d5053f83-022b-4b55-85de-a0ec758daf85   (avatar 694c83e2…, stock)
3d81a463-2348-47df-b949-621c7c011290   (avatar 2bc759ab…)
7792c05a-acab-45ac-82d3-aef175d9e3f5
0efed655-ca8a-4400-91da-6e742ce5e31a
8dbd265e-3593-46b4-a645-16c0b8681ecf
9855156c-026a-470a-8053-0449b4656cd3
69ae5e9b-6e50-42e9-9038-e306131ba7cb
cc34c2eb-7894-4530-8801-ec67460c5506
19b1c1f6-f0e9-4efc-a972-b5158ed9d872
```

**Questions**

1. Why do these sessions never leave `to_start`? Is there a server-side log we can be
   pointed at, or something in the request we are still getting wrong?
2. **Is there a concurrency limit on this API key, and do these ten stuck `to_start`
   sessions count against it?** If they do, they may now be blocking each other, and we
   have no way out — see part B.
3. Is there anything account-side (plan, quota, region) that has to be enabled before
   LiveKit sessions will start?

## A2. We also tried `/v1/calls`, and ruled it out

Your site documents `POST /v1/calls` with `avatar_id`, `livekit_url`, `livekit_token` and
`language`. We tried it, in case `/v1/session` was the older path. Three things came out,
and we mention them so you do not have to ask:

1. **`/v1/calls` does not take `avatar_id`.** It returns 422 for a missing `agent_id`. An
   agent (`POST /v1/agent`) requires `name`, `avatar_id` and `system_prompt` — that is your
   conversational stack. We do our own STT, LLM and TTS and use the avatar for rendering
   only, so an agent is not what we need.

2. **With an agent created, `/v1/calls` returns 403:** _"Programmatic call creation via API
   is only available from Growth Plan onwards."_ So that route is closed on our plan
   regardless. If the documented `/v1/calls` shape is in fact the supported path for
   avatar-only rendering, please say so — then this is a plan question and not a bug.

3. **`/v1/session` accepts `livekit_url`/`livekit_token` and `url`/`token` alike**; both
   give the same 400 on an invalid token, so they appear to be aliases.

## A3. Can we obtain a playback position for the audio we supply?

This one is not a bug report. It is the question that decides whether we can use an
avatar that renders inside the LiveKit room at all, and we would rather ask it before
building than discover the answer afterwards.

**Why we need it.** The client can interrupt the assistant mid-sentence. When that happens
we truncate the assistant's turn in the transcript to the part that was **actually
audible**, and discard the rest. That is not a nicety: the transcript is the record a lawyer
reads, and an assistant turn containing a question the client never heard makes the model —
and the lawyer — believe that question was asked. We currently do this with our own playback
clock, because today we render the audio ourselves.

If the avatar renders our audio, that clock moves to your side.

**The questions**

1. **Does `bey.AvatarSession`, or the API, expose how much of the supplied audio has been
   rendered to the viewer at a given moment** — a playback position, a consumed-bytes
   counter, or a callback per rendered chunk?

2. **On an interruption**, when we stop sending and clear the buffer: does the session
   report how much of the already-delivered audio was played before the cut? An
   acknowledgement carrying a position would be enough.

3. **What is the fixed delay** between a chunk arriving over the DataStream and the
   corresponding frame being visible to the viewer? If that offset is stable we can account
   for it; if it varies per session we need to read it rather than assume it.

If none of these exist today, please say so plainly — that is a usable answer. It tells us
the transcript truncation has to stay on our side of the boundary, and that shapes the
architecture rather than blocking it.

**Which leaves the report in section A unchanged.** `/v1/session` returns 201, the session
appears in `GET /v1/session`, the avatar participant joins our room — and never publishes a
video track. Status stays `to_start`. Ten sessions on our account are in that state.

**One question about `language`.** It is an enum on the agent that includes `nl`, and
`/v1/session` neither accepts nor needs it. We read that as: language configures your speech
pipeline, and is irrelevant when we supply the audio ourselves. Please confirm — if a
session-level language is required for correct rendering even in passthrough, that would
explain a great deal.

## B. There is no way to end a session, and that is a production problem too

We could not find any way to stop or delete a session:

```
DELETE /v1/session/{id}        -> 405 Method Not Allowed
POST   /v1/session/{id}/stop   -> 404 Not Found
PATCH  /v1/session/{id}        -> 405 Method Not Allowed
```

So sessions accumulate and stay indefinitely.

We want to flag that this is **not only a consequence of the bug above.** In production a
session ends for reasons that have nothing to do with errors: the client closes the tab,
the network drops, the conversation finishes. If the only way a session ends is a timeout
on your side, then every abandoned intake keeps consuming avatar minutes, and we cannot
give a law firm a defensible answer about either cost or data retention per session.

**Questions**

4. **How do we terminate a session ourselves, from our backend?** If an endpoint exists,
   which one; if not, is one planned?
5. Can you clear the ten stuck sessions listed above on your side?
6. What is the server-side timeout for a session where the LiveKit room disappears or the
   remote participants leave? Are we billed for that window?

## C. Data protection — questions for the DPA

We are building for Dutch law firms. Intake conversations in employment law routinely
touch illness, occupational-health assessments and reintegration, which is Article 9 GDPR
health data, combined with voice and optionally facial imagery. A Dutch firm's compliance
officer asks these questions before signing, and we cannot go live with a real client
until they are answered contractually.

Your public privacy policy documents your own marketing stack in detail but says nothing
about **session data**. That is the gap we need closed:

7. **Processing location.** In which region is session audio and video processed? Can EU-
   only processing be guaranteed contractually?
8. **Training.** Is session data used to train or improve models, in any form? We need an
   explicit contractual prohibition, not an opt-out setting.
9. **Retention.** How long is session audio and video retained? We are aiming for ≤ 24
   hours; what can you commit to?
10. **Biometric data.** How is facial geometry treated — is it derived, stored, or
    retained after a session? Under which legal basis? Your policy has no biometrics
    clause at all.
11. **Subprocessors.** Can we get the current subprocessor list, and notification of
    changes?
12. **Audit.** Do you offer an audit right, and can you share your SOC 2 Type II report
    under NDA?
13. Can you provide a standard DPA, and if so could you send the current version?

We would rather resolve part A first, but parts B and C determine whether we can put this
in front of a client at all, so we are asking them together.

Thanks,
[naam]
[bedrijf]
