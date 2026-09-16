import { useEffect, useState } from 'react'
import StatusChip from '../components/StatusChip'
import { Stat, fmtNum } from '../components/MetaStrip'
import { SkeletonCards } from '../components/Skeleton'
import { getCorpus } from '../api'

export default function Corpus() {
  const [documents, setDocuments] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    getCorpus()
      .then((res) => setDocuments(res.data.documents))
      .catch(() => setError('The corpus could not be loaded. Check the API container, then reload.'))
  }, [])

  const chunks = (documents || []).reduce((sum, d) => sum + (d.chunk_count || 0), 0)

  return (
    <div className="pb-16">
      <h1 className="page-title brand-rule">What the agent can see</h1>
      <p className="page-deck">
        The agent knows these documents and nothing else. A source that fails to download is shown as
        unavailable rather than quietly dropped.
      </p>

      {error && <p className="notice-error mt-6">{error}</p>}
      {!documents && !error && <SkeletonCards count={4} />}

      {documents && (
        <>
          <p className="mt-7 border-y border-line py-3 text-meta tabular text-slate2">
            {documents.length} documents, {fmtNum(chunks)} indexed passages.
          </p>

          <div className="stagger mt-2 2xl:grid 2xl:grid-cols-2 2xl:gap-x-14">
            {documents.map((doc) => (
              <article
                key={doc.key}
                className="group border-b border-line py-6 transition-colors duration-300 ease-smooth"
              >
                <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
                  <div className="max-w-measure">
                    <p className="eyebrow">{doc.short_name}</p>
                    <h2 className="mt-1.5 font-serif text-section font-semibold leading-[26px] text-navy transition-colors duration-300 ease-smooth group-hover:text-brand-redInk">
                      {doc.title}
                    </h2>
                    <p className="mt-1.5 text-body text-slate2">
                      {doc.publisher}, {doc.version}
                    </p>
                  </div>
                  <StatusChip status={doc.status === 'ok' ? 'ok' : doc.status} />
                </div>

                <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-3">
                  <Stat label="Passages" value={fmtNum(doc.chunk_count)} />
                  <Stat label="Embedded" value={fmtNum(doc.embedded_count)} />
                  <Stat label="Sections" value={fmtNum(doc.section_count)} />
                  <Stat label="Pages" value={doc.page_count ? fmtNum(doc.page_count) : null} />
                  <Stat
                    label="Retrieved"
                    value={doc.retrieved_at ? new Date(doc.retrieved_at).toLocaleDateString() : null}
                  />
                  <Stat label="sha256" value={doc.sha256 ? `${doc.sha256.slice(0, 16)}…` : null} mono />
                </dl>

                {doc.status_detail && doc.status !== 'ok' && (
                  <p className="mt-3 text-meta text-brand-redInk">{doc.status_detail}</p>
                )}

                <p className="mt-4 max-w-measure text-meta leading-[17px] text-slate2-light">
                  {doc.licence_note}
                </p>
                {doc.source_url && (
                  <a
                    href={doc.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="link mt-1.5 inline-block text-meta"
                  >
                    Original document
                  </a>
                )}
              </article>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
