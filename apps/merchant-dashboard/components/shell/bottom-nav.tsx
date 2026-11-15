import Link from "next/link"
import { Home, ShoppingCart, Package, Users, Menu } from "lucide-react"

export function BottomNav() {
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 bg-white border-t border-slate-200 flex justify-around p-2 z-50">
      <Link href="/" className="flex flex-col items-center p-2 text-slate-600 hover:text-blue-600">
        <Home className="h-6 w-6" />
        <span className="text-[10px] mt-1 font-medium">Home</span>
      </Link>
      <Link href="/orders" className="flex flex-col items-center p-2 text-slate-600 hover:text-blue-600">
        <ShoppingCart className="h-6 w-6" />
        <span className="text-[10px] mt-1 font-medium">POS</span>
      </Link>
      <Link href="/products" className="flex flex-col items-center p-2 text-slate-600 hover:text-blue-600">
        <Package className="h-6 w-6" />
        <span className="text-[10px] mt-1 font-medium">Products</span>
      </Link>
      <button className="flex flex-col items-center p-2 text-slate-600 hover:text-blue-600">
        <Menu className="h-6 w-6" />
        <span className="text-[10px] mt-1 font-medium">More</span>
      </button>
    </nav>
  )
}
