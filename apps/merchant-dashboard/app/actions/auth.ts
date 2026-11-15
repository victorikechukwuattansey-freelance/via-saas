"use server"

import { cookies } from "next/headers"
import { redirect } from "next/navigation"
import { prisma } from "@via-saas/database"

export async function logout() {
  const token = cookies().get("session_token")?.value

  // Optional but recommended: Delete the session from the database
  if (token) {
    await prisma.session.deleteMany({
      where: { token }
    })
  }

  // Clear the cookie
  cookies().delete("session_token")
  
  // Redirect to login
  redirect("/login")
}
