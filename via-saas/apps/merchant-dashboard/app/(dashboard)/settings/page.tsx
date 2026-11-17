import { getSessionContext } from "@/lib/auth-helpers"
import {
  listStaffMembers,
  listInvitations,
  listLocations,
} from "@via-saas/core"
import { redirect } from "next/navigation"
import { StaffInviteForm } from "./StaffInviteForm"
import {
  StaffTable,
  InvitationsList,
  LocationsPanel,
} from "./SettingsPanels"

export default async function SettingsPage() {
  const context = await getSessionContext()

  if (!context || context.role !== "OWNER") {
    redirect("/") // Staff cannot access settings
  }

  // OWNER-only views, resolved through the core gates (P1-14/P1-15/P1-16).
  const [staff, invitations, allLocations] = await Promise.all([
    listStaffMembers(context.orgId, context.userId),
    listInvitations(context.orgId, context.userId),
    listLocations(context.orgId, { includeArchived: true }),
  ])

  // Only ACTIVE locations can appear in access scopes (archived locations
  // are never grantable, P1-16).
  const activeLocations = allLocations
    .filter((loc) => !loc.archivedAt)
    .map((loc) => ({ id: loc.id, name: loc.name }))

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Staff & Permissions</h1>
        <p className="text-slate-500">Manage your team, locations and access levels.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Invite Form */}
        <StaffInviteForm locations={activeLocations} />

        {/* Staff List with edit/remove */}
        <StaffTable
          staff={staff}
          locations={activeLocations}
          currentUserId={context.userId}
        />

        {/* Invitations lifecycle */}
        <InvitationsList
          invitations={invitations.map((invite) => ({
            id: invite.id,
            name: invite.name,
            email: invite.email,
            role: invite.role,
            createdAt: invite.createdAt,
            expiresAt: invite.expiresAt,
            state: invite.state,
          }))}
        />

        {/* Location lifecycle (create / rename / archive / restore) */}
        <LocationsPanel
          locations={allLocations.map((loc) => ({
            id: loc.id,
            name: loc.name,
            archivedAt: loc.archivedAt,
          }))}
        />
      </div>
    </div>
  )
}
