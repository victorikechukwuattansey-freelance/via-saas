import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css"; // <--- THIS IS THE CRITICAL IMPORT

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "MySaaS Merchant Dashboard",
  description: "Manage your business, inventory, and orders.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} antialiased bg-slate-50 text-slate-900`}>
        {children}
      </body>
    </html>
  );
}
