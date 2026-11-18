import { getSessionContext } from "@/lib/auth-helpers"
import { prisma } from "@via-saas/database"
import { loadLowStockVariantIds } from "@/lib/low-stock"
import { redirect } from "next/navigation"
import Link from "next/link"
import { ProductCard } from "./ProductCard"
import { CategoryManager } from "./CategoryManager"
import { CreateProductForm } from "./CreateProductForm"

export default async function ProductsPage({
  searchParams,
}: {
  searchParams?: { category?: string; lowStock?: string }
}) {
  const context = await getSessionContext()
  if (!context) redirect("/login")

  const categoryFilter = searchParams?.category ?? null
  // P1-D (P1-21): optional low-stock filter — server-side, computed at read
  // time across the actor's accessible locations.
  const lowStockOnly = searchParams?.lowStock === "1"

  // Fetch Products + categories for this Organization ONLY (Tenant Isolation)
  const [products, categories] = await Promise.all([
    prisma.product.findMany({
      where: { organizationId: context.orgId },
      include: {
        variants: {
          include: { inventory: true } // To show stock levels
        },
        images: true,
        category: true,
      }
    }),
    prisma.category.findMany({
      where: { organizationId: context.orgId },
      include: { _count: { select: { products: true } } },
      orderBy: { name: "asc" },
    })
  ])

  // P1-D (P1-21): read-time low-stock variant ids at the actor's accessible
  // locations (PD-AC13/14; archived products excluded, R-9).
  const lowStockVariantIds = await loadLowStockVariantIds({
    orgId: context.orgId,
    accessibleLocationIds: context.accessibleLocationIds,
  })

  // Shape into plain serializable views for the client components.
  const productViews = products.map((product) => ({
    id: product.id,
    name: product.name,
    description: product.description,
    status: product.status,
    archived: product.archivedAt !== null,
    categoryId: product.categoryId,
    categoryName: product.category?.name ?? null,
    variants: product.variants.map((variant) => ({
      id: variant.id,
      name: variant.name,
      sku: variant.sku,
      barcode: variant.barcode,
      sellingPrice: Number(variant.sellingPrice),
      costPrice: Number(variant.costPrice),
      stock: variant.inventory.reduce((sum, row) => sum + row.quantity, 0),
      // P1-D (P1-21): read-time low-stock badge data (accessible locations).
      lowStockThreshold: variant.lowStockThreshold,
      lowStock: lowStockVariantIds.has(variant.id),
    })),
    images: product.images.map((image) => ({
      id: image.id,
      url: image.url,
      isPrimary: image.isPrimary,
    })),
  }))

  const categoryViews = categories.map((category) => ({
    id: category.id,
    name: category.name,
    productCount: category._count.products,
  }))

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h1 className="text-2xl font-bold text-slate-900">Product Catalogue</h1>
      </div>

      {/* Category filter (AC-A3): server-side, tenant-scoped */}
      <div className="flex gap-2 flex-wrap">
        <Link
          href="/products"
          className={`text-xs px-3 py-1 rounded-full border ${!categoryFilter ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}
        >
          All
        </Link>
        {categoryViews.map((category) => (
          <Link
            key={category.id}
            href={`/products?category=${category.id}`}
            className={`text-xs px-3 py-1 rounded-full border ${categoryFilter === category.id ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-600 border-slate-200 hover:border-slate-400"}`}
          >
            {category.name} ({category.productCount})
          </Link>
        ))}
        {/* P1-D (P1-21): low-stock filter, server-side at accessible locations. */}
        <Link
          href="/products?lowStock=1"
          className={`text-xs px-3 py-1 rounded-full border ${lowStockOnly ? "bg-amber-500 text-white border-amber-500" : "bg-white text-amber-700 border-amber-300 hover:border-amber-400"}`}
        >
          Low stock
        </Link>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left: Add Product Form + Categories */}
        <div className="space-y-6 h-fit">
          <CreateProductForm />

          <CategoryManager categories={categoryViews} />
        </div>

        {/* Right: Product List */}
        <div className="md:col-span-2 space-y-4">
          {productViews.length === 0 ? (
            <div className="text-center p-12 bg-white rounded-lg border border-slate-200 text-slate-500">
              No products yet. Add your first product to get started.
            </div>
          ) : (
            productViews
              .filter((product) => !categoryFilter || product.categoryId === categoryFilter)
              // P1-D (P1-21): low-stock filter — products with at least one
              // low-stock variant at the accessible locations (read-time).
              .filter((product) => !lowStockOnly || product.variants.some((v) => v.lowStock))
              .map((product) => (
                <ProductCard key={product.id} product={product} categories={categoryViews} />
              ))
          )}
        </div>
      </div>
    </div>
  )
}
