/**
 * Voert PCM aan op ware snelheid.
 *
 * Dit lijkt overdreven voor "elke 20 ms een blokje", maar de naïeve versie —
 * `await sleep(20)` in een lus — is de reden dat een endpointing-meting 2,2 seconden
 * aanwees waar 155 ms hoorde te staan.
 *
 * De oorzaak: `setTimeout(20)` slaapt minstens 20 ms en op Windows vaak 30. Die fout
 * stapelt per blokje op. Na 165 blokjes loopt de stream twee seconden achter op de
 * wandklok, en omdat de STT zijn tijdstempels aan de ontvangen audio hangt, lijkt het
 * alsof de cliënt twee seconden geleden is uitgesproken terwijl wij pas net klaar zijn
 * met aanleveren.
 *
 * In productie speelt dit niet: daar komt audio van een echte microfoon via WebRTC,
 * en dan lopen streamtijd en wandklok per definitie gelijk. Het is dus puur een
 * artefact van bestanden afspelen — en precies daarom gevaarlijk, want het zou de
 * bakeoff-cijfers vervuilen zonder dat er iets kapot lijkt.
 *
 * De oplossing is mikken op een absoluut tijdstip in plaats van steeds opnieuw wachten,
 * zodat een te lange slaap door de volgende ronde wordt ingehaald.
 */
export async function paceAudio(
  pcm: Int16Array,
  options: {
    readonly sampleRate: number;
    readonly frameMs?: number;
    readonly onFrame: (frame: Int16Array) => void;
  },
): Promise<void> {
  const frameMs = options.frameMs ?? 20;
  const samplesPerFrame = Math.round((options.sampleRate / 1000) * frameMs);
  const startedAt = performance.now();

  let index = 0;
  for (let offset = 0; offset < pcm.length; offset += samplesPerFrame, index += 1) {
    const targetElapsed = index * frameMs;
    const wait = targetElapsed - (performance.now() - startedAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

    options.onFrame(pcm.subarray(offset, Math.min(offset + samplesPerFrame, pcm.length)));
  }
}

/** Hoeveel de aanlevering achterliep op ware snelheid. Boven ~50 ms is de meting verdacht. */
export function pacingDrift(pcm: Int16Array, sampleRate: number, elapsedMs: number): number {
  const audioMs = (pcm.length / sampleRate) * 1000;
  return Math.round(elapsedMs - audioMs);
}
