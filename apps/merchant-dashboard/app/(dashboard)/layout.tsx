import { Sidebar } from "@/components/shell/sidebar"
import { TopBar } from "@/components/shell/top-bar"
import { BottomNav } from "@/components/shell/bottom-nav"
import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { prisma } from "@via-saas/database"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const cookieStore = cookies()
  const sessionToken = cookieStore.get("session_token")?.value

  if (!sessionToken) {
    redirect("/login")
  }

  // Fetch the session and user from the database
  const session = await prisma.session.findUnique({
    where: { token: sessionToken },
    include: {
      user: {
        include: {
          memberships: true, // Get their organization & role
        }
      }
    }
  })

  // If session doesn't exist or is expired
  if (!session || session.expiresAt < new Date()) {
    // Clear invalid cookie and redirect
    cookieStore.delete("session_token")
    redirect("/login")
  }

  const user = session.user
  const role = (user.memberships[0]?.role || "STAFF") as "OWNER" | "MANAGER" | "STAFF"

  return (
    <div className="min-h-screen bg-slate-50">
      <Sidebar role={role as any} />
      <div className="md:pl-64 flex flex-col min-h-screen pb-16 md:pb-0">
        {/* Pass real data to the Top Bar */}
        <TopBar userName={user.name} role={role} />
        <main className="flex-1 p-4 md:p-8">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  )
}
