# Whale frontend

The landing page lives at `/`. Open the application at `/workspace`. The landing page includes original SVG metal sculpture, scroll reveals, an accessible FAQ accordion, mobile navigation, and an illustrative workspace preview. The interactive access model explains Finance, Approver, Recipient, Auditor, and Public permissions; this is a product walkthrough, not an authorisation check.

Run `npm install` then `npm run dev` from this directory. Run `npm run build` for the production build.

Next.js App Router, TypeScript, Motion, Lucide and Radix primitives. The Button follows shadcn/ui's cva/Slot composition, with bespoke metal and glass styling. Its shimmer treatment references the 21st.dev Shiny Button design; it is an original implementation, not a copied registry component (the component source requires an account).

The production-facing UI intentionally displays no fictional balances or transaction confirmations. CSV uploads create in-memory session drafts only; refreshing clears them. No file is uploaded to a server. Treasury funding, approval records and activity need the backend API described in FRONTEND_PRD.md before they can operate. UI navigation currently uses local tab state.

Design: pearl and navy, softly rounded surfaces, floating navigation, restrained metallic reflections. Motion respects reduced-motion preferences. Dialogs use Radix focus trapping and keyboard dismissal.

Reference: https://docs.21st.dev/@hyperiux/components/shiny-button
Reference: https://ui.shadcn.com/docs/components/button
