import { MapPin, UserCircle, LogOut } from "lucide-react"
import { logout } from "@/app/actions/auth"

interface TopBarProps {
  userName: string
  role: string
}

export function TopBar({ userName, role }: TopBarProps) {
  return (
    <header className="h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 md:px-8 sticky top-0 z-40">
      <div className="flex items-center gap-4">
        {/* Location Switcher */}
        <button className="flex items-center gap-2 text-sm font-medium text-slate-700 bg-slate-100 px-3 py-1.5 rounded-md hover:bg-slate-200 transition-colors">
          <MapPin className="h-4 w-4 text-blue-600" />
          <span>Main Store - Lekki</span>
          <span className="text-xs text-slate-400">▼</span>
        </button>
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
