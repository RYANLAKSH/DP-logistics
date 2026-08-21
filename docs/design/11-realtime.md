# 11 — Realtime Dashboard Strategy

## 1. What has to be live, and what does not

Realtime is a cost — connections, RLS evaluation per change, reconnect complexity. Spend it
where a delay changes a decision.

| Surface | Live? | Why |
|---|---|---|
| Supervisor exception queue | **Yes, immediately** | A supervisor must reach a blocked driver while the truck is still at the ramp |
| Supervisor board counters | **Yes** | Ambient awareness of shift progress |
| Activity feed | **Yes** | The narrative of the shift; also how a supervisor spots an unusual pattern |
| Device approval requests | **Yes** | A driver is standing still until it is approved |
| Driver's own task list | **No** — poll on focus + every 5 min | Tasks are assigned, not competed for. A realtime socket on 40 phones with poor signal costs more than it returns |
| Admin manifest screens | **No** | Nothing changes under an admin mid-edit that they need to see instantly |
| Audit screens | **No** | Historical by definition |

The driver decision is deliberate and worth defending: an always-on WebSocket on a phone
that keeps losing signal produces a reconnect storm, drains battery, and delivers nothing
the app cannot get by refreshing when the driver returns to the task list. Drivers get
polling; supervisors get sockets.

## 2. Subscription model

```ts
// Supervisor board — one channel per yard the supervisor is assigned to.
supabase
  .channel(`yard:${yardId}`)
  .on('postgres_changes',
      { event: '*', schema: 'public', table: 'movement_events', filter: `yard_id=eq.${yardId}` },
      onMovementChange)
  .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'exceptions', filter: `yard_id=eq.${yardId}` },
      onException)
  .subscribe()
```

Three rules that keep this correct:

1. **Always filter server-side** (`filter:` in the subscription). An unfiltered subscription
   sends every org's changes to every listening client for RLS to reject, which is both a
   performance problem and one misconfigured policy away from a data leak.
2. **Realtime respects RLS only if it is enabled for the table** in the publication *and*
   the policies actually restrict `select`. Test this explicitly: subscribe as a supervisor
   from yard A and assert that a movement in yard B never arrives. This is a pgTAP-adjacent
   integration test, not something to assume.
3. **The payload is a trigger, not the truth.** A `postgres_changes` payload carries the raw
   row — not the joined, permission-filtered shape the UI needs, and it can arrive out of
   order. Use it to invalidate a TanStack Query key and let the refetch produce the
   authoritative view.

```ts
onMovementChange = (payload) => {
  queryClient.invalidateQueries({ queryKey: ['board', yardId] })
  if (payload.new?.status === 'blocked') notifySupervisor(payload.new)   // the exception
}
```

That pattern — *event invalidates, query fetches* — avoids an entire class of bug where a
client-side reducer applied to out-of-order events drifts from the database and nobody
notices until a supervisor acts on a number that is wrong.

## 3. The board

```
┌────────────────────────────────────────────────────────────────────────┐
│  NHAVA SHEVA · 21 Aug · Manifest v2            ● live      [filters ▾] │
├──────────────┬──────────────┬──────────────┬───────────────────────────┤
│ VEHICLES     │ CONTAINERS   │ EXCEPTIONS   │ DRIVERS                   │
│  14 / 32     │   5 / 16     │  2 open      │  6 active                 │
│  ▓▓▓▓░░░░░   │  ▓▓▓░░░░░░   │  1 critical  │  1 awaiting device approval│
├──────────────┴──────────────┴──────────────┴───────────────────────────┤
│  CONTAINERS                                                            │
│  MSKU4512345  ●●   complete    09:14, 09:31   R. Kumar                 │
│  TGHU7781234  ●○   1 of 2      09:44          S. Patel                 │
│  CAIU2298761  ○○   pending                                             │
├────────────────────────────────────────────────────────────────────────┤
│  ACTIVITY                                                              │
│  09:44  S. Patel   verified  MAT4482…  →  TGHU7781234                  │
│  09:41  R. Kumar   BLOCKED   wrong vehicle  MSKU4512345      [open]    │
│  09:31  R. Kumar   verified  MAT4483…  →  MSKU4512345                  │
└────────────────────────────────────────────────────────────────────────┘
```

The container strip is the most valuable widget on the screen. `●○` — one of two vehicles
loaded — is the visual that catches the error nobody else catches: a container that is about
to be sealed half-loaded. Every individual scan passed; only the aggregate reveals it.

Filters, per the build plan: date, driver, container, status, exception status. Filters
apply to the query, not to the realtime subscription — the subscription stays yard-scoped
and the filter narrows what is displayed, so changing a filter never requires tearing down
and rebuilding a channel.

## 4. Connection handling

A supervisor's laptop sleeps, their Wi-Fi drops, the tab is backgrounded for an hour. All of
these produce a socket that looks connected and is not.

- **Show connection state honestly.** `● live` / `◌ reconnecting` / `✕ disconnected — showing
  data from 09:41`. A dashboard that silently goes stale is worse than one that says so.
- **Refetch everything on reconnect.** Changes during the gap were not queued for you. Treat
  a reconnect as a cold start.
- **Refetch on tab focus** regardless of socket state.
- **Heartbeat**, and force a reconnect if no message and no heartbeat for 30 seconds.
- **Fall back to polling** after repeated socket failures — every 15 seconds, with the UI
  showing degraded mode. A corporate proxy that blocks WebSockets should degrade the
  dashboard, not disable it.

## 5. Web push, for when the tab is not open

Realtime only reaches an open tab. A supervisor walking the yard needs a blocked movement to
reach them anyway.

```
exception INSERT → database webhook → notify Edge Function
                                        ├─ Web Push to supervisor's subscribed devices
                                        └─ email fallback
```

Only high-priority events push: `movement.blocked`, `override.requested`,
`manifest.conflict`, `device.pending_approval`. Pushing routine verifications trains people
to swipe notifications away, which disables the channel for the ones that matter.

iOS Safari supports web push from 16.4, and only for an installed PWA. Supervisors on older
iOS get email; state this in the rollout notes rather than discovering it at go-live.

## 6. Scale

At pilot scale — a few yards, tens of drivers, hundreds of movements a day —
`postgres_changes` is comfortable and needs no special handling.

It becomes a problem at roughly a hundred concurrent dashboard clients or a high write rate,
because every change is evaluated against every subscriber's RLS context. The migration
path, when needed:

1. Move from `postgres_changes` to **Broadcast from the database** — a trigger sends a
   small, purpose-shaped payload to a topic, and RLS is evaluated once at subscribe time
   rather than per change per subscriber.
2. Send a minimal payload (id + event type), never the row. The client fetches.
3. Consider a `board_snapshot` materialized view refreshed on a short interval for the
   counters, with realtime carrying only the feed.

Design for step 1 from the start by keeping the *event invalidates, query fetches* pattern —
switching transport then changes one file, because nothing in the UI ever depended on the
payload's shape.
