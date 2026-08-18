# Trade documents

## The problem

The photographs answer "is the right car in the right container?". They do not
answer "can this container ship?" — that needs the paperwork, and the paperwork
lives in email threads, WhatsApp, a shared drive, and the CHA's filing cabinet.

So when something goes wrong three months later, someone spends a day
reassembling a shipment from six places. The document store exists to make that
a single request.

## What it holds

One table with a type, not a table per document kind — the set grows and the
handling is identical: upload, verify, link, retain, serve under audit.

| Type | Issued by | Typically covers |
|---|---|---|
| `PICKUP_LIST` | DO / exporter | A container, or several |
| `DELIVERY_ORDER` | Shipping line | A booking |
| `COMMERCIAL_INVOICE` | Exporter | Many VINs |
| `PACKING_LIST` | Exporter | A container |
| `SHIPPING_BILL` | Customs (via CHA) | A consignment |
| `SHIPPING_BILL_SUMMARY` | Customs | A consignment |
| `LEO` | Customs | A shipping bill — clearance to load |
| `BILL_OF_LADING` | Shipping line | A container |
| `VGM_CERTIFICATE` | Weighbridge | A container |
| `SEAL_CERTIFICATE` | Loading agent | A container |
| `CUSTOMS_EXAM_REPORT` | Customs | A container |
| `EGM` | Shipping line | A vessel |
| `INSURANCE_CERTIFICATE` | Insurer | A consignment |
| `OTHER` | — | Anything |

`OTHER` exists deliberately. A store that turns away an unrecognised document is
a store people work around by going back to email.

## Auto-linking — the part that matters

A document is scanned for container numbers and VINs using **the same extractors
the camera uses**, and every identifier found becomes a link. `shared-rules`
already knows ISO 6346 check digits and VIN shape, so a shipping bill and a
container plate are parsed by identical code.

```
document text ──► extractContainerNumbers()  ──► ISO 6346 valid?
                  extractVins()              ──► 17-char VIN shape?
                        │
                        └──► on an active report line?
                                 yes → link (source: 'extracted')
                                 no  → report as unmatched, link nothing
```

That last restraint is the important one. A shipping bill mentions containers
from other consignments; linking every string that happens to satisfy a check
digit would attach documents to shipments they have nothing to do with.
Unmatched identifiers are returned so a human can decide.

**Extracted vs. manual links are stored distinctly.** An extracted link is
evidence of what the document says. A manual link is somebody's claim about it.
In a dispute the difference matters.

Links are many-to-many on purpose: one invoice covers forty VINs, one VIN
appears on an invoice, a packing list, a shipping bill and an LEO.

### Documents that arrive before their report

Common — the DO and invoice turn up days before the pickup list. At upload time
there is nothing to link to, so the extracted text is stored and
`POST /v1/documents/:id/relink` re-runs extraction once the report lands.

### Text recognition

Auto-linking needs text. Where it comes from:

| Source | How |
|---|---|
| CSV / spreadsheets | The file *is* text |
| PDFs with a text layer | Pasted by the admin, or extracted client-side |
| **Scanned images, image-only PDFs** | **OCR — see below** |

A CHA sending a photographed shipping bill sends no text at all, which is the
common case and the one that would otherwise force manual filing.

**Provider is pluggable and off by default**, because recognition bills per page:

```bash
OCR_PROVIDER=textract          # requires S3_BUCKET — Textract reads from the bucket
TEXTRACT_REGION=ap-south-1
npm i @aws-sdk/client-textract -w @dp/api
```

With nothing configured, `NoopOcrProvider` runs: documents still upload, verify
and link manually. Nothing breaks, nothing is billed.

Textract has two paths and the code uses both:

- single-page images → `DetectDocumentText`, synchronous
- PDFs → `StartDocumentTextDetection`, asynchronous — returns a job id to poll

Recognition is queued, never inline. A document verifies, its email-path work
finishes, and the job runs behind it:

```
document verified
      │
      └─► ocr_jobs row (queued)
                │
          worker claims it ──► provider
                │                 │
                │           'pending' → poll next pass
                │                 │
                └──── text ◄───────┘
                        │
                        ├─► stored on the document
                        └─► autoLinkFromText() — same extractors as the camera
```

**Cost controls are part of the design**, not an afterthought:

| Guard | Why |
|---|---|
| Skip when text already exists | Never pay to produce what we have |
| Reuse text for a byte-identical file | The same invoice gets uploaded twice; the hash makes identity exact |
| Cap at 30 pages | A 400-page scan is a mistake, not a document |
| 3 retries, then abandon | Recognition failures are rarely transient |
| 60-poll ceiling on async jobs | A job stuck IN_PROGRESS would otherwise be polled forever |

