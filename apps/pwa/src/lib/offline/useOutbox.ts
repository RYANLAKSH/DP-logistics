import { useCallback, useEffect, useState } from 'react'
import { useData } from '@/data/provider'
import { db, requestPersistence, storageUsage, type OutboxItem, type StorageUsage,
         STORAGE_BLOCK_BYTES, STORAGE_WARN_BYTES } from './db'
import { drain, pending } from './outbox'
import { connectivity, useConnectivity } from './connectivity'

export interface OutboxView {
  items: OutboxItem[]
  pendingCount: number
  syncing: boolean
  usage: StorageUsage | null
  storageWarning: boolean
  storageBlocked: boolean
  sync(): Promise<void>
  refresh(): Promise<void>
}

export function useOutbox(pollMs = 15_000): OutboxView {
  const data = useData()
  const online = useConnectivity()
  const [items, setItems] = useState<OutboxItem[]>([])
  const [syncing, setSyncing] = useState(false)
  const [usage, setUsage] = useState<StorageUsage | null>(null)

  const refresh = useCallback(async () => {
    setItems(await pending())
    setUsage(await storageUsage())
  }, [])

  const sync = useCallback(async () => {
    if (connectivity() === 'offline') return
    setSyncing(true)
    try {
      await drain(data)
    } finally {
      setSyncing(false)
      await refresh()
    }
  }, [data, refresh])

  useEffect(() => { void requestPersistence(); void refresh() }, [refresh])

  useEffect(() => {
    // Drain when connectivity returns, and periodically while there is
    // anything outstanding. Background Sync handles the case where the app is
    // closed; this handles the case where it is open.
    if (online === 'offline') return
    void sync()
    const timer = window.setInterval(() => { void sync() }, pollMs)
    return () => window.clearInterval(timer)
  }, [online, sync, pollMs])

  const used = usage?.usedBytes ?? 0
  return {
    items,
    pendingCount: items.filter((i) => i.state !== 'confirmed').length,
    syncing,
    usage,
    storageWarning: used > STORAGE_WARN_BYTES,
    storageBlocked: used > STORAGE_BLOCK_BYTES,
    sync,
    refresh,
  }
}

export { db }
