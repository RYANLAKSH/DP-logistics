# Where the images live, and why you can trust them

## The short answer

**Private object storage in your own region, written to directly by the phone
using a one-minute-shelf-life URL, never through the API, never into the
database, and never onto the app server's disk.**

Concretely, pick one:

| Option | When it fits | Notes |
|---|---|---|
| **AWS S3, `ap-south-1` (Mumbai)** | Default choice for an India-based operation | Object Lock and lifecycle rules are the reason to prefer it |
| **Cloudflare R2** | Cost-sensitive, heavy viewing traffic | No egress fees. No Object Lock equivalent — weaker for evidence |
| **MinIO, self-hosted** | Data must not leave your own racks | You own patching, backups and durability. Real work |

The code does not care which. `StorageDriver` has two implementations
(`LocalStorageDriver`, `S3StorageDriver`) and switching is configuration:

```bash
S3_BUCKET=dp-evidence-prod
S3_REGION=ap-south-1
# S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com   # for R2 or MinIO
```

With no `S3_BUCKET`, the local driver runs — files on disk plus HMAC-signed
capability URLs. That is the development default and a legitimate small
self-hosted deployment; it is not what you want holding two years of legal
evidence on one server's filesystem.

## Why not the obvious alternatives

**Not in the database.** Blobs in Postgres wreck backup and restore times, and
you will eventually need to serve an image without loading the row.

**Not on the app server.** The disk is ephemeral, it is not backed up, it does
not survive a redeploy, and it scales to exactly one server.

**Not through the API.** Every image would occupy a request thread for the
duration of an upload over a bad connection at a port gate. Direct-to-storage
means a slow transfer costs you nothing but the transfer.

**Not in the phone's photo gallery.** Worth stating because it is the most
common leak in apps like this. Evidence photos live in the app's private
sandbox directory and are deleted once the server confirms a byte-identical
copy. They are never written to the shared media store, so they do not appear
in the gallery, do not sync to Google Photos, and do not survive uninstalling
the app.

## What makes an image trustworthy

A photograph on its own proves very little. What makes it evidence is
everything recorded around it, and the fact that none of it can be quietly
changed afterwards.

```
Device                                      Server
──────                                      ──────
compress → hash (SHA-256)
        │
        └─ declare: "I am about to send you
           this hash, this many bytes"  ────► committed to the DB FIRST
                                             (before any bytes exist)
                                                    │
        ◄──────────── one-hour upload URL ──────────┘
                      for one key, one operation

PUT bytes ──────────────────────────────────► object store
                                                    │
        finalize ───────────────────────────► re-hash what actually landed
                                             compare to the declaration
                                                    │
                                             match    → verified = 1
                                             mismatch → stays unverified,
                                                        failure recorded
```

The ordering is the point. The expected hash is committed **before** the bytes
arrive, so it cannot be back-filled to match whatever showed up. And an image
that fails verification is never marked verified and never served — an image
that looks like evidence but is not is worse than no image at all.

Stored alongside each image:

| Field | Why it matters |
|---|---|
| SHA-256 | Detects any later modification, in storage or in transit |
| GPS + accuracy | A reconciliation from 40 km off-site is a fraud signal |
| Device clock and server receipt time | Clock tampering shows up as skew |
| Officer identity and device id | Recorded for audit; not an access gate — see "Auth and roles" in architecture.md |
| Report reference **and version** | What the decision was actually judged against |
| OCR proposal vs. confirmed value | Whether a human corrected the machine |

`reconciliations` and `audit_log` are append-only. An override writes a **new**
row pointing at the one it supersedes; the blocked decision is never edited.

## Bucket configuration checklist

Do all of these before the first real image lands. Retrofitting Object Lock in
particular is not possible on an existing bucket.

- [ ] **Block Public Access** on, at account level as well as bucket level
- [ ] **No public ACLs**, ever — all reads go through presigned URLs
- [ ] **SSE-KMS with a customer-managed key**, not SSE-S3. The difference is
      that every decryption is logged in CloudTrail and you can revoke the key
