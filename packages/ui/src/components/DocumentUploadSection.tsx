'use client';

import { useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  File,
  FileText,
  Image as ImageIcon,
  Loader2,
  Search,
  Trash2,
  UploadCloud,
} from 'lucide-react';
import { URGENCY_STYLES } from '../urgency';
import { DOCUMENT_CATEGORIES, type DocumentCategory, type DocumentItem } from '../types';

/**
 * Documenten uploaden en terugzien.
 *
 * ## Wat er níét is overgenomen
 *
 * Het prototype verzon bij elke upload een analyse. Een willekeurig bestand kreeg feiten
 * als "Beroepstermijn kantonrechter: 2 maanden (uiterlijk 23 aug 2026)" met het etiket
 * *Urgent*, plus "Uploadstatus: succesvol geverifieerd" en een dossiernummer — allemaal
 * uit de bestandsnaam geraden, of ronduit gefabriceerd. Daarnaast stonden er drie
 * "test-document toevoegen"-knoppen die complete ontslagbrieven met termijnen injecteerden.
 *
 * Dat is dezelfde categorie als de nep-engine: een verzonnen juridische bevinding, en hier
 * met een deadline erin. Als de cliënt daarop vertrouwt en de echte termijn is een andere,
 * is de schade niet cosmetisch.
 *
 * Deze component **toont** daarom alleen wat de echte pijplijn teruggeeft. Een net
 * geüpload bestand staat op `processing` tot de analyse klaar is, en zolang die status
 * geldt worden er geen feiten getoond. Categoriseren op de bestandsnaam gebeurt nog wel,
 * maar het resultaat heet dan ook "vermoedelijk" en is met de hand te wijzigen.
 */

export interface DocumentUploadSectionProps {
  readonly documents: readonly DocumentItem[];
  /** Krijgt het ruwe bestand plus de gegokte categorie; de aanroeper doet de echte upload. */
  readonly onUploadFiles: (bestanden: readonly File[]) => void;
  readonly onDeleteDocument: (id: string) => void;
  readonly onSelectDocument: (doc: DocumentItem) => void;
  readonly bezig?: boolean;
}

const FILTERS = ['Alle', ...DOCUMENT_CATEGORIES] as const;

/**
 * Een eerste gok op basis van de bestandsnaam.
 *
 * Bewust een gok en geen bewering: de categorie is een hulpmiddel om terug te vinden, en
 * hij staat los van wat er in het document staat. Daarom valt hij terug op "Overig" in
 * plaats van iets aannemelijks te verzinnen.
 */
export function raadCategorie(bestandsnaam: string): DocumentCategory {
  const n = bestandsnaam.toLowerCase();
  if (n.includes('ontslag')) return 'Ontslagbrief';
  if (n.includes('contract') || n.includes('arbeid')) return 'Arbeidscontract';
  if (n.includes('loon') || n.includes('salaris')) return 'Loonstrook';
  if (n.includes('ziek') || n.includes('arts') || n.includes('medisch')) return 'Medisch / Ziekte';
  if (n.includes('uwv')) return 'UWV Dossier';
  if (n.includes('mail') || n.includes('brief')) return 'Correspondentie';
  return 'Overig';
}

function TypeIcoon({ type }: { type: DocumentItem['type'] }) {
  if (type === 'pdf')
    return (
      <FileText className="h-5 w-5" style={{ color: 'var(--urgency-critical)' }} aria-hidden />
    );
  if (type === 'image')
    return <ImageIcon className="h-5 w-5" style={{ color: 'var(--app-primary)' }} aria-hidden />;
  return <File className="h-5 w-5" style={{ color: 'var(--app-text-muted)' }} aria-hidden />;
}

