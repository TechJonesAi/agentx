/**
 * Build Learning Types
 * Types for build memory and pattern learning
 */

export interface BuildMemoryHints {
  /** Previously successful builds similar to current request */
  similarSuccessfulBuilds: string[];
  /** Recommended patterns based on past builds */
  recommendedPatterns: string[];
  /** Warnings from past attempts */
  warningMessages: string[];
}
