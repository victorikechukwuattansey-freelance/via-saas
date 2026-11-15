"use client"

import { useFormState, useFormStatus } from "react-dom"
import { Button } from "@via-saas/ui"
import { acceptInvite } from "./actions"

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <Button type="submit" className="w-full" disabled={pending}>
      {pending ? "Setting up..." : "Create My Account"}
    </Button>
  )
}

export default function InviteAcceptPage({ params }: { params: { token: string } }) {
  const [state, formAction] = useFormState(acceptInvite, null)

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-slate-900">Set up your account</h2>
        <p className="text-sm text-slate-500 mt-1">
          Choose a password to activate your team account.
        </p>
      </div>

      {state?.error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm">{state.error}</div>
      )}

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="token" value={params.token} />
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="password">New Password</label>
          <input
            id="password"
            name="password"
            type="password"
            minLength={8}
            placeholder="At least 8 characters"
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700" htmlFor="confirm">Confirm Password</label>
          <input
            id="confirm"
            name="confirm"
            type="password"
            minLength={8}
            className="w-full px-3 py-2 border border-slate-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            required
          />
        </div>
        <SubmitButton />
      </form>
    </div>
  )
}
