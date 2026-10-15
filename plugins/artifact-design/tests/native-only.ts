// What only Claude Code's own artifact tools and claude.ai have, which the plugin's model-facing text
// must not name (see AGENTS.md).
export const NATIVE_ONLY =
  /claude\.ai|Artifact[- ]types?\b|ArtifactComments|ArtifactData|type_url|window\.claude|runtime capabilit|scratchpad|connector|gallery|thumbnail|host background|viewer's theme|built-in Artifact|own Artifact tool|Design Systems?\b|live page/;
