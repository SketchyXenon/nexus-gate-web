import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Roboto_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { Providers } from "@/components/providers";
import { ThemeProvider } from "@/components/theme-provider";
import { ServiceWorkerRegister } from "@/components/sw-register";
import { getAppUrl } from "@/lib/app-url";

// JetBrains Mono — headings and subheadings
const jetbrains = JetBrains_Mono({
  variable: "--font-heading",
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700", "800"],
});

// Roboto Mono — body text
const roboto = Roboto_Mono({
  variable: "--font-body",
  subsets: ["latin"],
  display: "swap",
  weight: ["300", "400", "500", "600"],
});

const APP_URL = getAppUrl();

export const metadata: Metadata = {
  title: {
    default: "Nexus Gate - Attendance System",
    template: "%s · Nexus Gate",
  },
  description:
    "Simple, fast, and secure QR-based attendance. Scan a code to check in to your classes — no apps, no sign-in sheets.",
  keywords: [
    "attendance system",
    "QR attendance",
    "student attendance",
    "class check-in",
    "Nexus Gate",
  ],
  authors: [{ name: "Ray Abenasa", url: "https://ray-abenasa.vercel.app" }],
  creator: "Ray Abenasa",
  publisher: "Nexus Gate",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Nexus Gate",
  },
  icons: {
    icon: [
      { url: "/icon-192.svg", type: "image/svg+xml" },
      { url: "/icon-512.svg", type: "image/svg+xml" },
    ],
    apple: [{ url: "/icon-192.svg" }],
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    ...(APP_URL ? { url: APP_URL } : {}),
    siteName: "Nexus Gate",
    title: "Nexus Gate — Attendance, simplified.",
    description:
      "Scan a QR code to check in to your classes. No apps, no sign-in sheets, no waiting in line.",
    images: [
      {
        url: "/icon-512.svg",
        width: 512,
        height: 512,
        alt: "Nexus Gate",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Nexus Gate — Attendance System",
    description:
      "Scan a QR code to check in to your classes. No apps, no sign-in sheets.",
    images: ["/icon-512.svg"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
    },
  },
  alternates: {
    ...(APP_URL ? { canonical: APP_URL } : {}),
  },
  category: "education",
};

export const viewport: Viewport = {
  themeColor: "#b45309",
  width: "device-width",
  initialScale: 1,
  // Allow pinch-zoom for accessibility (WCAG 1.4.4)
  maximumScale: 5,
  userScalable: true,
};

// Structured data for SEO
const structuredData = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Nexus Gate",
  applicationCategory: "EducationalApplication",
  operatingSystem: "Web",
  description:
    "QR-based attendance system. Students scan a rotating QR code to check in to classes.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  creator: {
    "@type": "Person",
    name: "Ray Abenasa",
    url: "https://ray-abenasa.vercel.app",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData) }}
        />
      </head>
      <body
        className={`${jetbrains.variable} ${roboto.variable} antialiased bg-background text-foreground`}
        style={{ fontFamily: "var(--font-body), ui-monospace, monospace" }}
      >
        <ThemeProvider>
          <Providers>{children}</Providers>
          <Toaster />
          <ServiceWorkerRegister />
        </ThemeProvider>
      </body>
    </html>
  );
}
