import { useQuery } from '@tanstack/react-query'
import { ManagerShell } from '@/components/Layout'
import { Spinner } from '@/components/States'
import { Table, Td } from '@/components/Table'
import { useData } from '@/data/provider'

export function UsersPage() {
  const data = useData()
  const { data: users, isLoading } = useQuery({
    queryKey: ['users'],
    queryFn: () => data.listUsers(),
  })

  return (
    <ManagerShell title="Users" subtitle="Roles and yard assignments">
      {isLoading && <Spinner />}

      {users && (
        <div className="space-y-4">
          <p className="max-w-2xl text-sm text-ink-600">
            There is no self-registration. An administrator creates an account and assigns
            its role and yards; the role a user carries is what every database policy reads,
            so changing it here changes what they can see everywhere.
          </p>

          <Table headers={['Name', 'Employee no', 'Role', 'Yards']}>
            {users.map((u) => (
              <tr key={u.id}>
                <Td className="font-medium">{u.fullName}</Td>
                <Td className="code text-ink-600">{u.employeeNo ?? '—'}</Td>
                <Td>
                  <span className="rounded-full bg-idle-100 px-2.5 py-1 text-xs font-bold
                                   uppercase tracking-wide text-ink-700">
                    {u.role}
                  </span>
                </Td>
                <Td className="text-ink-600">{u.yardIds.length} assigned</Td>
              </tr>
            ))}
          </Table>
        </div>
      )}
    </ManagerShell>
  )
}
