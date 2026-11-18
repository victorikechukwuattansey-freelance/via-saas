"use client"

import { useState } from "react"
import { Button } from "@via-saas/ui"
import { archiveProduct, restoreProduct, updateProduct, deleteProduct, addVariant, updateVariant, addProductImage, deleteProductImage } from "./actions"
import { AdjustStockForm } from "./AdjustStockForm"

export type VariantView = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  sellingPrice: number
  costPrice: number
  stock: number
  // P1-D (P1-21): nullable low-stock threshold + read-time low-stock flag
  // (computed server-side at the actor's accessible locations).
  lowStockThreshold: number | null
  lowStock: boolean
}

export type ImageView = {
  id: string
  url: string
  isPrimary: boolean
}

export type ProductView = {
  id: string
  name: string
  description: string | null
  status: string
  archived: boolean
  categoryId: string | null
  categoryName: string | null
  variants: VariantView[]
  images: ImageView[]
}

type CategoryOption = { id: string; name: string }

const inputClass = "w-full px-3 py-2 border rounded-md mt-1 text-sm"
const labelClass = "text-sm font-medium"

function InlineActionForm({
  action,
  submitLabel,
  children,
}: {
  action: (formData: FormData) => Promise<{ success?: boolean; error?: string }>
  submitLabel: string
  children: React.ReactNode
}) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    const res = await action(new FormData(e.currentTarget))
    setIsLoading(false)
    if (res.error) setError(res.error)
  }

  return (
    <form onSubmit={handleSubmit} className="p-3 bg-slate-50 border border-slate-200 rounded-md space-y-2 text-left">
      {children}
      {error && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button type="submit" size="sm" disabled={isLoading}>
          {isLoading ? "Saving..." : submitLabel}
        </Button>
      </div>
    </form>
  )
}

function ToggleButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-xs text-blue-600 hover:underline font-medium">
      {label}
    </button>
  )
}

