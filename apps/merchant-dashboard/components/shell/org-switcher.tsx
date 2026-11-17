"use client"

// P1-17 — organization switcher (plan §10.3 UI). Renders the user's ELIGIBLE
// memberships (computed server-side); hidden switch surface for single-org
// users. The selected org id is verified server-side by switchOrganization.

import { useRef } from "react"
import { useFormState } from "react-dom"
import { Building2, ChevronDown } from "lucide-react"
import { switchOrganization } from "@/app/actions/organization"

type Org = { organizationId: string; name: string }

export function OrgSwitcher({
  organizations,
  currentOrgId,
}: {
  organizations: Org[]
  currentOrgId: string
}) {
  const [, formAction] = useFormState(switchOrganization, null)
  const formRef = useRef<HTMLFormElement>(null)
  const current =
    organizations.find((o) => o.organizationId === currentOrgId)?.name ?? "My Business"
  const multi = organizations.length > 1

  if (!multi) {
    return (
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700 bg-slate-100 px-3 py-1.5 rounded-md">
        <Building2 className="h-4 w-4 text-blue-600" />
        <span>{current}</span>
      </div>
    )
  }

  return (
    <form ref={formRef} action={formAction} className="flex items-center gap-2">
      <div className="flex items-center gap-2 text-sm font-medium text-slate-700 bg-slate-100 px-3 py-1.5 rounded-md">
        <Building2 className="h-4 w-4 text-blue-600" />
        <select
          name="organizationId"
          defaultValue={currentOrgId}
          onChange={() => formRef.current?.requestSubmit()}
          aria-label="Active organization"
          className="bg-transparent text-sm font-medium text-slate-700 outline-none max-w-40"
        >
          {organizations.map((org) => (
            <option key={org.organizationId} value={org.organizationId}>
              {org.name}
            </option>
          ))}
        </select>
        <ChevronDown className="h-3 w-3 text-slate-400" />
      </div>
    </form>
  )
}
