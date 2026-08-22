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
