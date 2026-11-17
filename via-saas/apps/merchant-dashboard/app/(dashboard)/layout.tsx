import { Sidebar } from "@/components/shell/sidebar"
import { TopBar } from "@/components/shell/top-bar"
import { BottomNav } from "@/components/shell/bottom-nav"
import { getSessionContext, listEligibleOrganizations } from "@/lib/auth-helpers"
import { redirect } from "next/navigation"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Single session-resolution path: expiry and membership checks are
  // centralized in getSessionContext (E-8).
  const context = await getSessionContext()

  if (!context) {
    redirect("/login")
  }

  const role = context.role as "OWNER" | "MANAGER" | "STAFF"
  // P1-17: eligible organizations for the switcher (deterministic §10.2
  // order; eligibility = ≥1 accessible ACTIVE location).
  const organizations = await listEligibleOrganizations(context.userId)

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar role={role} />
      <div className="md:pl-64 flex flex-col min-h-screen pb-16 md:pb-0">
        {/* Pass real data to the Top Bar */}
        <TopBar
          userName={context.user.name}
          role={role}
          organizations={organizations}
          currentOrgId={context.orgId}
        />
        <main className="flex-1 p-4 md:p-8">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
