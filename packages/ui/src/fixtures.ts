import type { CaseFact, RiskFlag } from '@intake/domain';
import type { ConversationMessage, DocumentItem, DossierState, SessieFasen } from './types';

/**
 * Voorbeelddata — **alleen voor tests en losse componentweergaven.**
 *
 * De mockdata uit het vormgevingsprototype voedde daar de draaiende app: een cliënt zag
 * verzonnen feiten en een verzonnen urgentie-inschatting. Hier is het testmateriaal, en
 * dat verschil is de reden dat dit bestand `fixtures` heet en niet `data`.
 *
 * Niets hiervan wordt geëxporteerd uit de pakketingang. Wie het wil gebruiken importeert
 * `@intake/ui/fixtures` expliciet, en dat is in productiecode meteen zichtbaar.
 */

export const FIXTURE_FASEN_KLAAR: SessieFasen = {
  sessie: 'klaar',
  verbonden: 'klaar',
  eersteFrame: 'klaar',
};

export const FIXTURE_FASEN_BEZIG: SessieFasen = {
  sessie: 'klaar',
  verbonden: 'bezig',
  eersteFrame: 'wachten',
};

export const FIXTURE_FASEN_FOUT: SessieFasen = {
  sessie: 'fout',
  verbonden: 'wachten',
  eersteFrame: 'wachten',
  fout: 'avatar aangevraagd maar geen sessietoken ontvangen',
};

export const FIXTURE_BERICHTEN: readonly ConversationMessage[] = [
  {
    id: 'm1',
    speaker: 'ASSISTENT',
    text:
      'Goedemiddag. U spreekt met de AI-intake-assistent van Kantoor De Vries — ik ben geen ' +
      'advocaat. Ik stel een aantal vragen zodat een advocaat uw situatie sneller kan ' +
      'beoordelen. Vertelt u eens rustig wat er is gebeurd?',
    timestamp: '14:02:11',
    latency: { eot: 284, llm: 601, tts: 188, frame: 512, totaal: 1585, aanloop: 204 },
  },
  {
    id: 'm2',
    speaker: 'U',
    text: 'Ik ben vorige week op staande voet ontslagen terwijl ik ziek thuis zat.',
    timestamp: '14:02:29',
  },
  {
    id: 'm3',
    speaker: 'SYSTEEM',
    text: 'beurt overgeslagen — geen cliëntinhoud; hij blijft wachten',
    timestamp: '14:02:35',
  },
];

const feit = (
  key: string,
  value: unknown,
  status: CaseFact['status'],
  valueType: CaseFact['valueType'] = 'string',
): CaseFact => ({
  key,
  value,
  valueType,
  status,
  confidence: status === 'unknown' ? 0 : 0.9,
  source: 'client_statement',
  sourceRef: status === 'unknown' ? null : 'm2',
  llmCallId: null,
});

export const FIXTURE_FEITEN: readonly CaseFact[] = [
  feit('primary_issue', 'ontslag op staande voet', 'confirmed'),
  feit('currently_ill', true, 'confirmed', 'boolean'),
  feit('sick_since', '2026-08-10', 'inferred', 'date'),
  feit('financial_interest', null, 'unknown', 'number'),
];

export const FIXTURE_SIGNALEN: readonly RiskFlag[] = [
  {
    ruleKey: 'vervaltermijn_ontslag_op_staande_voet',
    level: 'HIGH',
    label: 'Mogelijk een vervaltermijn van twee maanden na de ontslagdatum.',
    detectedBy: 'rule',
    sourceRef: 'm2',
  },
];

export const FIXTURE_DOSSIER: DossierState = {
  completeness: 0.23,
  facts: FIXTURE_FEITEN,
  riskFlags: FIXTURE_SIGNALEN,
  rejected: [{ key: 'employer_name', reason: 'niet terug te vinden in een cliëntbeurt' }],
};

export const FIXTURE_DOCUMENTEN: readonly DocumentItem[] = [
  {
    id: 'doc-1',
    name: 'Ontslagbrief.pdf',
    type: 'pdf',
    category: 'Ontslagbrief',
    size: '318 KB',
    uploadedAt: '14:05',
    status: 'analyzed',
    summary: 'Brief waarin het dienstverband per direct wordt beëindigd.',
    extractedFacts: [
      { label: 'Datum brief', value: '23 juni 2026', sourceRef: 'pagina 1, regel 3' },
    ],
    textContent: 'AANGETEKENDE BRIEF\nDatum: 23 juni 2026\nBetreft: beëindiging dienstverband',
  },
  {
    id: 'doc-2',
    name: 'Loonstrook_juli.pdf',
    type: 'pdf',
    category: 'Loonstrook',
    size: '92 KB',
    uploadedAt: '14:06',
    status: 'processing',
    summary: '',
    extractedFacts: [],
  },
  {
    id: 'doc-3',
    name: 'Foto_werkrooster.jpg',
    type: 'image',
    category: 'Bewijsstuk',
    size: '1.2 MB',
    uploadedAt: '14:07',
    status: 'failed',
    summary: '',
    extractedFacts: [],
    failureReason: 'De afbeelding is te onscherp om tekst uit te lezen.',
  },
];
