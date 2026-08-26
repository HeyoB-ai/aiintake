# Vragen aan Anam — klaar om te versturen

**Kanaal:** twee losse berichten, niet één mail.

- **Deel A** gaat via het chatvenster naar support. Technische vraag.
- **Deel B** gaat apart naar sales. DPA-vragen horen daar thuis en niet bij een
  supportmedewerker die er niets over kan toezeggen.

Beide zijn zelfstandig leesbaar, met een eigen korte introductie — ze worden immers
los verstuurd. De tabellen staan in platte tekst en niet in markdown, omdat een
chatvenster die zelden rendert.

Vervang `[naam]` en `[bedrijf]` voor verzenden.

---

Hi,

We are building a realtime video intake product for Dutch law firms. We do our own STT
(Deepgram) and TTS (Cartesia, Dutch voice) and use the avatar for rendering only, via
`createAgentAudioInputStream`. We have been measuring from Amsterdam against your EU
endpoints and would like to check two numbers with you before we commit.

## A. Latency in audio passthrough

**Measurement setup.** Browser SDK, warm session, our own 16 kHz PCM. We detect audible
onset with a `ScriptProcessorNode` on the received audio track at 256-sample blocks, so
resolution is about one millisecond, and we record the **duration** of each audible burst
as well as its start — that distinguishes a short artifact from the avatar actually
speaking.

**What we measure.** Delivering the audio as fast as the SDK accepts it:

- **~730–800 ms** from first audio chunk handed to the SDK until audible output.
- Consistent across turns within a session and across sessions.

**The behaviour decomposes into two parts.** Delivering the same tape at 1×, 2×, 4× and as
fast as possible gives a very clean fit to `onset = D + T/S`:

| delivery speed      | measured onset |
| ------------------- | -------------- |
| 1× (realtime)       | 1540 ms        |
| 2×                  | 1125 ms        |
| 4×                  | 965 ms         |
| as fast as possible | 807 ms         |

- a **fixed delay D ≈ 800 ms** that does not shrink however fast we deliver;
- an **input buffer threshold T ≈ 730 ms of audio** that scales with delivery speed.

We confirmed T independently by sending only a prefix and deliberately **not** calling
`endSequence()` (which would force a flush):

| prefix sent | audible output? |
| ----------- | --------------- |
| 200 ms      | no              |
| 400 ms      | no              |
| 800 ms      | yes             |
| 1600 ms     | yes             |

So the avatar needs roughly 730 ms of buffered audio before it starts.

**We also checked `talk()`** in the same session, interleaved with passthrough, using the
same detector: median 838 ms against 731 ms for passthrough. So passthrough is not slower
than your text path — the two are comparable, and we are not asking because we suspect
passthrough is deprioritised.

**Our questions**

1. **Is the input buffer threshold configurable?** Our latency budget for the avatar step
   is 180 ms p50 / 350 ms p95, and ~800 ms puts us well over. If the ~730 ms buffer can be
   lowered — even at the cost of occasional underruns, which we can compensate for by
   over-delivering — that would materially change the picture for us.
2. **Is the ~800 ms fixed component expected?** Is that inherent to the rendering
   pipeline, or is there a configuration, region, or plan on which it is lower?
3. Is there anything in how we deliver audio that would reduce this? We currently send
   20 ms `pcm_s16le` frames at 16 kHz as fast as the SDK accepts them. Would a different
   sample rate, frame size, or encoding help?
4. What figure do you consider representative for time-to-first-audible in passthrough
   mode from an EU client? We would like to know whether our ~800 ms is normal or whether
   we have something misconfigured.

## A2. Audible clicks in the returned audio

Separate from latency, and the more serious of the two for us: **the audio coming back from
the avatar has audible clicks.** They are there in every turn, in every session.

**What we have ruled out on our side.**

- **Not persona-dependent.** Present with a stock persona (Anika) and with our own persona
  (avatar Mia, `llmId: CUSTOMER_CLIENT_V1`), identically.
- **The audio we send is clean.** We run a click detector — outliers in the second
  difference `x[n] - 2x[n-1] + x[n-2]`, thresholded against a per-25 ms local median so it
  does not fire on fricatives — over the PCM immediately before it enters
  `sendAudioChunk()`. Same detector on the returned track. Source measures 2.8-4.2
  events/s; that is our baseline, and the returned audio is measured against it.
- **Not a chunk-boundary artifact of ours.** Chunk boundaries in the source PCM are
  continuous (first sample -5, largest step 16 within the first 5 ms), and there are no
  odd-length buffers.
- **Not our leading-silence trimming.** Disabling it changes nothing.

**Sample rate experiment.** We deliver 16 kHz because Cartesia's streaming WebSocket only
emits 16 kHz. Since you accept 24 kHz, we tested whether a resampling step on your side
explains it. Three arms, one variable each, two full runs:

arm run 1 run 2
A 16 kHz (our current path) 2.87 /s 2.48 /s
B 24 kHz, we upsample from the
_identical_ 16 kHz source 1.91 /s 1.59 /s
C 24 kHz native from Cartesia REST 1.98 /s 2.43 /s

Arm B uses windowed-sinc interpolation, not linear, and measures identical to arm A on the
source side (18 vs 18, 21 vs 22 events) — so the upsampling itself introduces nothing.

