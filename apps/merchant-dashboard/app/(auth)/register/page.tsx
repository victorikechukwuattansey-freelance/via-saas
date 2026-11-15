"use client"

import Link from "next/link"
import { Button } from "@via-saas/ui"
import { useFormState, useFormStatus } from "react-dom"
import { registerUser } from "./actions"

// Separate button component to handle the loading state
function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Creating Account..." : "Create Business Account"}
    </Button>
  )
}

export default function RegisterPage() {
  const [state, formAction] = useFormState(registerUser, null)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Create your account</h2>
        <p className="text-sm text-slate-500 mt-1">Start managing your business today.</p>
      </div>

      {state?.error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        {/* ... (Keep all your existing input fields EXACTLY as they are) ... */}
        {/* Just ensure you added the `name` attribute to the inputs: */}
        
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="name">Full Name</label>
          <input id="name" name="name" type="text" placeholder="John Doe" className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" required />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="business">Business Name</label>
          <input id="business" name="business" type="text" placeholder="Acme Stores Ltd" className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" required />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="email">Email Address</label>
          <input id="email" name="email" type="email" placeholder="john@example.com" className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" required />
        </div>

        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" placeholder="••••••••" className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" required />
        </div>

        <SubmitButton />
      </form>

      <div className="text-center text-sm">
        <span className="text-slate-500">Already have an account? </span>
        <Link href="/login" className="font-medium text-blue-600 hover:text-blue-500">Log in</Link>
      </div>
    </div>
  )
}
