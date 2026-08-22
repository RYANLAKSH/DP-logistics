/**
 * parse-manifest — decodes an uploaded manifest and stores the parse result.
 *
 * Why this is a function and not something the browser does: `parsed_rows` is
 * what publish_manifest_from_import() turns into live assignments, so a client
 * that could write it could write any assignment it liked. The RLS grants on
 * manifest_imports deliberately exclude that column; only the service role can
 * set it, and only from here.
 *
 * The caller's own JWT is still checked first. The service role is used for one
 * thing — writing the parse result — and never as a way to skip authorisation.
 */
import { createClient } from 'jsr:@supabase/supabase-js@2'
import {
  detectColumns, findHeaderRow, isUsableMapping, parseDelimited, validateRows,
  type ColumnMap,
} from '../_shared/manifest/index.ts'

const CORS = {
  'Access-Control-Allow-Origin': Deno.env.get('ALLOWED_ORIGIN') ?? '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const MAX_BYTES = 10 * 1024 * 1024

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  })
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405)

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) return json({ error: 'authentication required' }, 401)

  const url = Deno.env.get('SUPABASE_URL')!
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

  // Acts as the caller. Everything this client reads is filtered by RLS, so an
  // import belonging to another yard simply is not visible.
  const asUser = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  })

  const { data: me, error: meError } = await asUser.rpc('me')
  if (meError || !me) return json({ error: 'not authorised' }, 403)
  if (me.role !== 'MANAGER' && me.role !== 'ADMIN') {
    return json({ error: 'only a MANAGER or ADMIN may import a manifest' }, 403)
  }

  let importId: string
  let columnOverride: ColumnMap | undefined
  try {
    const body = await req.json()
    importId = String(body.importId ?? '')
    columnOverride = body.columnMap
    if (!importId) throw new Error('importId is required')
  } catch {
    return json({ error: 'importId is required' }, 400)
  }

  const { data: imp, error: impError } = await asUser
    .from('manifest_imports')
    .select('*')
    .eq('id', importId)
    .maybeSingle()

  if (impError) return json({ error: impError.message }, 400)
  if (!imp) return json({ error: 'import not found' }, 404)
  if (imp.status === 'COMMITTED') {
    return json({ error: 'this import has already been published' }, 409)
  }
  if (imp.file_bytes > MAX_BYTES) return json({ error: 'file is too large' }, 413)

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } })

  const { data: file, error: dlError } = await admin.storage
    .from('manifests')
    .download(imp.file_path)
  if (dlError || !file) return json({ error: 'could not read the uploaded file' }, 400)

  const bytes = new Uint8Array(await file.arrayBuffer())

  // The hash was computed on the manager's device before upload. Re-checking it
  // here proves the object in the bucket is the file they reviewed.
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const sha256 = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0')).join('')
  if (sha256 !== imp.file_sha256) {
    await admin.from('manifest_imports')
      .update({ status: 'FAILED', error_summary: { HASH_MISMATCH: 1 } })
      .eq('id', importId)
    return json({ error: 'the stored file does not match the uploaded hash' }, 409)
  }

  let grid: string[][]
  try {
    grid = imp.file_name.toLowerCase().endsWith('.csv')
      ? parseDelimited(new TextDecoder().decode(bytes))
      : await readSpreadsheet(bytes)
  } catch (e) {
    await admin.from('manifest_imports')
      .update({ status: 'FAILED', error_summary: { PARSE_FAILED: 1 } })
      .eq('id', importId)
    return json({ error: `could not parse the file: ${(e as Error).message}` }, 400)
  }

  const headerRow = findHeaderRow(grid)
  const map = columnOverride ?? (headerRow >= 0 ? detectColumns(grid[headerRow]!) : {})

  if (!isUsableMapping(map)) {
    await admin.from('manifest_imports').update({
      status: 'FAILED',
      error_summary: { NO_COLUMN_MAPPING: 1 },
      row_count: grid.length,
    }).eq('id', importId)
    return json({
      error: 'Could not find a container column and a chassis column.',
      headerCandidates: grid.slice(0, 10),
    }, 422)
  }

  const body = grid.slice(headerRow >= 0 ? headerRow + 1 : 0)
  const result = validateRows(body, map, { operatingDate: imp.operating_date })

  const { error: writeError } = await admin.from('manifest_imports').update({
    // VALIDATION_FAILED rather than READY when anything was rejected: only a
    // READY import can be published, so a bad file cannot reach the yard.
    status: result.rejectedCount > 0 ? 'VALIDATION_FAILED' : 'READY',
    column_map: map,
    parsed_rows: result.rows,
    row_count: result.rowCount,
    valid_count: result.validCount,
    rejected_count: result.rejectedCount,
    error_summary: result.errorSummary,
  }).eq('id', importId)

  if (writeError) return json({ error: writeError.message }, 500)

  return json({
    importId,
    status: result.rejectedCount > 0 ? 'VALIDATION_FAILED' : 'READY',
    columnMap: map,
    rowCount: result.rowCount,
    validCount: result.validCount,
    rejectedCount: result.rejectedCount,
    errorSummary: result.errorSummary,
    warningSummary: result.warningSummary,
    rows: result.rows,
  })
})

/**
 * XLSX decoding.
 *
 * SheetJS is loaded from its own CDN rather than from npm: the npm package is
 * pinned at a version carrying prototype-pollution and ReDoS advisories, and
 * this parses files that arrive by email from outside the company.
 */
async function readSpreadsheet(bytes: Uint8Array): Promise<string[][]> {
  const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.3/package/xlsx.mjs')
  const book = XLSX.read(bytes, { type: 'array', cellDates: false, cellFormula: false })
  const sheetName = book.SheetNames[0]
  if (!sheetName) throw new Error('the workbook has no sheets')
  const sheet = book.Sheets[sheetName]
  const grid = XLSX.utils.sheet_to_json(sheet, {
    header: 1, raw: false, defval: '', blankrows: false,
  }) as unknown[][]
  return grid.map((row) => row.map((cell) => String(cell ?? '')))
}