Recognition is only attempted on **verified** documents. Extracting identifiers
from a file that failed hash verification — and then linking on them — would be
linking on something that may not be the document it claims to be.

A blank result is recorded as `done` with `NO_TEXT_FOUND`, not as a failure: the
operational response is "link this one by hand", not "debug the pipeline".

The worker runs in-process on a 30-second interval. That is a deliberate
simplification at pilot volume, and the queue lives in the database, so moving
to a dedicated worker later means pointing another process at the same table.

## The container dossier

`GET /v1/containers/:containerNo/dossier` assembles the three things that
normally live apart:

```
OOLU2656042
├── booked        4 vehicles, from report PUR/20260814/INMUN/001 v1
├── aboard        4/4 MATCH, each with 2/2 hash-verified photographs
└── paperwork     ✓ PICKUP_LIST  ✓ DELIVERY_ORDER  ✓ COMMERCIAL_INVOICE
                  ✓ PACKING_LIST ✓ SHIPPING_BILL   ✓ LEO
                  → documentsComplete: true
```

Two rules worth knowing:

**A requirement is satisfied by a document linked to the container OR to any
vehicle in it.** A consignment invoice is linked per VIN; demanding a
container-level copy as well would be paperwork for its own sake.

**Only a verified document counts.** Declared-but-not-uploaded does not satisfy
anything — otherwise the checklist would go green on an intention rather than a
document.

The mandatory set is configured per org (`document_requirements`), because it
varies by trade lane and by customer. The seed ships a common denominator for
containerised vehicle export out of India: pickup list, DO, invoice, packing
list, shipping bill, LEO.

## Integrity

Documents use the same path as scan evidence: declare a SHA-256, upload straight
to storage with a capability URL, then have the server verify what landed. Same
guarantees, same audit trail, same refusal to serve anything unverified. See
[security.md](security.md).

Content types are restricted to PDF, images, CSV and Excel. Absent on purpose:
**no HTML, no SVG, no archives** — the first two execute in a viewer, which
would make the document store a stored-XSS vector against the admin panel, and
archives hide arbitrary content.

Retention is 8 years, longer than evidence images, because customs and tax
exposure outlives the shipment.

## API

```
GET  /v1/documents/:id/ocr               recognition state + what it linked
POST /v1/documents/:id/ocr               force a fresh pass
POST /v1/admin/ocr/run                   drain the queue now
GET  /v1/admin/ocr-jobs                  queue and history

POST /v1/documents                       declare → returns an upload URL
POST /v1/documents/:id/uploaded          verify what landed
GET  /v1/documents                       list, filter by type or reference
GET  /v1/documents/:id/view              signed viewing link (logged)
POST /v1/documents/:id/links             assert a manual link
POST /v1/documents/:id/relink            re-extract against current reports
GET  /v1/documents/for/:type/:id         documents for a container, VIN, DO
GET  /v1/containers/:containerNo/dossier the whole picture

GET/POST /v1/admin/document-requirements what a shipment must have
```

Upload and linking need supervisor or admin. Reading needs any authenticated
role, so a field officer can see the paperwork for the container in front of
them.

## In the admin panel

**Documents** tab: pick a type, choose a file, optionally paste text for
auto-linking, upload. Each row shows its recognition state and what its text
linked to, with a **Re-read** button per document and **Run recognition queue
now** for the whole queue. The browser hashes the file with SubtleCrypto before
declaring it, so the same verification applies to admin uploads as to phone
photographs.

**Container dossier** tab: type a container number, get the picture above.

## What is not built

- **The Textract provider has not been run against real AWS.** No credentials
  here. `FixtureOcrProvider` covers the pipeline — queueing, the async poll path,
  cost guards, reuse, retries, linking — and the Textract class covers the API
  surface. Budget a day to shake out the real integration.
- **No table-structure awareness.** Textract's `AnalyzeDocument` returns table
  cells; we use plain `DetectDocumentText` and rely on the extractors. That works
  because container numbers and VINs are self-validating, but a pickup list could
  be parsed into rows properly rather than treated as loose text.
- email-inbox ingest (a mailbox that pulls DO attachments in automatically)
- document versioning UI — the schema supports `supersedes_id`, nothing sets it
- virus and content scanning
- bulk upload of a whole shipment's paperwork in one go
