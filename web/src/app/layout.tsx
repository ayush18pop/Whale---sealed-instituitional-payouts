import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Whale — Funds, in confidence.', description: 'A calmer workspace for institutional payouts.' };
export default function RootLayout({ children }: Readonly<{children: React.ReactNode}>) { return <html lang="en"><body>{children}</body></html>; }
