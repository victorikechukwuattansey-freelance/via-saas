"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { Button } from "@via-saas/ui"
import { createOrder } from "./actions"
import { findVariantByCode, type PosProduct, type PosVariant } from "@/lib/pos-search"
import { ShoppingCart, CheckCircle2, User, ScanLine } from "lucide-react"

// The POS feed carries every variant scalar, including sku and barcode
// (Prisma include). Types come from the shared search module.
type Product = PosProduct

export default function POSPage() {
  const [products, setProducts] = useState<Product[]>([])
  const [cart, setCart] = useState<{ variantId: string; name: string; price: number; quantity: number }[]>([])
  const [customerName, setCustomerName] = useState("")
  const [customerPhone, setCustomerPhone] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  // P1-B success state: keeps the created order reference so the merchant
  // can jump straight to the detail/receipt-record page.
  const [successOrder, setSuccessOrder] = useState<{ orderId: string; orderNumber: string } | null>(null)
  // B6: scan/search box state + user-visible lookup feedback.
  const [scanCode, setScanCode] = useState("")
  const [scanNotice, setScanNotice] = useState<string | null>(null)

  useEffect(() => {
    fetch("/api/products")
      .then(res => res.json())
      .then(data => setProducts(data))
  }, [])

  const addToCart = (product: Product, variant: PosVariant) => {
    const stock = variant.inventory[0]?.quantity || 0
    if (stock <= 0) return alert("Out of stock!")

    const displayName = product.variants.length > 1 ? `${product.name} — ${variant.name}` : product.name

    setCart(prev => {
      const existing = prev.find(i => i.variantId === variant.id)
      if (existing) {
        return prev.map(i => i.variantId === variant.id ? { ...i, quantity: i.quantity + 1 } : i)
      }
      return [...prev, { variantId: variant.id, name: displayName, price: Number(variant.sellingPrice), quantity: 1 }]
    })
  }

  // B6 (P1-11): exact, case-insensitive SKU/barcode lookup. Multi-match
  // resolves deterministically and the explicit notice is surfaced.
  const handleScan = (event: React.FormEvent) => {
    event.preventDefault()
    setScanNotice(null)

    const result = findVariantByCode(products, scanCode)
    if (!result.found) {
      setScanNotice(`No product matches "${scanCode.trim()}".`)
      return
    }

    addToCart(result.product, result.variant)
    setScanNotice(result.notice ?? `Added ${result.product.name}${result.product.variants.length > 1 ? ` — ${result.variant.name}` : ""}.`)
    setScanCode("")
  }

  const handleCheckout = async (method: "CASH" | "TRANSFER") => {
    if (cart.length === 0) return

    // Require customer details for a real POS sale
    if (!customerName || !customerPhone) {
      return alert("Please enter a customer name and phone number.")
    }

    setIsProcessing(true)
    setSuccessOrder(null)

    // D-C: the POS ALWAYS supplies an idempotency key — a fresh UUID per
    // submission attempt. A retry of the SAME attempt reuses the same key
    // (server returns the original order); a NEW attempt gets a new key.
    // The key is a key only: it can never influence pricing, attribution,
    // or the audit source.
    const idempotencyKey = crypto.randomUUID()

    const res = await createOrder({
      items: cart.map(c => ({ variantId: c.variantId, quantity: c.quantity })),
      paymentMethod: method,
      customerName, // Pass these to the server action
      customerPhone,
      idempotencyKey
    })

    setIsProcessing(false)
    if (res.success && res.orderId && res.orderNumber) {
      setCart([])
      setSuccessOrder({ orderId: res.orderId, orderNumber: res.orderNumber })
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

        {/* B6: SKU / barcode scan box — exact match, adds straight to cart. */}
        <form onSubmit={handleScan} className="flex gap-2">
          <div className="relative flex-1">
            <ScanLine className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={scanCode}
              onChange={(e) => setScanCode(e.target.value)}
              placeholder="Scan or type SKU / barcode, then press Enter"
              className="w-full text-sm pl-9 pr-3 py-2 border border-slate-300 rounded-md"
            />
          </div>
          <button
            type="submit"
            className="border border-slate-300 rounded-md text-sm px-3 py-2 hover:bg-slate-50"
          >
            Add
          </button>
        </form>
        {scanNotice && (
          <p className={`text-xs ${scanNotice.startsWith("No product") ? "text-red-600" : scanNotice.startsWith("Warning:") ? "text-amber-600" : "text-green-700"}`}>
            {scanNotice}
          </p>
        )}

        {products.length === 0 && <p className="text-slate-500">Loading products...</p>}
        <div className="grid grid-cols-2 gap-4">
          {products.map(p => (
            p.variants.map(v => (
              <button
                key={v.id}
                onClick={() => addToCart(p, v)}
                className="bg-white p-4 rounded-lg border border-slate-200 text-left hover:border-blue-500 transition-colors"
              >
                <h3 className="font-semibold">
                  {p.name}
                  {p.variants.length > 1 && <span className="text-slate-500 font-normal text-sm"> · {v.name}</span>}
                </h3>
                <p className="text-blue-600 font-bold">₦{Number(v.sellingPrice).toLocaleString()}</p>
                <p className="text-xs text-slate-500">{v.inventory[0]?.quantity || 0} in stock</p>
              </button>
            ))
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

          {/* P1-B success state: persistent (not auto-dismissed) with a link
              to the order detail / receipt-record page. */}
          {successOrder && (
            <div className="bg-green-50 text-green-700 p-3 rounded-md text-sm space-y-2">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" /> Order {successOrder.orderNumber} completed!
              </div>
              <Link
                href={`/orders/${successOrder.orderId}`}
                className="font-medium underline hover:no-underline"
              >
                View order & receipt →
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
