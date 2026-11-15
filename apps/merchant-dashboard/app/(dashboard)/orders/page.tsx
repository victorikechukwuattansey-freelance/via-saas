"use client"

import { useState, useEffect } from "react"
import { Button } from "@via-saas/ui"
import { createOrder } from "./actions"
import { ShoppingCart, CheckCircle2, User} from "lucide-react"

// In a real app, you'd fetch this via an API call or pass it from a Server Component
type Product = {
  id: string
  name: string
  variants: { id: string; sellingPrice: string; inventory: { quantity: number }[] }[]
}

export default function POSPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<{ variantId: string; name: string; price: number; quantity: number }[]>([])
  const [customerName, setCustomerName] = useState("")
  const [customerPhone, setCustomerPhone] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [success, setSuccess] = useState(false)

  // Mock fetching products (in reality, fetch from a Server Component or API route)
  useEffect(() => {
    // We will simulate this for now
    fetch("/api/products")
      .then(res => res.json())
      .then(data => setProducts(data))
  }, [])

  const addToCart = (product: Product) => {
    const variant = product.variants[0]
    const stock = variant.inventory[0]?.quantity || 0
    if (stock <= 0) return alert("Out of stock!")

    setCart(prev => {
      const existing = prev.find(i => i.variantId === variant.id)
      if (existing) {
        return prev.map(i => i.variantId === variant.id ? { ...i, quantity: i.quantity + 1 } : i)
      }
      return [...prev, { variantId: variant.id, name: product.name, price: Number(variant.sellingPrice), quantity: 1 }]
    })
  }

  const handleCheckout = async (method: "CASH" | "TRANSFER") => {
    if (cart.length === 0) return

    // Require customer details for a real POS sale
    if (!customerName || !customerPhone) {
      return alert("Please enter a customer name and phone number.")
    }

    setIsProcessing(true)
    
    const res = await createOrder({
      items: cart.map(c => ({ variantId: c.variantId, quantity: c.quantity, price: c.price })),
      paymentMethod: method,
      customerName, // Pass these to the server action
      customerPhone
    })

    setIsProcessing(false)
    if (res.success) {
      setCart([])
      setSuccess(true)
      setTimeout(() => setSuccess(false), 3000)
    } else {
      alert(res.error)
    }
  }

  const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)

  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-6 h-[calc(100vh-8rem)]">
      {/* Products Grid */}
      <div className="md:col-span-2 space-y-4 overflow-y-auto pr-2">
        <h1 className="text-2xl font-bold">Point of Sale</h1>
        {products.length === 0 && <p className="text-slate-500">Loading products...</p>}
        <div className="grid grid-cols-2 gap-4">
          {products.map(p => (
            <button 
              key={p.id} 
              onClick={() => addToCart(p)}
              className="bg-white p-4 rounded-lg border border-slate-200 text-left hover:border-blue-500 transition-colors"
            >
              <h3 className="font-semibold">{p.name}</h3>
              <p className="text-blue-600 font-bold">₦{Number(p.variants[0].sellingPrice).toLocaleString()}</p>
              <p className="text-xs text-slate-500">{p.variants[0].inventory[0]?.quantity || 0} in stock</p>
            </button>
          ))}
        </div>
      </div>

      {/* Cart Sidebar */}
      <div className="bg-white border border-slate-200 rounded-lg p-6 flex flex-col h-full shadow-sm">
        <h2 className="text-lg font-bold flex items-center gap-2 mb-4">
          <ShoppingCart className="w-5 h-5" /> Current Order
        </h2>

        {/* Customer Input Form */}
        <div className="bg-slate-50 p-3 rounded-md mb-4 border border-slate-200 space-y-2">
          <p className="text-xs font-semibold text-slate-600 flex items-center gap-1"><User className="w-3 h-3"/> Customer Details</p>
          <input 
            placeholder="Customer Name" 
            className="w-full text-sm px-2 py-1.5 border rounded" 
            value={customerName} onChange={(e) => setCustomerName(e.target.value)} 
          />
          <input 
            placeholder="Phone Number" 
            className="w-full text-sm px-2 py-1.5 border rounded" 
            value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} 
          />
        </div>
        
        <div className="flex-1 overflow-y-auto space-y-3">
          {cart.length === 0 ? (
            <p className="text-slate-400 text-center mt-10">Cart is empty</p>
          ) : (
            cart.map(item => (
              <div key={item.variantId} className="flex justify-between items-center text-sm border-b pb-2">
                <div>
                  <p className="font-medium">{item.name}</p>
                  <p className="text-slate-500">Qty: {item.quantity}</p>
                </div>
                <p className="font-semibold">₦{(item.price * item.quantity).toLocaleString()}</p>
              </div>
            ))
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-slate-200 space-y-4">
          <div className="flex justify-between items-center text-lg font-bold">
            <span>Total</span>
            <span>₦{total.toLocaleString()}</span>
          </div>
          
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => handleCheckout("CASH")} disabled={isProcessing || cart.length === 0}>
              Cash
            </Button>
            <Button onClick={() => handleCheckout("TRANSFER")} variant="outline" disabled={isProcessing || cart.length === 0}>
              Transfer
            </Button>
          </div>
          
          {success && (
            <div className="bg-green-50 text-green-700 p-3 rounded-md flex items-center gap-2 text-sm">
              <CheckCircle2 className="w-4 h-4" /> Order completed successfully!
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