export function DocumentUploadSection({
  documents,
  onUploadFiles,
  onDeleteDocument,
  onSelectDocument,
  bezig = false,
}: DocumentUploadSectionProps) {
  const [sleept, setSleept] = useState(false);
  const [zoek, setZoek] = useState('');
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('Alle');
  const invoerRef = useRef<HTMLInputElement>(null);

  const verwerk = (lijst: FileList | null): void => {
    if (!lijst || lijst.length === 0) return;
    onUploadFiles(Array.from(lijst));
  };

  const zichtbaar = documents.filter((doc) => {
    const q = zoek.toLowerCase();
    const raakt =
      q === '' ||
      doc.name.toLowerCase().includes(q) ||
      doc.summary.toLowerCase().includes(q) ||
      doc.category.toLowerCase().includes(q);
    return raakt && (filter === 'Alle' || doc.category === filter);
  });

  return (
    <div className="space-y-4">
      {/* Sleepvlak */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setSleept(true);
        }}
        onDragLeave={() => setSleept(false)}
        onDrop={(e) => {
          e.preventDefault();
          setSleept(false);
          verwerk(e.dataTransfer.files);
        }}
        className="relative rounded-2xl border-2 border-dashed p-7 text-center shadow-sm transition-all"
        style={{
          backgroundColor: sleept ? 'var(--app-accent-bg)' : 'var(--app-card)',
          borderColor: sleept ? 'var(--app-primary)' : 'var(--app-border)',
        }}
      >
        <input
          ref={invoerRef}
          type="file"
          multiple
          accept=".pdf,.docx,.doc,.txt,.png,.jpg,.jpeg"
          onChange={(e) => {
            verwerk(e.target.files);
            if (invoerRef.current) invoerRef.current.value = '';
          }}
          className="hidden"
          id="document-upload-invoer"
        />

        <div className="mx-auto max-w-md space-y-2.5">
          <span
            className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border shadow-sm"
            style={{
              backgroundColor: 'var(--app-accent-bg)',
              color: 'var(--app-primary)',
              borderColor: 'var(--app-accent-border)',
            }}
          >
            <UploadCloud className="h-6 w-6" aria-hidden />
          </span>

          <div>
            <h3 className="text-sm font-semibold" style={{ color: 'var(--app-text)' }}>
              Sleep documenten hierheen
            </h3>
            <p className="mt-1 text-xs" style={{ color: 'var(--app-text-muted)' }}>
              PDF, Word, afbeeldingen of tekst. Denk aan uw arbeidscontract, een ontslagbrief,
              loonstroken of correspondentie.
            </p>
          </div>

          <button
            type="button"
            onClick={() => invoerRef.current?.click()}
            className="rounded-xl border px-3.5 py-1.5 text-xs font-semibold shadow-sm transition-all hover:opacity-90"
            style={{
              backgroundColor: 'var(--app-card)',
              borderColor: 'var(--app-border-strong)',
              color: 'var(--app-text)',
            }}
          >
            Bestand kiezen
          </button>
        </div>

        {bezig && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center gap-3 rounded-2xl backdrop-blur-sm"
            style={{ backgroundColor: 'var(--app-card)', opacity: 0.95 }}
          >
            <Loader2
              className="h-5 w-5 animate-spin"
              style={{ color: 'var(--app-primary)' }}
              aria-hidden
            />
            <span className="text-sm font-medium" style={{ color: 'var(--app-primary)' }}>
              Uploaden…
            </span>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="flex flex-col items-stretch justify-between gap-3 pt-2 sm:flex-row sm:items-center">
        <h2
          className="text-sm font-bold uppercase tracking-wider"
          style={{ color: 'var(--app-text)' }}
        >
          Documenten ({zichtbaar.length})
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex max-w-full items-center gap-1 overflow-x-auto pb-1">
            {FILTERS.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setFilter(cat)}
                className="whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium transition-all"
                style={{
                  backgroundColor: filter === cat ? 'var(--app-primary)' : 'var(--app-card)',
                  color: filter === cat ? 'var(--app-primary-text)' : 'var(--app-text-muted)',
                  border: `1px solid ${filter === cat ? 'var(--app-primary)' : 'var(--app-border)'}`,
                }}
              >
                {cat}
              </button>
            ))}
          </div>

          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2"
              style={{ color: 'var(--app-text-dim)' }}
              aria-hidden
            />
            <label htmlFor="document-zoek" className="sr-only">
              Zoek in documenten
            </label>
            <input
              id="document-zoek"
              type="search"
              value={zoek}
              onChange={(e) => setZoek(e.target.value)}
              placeholder="Zoeken…"
              className="w-36 rounded-lg border py-1.5 pl-8 pr-3 text-xs transition-colors focus:outline-none sm:w-44"
              style={{
                backgroundColor: 'var(--app-card)',
                borderColor: 'var(--app-border-strong)',
                color: 'var(--app-text)',
              }}
            />
          </div>
        </div>
      </div>

      {/* Kaarten */}
      {zichtbaar.length === 0 ? (
        <div
          className="space-y-2 rounded-2xl border py-10 text-center"
          style={{
            backgroundColor: 'var(--app-surface-subtle)',
            borderColor: 'var(--app-border)',
          }}
        >
          <FileText
            className="mx-auto h-8 w-8"
            style={{ color: 'var(--app-text-dim)' }}
            aria-hidden
          />
          <p className="text-sm font-medium" style={{ color: 'var(--app-text-muted)' }}>
            {documents.length === 0 ? 'Nog geen documenten' : 'Niets gevonden'}
          </p>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3.5 md:grid-cols-2">
          {zichtbaar.map((doc) => (
            <li
              key={doc.id}
              className="flex flex-col justify-between rounded-2xl border p-4 shadow-sm transition-all hover:shadow-md"
              style={{ backgroundColor: 'var(--app-card)', borderColor: 'var(--app-border)' }}
            >
              <div className="space-y-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-start gap-2.5">
                    <span
                      className="shrink-0 rounded-xl border p-2"
                      style={{
                        backgroundColor: 'var(--app-surface)',
                        borderColor: 'var(--app-border)',
                      }}
                    >
                      <TypeIcoon type={doc.type} />
                    </span>
                    <div className="min-w-0">
                      <h3
                        className="truncate text-sm font-semibold"
                        style={{ color: 'var(--app-text)' }}
                        title={doc.name}
                      >
                        {doc.name}
                      </h3>
                      <p
                        className="mt-0.5 font-mono text-[11px]"
                        style={{ color: 'var(--app-text-dim)' }}
                      >
                        {doc.size} · {doc.uploadedAt}
                      </p>
                    </div>
                  </div>

                  <span
                    className="shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] font-medium uppercase tracking-wider"
                    style={{
                      backgroundColor: 'var(--app-surface)',
                      borderColor: 'var(--app-border)',
                      color: 'var(--app-text-muted)',
                    }}
                  >
                    {doc.category}
                  </span>
                </div>

                {/*
                 * Samenvatting en feiten pas als de analyse klaar is. Zolang die loopt
                 * staat er dat hij loopt — niet iets aannemelijks.
                 */}
                {doc.status === 'processing' && (
                  <p
                    className="flex items-center gap-2 rounded-xl border p-2.5 text-xs"
                    style={{
                      backgroundColor: 'var(--app-surface-subtle)',
                      borderColor: 'var(--app-border)',
                      color: 'var(--app-text-muted)',
                    }}
                  >
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    Wordt gelezen — nog geen inhoud beoordeeld.
                  </p>
                )}

                {doc.status === 'failed' && (
                  <p
                    className="flex items-start gap-2 rounded-xl border p-2.5 text-xs"
                    style={{
                      backgroundColor: 'var(--urgency-critical-bg)',
                      borderColor: 'var(--urgency-critical)',
                      color: 'var(--urgency-critical)',
                    }}
                  >
                    <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                    {doc.failureReason ?? 'Analyse mislukt.'}
                  </p>
                )}

                {doc.status === 'analyzed' && doc.summary && (
                  <p
                    className="line-clamp-2 rounded-xl border p-2.5 text-xs leading-relaxed"
                    style={{
                      backgroundColor: 'var(--app-surface-subtle)',
                      borderColor: 'var(--app-border)',
                      color: 'var(--app-text-muted)',
                    }}
                  >
                    {doc.summary}
                  </p>
                )}

                {doc.status === 'analyzed' && doc.extractedFacts.length > 0 && (
                  <ul className="space-y-1 pt-1">
                    {doc.extractedFacts.slice(0, 2).map((fact) => (
                      <li
                        key={`${fact.label}-${fact.sourceRef}`}
                        className="flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1 text-xs"
                        style={{
                          backgroundColor: 'var(--app-surface)',
                          borderColor: 'var(--app-border)',
                        }}
                      >
                        <span style={{ color: 'var(--app-text-muted)' }}>{fact.label}</span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className="font-mono text-[11px] font-medium"
                            style={{ color: 'var(--app-text)' }}
                          >
                            {fact.value}
                          </span>
                          {fact.level && (
                            <span
                              className="rounded border px-1.5 text-[9px] font-semibold"
                              style={{
                                backgroundColor: URGENCY_STYLES[fact.level].bg,
                                color: URGENCY_STYLES[fact.level].fg,
                                borderColor: URGENCY_STYLES[fact.level].fg,
                              }}
                            >
                              {URGENCY_STYLES[fact.level].label.nl}
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div
                className="mt-3 flex items-center justify-between border-t pt-3 text-xs"
                style={{ borderColor: 'var(--app-border)' }}
              >
                {doc.status === 'analyzed' ? (
                  <span
                    className="flex items-center gap-1.5 text-[11px] font-medium"
                    style={{ color: 'var(--app-badge-green-text)' }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
                    Gelezen
                  </span>
                ) : (
                  <span className="text-[11px]" style={{ color: 'var(--app-text-dim)' }}>
                    {doc.status === 'processing' ? 'Bezig' : 'Mislukt'}
                  </span>
                )}

                <span className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => onSelectDocument(doc)}
                    className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium shadow-sm transition-all hover:opacity-90"
                    style={{
                      backgroundColor: 'var(--app-accent-bg)',
                      borderColor: 'var(--app-accent-border)',
                      color: 'var(--app-accent-text)',
                    }}
                  >
                    <Eye className="h-3.5 w-3.5" aria-hidden />
                    Bekijken
                  </button>

                  <button
                    type="button"
                    onClick={() => onDeleteDocument(doc.id)}
                    className="rounded p-1 transition-colors"
                    style={{ color: 'var(--app-text-dim)' }}
                    title={`${doc.name} verwijderen`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden />
                    <span className="sr-only">{doc.name} verwijderen</span>
                  </button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
