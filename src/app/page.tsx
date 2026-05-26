import StreamVaultApp from '@/components/streaming/StreamVaultApp';

/**
 * Server Component — reads env vars at REQUEST TIME (not build time).
 * This is the ONLY reliable way to get runtime env vars on Vercel:
 *   - Server Components read process.env at request time ✓
 *   - Client Components get NEXT_PUBLIC_* baked at build time ✗
 *   - Layout can be statically cached by Next.js ✗
 *
 * Props are serialized into HTML and hydrated on the client,
 * so the client component receives the correct credentials.
 */
export const dynamic = 'force-dynamic';

export default function Page() {
  return (
    <StreamVaultApp
      supabaseUrl={process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || ''}
      supabaseAnonKey={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || ''}
    />
  );
}
