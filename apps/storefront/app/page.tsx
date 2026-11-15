"use client"

import { useState, useEffect } from "react"
import { Button } from "@via-saas/ui"
import { ShoppingCart, X } from "lucide-react"

type Product = {
  id: string
  name: string
  variants: { id: string; sellingPrice: string; inventory: { quantity: number }[] }[]
}

export default function StorefrontPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<{ variantId: string; name: string; price: number; quantity: number }[]>([])
  const [isCartOpen, setIsCartOpen] = useState(false)
  const [isCheckingOut, setIsCheckingOut] = useState(false)
  const [orderComplete, setOrderComplete] = useState<string | null>(null)
  
  const [customer, setCustomer] = useState({ name: "", phone: "", email: "" })
  const [cartToken, setCartToken] = useState<string | null>(null)

  // 1. Fetch products and initialize cart token
  useEffect(() => {
    fetch("http://localhost:4000/api/products")
      .then(res => res.json())
      .then(data => setProducts(data))
      
    const existingToken = localStorage.getItem("cart_token")
    if (existingToken) {
      setCartToken(existingToken)
    } else {
      fetch("http://localhost:4000/api/cart", { method: "POST" })
        .then(res => res.json())
        .then(data => {
          localStorage.setItem("cart_token", data.cartToken)
          setCartToken(data.cartToken)
        })
    }
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
    setIsCartOpen(true)
  }

  const handleCheckout = async () => {
    if (!cartToken || !customer.name || !customer.phone) {
      return alert("Please fill in your name and phone number.")
    }

    setIsCheckingOut(true)
    
    const res = await fetch("http://localhost:4000/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        items: cart.map(c => ({ variantId: c.variantId, quantity: c.quantity, price: c.price })),
        customer,
        paymentMethod: "TRANSFER", // Simulate online payment
        cartToken
      })
    })

    const data = await res.json()
    setIsCheckingOut(false)

    if (data.success) {
      setOrderComplete(data.orderNumber)
      setCart([])
      localStorage.removeItem("cart_token")
    } else {
      alert(data.error)
    }
  }

  const total = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0)

  if (orderComplete) {
    return (
      <div className="max-w-lg mx-auto mt-20 p-8 bg-white border border-slate-200 rounded-xl text-center shadow-sm">
        <div className="w-16 h-16 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-4">
          <ShoppingCart className="w-8 h-8" />
        </div>
        <h1 className="text-2xl font-bold text-slate-900 mb-2">Order Confirmed!</h1>
        <p className="text-slate-500 mb-6">Your order number is <strong>{orderComplete}</strong>. You will receive payment instructions shortly.</p>
        <Button onClick={() => window.location.reload()}>Continue Shopping</Button>
      </div>
    )
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-12">
      <div className="flex justify-between items-center mb-8">
        <h2 className="text-3xl font-bold">Shop Our Collection</h2>
        <button onClick={() => setIsCartOpen(true)} className="relative p-2 bg-slate-100 rounded-full hover:bg-slate-200">
          <ShoppingCart className="w-6 h-6" />
          {cart.length > 0 && (
            <span className="absolute top-0 right-0 bg-red-500 text-white text-xs w-5 h-5 rounded-full flex items-center justify-center">
              {cart.reduce((sum, item) => sum + item.quantity, 0)}
            </span>
          )}
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-8">
        {products.map((product) => {
          const variant = product.variants[0]
          const stock = variant.inventory[0]?.quantity || 0
          
          return (
            <div key={product.id} className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-sm hover:shadow-md transition-shadow">
              <div className="h-48 bg-slate-100 flex items-center justify-center">
                <span className="text-slate-400 text-sm">No Image</span>
              </div>
              <div className="p-6">
                <h3 className="font-semibold text-lg text-slate-900">{product.name}</h3>
                <p className="text-slate-500 text-sm mt-1 mb-4">{stock > 0 ? "In Stock" : "Out of Stock"}</p>
                <div className="flex items-center justify-between">
                  <span className="text-xl font-bold text-slate-900">₦{Number(variant.sellingPrice).toLocaleString()}</span>
                  <Button disabled={stock <= 0} size="sm" onClick={() => addToCart(product)}>Add</Button>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Cart Drawer / Modal */}
      {isCartOpen && (
        <div className="fixed inset-0 bg-black/50 flex justify-end z-50">
          <div className="w-full max-w-md bg-white h-full p-6 flex flex-col shadow-xl">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold">Your Cart</h2>
              <button onClick={() => setIsCartOpen(false)}><X className="w-6 h-6 text-slate-500" /></button>
            </div>

            <div className="flex-1 overflow-y-auto space-y-4">
              {cart.length === 0 ? <p className="text-slate-500 text-center mt-10">Cart is empty</p> : cart.map(item => (
                <div key={item.variantId} className="flex justify-between items-center border-b pb-2">
                  <div>
                    <p className="font-medium">{item.name}</p>
                    <p className="text-sm text-slate-500">Qty: {item.quantity}</p>
                  </div>
                  <p className="font-semibold">₦{(item.price * item.quantity).toLocaleString()}</p>
                </div>
              ))}
            </div>

            {cart.length > 0 && (
              <div className="pt-4 border-t border-slate-200 space-y-4 mt-4">
                <div className="space-y-2">
                  <input placeholder="Full Name" className="w-full px-3 py-2 border rounded" value={customer.name} onChange={e => setCustomer({...customer, name: e.target.value})} />
                  <input placeholder="Phone Number" className="w-full px-3 py-2 border rounded" value={customer.phone} onChange={e => setCustomer({...customer, phone: e.target.value})} />
                </div>
                <div className="flex justify-between items-center text-lg font-bold">
                  <span>Total</span>
                  <span>₦{total.toLocaleString()}</span>
                </div>
                <Button className="w-full" onClick={handleCheckout} disabled={isCheckingOut}>
                  {isCheckingOut ? "Processing..." : "Pay with Transfer"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
