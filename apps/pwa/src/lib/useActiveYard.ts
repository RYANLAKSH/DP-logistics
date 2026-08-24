import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useData } from '@/data/provider'
import { useSession } from '@/lib/session'
import type { Yard } from '@/data/types'

export interface ActiveYard {
  /** null until listYards() resolves. Every query on it must be gated. */
  yardId: string | null
  /** For a yard switcher. Passing null returns to the default choice. */
  setYardId: (id: string | null) => void
  yards: Yard[]
  loading: boolean
}

/**
 * Which yard the manager screens are looking at.
 *
 * This exists because three screens had the yard id written into them as the
 * literal 'yard-nsa' — the mock backend's fixture id. Against Supabase a yard
 * id is a uuid, so `create_manifest_upload_path('yard-nsa', ...)` came back
 * `invalid input syntax for type uuid`, and the manifest upload could not
 * work at all on a real project. The other two screens quietly returned
 * nothing, which is worse: an empty table reads as "no exceptions today".
 *
 * The rule the id has to satisfy is the reason this is resolved rather than
 * stored: a MANAGER is scoped to the yards on their profile, while an ADMIN
 * has no yard rows at all by design — they see the whole organisation. So the
 * default is the first yard the profile names, and failing that simply the
 * first yard RLS was willing to return, which for an admin is the org's own
 * list and for anyone else is already filtered to what they may see.
 */
export function useActiveYard(): ActiveYard {
  const data = useData()
  const { profile } = useSession()
  const [chosen, setChosen] = useState<string | null>(null)

  const yards = useQuery({ queryKey: ['yards'], queryFn: () => data.listYards() })

  const yardId =
    chosen
    ?? yards.data?.find((y) => profile?.yardIds.includes(y.id))?.id
    ?? yards.data?.[0]?.id
    ?? null

  return {
    yardId,
    setYardId: setChosen,
    yards: yards.data ?? [],
    loading: yards.isLoading,
  }
}
