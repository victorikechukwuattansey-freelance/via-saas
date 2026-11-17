"use client"

// P1-C settings panels — client wrappers around the OWNER-only server
// actions in ./actions. Errors/successes surface via useFormState; all
// authorization is enforced server-side (UI is convenience only).

import { useFormState, useFormStatus } from "react-dom"
import { Button } from "@via-saas/ui"
import {
  updateStaff,
  removeStaff,
  rescindInvite,
  addLocation,
  renameLocationAction,
  archiveLocationAction,
} from "./actions"

type ActionState = { error?: string; success?: string } | null

function Feedback({ state }: { state: ActionState }) {
  if (!state) return null
  if (state.error)
    return <div className="bg-red-50 text-red-600 p-2 rounded-md text-xs mb-2">{state.error}</div>
  if (state.success)
    return <div className="bg-green-50 text-green-700 p-2 rounded-md text-xs mb-2">{state.success}</div>
  return null
}

function SubmitButton({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus()
  return (
    <Button
      type="submit"
      size="sm"
      variant={danger ? "outline" : "default"}
      disabled={pending}
      className={danger ? "border-red-200 text-red-600 hover:bg-red-50" : ""}
    >
      {pending ? "..." : label}
    </Button>
  )
}

// ---------- Staff ----------

export type StaffRowData = {
  membershipId: string
  userId: string
  name: string
  email: string
  role: string
  allowedLocationIds: string[]
}

function StaffRow({
  member,
  locations,
  isSelf,
}: {
  member: StaffRowData
  locations: { id: string; name: string }[]
  isSelf: boolean
}) {
  const [updateState, updateAction] = useFormState(updateStaff, null)
  const [removeState, removeAction] = useFormState(removeStaff, null)
  const currentScope =
    member.allowedLocationIds.length === 0
      ? "ALL"
      : (member.allowedLocationIds[0] ?? "ALL")

  return (
    <tr className="border-b border-slate-100 align-top">
      <td className="p-4">
        <p className="font-medium text-slate-900">{member.name}</p>
        <p className="text-sm text-slate-500">{member.email}</p>
      </td>
      <td className="p-4">
        <span
          className={`px-2 py-1 rounded-full text-xs font-medium ${
            member.role === "OWNER"
              ? "bg-purple-100 text-purple-700"
              : member.role === "MANAGER"
                ? "bg-blue-100 text-blue-700"
                : "bg-slate-100 text-slate-700"
          }`}
        >
          {member.role}
        </span>
      </td>
      <td className="p-4 text-sm text-slate-600">
        {member.allowedLocationIds.length === 0
          ? "All Locations"
          : (locations.find((l) => l.id === member.allowedLocationIds[0])?.name ?? "Restricted")}
      </td>
      <td className="p-4">
        {isSelf ? (
          <p className="text-xs text-slate-400">Your own record cannot be modified.</p>
        ) : (
          <div className="space-y-2">
            <Feedback state={updateState} />
            <form action={updateAction} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="membershipId" value={member.membershipId} />
              <select
                name="role"
                defaultValue={member.role}
                className="border rounded-md px-2 py-1 text-xs"
                aria-label={`Role for ${member.name}`}
              >
                <option value="OWNER">OWNER</option>
                <option value="MANAGER">MANAGER</option>
                <option value="STAFF">STAFF</option>
              </select>
              <select
                name="locationId"
                defaultValue={currentScope}
                className="border rounded-md px-2 py-1 text-xs"
                aria-label={`Location scope for ${member.name}`}
              >
                <option value="ALL">All Locations</option>
                {locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
              <SubmitButton label="Save" />
            </form>
            <form action={removeAction}>
              <Feedback state={removeState} />
              <input type="hidden" name="membershipId" value={member.membershipId} />
              <SubmitButton label="Remove" danger />
            </form>
          </div>
        )}
      </td>
    </tr>
  )
}

export function StaffTable({
  staff,
  locations,
  currentUserId,
}: {
  staff: StaffRowData[]
  locations: { id: string; name: string }[]
  currentUserId: string
}) {
  return (
    <div className="md:col-span-2 bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <table className="w-full text-left border-collapse">
        <thead>
          <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
            <th className="p-4 font-medium">Name</th>
            <th className="p-4 font-medium">Role</th>
            <th className="p-4 font-medium">Location Scope</th>
            <th className="p-4 font-medium">Manage</th>
          </tr>
        </thead>
        <tbody>
          {staff.map((member) => (
            <StaffRow
              key={member.membershipId}
              member={member}
              locations={locations}
              isSelf={member.userId === currentUserId}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

// ---------- Invitations ----------

export type InvitationRowData = {
  id: string
  name: string
  email: string
  role: string
  createdAt: Date
  expiresAt: Date
  state: "PENDING" | "ACCEPTED" | "EXPIRED" | "REVOKED"
}

const STATE_STYLES: Record<InvitationRowData["state"], string> = {
  PENDING: "bg-amber-100 text-amber-700",
  ACCEPTED: "bg-green-100 text-green-700",
  EXPIRED: "bg-slate-100 text-slate-500",
  REVOKED: "bg-red-100 text-red-600",
}

export function InvitationsList({ invitations }: { invitations: InvitationRowData[] }) {
  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm md:col-span-3 overflow-hidden">
      <div className="p-4 border-b border-slate-200">
        <h2 className="text-lg font-semibold">Invitations</h2>
        <p className="text-sm text-slate-500">Recent staff invitations and their status.</p>
      </div>
      {invitations.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">No invitations yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {invitations.map((invite) => (
            <li key={invite.id} className="p-4 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-slate-900">
                  {invite.name} <span className="text-slate-400">·</span> {invite.email}
                </p>
                <p className="text-xs text-slate-500">
                  {invite.role} · sent {new Date(invite.createdAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span
                  className={`px-2 py-1 rounded-full text-xs font-medium ${STATE_STYLES[invite.state]}`}
                >
                  {invite.state}
                </span>
                {invite.state === "PENDING" && <RescindButton inviteId={invite.id} />}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function RescindButton({ inviteId }: { inviteId: string }) {
  const [state, action] = useFormState(rescindInvite, null)
  return (
    <form action={action} className="flex items-center gap-2">
      <Feedback state={state} />
      <input type="hidden" name="inviteId" value={inviteId} />
      <SubmitButton label="Rescind" danger />
    </form>
  )
}

// ---------- Locations ----------

export type LocationRowData = {
  id: string
  name: string
  archivedAt: Date | null
}

export function LocationsPanel({
  locations,
}: {
  locations: LocationRowData[]
}) {
  const [addState, addAction] = useFormState(addLocation, null)
  const activeCount = locations.filter((l) => !l.archivedAt).length

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm md:col-span-3 p-6">
      <h2 className="text-lg font-semibold mb-1">Locations</h2>
      <p className="text-sm text-slate-500 mb-4">
        Stores and sale points for this business. The last active location cannot be archived.
      </p>

      <Feedback state={addState} />
      <form action={addAction} className="flex items-center gap-2 mb-4">
        <input
          name="name"
          type="text"
          placeholder="New location name"
          required
          className="flex-1 px-3 py-2 border rounded-md text-sm"
        />
        <SubmitButton label="Add location" />
      </form>

      <ul className="divide-y divide-slate-100">
        {locations.map((loc) => (
          <LocationRow key={loc.id} location={loc} canArchive={activeCount > 1 || !!loc.archivedAt} />
        ))}
      </ul>
    </div>
  )
}

function LocationRow({
  location,
  canArchive,
}: {
  location: LocationRowData
  canArchive: boolean
}) {
  const [renameState, renameAction] = useFormState(renameLocationAction, null)
  const [archiveState, archiveAction] = useFormState(archiveLocationAction, null)

  return (
    <li className="py-3 flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-sm font-medium text-slate-900">{location.name}</p>
        <p className="text-xs text-slate-500">
          {location.archivedAt
            ? `Archived ${new Date(location.archivedAt).toLocaleDateString()}`
            : "Active"}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Feedback state={renameState} />
        <Feedback state={archiveState} />
        <form action={renameAction} className="flex items-center gap-2">
          <input type="hidden" name="locationId" value={location.id} />
          <input
            name="name"
            type="text"
            defaultValue={location.name}
            className="border rounded-md px-2 py-1 text-xs w-36"
            aria-label={`New name for ${location.name}`}
            required
          />
          <SubmitButton label="Rename" />
        </form>
        <form action={archiveAction}>
          <input type="hidden" name="locationId" value={location.id} />
          <input type="hidden" name="restore" value={location.archivedAt ? "true" : "false"} />
          {location.archivedAt ? (
            <SubmitButton label="Restore" />
          ) : (
            <button
              type="submit"
              disabled={!canArchive}
              title={canArchive ? undefined : "The last active location cannot be archived."}
              className="text-sm border border-red-200 text-red-600 hover:bg-red-50 rounded-md px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Archive
            </button>
          )}
        </form>
      </div>
    </li>
  )
}
