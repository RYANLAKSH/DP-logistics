# Sample documents — local only

This directory is **gitignored**. Nothing in it reaches the repository.

## Before you put a real document here

Ask whether the real values are needed. Usually they are not — what makes a
sample useful for this project is its **layout**: which columns exist, what the
headers are called, where the container number and chassis number sit, how the
preamble above the table is arranged. None of that requires a real invoice value
or a real consignee.

So, in order of preference:

1. **Describe the layout**, or send a screenshot with values blacked out.
2. **Redact**, then upload — keep the structure, replace the data:
   - container numbers → any check-digit-valid number (see below)
   - VINs → any 17-character VIN
   - exporter, consignee, buyer names → placeholders
   - invoice values, IEC, GSTIN, PAN, AD code → placeholders
   - driver names and phone numbers → remove entirely
3. **Real, unredacted** — only if the layout genuinely cannot be reproduced
   without it, and only in this directory.

Generate valid replacement identifiers with the fixture generator, which
computes correct ISO 6346 and ISO 3779 check digits:

```bash
npm run seed        # writes packages/fixtures/data/pickup-report.csv
```

## Why the caution

Two distinct risks, and the second is the bigger one:

**The conversation.** Anything attached to a Claude conversation is transmitted
to Anthropic and forms part of that conversation's history. Whether it can be
used to improve the models depends on your account type and your data settings —
check those settings for your own account rather than assuming either way.

**Git history.** This is the risk that actually bites. A document committed by
accident is permanent: it survives deletion, it is in every clone, and removing
it means rewriting history and force-pushing. The `.gitignore` rules exist to
make that mistake hard, but they only work if samples live here.

## Testing without real documents

The OCR pipeline does not need them. `FixtureOcrProvider` returns canned text for
any object key, so the full path — recognition, auto-linking, the dossier — is
exercisable with synthetic data. See `packages/api/src/__tests__/ocr.test.ts`.
