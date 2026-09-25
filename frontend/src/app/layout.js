import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata = {
  title: "Doc Editor",
  description: "A simple docx-like web application",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-50">
        <Providers>
          <div className="flex flex-1 flex-col">{children}</div>
        </Providers>
      </body>
    </html>
  );
}