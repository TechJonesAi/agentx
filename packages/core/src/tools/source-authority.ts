/**
 * Source-authority scoring for web search results.
 *
 * Phase B3 lift: copied verbatim from silly-johnson's tools/builtin.ts
 * (lines defining SourceAuthority + scoreSourceAuthority + AUTHORITY_PATTERNS)
 * so the hybrid orchestrator can be lifted without overwriting main's
 * tools/builtin.ts. When a builtin.ts three-way merge happens later this
 * file should be removed and consumers should import from builtin.ts again.
 */

export type SourceAuthority = 'HIGH' | 'MEDIUM' | 'LOW';

/** Authoritative domain patterns for source scoring */
const AUTHORITY_PATTERNS: Array<{ pattern: RegExp; authority: SourceAuthority; label: string }> = [
  // HIGH authority — government, courts, tribunals, and official legal sources
  { pattern: /legislation\.gov\.uk/i, authority: 'HIGH', label: 'UK Legislation' },
  { pattern: /judiciary\.uk/i, authority: 'HIGH', label: 'UK Judiciary' },
  { pattern: /employment-tribunals\.service\.gov\.uk/i, authority: 'HIGH', label: 'Employment Tribunals' },
  { pattern: /supremecourt\.uk/i, authority: 'HIGH', label: 'Supreme Court' },
  { pattern: /bailii\.org/i, authority: 'HIGH', label: 'BAILII (Case Law)' },
  { pattern: /acas\.org\.uk/i, authority: 'HIGH', label: 'ACAS' },
  { pattern: /gov\.uk/i, authority: 'HIGH', label: 'UK Government' },
  { pattern: /parliament\.uk/i, authority: 'HIGH', label: 'UK Parliament' },
  { pattern: /citizensadvice\.org\.uk/i, authority: 'HIGH', label: 'Citizens Advice' },
  { pattern: /lawsociety\.org\.uk/i, authority: 'HIGH', label: 'Law Society' },
  { pattern: /barcouncil\.org\.uk/i, authority: 'HIGH', label: 'Bar Council' },
  { pattern: /equalityhumanrights\.com/i, authority: 'HIGH', label: 'EHRC' },
  { pattern: /hse\.gov\.uk/i, authority: 'HIGH', label: 'HSE' },
  { pattern: /gov\.au|gov\.nz|europa\.eu|congress\.gov|irs\.gov|sec\.gov/i, authority: 'HIGH', label: 'Government' },
  { pattern: /nhs\.uk/i, authority: 'HIGH', label: 'NHS' },
  { pattern: /\.edu\b/i, authority: 'HIGH', label: 'Educational Institution' },
  // MEDIUM authority — reputable news, legal reference, professional bodies
  { pattern: /bbc\.co\.uk|bbc\.com/i, authority: 'MEDIUM', label: 'BBC' },
  { pattern: /reuters\.com|apnews\.com/i, authority: 'MEDIUM', label: 'Wire Service' },
  { pattern: /ft\.com|economist\.com|theguardian\.com/i, authority: 'MEDIUM', label: 'Major Publication' },
  { pattern: /wikipedia\.org/i, authority: 'MEDIUM', label: 'Wikipedia' },
  { pattern: /practicallaw\.|westlaw\.|lexisnexis\./i, authority: 'MEDIUM', label: 'Legal Database' },
  { pattern: /moneyhelper\.org\.uk|moneysavingexpert\.com/i, authority: 'MEDIUM', label: 'Financial Guide' },
  { pattern: /cipd\.org|cipd\.co\.uk/i, authority: 'MEDIUM', label: 'CIPD' },
  { pattern: /lawdonut\.co\.uk|netlawman\.co\.uk/i, authority: 'MEDIUM', label: 'Legal Guide' },
  { pattern: /.*\.org\.uk|.*\.org\b/i, authority: 'MEDIUM', label: 'Organisation' },
];

/**
 * Score a URL's source authority tier.
 */
export function scoreSourceAuthority(url: string): { authority: SourceAuthority; label: string } {
  for (const entry of AUTHORITY_PATTERNS) {
    if (entry.pattern.test(url)) {
      return { authority: entry.authority, label: entry.label };
    }
  }
  return { authority: 'LOW', label: 'Blog/Forum/Unknown' };
}
