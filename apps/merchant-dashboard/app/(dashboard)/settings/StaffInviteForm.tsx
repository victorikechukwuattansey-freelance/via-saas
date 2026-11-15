"use client"

import { useState } from "react"
import { useFormState } from "react-dom"
import { Button } from "@via-saas/ui"
import { inviteStaff } from "./actions"

type InviteState = { error?: string; inviteUrl?: string; linked?: boolean } | null

export function StaffInviteForm({ locations }: { locations: { id: string; name: string }[] }) {
  const [state, formAction] = useFormState(inviteStaff, null)
  const [copied, setCopied] = useState(false)

  return (
    <div className="bg-white p-6 rounded-lg border border-slate-200 shadow-sm h-fit">
      <h2 className="text-lg font-semibold mb-4">Invite Team Member</h2>

      {state?.error && (
        <div className="bg-red-50 text-red-600 p-3 rounded-md text-sm mb-4">{state.error}</div>
      )}

      {state?.linked && (
        <div className="bg-green-50 text-green-700 p-3 rounded-md text-sm mb-4">
          This person already has a VIA account — they have been added to your business.
        </div>
      )}

      {state?.inviteUrl && (
        <div className="bg-blue-50 border border-blue-200 p-3 rounded-md text-sm mb-4">
          <p className="text-blue-800 font-medium mb-1">One-time setup link (shown once):</p>
          <p className="text-blue-700 break-all mb-2">
            {typeof window !== "undefined" ? window.location.origin : ""}
            {state.inviteUrl}
          </p>
          <p className="text-blue-600 text-xs mb-2">
            Send this link to the team member. It expires in 48 hours and can be used only once.
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              navigator.clipboard.writeText(
                `${window.location.origin}${state.inviteUrl}`
              )
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            }}
          >
            {copied ? "Copied!" : "Copy link"}
          </Button>
        </div>
      )}

      <form action={formAction} className="space-y-4">
        <div>
          <label className="text-sm font-medium">Full Name</label>
          <input name="name" type="text" className="w-full px-3 py-2 border rounded-md mt-1" required />
        </div>
        <div>
          <label className="text-sm font-medium">Email Address</label>
          <input name="email" type="email" className="w-full px-3 py-2 border rounded-md mt-1" required />
        </div>
        <div>
          <label className="text-sm font-medium">Role</label>
          <select name="role" className="w-full px-3 py-2 border rounded-md mt-1" required>
            <option value="STAFF">Staff (Restricted)</option>
            <option value="MANAGER">Manager (Broad Access)</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium">Location Access</label>
          <select name="locationId" className="w-full px-3 py-2 border rounded-md mt-1">
            <option value="ALL">All Locations</option>
            {locations.map(loc => (
              <option key={loc.id} value={loc.id}>{loc.name} (Restricted)</option>
            ))}
          </select>
        </div>
        <Button type="submit" className="w-full">Send Invite</Button>
      </form>
      <p className="text-xs text-slate-500 mt-4 text-center">
        New team members set their own password via a one-time, expiring invite link.
      </p>
    </div>
  )
}