**What that tells us.** Delivering 24 kHz gives a reproducible reduction of roughly one
third, but **the clicks do not go away**. So the 16 kHz to 24 kHz conversion is a
contributing factor at most, not the cause.

**Caveats we want to be explicit about.** The returned audio is measured after WebRTC, so
Opus adds its own artifacts; only the differences between arms — which share that path —
are meaningful. And the detector is deliberately conservative: a click that falls inside a
fricative is not separable from the fricative itself, so these counts are a lower bound.

**Our questions**

5. **Is this known?** Do you see clicks in agent-audio passthrough with 16 kHz
   `pcm_s16le` input, and is there a recommended input format that avoids them?
6. **What does your pipeline do with the input audio?** Specifically: what internal sample
   rate does the engine run at, and what resampler is applied to 16 kHz input?
7. **Can chunks be delivered faster than realtime**, or does the engine expect
   realtime-paced input? If it expects realtime and we over-deliver, would that produce
   exactly this kind of artifact?
8. **What is `enableAudioPassthrough` for?** Our audio comes through fine with that field
   set to `false`. We also cannot set it: `POST /v1/personas` with `true` returns 201 with
   the field on `false`, `PUT` returns 200 and changes nothing, `PATCH` returns 405.
9. Relatedly — `personaConfig` accepts `avatarId` and `voiceId` alongside `personaId` with
   HTTP 200 and then ignores them. That cost us an evening: we saw a different face and a
   Spanish greeting than we had configured. **Would you consider rejecting fields that are
   not applied?** A 400 there would have saved the entire investigation.

## A4. Two questions that decide whether we can keep the avatar in the loop

These are not bug reports. They decide an architecture choice, and we would rather ask than
assume.

**Context.** We interrupt the assistant mid-sentence when the client starts speaking, and we
then truncate the assistant's turn in our transcript to the part that was **actually
audible**. That transcript is the record a lawyer reads. A turn containing a question the
client never heard makes both the model and the lawyer believe it was asked.

Today we compute that from our own delivery clock — how much audio we handed to the SDK and
when. With ~800 ms of fixed delay on your side, that clock is systematically ahead of what
the client heard.

**1. Is there any way to learn how much of the supplied audio has been rendered?**

We looked in the SDK (`@anam-ai/js-sdk@4.25.0`) before asking. `AgentAudioInputStream`
exposes `sendAudioChunk`, `endSequence` and `getSequenceNumber`; there is no playback
position, no rendered-bytes counter, and no callback per rendered chunk. `AgentAudioInputConfig`
has exactly `encoding`, `sampleRate` and `channels`.

Is there something equivalent we have missed — a signalling message, an event, anything that
says "I have now rendered up to here"? An acknowledgement carrying a position on
interruption would be enough.

**2. Is the ~730 ms input buffer threshold configurable, server-side or per persona?**

From the prefix tests in section A: 400 ms of audio produces no output, 800 ms does. That
threshold is not exposed in `AgentAudioInputConfig`, so we assume it is server-side.

If it is fixed, then 730 ms of buffered audio is a hard floor under everything we build, on
top of the ~800 ms fixed delay. We would like to know that as a fact rather than infer it,
because our total latency budget is 1200 ms p50 for the whole chain — speech end to a
speaking face — and those two numbers alone exceed it.

If either answer is "no, not available", please say so plainly. That is a usable answer: it
tells us the avatar cannot sit inside the interruption path as we have designed it, and we
will change the design rather than keep measuring around it.

## B. Data protection — questions for the DPA

We are building for Dutch law firms. Intake conversations in employment law routinely
touch illness, occupational-health assessments and reintegration, which is Article 9 GDPR
health data, combined with voice and optionally facial imagery. A Dutch firm's compliance
officer asks these before signing, so we need them answered contractually rather than by
product page.

Your public material is more complete than most in this market — SOC 2 Type II, HIPAA,
explicit EU region endpoints, ZDR and regional residency on Enterprise, and a separate
biometric privacy notice. These questions are about pinning that down for our case.

5. **Processing location.** We connect to `connect-eu.anam.ai`. Can EU-only processing of
   session audio and video be guaranteed **contractually**, including failover? Anam is
   UK-established: does any session data, metadata, or support access reach the UK or the
   US, and if so under which transfer mechanism?
6. **Zero data retention.** ZDR and regional residency are listed as Enterprise features.
   What is the entry point for that, and what exactly does ZDR cover — audio, video,
   transcripts, logs?
7. **Retention.** Absent ZDR, how long is session audio and video retained by default? We
   are aiming for ≤ 24 hours.
8. **Training.** Is session data used to train or improve models in any form? We need an
   explicit contractual prohibition rather than an account setting.
9. **Biometric data.** Your biometric notice mentions Article 9(2)(a) consent separate
   from avatar creation. For our use — a stock avatar, with the **client's** camera never
   published to any server — we want to confirm no biometric data of the end user is
   derived or stored at all. Can you confirm that in writing?
10. **Subprocessors.** Current list, and notification of changes?
11. **Audit.** Do you offer an audit right, and can you share the SOC 2 Type II report
    under NDA?
12. Can you send your standard DPA?

Happy to share our measurement harness if it is useful for reproducing part A.

Thanks,
[naam]
[bedrijf]
