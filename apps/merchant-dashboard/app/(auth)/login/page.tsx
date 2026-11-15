"use client"

import Link from "next/link"
import { Button } from "@via-saas/ui"
import { useFormState, useFormStatus } from "react-dom"
import { loginUser } from "./actions"

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Logging in..." : "Log In"}
    </Button>
  )
}

export default function LoginPage() {
  const [state, formAction] = useFormState(loginUser, null)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Welcome back</h2>
        <p className="text-sm text-slate-500 mt-1">Log in to your merchant dashboard.</p>
      </div>

      {state?.error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">
          {state.error}
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="email">Email Address</label>
          <input id="email" name="email" type="email" placeholder="john@example.com" className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" required />
        </div>

        <div className="space-y-2">
          <div className="flex justify-between items-center">
            <label className="text-sm font-medium text-slate-700" htmlFor="password">Password</label>
            <Link href="/forgot-password" className="text-sm text-blue-600 hover:text-blue-500">Forgot password?</Link>
          </div>
          <input id="password" name="password" type="password" placeholder="••••••••" className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" required />
        </div>

        <SubmitButton />
      </form>

      <div className="text-center text-sm">
        <span className="text-slate-500">Don't have an account? </span>
        <Link href="/register" className="font-medium text-blue-600 hover:text-blue-500">Sign up</Link>
      </div>
    </div>
  )
}
