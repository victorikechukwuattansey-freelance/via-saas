import Link from "next/link"

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="min-h-screen flex flex-col justify-center items-center bg-slate-50 p-4">
      <div className="w-full max-w-md">
        {/* Logo / Brand */}
        <div className="text-center mb-8">
          <Link href="/" className="text-3xl font-bold tracking-tight text-slate-900">
            VIA
          </Link>
          <p className="text-slate-500 mt-2">Manage your business with ease.</p>
        </div>

        {/* The Form Container */}
        <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm">
          {children}
        </div>
        
        {/* Footer Links */}
        <p className="text-center text-sm text-slate-500 mt-6">
          By continuing, you agree to our Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  )
}