- [ ] **Versioning on** — required for Object Lock, and it means a mistaken
      overwrite is recoverable
- [ ] **Object Lock, compliance mode, 24-month retention.** This is the single
      most valuable setting for evidence: within the retention window nobody
      can delete or alter an object — not an admin, not root, not someone with
      stolen credentials. If you take one item from this list, take this one
- [ ] **Lifecycle**: Standard for 90 days → Glacier Instant Retrieval → expire
      per your retention policy
- [ ] **TLS only**, enforced by bucket policy (`aws:SecureTransport`)
- [ ] **Access logging** or CloudTrail data events on
- [ ] **IAM: no `s3:DeleteObject`** for the application role. Deletion is a
      lifecycle rule's job, not the app's

The application's role wants exactly this and nothing more:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["s3:PutObject", "s3:GetObject", "s3:HeadObject"],
    "Resource": "arn:aws:s3:::dp-evidence-prod/*",
    "Condition": { "Bool": { "aws:SecureTransport": "true" } }
  }]
}
```

## Access control

**The phone never holds bucket credentials.** It receives a capability URL that
names one object key, permits one operation, and expires. If a device is lost,
the worst an attacker inherits is the ability to upload one image to one key
that already exists — and the refresh token can be revoked server-side.

**Keys are derived server-side** from the org, the date and the scan id. The
client cannot name its destination; if it could, a compromised device could
overwrite another officer's evidence or escape the prefix. The key format is
also validated against a fixed pattern, with a filesystem containment check
behind that as a second line.

**Viewing links are logged.** Every issued link writes a row to
`evidence_access_log` with the actor, the object and the time. "Who has seen
this?" is a question that gets asked in disputes and cannot be answered
retroactively.

Roles: officers scan; supervisors approve overrides; admins manage reports,
users and documents; auditors read everything and change nothing.

## What this does not protect against

Worth being straight about the limits.

**A determined malicious officer.** The device declares the hash, so it can
declare the hash of a photograph of the *wrong* container taken yesterday.
Hash verification proves the bytes were not corrupted or swapped in transit; it
does not prove the camera took them at that moment. The mitigations are
circumstantial rather than cryptographic: GPS, timestamp skew, device binding,
supervisor override rates, and the fact that the same officer's other scans
that shift form a pattern. Closing the gap properly needs hardware capture
attestation (Play Integrity / DeviceCheck plus a signed camera pipeline), which
is a real project and probably not worth it before you have seen whether it is
a real problem.

**An attacker with your KMS key and Object Lock disabled.** Which is why Object
Lock in compliance mode is on the checklist.

**Someone photographing a screen.** Nothing technical solves this.

## Retention and residency

| Data | Retention | Then |
|---|---|---|
| Evidence images | 24 months (configurable) | Glacier, then expire |
| Trade documents | 8 years | Customs and tax exposure outlives the shipment |
| Reconciliation records | Indefinite | Small, and they are the audit trail |
| `audit_log` | 7 years | Cold storage |
| `evidence_access_log` | 12 months | Volume is high, value decays fast |
| Driver names/phones | Report validity + 12 months | Null out, keep the reconciliation |

If Indian data residency matters to you — and for customs-adjacent records it
usually does — keep the bucket in `ap-south-1` and do **not** enable
cross-region replication to a foreign region. Use same-region replication or
versioning plus Object Lock for durability instead.

## Current implementation status

Built and tested:

- both storage drivers, capability URL signing, expiry, tamper rejection
- server-derived keys with traversal resistance
- declare → upload → verify with hash and size checking
- failed verification recorded, unverified images never linked
- access logging on every issued viewing link
- append-only reconciliation and audit trails
- on-device: app-private storage, deleted after verification

Not yet done:

- **S3 driver is untested against a real bucket** — no credentials in this
  environment. The local driver is what the 47 storage and evidence tests
  cover, and it deliberately mirrors the S3 driver's semantics
- Object Lock, KMS and lifecycle are bucket configuration, not code — the
  checklist above is the work
- no antivirus or content scanning on uploaded documents
- no client-side encryption before upload (server-side at rest only)
