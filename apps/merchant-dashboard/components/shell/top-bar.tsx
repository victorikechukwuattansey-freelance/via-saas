import { MapPin, UserCircle, LogOut } from "lucide-react"
import { logout } from "@/app/actions/auth"
import { OrgSwitcher } from "./org-switcher"

interface TopBarProps {
  userName: string
  role: string
  organizations: { organizationId: string; name: string }[]
  currentOrgId: string
}

export function TopBar({ userName, role, organizations, currentOrgId }: TopBarProps) {
  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-8 sticky top-0 z-40">
      <div className="flex items-center gap-4">
        {/* Organization switcher (P1-17): real eligible organizations; the
            former DR-2 fake location button is replaced. The active LOCATION
            is resolved server-side per request (§10.2) and is not a client
            selection surface. */}
        <OrgSwitcher organizations={organizations} currentOrgId={currentOrgId} />
        <span className="hidden sm:flex items-center gap-1.5 text-xs text-slate-400">
          <MapPin className="h-3.5 w-3.5" />
          location resolved per request
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-right hidden sm:block">
          <p className="text-sm font-medium text-slate-900">{userName}</p>
          <p className="text-xs text-slate-500 font-semibold tracking-wider">{role}</p>
        </div>
        
        {/* Logout Button */}
        <form action={logout}>
          <button 
            type="submit" 
            className="flex items-center gap-2 text-sm text-slate-500 hover:text-red-600 transition-colors p-2 rounded-md hover:bg-red-50"
            title="Log out"
          >
            <LogOut className="h-5 w-5" />
            <span className="hidden md:inline">Logout</span>
          </button>
        </form>
      </div>
    </header>
  )
}
