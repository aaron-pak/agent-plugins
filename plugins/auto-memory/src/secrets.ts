// Credentials memory_write refuses to save. Claude Code checks content against a gitleaks-style rule
// set; this is a shorter list of the common, distinctive token shapes, named the way gitleaks names
// them.

const RULES: [label: string, pattern: RegExp][] = [
  ["private-key", /-----BEGIN[ A-Z0-9_-]{0,100}PRIVATE KEY(?: BLOCK)?-----/],
  ["aws-access-token", /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z2-7]{16}\b/],
  ["github-pat", /\bghp_[0-9a-zA-Z]{36}\b/],
  ["github-fine-grained-pat", /\bgithub_pat_\w{82}\b/],
  ["github-oauth", /\bgho_[0-9a-zA-Z]{36}\b/],
  ["github-app-token", /\b(?:ghu|ghs)_[0-9a-zA-Z]{36}\b/],
  ["github-refresh-token", /\bghr_[0-9a-zA-Z]{36}\b/],
  ["gitlab-pat", /\bglpat-[\w-]{20}\b/],
  ["anthropic-api-key", /\bsk-ant-(?:api|admin)\d{2}-[\w-]{80,}/],
  ["openai-api-key", /\bsk-(?:proj|svcacct|admin)-[\w-]{20,}/],
  ["slack-token", /\bxox[abpors]-[0-9A-Za-z-]{10,}/],
  ["slack-webhook-url", /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,}/],
  ["stripe-access-token", /\b(?:sk|rk)_(?:live|test|prod)_[0-9a-zA-Z]{10,99}\b/],
  ["gcp-api-key", /\bAIza[\w-]{35}\b/],
  ["npm-access-token", /\bnpm_[a-zA-Z0-9]{36}\b/],
  ["jwt", /\bey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/_-]{17,}\.[a-zA-Z0-9/_-]{10,}={0,2}/],
];

/** The labels of the credentials `content` seems to hold. */
export function secretsIn(content: string): string[] {
  return RULES.filter(([, pattern]) => pattern.test(content)).map(([label]) => label);
}
