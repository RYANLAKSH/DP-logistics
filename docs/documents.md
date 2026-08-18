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

### A note on text extraction

Auto-linking needs text. Where it comes from today:

- **CSV / spreadsheets** — the file is text
- **PDFs with a text layer** — the admin pastes it, or the client extracts it
- **Scanned images and image-only PDFs** — nothing automatic; link manually

Server-side OCR (Textract) for scanned documents is the obvious next step and
would remove the manual case entirely. Not built.

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
auto-linking, upload. The browser hashes the file with SubtleCrypto before
declaring it, so the same verification applies to admin uploads as to phone
photographs.

**Container dossier** tab: type a container number, get the picture above.

## What is not built

- server-side OCR for scanned documents
- email-inbox ingest (a mailbox that pulls DO attachments in automatically)
- document versioning UI — the schema supports `supersedes_id`, nothing sets it
- virus and content scanning
- bulk upload of a whole shipment's paperwork in one go
