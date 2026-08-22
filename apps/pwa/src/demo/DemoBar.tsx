import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useData } from '@/data/provider'
import { chassisLabel, containerLabel, setDemoLabel, unreadableLabel } from './label'

/**
 * The demo's stand-in for walking up to a container.
 *
 * On a scan screen it asks the only question a yard would answer for us: which
 * physical object is in front of the camera. Choosing the wrong vehicle is the
 * point of the whole product, so it is one tap away rather than buried.
 *
 * Everything downstream of the choice is the real app.
 */
let introduced = false

export function DemoBar() {
  const { pathname } = useLocation()
  const data = useData()
  const [open, setOpen] = useState(false)


  const scan = useMemo(() => {
    const m = pathname.match(/^\/driver\/pickup\/([^/]+)\/scan\/(container|chassis)$/)
    return m ? { assignmentId: m[1]!, kind: m[2] as 'container' | 'chassis' } : null
  }, [pathname])

  const { data: assignment } = useQuery({
    queryKey: ['assignment', scan?.assignmentId],
    queryFn: () => data.getAssignment(scan!.assignmentId),
    enabled: !!scan,
  })
  const { data: all } = useQuery({
    queryKey: ['driver', 'assignments'],
    queryFn: () => data.listMyAssignments(),
    enabled: !!scan,
  })

  const choices = useMemo(() => {
    if (!scan || !assignment) return []
    const others = (all ?? []).filter((a) => a.id !== assignment.id)
    if (scan.kind === 'container') {
      const wrong = others.find((a) => a.containerNo !== assignment.containerNo)
      return [
        { key: 'right', label: 'The container on my job sheet',
          value: assignment.containerNo, make: () => containerLabel(assignment.containerNo) },
        ...(wrong ? [{ key: 'wrong', label: 'The container standing next to it',
          value: wrong.containerNo, make: () => containerLabel(wrong.containerNo) }] : []),
        { key: 'bad', label: 'Marking painted over', value: 'unreadable',
          make: () => unreadableLabel() },
      ]
    }
    const wrong = others.find((a) => a.chassisNo !== assignment.chassisNo)
    return [
      { key: 'right', label: 'The vehicle on my job sheet',
        value: assignment.chassisNo, make: () => chassisLabel(assignment.chassisNo) },
      ...(wrong ? [{ key: 'wrong', label: 'A different vehicle from the yard',
        value: wrong.chassisNo, make: () => chassisLabel(wrong.chassisNo) }] : []),
      { key: 'bad', label: 'Label torn and oily', value: 'unreadable',
        make: () => unreadableLabel() },
    ]
  }, [scan, assignment, all])

  const [picked, setPicked] = useState('right')

  // Entering a scan screen points the camera at the right object. Going wrong
  // should be a decision the tester makes, not the default they land in.
  useEffect(() => {
    if (!scan || choices.length === 0) return
    setPicked('right')
    setDemoLabel(choices[0]!.make())
  }, [scan?.assignmentId, scan?.kind, choices.length])

  // Opened once, so the choice is discovered; after that it stays as the
  // tester left it and out of the way of the screen being demonstrated.
  useEffect(() => {
    if (scan && !introduced) {
      introduced = true
      setOpen(true)
    }
  }, [scan?.kind, scan?.assignmentId])

  // Off the scan screens this says one thing and gets out of the way. It sits
  // at the bottom because every screen in the app puts something it needs at
  // the top, and a banner that covers a heading is worse than no banner.
  if (!scan) {
    return (
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-2">
        <span className="rounded-full bg-ink-900/80 px-3 py-1 text-[10px] font-semibold
                         uppercase tracking-wide text-white/90 shadow">
          Demonstration · sample data
        </span>
      </div>
    )
  }

  // In flow rather than overlaid: on the scan screen the app puts the expected
  // value and the camera at the top, and a floating panel covered both.
  return (
    <div className="sticky top-0 z-50 bg-ink-950 px-2 py-2">
      <div className="mx-auto max-w-md rounded-card bg-ink-900 p-3 text-white shadow-lg">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <span className="text-[11px] font-semibold uppercase tracking-wide text-brand-500">
            Demo · what is in front of the camera
          </span>
          <span aria-hidden="true" className="text-white/70">{open ? '▲' : '▼'}</span>
        </button>

        {open && (
          <div className="mt-2 space-y-1.5">
            {choices.map((c) => (
              <button
                key={c.key}
                onClick={() => { setPicked(c.key); setDemoLabel(c.make()) }}
                className={`flex w-full flex-col rounded-lg px-3 py-2 text-left
                  ${picked === c.key ? 'bg-brand-500 text-ink-900' : 'bg-white/10 text-white'}`}
              >
                <span className="text-sm font-semibold">{c.label}</span>
                <span className="code text-[11px] opacity-80">{c.value}</span>
              </button>
            ))}
            <p className="pt-1 text-[11px] leading-snug text-white/60">
              The camera is a canvas — everything after it is the real app. Nothing here
              tells it what the manifest expects.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
