import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { redirect } from "next/navigation"
import { StaffInviteForm } from "./StaffInviteForm"

export default async function SettingsPage() {
  const context = await getSessionContext()
  
  if (!context || context.role !== "OWNER") {
    redirect("/") // Staff cannot access settings
  }

  // Fetch all staff in this organization
  const memberships = await prisma.membership.findMany({
    where: { organizationId: context.orgId },
    include: { user: true }
  })

  // Fetch locations for the dropdown
  const locations = await prisma.location.findMany({
    where: { store: { organizationId: context.orgId } }
  })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Staff & Permissions</h1>
        <p className="text-slate-500">Manage your team and control their access levels.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Invite Form */}
        <StaffInviteForm
          locations={locations.map((loc) => ({ id: loc.id, name: loc.name }))}
        />

        {/* Staff List */}
        <div className="md:col-span-2 bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50 border-b border-slate-200 text-slate-500 text-sm">
                <th className="p-4 font-medium">Name</th>
                <th className="p-4 font-medium">Role</th>
                <th className="p-4 font-medium">Location Scope</th>
              </tr>
            </thead>
            <tbody>
              {memberships.map((m) => (
                <tr key={m.id} className="border-b border-slate-100">
                  <td className="p-4">
                    <p className="font-medium text-slate-900">{m.user.name}</p>
                    <p className="text-sm text-slate-500">{m.user.email}</p>
                  </td>
                  <td className="p-4">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                      m.role === 'OWNER' ? 'bg-purple-100 text-purple-700' : 
                      m.role === 'MANAGER' ? 'bg-blue-100 text-blue-700' : 
                      'bg-slate-100 text-slate-700'
                    }`}>
                      {m.role}
                    </span>
                  </td>
                  <td className="p-4 text-sm text-slate-600">
                    {m.allowedLocationIds.length === 0 ? "All Locations" : "Restricted"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
