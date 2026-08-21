import type { ReactNode } from 'react'

/**
 * Wide tables scroll inside their own container. The page body must never
 * scroll sideways — on a tablet that makes every column feel broken.
 */
export function Table({
  headers, children, caption,
}: { headers: string[]; children: ReactNode; caption?: string }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line/20 bg-white">
      <table className="w-full min-w-[40rem] border-collapse text-left text-sm">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr className="border-b border-line/20 bg-paper">
            {headers.map((h) => (
              <th key={h} scope="col" className="px-4 py-3 text-xs font-bold uppercase
                                                 tracking-wider text-ink-600">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/15">{children}</tbody>
      </table>
    </div>
  )
}

export function Td({
  children, className = '',
}: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-top ${className}`}>{children}</td>
}