export function ProductCard({
  product,
  categories,
}: {
  product: ProductView
  categories: CategoryOption[]
}) {
  const [showEdit, setShowEdit] = useState(false)
  const [showAddVariant, setShowAddVariant] = useState(false)
  const [showAddImage, setShowAddImage] = useState(false)
  const [editingVariantId, setEditingVariantId] = useState<string | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [banner, setBanner] = useState<string | null>(null)
  const [imageError, setImageError] = useState<string | null>(null)

  const runLifecycle = async (action: (formData: FormData) => Promise<{ success?: boolean; error?: string }>, productId: string, confirmText: string) => {
    if (!confirm(confirmText)) return
    setIsBusy(true)
    setBanner(null)
    const formData = new FormData()
    formData.set("productId", productId)
    const res = await action(formData)
    setIsBusy(false)
    if (res.error) setBanner(res.error)
  }

  return (
    <div className={`bg-white p-4 rounded-lg border shadow-sm flex flex-col gap-3 ${product.archived ? "border-amber-300 bg-amber-50/40" : "border-slate-200"}`}>
      <div className="flex justify-between items-start">
        <div>
          <h3 className="font-semibold text-slate-900">
            {product.name}
            {product.archived && (
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700 align-middle">Archived</span>
            )}
            {!product.archived && product.status === "DRAFT" && (
              <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 align-middle">Draft</span>
            )}
          </h3>
          {product.categoryName && <p className="text-xs text-slate-500 mt-0.5">Category: {product.categoryName}</p>}
          {product.description && <p className="text-xs text-slate-500 mt-0.5">{product.description}</p>}
        </div>
        <div className="flex gap-2 shrink-0">
          {!product.archived && (
            <ToggleButton label={showEdit ? "Close" : "Edit"} onClick={() => setShowEdit(!showEdit)} />
          )}
          {product.archived ? (
            <ToggleButton label="Restore" onClick={() => runLifecycle(restoreProduct, product.id, "Restore this product to your active catalogue?")} />
          ) : (
            <ToggleButton label="Archive" onClick={() => runLifecycle(archiveProduct, product.id, "Archive this product? It disappears from your store and POS, but its history is kept.")} />
          )}
          <ToggleButton
            label="Delete"
            onClick={() => runLifecycle(deleteProduct, product.id, "Permanently delete this product? Only products with no sales or stock history can be deleted; otherwise archive it.")}
          />
        </div>
      </div>

      {banner && <p className="text-xs text-red-600">{banner}</p>}

      {showEdit && !product.archived && (
        <InlineActionForm action={updateProduct} submitLabel="Save Changes">
          <input type="hidden" name="productId" value={product.id} />
          <div>
            <label className={labelClass}>Name</label>
            <input name="name" type="text" defaultValue={product.name} className={inputClass} required />
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <input name="description" type="text" defaultValue={product.description ?? ""} className={inputClass} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelClass}>Status</label>
              <select name="status" defaultValue={product.status} className={inputClass}>
                <option value="PUBLISHED">Published</option>
                <option value="DRAFT">Draft</option>
              </select>
            </div>
            <div>
              <label className={labelClass}>Category</label>
              <select name="categoryId" defaultValue={product.categoryId ?? ""} className={inputClass}>
                <option value="">No category</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>
        </InlineActionForm>
      )}

      {/* Variants */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Variants</p>
          {!product.archived && (
            <ToggleButton label={showAddVariant ? "Cancel" : "+ Add Variant"} onClick={() => setShowAddVariant(!showAddVariant)} />
          )}
        </div>

        {showAddVariant && !product.archived && (
          <InlineActionForm action={addVariant} submitLabel="Add Variant">
            <input type="hidden" name="productId" value={product.id} />
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>Variant Name</label>
                <input name="name" type="text" placeholder="e.g. Red / Medium" className={inputClass} required />
              </div>
              <div>
                <label className={labelClass}>SKU (unique in your business)</label>
                <input name="sku" type="text" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Barcode</label>
                <input name="barcode" type="text" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Selling Price (₦)</label>
                <input name="sellingPrice" type="number" step="0.01" className={inputClass} required />
              </div>
              <div>
                <label className={labelClass}>Cost (₦, optional)</label>
                <input name="costPrice" type="number" step="0.01" className={inputClass} />
              </div>
              <div>
                <label className={labelClass}>Initial Stock</label>
                <input name="initialStock" type="number" className={inputClass} required />
              </div>
            </div>
          </InlineActionForm>
        )}

        {product.variants.map((variant) => (
          <div key={variant.id} className="border border-slate-200 rounded-md p-3 space-y-2">
            <div className="flex justify-between items-start">
              <div>
                <p className="text-sm font-medium text-slate-900">{variant.name}</p>
                <p className="text-xs text-slate-500">
                  {variant.sku ? `SKU: ${variant.sku}` : "No SKU"}
                  {variant.barcode ? ` · Barcode: ${variant.barcode}` : ""}
                </p>
              </div>
              <div className="text-right">
                <p className="font-bold text-slate-900">₦{variant.sellingPrice.toLocaleString()}</p>
                <p className={`text-sm ${variant.stock > 0 ? "text-green-600" : "text-red-600"}`}>{variant.stock} in stock</p>
                {/* P1-D (P1-21): read-time low-stock badge (R-9: archived
                    products are excluded server-side; this is belt-and-braces). */}
                {variant.lowStock && !product.archived && (
                  <span className="inline-block mt-1 text-xs px-2 py-0.5 rounded-full bg-red-100 text-red-700">
                    Low stock
                  </span>
                )}
              </div>
            </div>

            <div className="flex gap-3 items-center flex-wrap">
              <AdjustStockForm variantId={variant.id} />
              {!product.archived && (
                <ToggleButton
                  label={editingVariantId === variant.id ? "Close" : "Edit Variant"}
                  onClick={() => setEditingVariantId(editingVariantId === variant.id ? null : variant.id)}
                />
              )}
            </div>

            {editingVariantId === variant.id && !product.archived && (
              <InlineActionForm action={updateVariant} submitLabel="Save Variant">
                <input type="hidden" name="variantId" value={variant.id} />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className={labelClass}>Variant Name</label>
                    <input name="name" type="text" defaultValue={variant.name} className={inputClass} required />
                  </div>
                  <div>
                    <label className={labelClass}>SKU (unique in your business)</label>
                    <input name="sku" type="text" defaultValue={variant.sku ?? ""} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Barcode</label>
                    <input name="barcode" type="text" defaultValue={variant.barcode ?? ""} className={inputClass} />
                  </div>
                  <div>
                    <label className={labelClass}>Selling Price (₦)</label>
                    <input name="sellingPrice" type="number" step="0.01" defaultValue={variant.sellingPrice} className={inputClass} required />
                  </div>
                  <div>
                    <label className={labelClass}>Cost (₦)</label>
                    <input name="costPrice" type="number" step="0.01" defaultValue={variant.costPrice} className={inputClass} required />
                  </div>
                  <div>
                    {/* P1-D (P1-21): threshold editor field — blank disables
                        the alert (NULL); 0 flags out-of-stock only. */}
                    <label className={labelClass}>Low Stock Alert Threshold (blank = off)</label>
                    <input
                      name="lowStockThreshold"
                      type="number"
                      min="0"
                      step="1"
                      defaultValue={variant.lowStockThreshold ?? ""}
                      className={inputClass}
                    />
                  </div>
                </div>
              </InlineActionForm>
            )}
          </div>
        ))}
      </div>

      {/* Images */}
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <p className="text-xs font-semibold text-slate-600 uppercase tracking-wide">Images (URL)</p>
          {!product.archived && (
            <ToggleButton label={showAddImage ? "Cancel" : "+ Add Image"} onClick={() => setShowAddImage(!showAddImage)} />
          )}
        </div>

        {imageError && <p className="text-xs text-red-600">{imageError}</p>}

        {showAddImage && !product.archived && (
          <InlineActionForm action={addProductImage} submitLabel="Add Image">
            <input type="hidden" name="productId" value={product.id} />
            <div>
              <label className={labelClass}>Image URL (http/https)</label>
              <input name="url" type="url" placeholder="https://..." className={inputClass} required />
            </div>
            <label className="text-xs flex items-center gap-2">
              <input type="checkbox" name="isPrimary" /> Set as primary image
            </label>
          </InlineActionForm>
        )}

        {product.images.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            {product.images.map((image) => (
              <div key={image.id} className="relative border border-slate-200 rounded-md p-1 text-xs">
                {image.isPrimary && <span className="text-[10px] text-blue-600">Primary · </span>}
                <a href={image.url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline break-all">
                  {image.url.length > 40 ? image.url.slice(0, 40) + "…" : image.url}
                </a>
                {!product.archived && (
                  <button
                    onClick={() => {
                      const formData = new FormData()
                      formData.set("imageId", image.id)
                      void deleteProductImage(formData).then((res) => {
                        if (res.error) setImageError(res.error)
                      })
                    }}
                    className="ml-1 text-red-500 hover:underline"
                  >
                    remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
