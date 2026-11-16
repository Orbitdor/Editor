import "./globals.css";
import { Providers } from "@/components/providers";

export const metadata = {
  title: "Doc Editor",
  description: "A simple docx-like web application",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      {/* Browser extensions (e.g. ColorZilla's `cz-shortcut-listen`) inject
          attributes onto <body> before React hydrates; that is not our markup,
          so the mismatch is expected and silenced rather than "fixed". */}
      <body className="min-h-full flex flex-col bg-zinc-50" suppressHydrationWarning>
        <Providers>
          <div className="flex flex-1 flex-col">{children}</div>
        </Providers>
      </body>
    </html>
  );
}