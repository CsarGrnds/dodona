import type { Metadata } from "next";
import MarketBar from "@/components/MarketBar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Dodona",
  description: "Investment analytics with a per-ticker agent that follows each company and suggests when to buy or sell.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <MarketBar />
        {children}
      </body>
    </html>
  );
}
