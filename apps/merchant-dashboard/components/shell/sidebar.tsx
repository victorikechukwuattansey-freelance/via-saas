import Link from "next/link"
import { Home, ShoppingCart, Package, Users, Settings, BarChart, List, History, ClipboardList } from "lucide-react"
import { cn } from "@via-saas/ui"



interface SidebarProps {
  role: "OWNER" | "MANAGER" | "STAFF"
}

export function Sidebar({ role }: SidebarProps) {
  const navItems = [
    { name: "Dashboard", href: "/", icon: Home, roles: ["OWNER", "MANAGER", "STAFF"] },
    { name: "Orders (POS)", href: "/orders", icon: ShoppingCart, roles: ["OWNER", "MANAGER", "STAFF"] },
    // 2. Add the Order History link
    { name: "Order History", href: "/orders/list", icon: List, roles: ["OWNER", "MANAGER", "STAFF"] },
    { name: "Products", href: "/products", icon: Package, roles: ["OWNER", "MANAGER", "STAFF"] },
    // P1-D (P1-20): inventory movement history. Visibility per role is
    // enforced server-side (STAFF sees only accessibleLocationIds).
    { name: "Inventory History", href: "/inventory", icon: History, roles: ["OWNER", "MANAGER", "STAFF"] },
    // P1-D (P1-22): stock counts. OWNER/MANAGER only (PD-D2) — the server
    // re-checks the role on every page and action; this hides the entry only.
    { name: "Stock Counts", href: "/stock-counts", icon: ClipboardList, roles: ["OWNER", "MANAGER"] },
    { name: "Customers", href: "/customers", icon: Users, roles: ["OWNER", "MANAGER"] },
    { name: "Analytics", href: "/analytics", icon: BarChart, roles: ["OWNER"] },
    { name: "Settings", href: "/settings", icon: Settings, roles: ["OWNER"] },
  ]

  return (
    <aside className="hidden md:flex flex-col w-64 bg-slate-900 text-white h-screen fixed left-0 top-0">
      <div className="p-6">
        <h1 className="text-2xl font-bold tracking-tight">VIA</h1>
      </div>
      <nav className="flex-1 px-4 space-y-2">
        {navItems
          .filter((item) => item.roles.includes(role))
          .map((item) => (
            <Link
              key={item.name}
              href={item.href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium hover:bg-slate-800 transition-colors",
                "text-slate-300 hover:text-white"
              )}
            >
              <item.icon className="h-5 w-5" />
              {item.name}
            </Link>
          ))}
      </nav>
    </aside>
  )
}
